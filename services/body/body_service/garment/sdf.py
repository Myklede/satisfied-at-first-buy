"""7 mm conservative body SDF, built once per posed body and kept in RAM."""

from concurrent.futures import ThreadPoolExecutor

import numpy as np
import trimesh
from scipy.ndimage import binary_fill_holes, distance_transform_edt
from scipy.spatial import cKDTree

from .. import config
from ..surface_query import SurfaceQuery


def sdf_grid(vertices: np.ndarray) -> tuple[np.ndarray, tuple[int, int, int], np.ndarray]:
    """Grid of ``body_sdf`` from the vertices alone: (origin, dimensions, min voxel index).

    Surface samples are convex combinations of the vertices and rounding is monotone, so the
    occupied index range is exactly round(min/max vertex / pitch). Callers can therefore
    publish the grid before the field itself is computed.
    """
    spacing = config.SDF_SPACING_M
    pad = int(np.ceil(config.SDF_PADDING_M / spacing))
    low = np.round(vertices.min(0) / spacing).astype(np.int64)
    high = np.round(vertices.max(0) / spacing).astype(np.int64)
    dims = tuple(int(d) for d in high - low + 1 + 2 * pad)
    origin = low * spacing - pad * spacing
    return origin, dims, low


def surface_voxels(mesh: trimesh.Trimesh, spacing: float, low: np.ndarray) -> np.ndarray:
    """Occupied surface voxel indices (relative to ``low``).

    Same rule as ``trimesh`` ``voxelize_subdivide`` (samples no farther apart than half a
    voxel, rounded to the voxel grid), but each triangle is sampled on its dyadic barycentric
    lattice in one vectorised step. The lattice contains every midpoint-subdivision vertex,
    so the occupied set is a (denser) superset of the subdivision's.
    """
    tri = mesh.triangles
    longest = np.linalg.norm(tri - np.roll(tri, 1, axis=1), axis=2).max(1)
    level = np.ceil(np.log2(np.maximum(longest / (spacing / 2), 1.0))).astype(int)
    chunks = []
    for value in np.unique(level):
        k = 2 ** int(value)
        i, j = np.meshgrid(np.arange(k + 1), np.arange(k + 1), indexing="ij")
        keep = i + j <= k
        weights = np.c_[k - i[keep] - j[keep], i[keep], j[keep]] / k
        points = np.einsum("pk,fkd->fpd", weights, tri[level == value]).reshape(-1, 3)
        chunks.append(np.round(points / spacing).astype(np.int64) - low)
    index = np.vstack(chunks)
    shape = index.max(0) + 1
    occupied = np.zeros(tuple(int(s) for s in shape), bool)
    occupied[tuple(index.T)] = True
    return occupied


def body_sdf(mesh: trimesh.Trimesh) -> tuple[np.ndarray, np.ndarray, float]:
    spacing = config.SDF_SPACING_M
    origin, dims, low = sdf_grid(mesh.vertices)
    pad = int(np.ceil(config.SDF_PADDING_M / spacing))
    surface = surface_voxels(mesh, spacing, low)
    filled = binary_fill_holes(surface)
    occupancy = np.pad(filled, pad)
    if occupancy.shape != dims:
        raise ValueError("SDF grid does not match its published dimensions")
    outside = distance_transform_edt(~occupancy, sampling=spacing)
    # Inside distances only need one background voxel round the box: any farther padding
    # voxel projects onto that layer at a smaller distance.
    inside = np.zeros_like(outside)
    core = (slice(pad - 1, -pad + 1),) * 3
    inside[core] = distance_transform_edt(np.pad(filled, 1), sampling=spacing)
    field = outside - inside
    # EDT centres alone overinflate narrow cuffs. Seed actual surface triangles
    # at occupied surface voxels, then refine the contact band against triangles
    # from nearby seeds. Far-field EDT remains sufficient for loose-gap display.
    surface_indices = np.argwhere(np.pad(surface, pad))
    surface_points = origin + surface_indices * spacing
    query = SurfaceQuery(mesh)
    chunk = config.SDF_QUERY_CHUNK
    seed_faces = np.empty(len(surface_points), dtype=int)

    def seed(start: int) -> None:
        _, _, seed_faces[start : start + chunk] = query.closest(
            surface_points[start : start + chunk]
        )

    tree = cKDTree(surface_points)
    band = np.argwhere(np.abs(field) <= config.SDF_REFINE_BAND_M)
    refined = np.empty(len(band), dtype=np.float64)

    def refine(start: int) -> None:
        indices = band[start : start + chunk]
        points = origin + indices * spacing
        _, seeds = tree.query(points, k=config.SDF_NEARBY_SEEDS)
        faces = seed_faces[seeds]
        count = faces.shape[1]
        repeated = np.repeat(points, count, axis=0)
        projected = trimesh.triangles.closest_point(mesh.triangles[faces.ravel()], repeated)
        projected = projected.reshape(len(points), count, 3)
        distance = np.linalg.norm(projected - points[:, None, :], axis=2)
        best = distance.argmin(1)
        rows = np.arange(len(points))
        nearest = projected[rows, best]
        normals = query.pseudonormals(nearest, faces[rows, best])
        refined[start : start + chunk] = distance[rows, best] * np.where(
            np.einsum("ij,ij->i", points - nearest, normals) >= 0, 1.0, -1.0
        )

    # Chunks are independent; numpy releases the GIL inside the large array kernels.
    with ThreadPoolExecutor(config.SDF_THREADS) as pool:
        list(pool.map(seed, range(0, len(surface_points), chunk)))
        list(pool.map(refine, range(0, len(band), chunk)))
    field[tuple(band.T)] = refined
    return field.astype("<f4"), origin, spacing
