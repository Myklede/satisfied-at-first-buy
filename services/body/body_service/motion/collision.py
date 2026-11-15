"""Articulated body distance: rigid per-segment fields + exact skinned joint zone.

Per body (once): each segment's near-rigid CORE (skin weight >= SEGMENT_CORE_WEIGHT on its
bones) is closed with centroid fans over its boundary loops and its signed distance is
sampled on a regular grid in the segment bone's LOCAL rest frame. The remaining triangles
(the LBS blend zone around joints and along the spine) form the joint zone.

Per frame: d(p) = min(min_s SDF_s(inv(W_s) p), exact distance to the skinned joint-zone
triangles), with bounding-sphere culling of the rigid part. Python reference; FORMAT.md
documents the binary layout a TypeScript worker samples.

Grid sign: exact ray parity (inside = negative) at every node along +Z columns. Grid
magnitude: exact closest points at nodes next to the surface, EDT feature map elsewhere.
"""

from dataclasses import dataclass

import numpy as np
import trimesh
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from . import config
from .rig import RestRig


@dataclass
class SegmentField:
    name: str
    bone: int  # reference bone index; the grid lives in this bone's rest-local frame
    local_from_rest: np.ndarray  # (4, 4) = inv(R_bone): rest scene -> bone local
    origin: np.ndarray  # (3,) local coordinates of grid point (0, 0, 0)
    spacing: float
    values: np.ndarray  # (nx, ny, nz) float32 signed distance, metres, x-major (C order)
    centre: np.ndarray  # (3,) bounding-sphere centre, local frame
    radius: float  # max distance from centre to the segment's closed surface
    vertex_ids: np.ndarray  # rest vertices belonging to the segment (overlap included)


def bone_owners(rig: RestRig) -> np.ndarray:
    """Segment index owning each bone: the nearest listed ancestor (or itself)."""
    listed = {}
    for s, (_, bones) in enumerate(config.SEGMENTS.values()):
        for label in bones:
            listed[rig.bone(label)] = s
    owner = np.full(len(rig.labels), -1)
    for b in range(len(rig.labels)):
        j = b
        while j >= 0 and j not in listed:
            j = int(rig.parents[j])
        if j < 0:
            raise ValueError(f"Bone {rig.labels[b]} has no segment")
        owner[b] = listed[j]
    return owner


def segment_weights(rig: RestRig) -> np.ndarray:
    """(V, S) skin weight carried by each segment's bones."""
    owner = bone_owners(rig)
    out = np.zeros((len(rig.vertices), len(config.SEGMENTS)))
    for k in range(rig.indices.shape[1]):
        np.add.at(out, (np.arange(len(rig.vertices)), owner[rig.indices[:, k]]), rig.weights[:, k])
    return out


def outer_faces(rig: RestRig) -> np.ndarray:
    """Faces of the largest connected component (drops Anny's internal eye geometry)."""
    f = rig.faces
    n = len(rig.vertices)
    graph = coo_matrix(
        (np.ones(len(f) * 3), (f[:, [0, 1, 2]].ravel(), f[:, [1, 2, 0]].ravel())), shape=(n, n)
    )
    _, labels = connected_components(graph, directed=False)
    main = np.bincount(labels[f[:, 0]]).argmax()
    return f[labels[f[:, 0]] == main]


def close_patch(vertices: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Cap every boundary loop of an open patch with a fan to the loop's centroid."""
    edges = np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = unique[counts == 1]
    if not len(boundary):
        return vertices, faces
    n = len(vertices)
    graph = coo_matrix((np.ones(len(boundary)), (boundary[:, 0], boundary[:, 1])), shape=(n, n))
    _, labels = connected_components(graph, directed=False)
    loop = labels[boundary[:, 0]]
    loops = np.unique(loop)
    centroids = np.array([vertices[np.unique(boundary[loop == c])].mean(0) for c in loops])
    centre_ids = n + np.searchsorted(loops, loop)
    caps = np.c_[boundary, centre_ids]
    return np.vstack((vertices, centroids)), np.vstack((faces, caps))


def parity_inside(
    tri: np.ndarray, origin: np.ndarray, dims: tuple[int, int, int], h: float
) -> np.ndarray:
    """Inside test at every grid point by +Z ray parity against closed triangles (T,3,3)."""
    nx, ny, nz = dims
    # Ray columns sit at grid x/y; a sub-micron shift avoids exact edge/vertex hits.
    shift = np.array([3.1e-7, 1.7e-7])
    p = tri[:, :, :2] - origin[:2] - shift  # (T, 3, 2) relative to column 0
    lo = np.clip(np.ceil(p.min(1) / h).astype(int), 0, [nx, ny])
    hi = np.clip(np.floor(p.max(1) / h).astype(int) + 1, 0, [nx, ny])
    span = np.maximum(hi - lo, 0)
    count = span[:, 0] * span[:, 1]
    tid = np.repeat(np.arange(len(tri)), count)
    local = np.arange(count.sum()) - np.repeat(np.cumsum(count) - count, count)
    ix = lo[tid, 0] + local // np.maximum(span[tid, 1], 1)
    iy = lo[tid, 1] + local % np.maximum(span[tid, 1], 1)
    q = np.c_[ix, iy] * h
    a, b, c = p[tid, 0], p[tid, 1], p[tid, 2]
    v0, v1, v2 = b - a, c - a, q - a
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    ok = np.abs(den) > 1e-18
    den = np.where(ok, den, 1.0)
    u = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den
    v = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1)
    z = (
        tri[tid, 0, 2]
        + u * (tri[tid, 1, 2] - tri[tid, 0, 2])
        + v * (tri[tid, 2, 2] - tri[tid, 0, 2])
    )
    ix, iy, z = ix[hit], iy[hit], z[hit]
    k = np.clip(np.ceil((z - origin[2]) / h).astype(int), 0, nz)
    crossings = np.zeros((nx, ny, nz + 1), dtype=np.int32)
    np.add.at(crossings, (ix, iy, k), 1)
    return (np.cumsum(crossings, axis=2)[:, :, :nz] % 2) == 1


def closest_points(tri: np.ndarray, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Closest surface point and distance over the nearest SDF_CANDIDATES triangle centres.

    Candidate pruning (k nearest centres) is a broad phase; adjacent triangles of a mesh
    at this resolution (edges <= ~1.5 cm) make it exact in practice, and the result is
    validated against exact trimesh distances in the tests.
    """
    k = min(config.SDF_CANDIDATES, len(tri))
    _, ids = cKDTree(tri.mean(1)).query(points, k=k)
    ids = ids.reshape(len(points), k)
    closest = trimesh.triangles.closest_point(tri[ids.ravel()], np.repeat(points, k, 0))
    closest = closest.reshape(len(points), k, 3)
    distance = np.linalg.norm(closest - points[:, None], axis=2)
    best = distance.argmin(1)
    rows = np.arange(len(points))
    return closest[rows, best], distance[rows, best]


def surface_points(tri: np.ndarray, spacing: float) -> np.ndarray:
    """Deterministic barycentric lattice on every triangle, at most `spacing` apart."""
    longest = np.linalg.norm(tri - np.roll(tri, 1, axis=1), axis=2).max(1)
    steps = np.maximum(1, np.ceil(longest / spacing).astype(int))
    out = [tri.reshape(-1, 3)]
    for n in np.unique(steps):
        group = tri[steps == n]
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
        keep = i + j <= n
        u, v = i[keep] / n, j[keep] / n
        w = 1 - u - v
        out.append(
            (
                group[:, None, 0] * w[None, :, None]
                + group[:, None, 1] * u[None, :, None]
                + group[:, None, 2] * v[None, :, None]
            ).reshape(-1, 3)
        )
    return np.vstack(out)


def unsigned_distance(
    tri: np.ndarray, inside: np.ndarray, origin: np.ndarray, h: float
) -> np.ndarray:
    """Unsigned distance on the grid.

    Boundary voxels (inside/outside transitions) get their exact closest surface point.
    Every other grid point takes the distance to the closest surface point of its nearest
    boundary voxel (Euclidean distance transform feature map): an upper bound that is
    second-order accurate away from the surface. Points within SDF_EXACT_BAND_M get exact
    point-triangle distances.
    """
    dims = inside.shape
    boundary = inside & ~ndimage.binary_erosion(inside, border_value=1)
    boundary |= ~inside & ndimage.binary_dilation(inside)
    # Also seed the 8 grid nodes around dense triangle samples: a sheet thinner than a voxel
    # (small rigid cores) has no inside/outside transition next to it.
    cell = np.floor((surface_points(tri, h / 2) - origin) / h).astype(np.int64)
    for corner in np.ndindex(2, 2, 2):
        idx = np.clip(cell + corner, 0, np.array(dims) - 1)
        boundary[tuple(idx.T)] = True
    cells = np.argwhere(boundary)
    feature, _ = closest_points(tri, origin + cells * h)
    lookup = np.full(dims, -1, dtype=np.int64)
    lookup[tuple(cells.T)] = np.arange(len(cells))
    nearest = ndimage.distance_transform_edt(~boundary, return_distances=False, return_indices=True)
    owner = lookup[tuple(nearest)]
    grid = np.stack(np.meshgrid(*(np.arange(n) for n in dims), indexing="ij"), -1) * h + origin
    out = np.linalg.norm(grid - feature[owner], axis=-1)
    near = np.argwhere(out < config.SDF_EXACT_BAND_M)
    if config.SDF_EXACT_BAND_M > 0 and len(near):
        out[tuple(near.T)] = closest_points(tri, origin + near * h)[1]
    return out


def build_segment(
    rig: RestRig, name: str, bone: int, ids: np.ndarray, faces: np.ndarray
) -> SegmentField:
    h = config.SDF_SPACING_M
    local_from_rest = np.linalg.inv(rig.rest[bone])
    member = np.zeros(len(rig.vertices), bool)
    member[ids] = True
    # Only faces whose three vertices are near-rigid with this segment (its core); the
    # blend-zone faces between cores are handled exactly per frame (JointZone).
    patch = faces[member[faces].all(1)]
    used = np.unique(patch)
    remap = np.full(len(rig.vertices), -1)
    remap[used] = np.arange(len(used))
    local = rig.vertices[used] @ local_from_rest[:3, :3].T + local_from_rest[:3, 3]
    verts, tris = close_patch(local, remap[patch])
    tri = verts[tris]
    origin = verts.min(0) - config.SDF_PADDING_M
    dims = tuple(int(n) for n in np.ceil((verts.max(0) + config.SDF_PADDING_M - origin) / h) + 1)
    inside = parity_inside(tri, origin, dims, h)
    distance = unsigned_distance(tri, inside, origin, h)
    values = np.where(inside, -distance, distance).astype(np.float32)
    centre = 0.5 * (verts.min(0) + verts.max(0))
    radius = float(np.linalg.norm(verts - centre, axis=1).max())
    return SegmentField(name, bone, local_from_rest, origin, h, values, centre, radius, used)


@dataclass
class JointZone:
    """Blend-zone skin between the rigid cores, queried exactly on the skinned mesh."""

    faces: np.ndarray  # (Z, 3) rest vertex ids
    vertices: np.ndarray  # (U,) unique vertex ids used by `faces`
    local_faces: np.ndarray  # (Z, 3) indices into `vertices`
    boundary_edges: np.ndarray  # (E, 2) sorted local vertex pairs on the zone border


@dataclass
class BodyField:
    fields: list[SegmentField]
    zone: JointZone


def build_fields(rig: RestRig) -> BodyField:
    weights = segment_weights(rig)
    faces = outer_faces(rig)
    fields = []
    covered = np.zeros(len(faces), bool)
    # Shoulder-ridge transfer (ridge.py): above 90 degrees that skin leaves its segment's rigid
    # frame, so its faces belong to the exactly skinned joint zone, never to a rigid core.
    moving = np.zeros(len(rig.vertices), bool)
    if rig.ridge is not None:
        moving[rig.ridge.vertices] = True
    for s, (name, (ref, _)) in enumerate(config.SEGMENTS.items()):
        ids = np.flatnonzero((weights[:, s] >= config.SEGMENT_CORE_WEIGHT) & ~moving)
        member = np.zeros(len(rig.vertices), bool)
        member[ids] = True
        core = member[faces].all(1)
        if not core.any():
            continue  # smoothly blended segment (e.g. mid spine): entirely in the joint zone
        covered |= core
        fields.append(build_segment(rig, name, rig.bone(ref), ids, faces))
    zone_faces = faces[~covered]
    used, local = np.unique(zone_faces, return_inverse=True)
    local = local.reshape(-1, 3)
    edges = np.sort(local[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    return BodyField(fields, JointZone(zone_faces, used, local, unique[counts == 1]))


def zone_distance(
    rig: RestRig, zone: JointZone, skin: np.ndarray, points: np.ndarray
) -> np.ndarray:
    """Exact signed distance to the skinned blend-zone triangles (+inf where not decisive).

    Sign from the angle-weighted pseudo-normal of the closest feature. A closest point on
    the zone's open border is rejected (+inf): there the adjacent rigid core is decisive.
    """
    from ..surface_query import SurfaceQuery
    from .rig import lbs

    posed = lbs(rig, skin, zone.vertices)
    mesh = trimesh.Trimesh(posed, zone.local_faces, process=False)
    query = SurfaceQuery(mesh)
    closest, distance, face = query.exact_closest(points)
    tri = zone.local_faces[face]
    bary = trimesh.triangles.points_to_barycentric(mesh.triangles[face], closest)
    eps = config.ZONE_BARY_EPS
    border = np.zeros(len(points), bool)
    edge_keys = {tuple(e) for e in zone.boundary_edges.tolist()}
    border_vertex = np.zeros(len(posed), bool)
    border_vertex[zone.boundary_edges.ravel()] = True
    for corner in range(3):
        at_vertex = bary[:, corner] > 1 - eps
        border |= at_vertex & border_vertex[tri[:, corner]]
        a, b = tri[:, (corner + 1) % 3], tri[:, (corner + 2) % 3]
        on_edge = (bary[:, corner] < eps) & ~at_vertex
        if on_edge.any():
            pairs = np.sort(np.c_[a, b], axis=1)
            border |= on_edge & np.array([tuple(p) in edge_keys for p in pairs.tolist()])
    normals = query.pseudonormals(closest, face)
    sign = np.where(np.einsum("ij,ij->i", points - closest, normals) >= 0, 1.0, -1.0)
    return np.where(border, np.inf, sign * distance)


def body_distance(
    rig: RestRig, body: BodyField, world: np.ndarray, skin: np.ndarray, points: np.ndarray
) -> np.ndarray:
    """Reference runtime distance: min(rigid segment fields, exact blend-zone distance)."""
    rigid, _ = articulated_distance(body.fields, world, points)
    return np.minimum(rigid, zone_distance(rig, body.zone, skin, points))


def trilinear(field: SegmentField, local: np.ndarray) -> np.ndarray:
    """Sample with clamping; outside the box add the distance to the box (upper bound)."""
    dims = np.array(field.values.shape)
    g = (local - field.origin) / field.spacing
    clamped = np.clip(g, 0, dims - 1)
    outside = np.linalg.norm(g - clamped, axis=1) * field.spacing
    i0 = np.minimum(np.floor(clamped).astype(int), dims - 2)
    f = clamped - i0
    v = field.values
    out = np.zeros(len(local))
    for dx in (0, 1):
        wx = f[:, 0] if dx else 1 - f[:, 0]
        for dy in (0, 1):
            wy = f[:, 1] if dy else 1 - f[:, 1]
            for dz in (0, 1):
                wz = f[:, 2] if dz else 1 - f[:, 2]
                out += wx * wy * wz * v[i0[:, 0] + dx, i0[:, 1] + dy, i0[:, 2] + dz]
    return out + outside


def articulated_distance(
    fields: list[SegmentField], world: np.ndarray, points: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Signed distance of world points to the posed body; returns (distance, segment id).

    `world` = posed bone world poses (B, 4, 4); segment s samples at inv(world[bone]) @ p.
    Bounding-sphere culling: a segment whose sphere lower bound |p - c| - r already
    exceeds the current best distance is skipped for that point.
    """
    best = np.full(len(points), np.inf)
    which = np.full(len(points), -1)
    order = []
    for s, field in enumerate(fields):
        inverse = np.linalg.inv(world[field.bone])
        local = points @ inverse[:3, :3].T + inverse[:3, 3]
        lower = np.linalg.norm(local - field.centre, axis=1) - field.radius
        # Inside the sphere the bound says nothing about negative (interior) distances.
        lower = np.where(lower > 0, lower, -np.inf)
        order.append((s, local, lower))
    order.sort(key=lambda item: float(np.median(item[2])))
    for s, local, lower in order:
        todo = np.flatnonzero(lower < best)
        if not len(todo):
            continue
        d = trilinear(fields[s], local[todo])
        better = d < best[todo]
        best[todo[better]] = d[better]
        which[todo[better]] = s
    return best, which
