"""Deterministic fixed-topology tube/yoke shell. Not a cloth physics simulation."""

from dataclasses import dataclass
from time import perf_counter

import numpy as np
import trimesh

from .. import config
from ..fit import FittedBody
from ..measure import polyline_length, section_loops
from .fit_math import exact, geometry_missing, walk, wrapped_section
from .models import GarmentSpec, SizeFit
from .surface_query import SurfaceQuery


@dataclass
class BuiltGarment:
    mesh: trimesh.Trimesh
    glb: bytes
    build_ms: float
    min_gap_cm: float
    inflated: bool


def radial_resample(
    points: np.ndarray, centre: np.ndarray, u: np.ndarray, v: np.ndarray, angles: np.ndarray
) -> np.ndarray:
    """Intersect convex section polygon with rays at fixed angles, preserving ring order."""
    uv = np.stack(((points - centre) @ u, (points - centre) @ v), axis=1)
    from scipy.spatial import ConvexHull

    uv = uv[ConvexHull(uv).vertices]
    a, b = uv, np.roll(uv, -1, axis=0)
    edge = b - a
    direction = np.stack((np.cos(angles), np.sin(angles)), axis=1)
    cross = direction[:, 0, None] * edge[None, :, 1] - direction[:, 1, None] * edge[None, :, 0]
    denom = np.where(abs(cross) < 1e-12, np.nan, cross)
    distance = (a[:, 0] * edge[:, 1] - a[:, 1] * edge[:, 0])[None, :] / denom
    fraction = (
        a[None, :, 0] * direction[:, None, 1] - a[None, :, 1] * direction[:, None, 0]
    ) / denom
    distance[(fraction < -1e-7) | (fraction > 1 + 1e-7) | (distance < 0)] = np.nan
    radii = np.nanmax(distance, axis=1)
    if not np.isfinite(radii).all():
        raise ValueError("Section centre must lie inside convex support")
    return centre + radii[:, None] * (np.cos(angles)[:, None] * u + np.sin(angles)[:, None] * v)


def expanded_ring(
    points: np.ndarray,
    centre: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    angles: np.ndarray,
    target_cm: float,
    minimum_m: float,
) -> tuple[np.ndarray, bool]:
    ring = radial_resample(points, centre, u, v, angles)
    perimeter = polyline_length(np.vstack((ring, ring[0])))
    offset = (target_cm / 100 - perimeter) / (2 * np.pi)
    inflated = offset < minimum_m
    offset = max(offset, minimum_m)
    direction = ring - centre
    direction /= np.linalg.norm(direction, axis=1)[:, None]
    return ring + direction * offset, inflated


def clearance_samples(
    mesh: trimesh.Trimesh, body: trimesh.Trimesh
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vertex/edge-midpoint/face-centroid samples for reproducible collision regression."""
    edges = mesh.edges_unique
    points = np.vstack((mesh.vertices, mesh.vertices[edges].mean(1), mesh.triangles_center))
    closest, distance, triangles = SurfaceQuery(body).exact_closest(points)
    normals = body.face_normals[triangles]
    signed = np.einsum("ij,ij->i", points - closest, normals)
    return points, signed, distance


def push_out(
    vertices: np.ndarray, faces: np.ndarray, body: trimesh.Trimesh, clearance: float
) -> np.ndarray:
    result = vertices.copy()
    query = SurfaceQuery(body)
    edges = trimesh.Trimesh(vertices, faces, process=False).edges_unique
    for _ in range(config.GARMENT_COLLISION_PASSES):
        points = np.vstack((result, result[edges].mean(1), result[faces].mean(1)))
        closest, distance, triangle = query.closest(points)
        normal = body.face_normals[triangle]
        signed = np.einsum("ij,ij->i", points - closest, normal)
        bad = (signed < 0) | (distance < clearance)
        if not bad.any():
            break
        correction = np.zeros_like(points)
        correction[bad] = closest[bad] + normal[bad] * clearance - points[bad]
        changes = np.zeros_like(result)
        counts = np.zeros(len(result))
        nv, ne = len(result), len(edges)
        changes += correction[:nv]
        counts += bad[:nv]
        for corner in range(2):
            np.add.at(changes, edges[:, corner], correction[nv : nv + ne])
            np.add.at(counts, edges[:, corner], bad[nv : nv + ne])
        for corner in range(3):
            np.add.at(changes, faces[:, corner], correction[nv + ne :])
            np.add.at(counts, faces[:, corner], bad[nv + ne :])
        moved = counts > 0
        result[moved] += changes[moved] / counts[moved, None] * config.GARMENT_COLLISION_GAIN
    return result


def build_garment(
    body: FittedBody,
    product: GarmentSpec,
    size_name: str,
    metrics: SizeFit,
    routes: dict[str, np.ndarray],
    layer_cm: float,
) -> BuiltGarment:
    started = perf_counter()
    size = product.sizes[size_name]
    missing = geometry_missing(product, size)
    if missing:
        raise ValueError("Cannot build garment: missing " + ", ".join(missing))
    n = config.GARMENT_ANGULAR_SAMPLES
    rows = config.GARMENT_TORSO_ROWS
    angles = np.linspace(0, 2 * np.pi, n, endpoint=False)
    g = body.geometry
    loft = product.loft_cm / 100
    minimum = (product.loft_cm + layer_cm) / 100 + config.GARMENT_SURFACE_MARGIN_M
    chest = exact(size.chest)
    hem = exact(size.hem)
    bicep = exact(size.bicep)
    shoulder = (
        exact(size.shoulder)
        if product.construction != "raglan"
        else g.measurements["shoulder_arc"].value_cm
    )
    end_y = metrics.anchors["hem_back"][1]
    seam = {
        side: np.array(metrics.anchors.get(f"seam_{side}", metrics.anchors[f"acromion_{side}"]))
        for side in ("L", "R")
    }
    chest_y = min(
        g.tapes["chest"].points[:, 1].mean() - config.GARMENT_CHEST_DROP_M,
        min(p[1] for p in seam.values())
        - bicep / (100 * np.pi) * config.GARMENT_ARMHOLE_RADIUS_FACTOR,
    )
    if chest_y <= end_y:
        raise ValueError("Garment length ends above armhole; this topology cannot represent it")
    vertices = []
    details = []
    inflated = False
    neck = (g.landmarks["C7"] + g.landmarks["jugular_notch"]) / 2
    neck_radius = g.measurements["neck_base"].value_cm / (200 * np.pi) + minimum
    for r in range(rows):
        if r == 0:
            ring = np.c_[
                np.cos(angles) * neck_radius,
                np.full(n, neck[1]),
                neck[2] + np.sin(angles) * neck_radius,
            ]
            ring[:, 1] += (
                (g.landmarks["jugular_notch"][1] - g.landmarks["C7"][1]) * np.sin(angles) / 2
            )
        elif r == 1:
            body_chest = g.tapes["chest"].points
            front, back = body_chest[:, 2].max() + minimum, body_chest[:, 2].min() - minimum
            depth = np.where(np.sin(angles) >= 0, front - neck[2], neck[2] - back)
            x = np.where(
                np.cos(angles) >= 0, abs(seam["L"][0]) + loft, abs(seam["R"][0]) + loft
            ) * np.cos(angles)
            side_y = np.where(np.cos(angles) >= 0, seam["L"][1], seam["R"][1]) + loft
            y = (
                side_y * np.cos(angles) ** 2
                + (neck[1] - config.GARMENT_YOKE_NECK_DROP_M) * np.sin(angles) ** 2
            )
            ring = np.c_[x, y, neck[2] + depth * np.sin(angles)]
        else:
            t = (r - 2) / (rows - 3)
            y = chest_y * (1 - t) + end_y * t
            points = wrapped_section(body, float(y))
            centre = np.array([0.0, y, (points[:, 2].min() + points[:, 2].max()) / 2])
            ring, clamped = expanded_ring(
                points,
                centre,
                np.array([1.0, 0.0, 0.0]),
                np.array([0.0, 0.0, 1.0]),
                angles,
                chest * (1 - t) + hem * t,
                minimum,
            )
            inflated |= clamped
            radial = ring - centre
            radial /= np.maximum(np.linalg.norm(radial, axis=1)[:, None], 1e-12)
            amplitude = config.GARMENT_FOLD_AMPLITUDE_M * max(
                0.0, (chest - g.measurements["chest"].value_cm) / 10
            )
            ring += radial * (amplitude * np.sin(4 * angles) * np.sin(np.pi * t))[:, None]
        vertices.extend(ring)
        details.extend([0.35 if r >= rows - 2 else 0.0] * n)
    faces = []
    span = config.GARMENT_ARMHOLE_HALF_SPAN
    cut_segments = set()
    for centre in (0, n // 2):
        cut_segments.update((centre + j) % n for j in range(-span, span))
    for r in range(rows - 1):
        for i in range(n):
            if r == 1 and i in cut_segments:
                continue
            a, b = r * n + i, r * n + (i + 1) % n
            c, d = (r + 1) * n + (i + 1) % n, (r + 1) * n + i
            faces.extend(((a, b, c), (a, c, d)))
    # Collar band shares the neckline ring; open neck, hem and cuff boundaries are deliberate.
    collar_start = len(vertices)
    collar = np.array(vertices[:n]) + np.array([0.0, config.GARMENT_COLLAR_HEIGHT_M, 0.0])
    vertices.extend(collar)
    details.extend([0.2] * n)
    for i in range(n):
        a, b = collar_start + i, collar_start + (i + 1) % n
        c, d = (i + 1) % n, i
        faces.extend(((a, b, c), (a, c, d)))
    for side, centre_index in (("L", 0), ("R", n // 2)):
        ids = [(centre_index + j) % n for j in range(-span, span + 1)]
        previous = [n + i for i in ids] + [2 * n + i for i in ids[::-1]]
        count = len(previous)
        boundary = np.array(vertices)[previous]
        centre = boundary.mean(0)
        route = routes[side]
        start_distance = shoulder / 200
        cuff_distance = (
            exact(size.sleeve_cb) / 100
            if product.construction == "raglan"
            else start_distance + exact(size.sleeve) / 100
        )
        tangent = walk(route, start_distance + 2 * config.GARMENT_TANGENT_STEP_M) - walk(
            route, start_distance
        )
        tangent /= np.linalg.norm(tangent)
        winding = np.sum(
            np.cross(boundary - centre, np.roll(boundary, -1, axis=0) - centre), axis=0
        )
        if winding @ tangent < 0:
            previous = previous[::-1]
            boundary = boundary[::-1]
        u = boundary[0] - centre
        u -= tangent * (u @ tangent)
        u /= np.linalg.norm(u)
        sleeve_angles = np.linspace(0, 2 * np.pi, count, endpoint=False)
        body_wrist = g.measurements["wrist"].value_cm
        bicep_body = g.measurements["upper_arm"].value_cm
        cuff_target = (
            body_wrist
            + 2 * np.pi * (product.loft_cm + layer_cm)
            + max(config.MIN_CUFF_EASE_CM, (bicep - bicep_body) * config.CUFF_EASE_FRACTION)
        )
        for r in range(1, config.GARMENT_SLEEVE_ROWS):
            t = r / (config.GARMENT_SLEEVE_ROWS - 1)
            distance = start_distance + (cuff_distance - start_distance) * t
            position = walk(route, distance)
            tangent = walk(route, distance + config.GARMENT_TANGENT_STEP_M) - walk(
                route, distance - config.GARMENT_TANGENT_STEP_M
            )
            tangent /= np.linalg.norm(tangent)
            u -= tangent * (u @ tangent)
            u /= np.linalg.norm(u)
            v = np.cross(tangent, u)
            try:
                loops = section_loops(body.mesh.vertices, body.mesh.faces, position, tangent)
                loop = min(loops, key=lambda x: np.linalg.norm(x.points.mean(0) - position))
                support = loop.points
                if np.linalg.norm(support.mean(0) - position) > config.GARMENT_CUFF_SUPPORT_MAX_M:
                    raise ValueError("Beyond supported limb section")
                centre = support.mean(0)
                centre -= tangent * ((centre - position) @ tangent)
            except ValueError:
                # Past the body: continue a body-derived wrist opening;
                # this is not a measured garment cuff girth.
                centre = position
                radius = body_wrist / (200 * np.pi)
                support = centre + radius * (
                    np.cos(sleeve_angles)[:, None] * u + np.sin(sleeve_angles)[:, None] * v
                )
            ring, clamped = expanded_ring(
                support, centre, u, v, sleeve_angles, bicep * (1 - t) + cuff_target * t, minimum
            )
            inflated |= clamped
            current = list(range(len(vertices), len(vertices) + count))
            vertices.extend(ring)
            details.extend([0.35 if r >= config.GARMENT_SLEEVE_ROWS - 2 else 0.0] * count)
            for j in range(count):
                a, b = previous[j], previous[(j + 1) % count]
                c, d = current[(j + 1) % count], current[j]
                faces.extend(((a, b, c), (a, c, d)))
            previous = current
    sleeve_end = len(vertices)
    # Thin centre-front zip strip; same vertices/order for every size.
    front = n // 4
    zipper = []
    for r in range(rows):
        point = np.array(vertices[r * n + front]) + np.array(
            [0.0, 0.0, config.GARMENT_SURFACE_MARGIN_M]
        )
        pair = [
            point + np.array([-config.GARMENT_ZIP_HALF_WIDTH_M, 0.0, 0.0]),
            point + np.array([config.GARMENT_ZIP_HALF_WIDTH_M, 0.0, 0.0]),
        ]
        zipper.append([len(vertices), len(vertices) + 1])
        vertices.extend(pair)
        details.extend([1.0, 1.0])
    for a, b in zip(zipper[:-1], zipper[1:], strict=True):
        faces.extend(((a[0], a[1], b[1]), (a[0], b[1], b[0])))
    vertices = np.asarray(vertices)
    faces = np.asarray(faces, dtype=np.int64)
    edges = trimesh.Trimesh(vertices, faces, process=False).edges_unique
    sums = np.zeros_like(vertices)
    counts = np.zeros(len(vertices))
    np.add.at(sums, edges[:, 0], vertices[edges[:, 1]])
    np.add.at(sums, edges[:, 1], vertices[edges[:, 0]])
    np.add.at(counts, edges.reshape(-1), 1)
    smooth = np.asarray(details) < 0.2
    vertices[smooth] += (
        sums[smooth] / counts[smooth, None] - vertices[smooth]
    ) * config.GARMENT_SMOOTHING_WEIGHT
    vertices = push_out(vertices, faces, body.mesh, minimum)
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    _, signed, distances = clearance_samples(mesh, body.mesh)
    if signed.min() < -config.GARMENT_SURFACE_MARGIN_M:
        raise ValueError(
            f"Collision correction failed: minimum sampled signed gap {signed.min() * 100:.3f} cm"
        )
    # clearance_samples starts with all vertices; reuse its exact distances.
    gaps = distances[: len(vertices)]
    mesh.vertex_attributes["gap_cm"] = (gaps * 100).astype(np.float32)
    mesh.vertex_attributes["inner_gap_cm"] = (gaps * 100 - product.loft_cm - layer_cm).astype(
        np.float32
    )
    mesh.vertex_attributes["detail"] = np.asarray(details, dtype=np.float32)
    elastic = np.zeros(len(vertices), dtype=np.float32)
    if product.hem_elastic:
        elastic[(rows - 2) * n : rows * n] = 1
    if product.style in config.ADJUSTABLE_CUFF_STYLES:
        sleeve_ids = np.arange(rows * n + n, sleeve_end)
        elastic[sleeve_ids[np.asarray(details)[sleeve_ids] == 0.35]] = 1
    mesh.vertex_attributes["elastic_gather"] = elastic
    colour = (
        np.array([231, 230, 223, 255])
        if "White" in product.colourway
        else np.array([177, 155, 116, 255])
    )
    colors = np.tile(colour, (len(vertices), 1))
    colors[:, :3] = (colors[:, :3] * (1 - np.asarray(details)[:, None] * 0.75)).astype(np.uint8)
    mesh.visual.vertex_colors = colors.astype(np.uint8)
    glb = mesh.export(file_type="glb", include_normals=True)
    return BuiltGarment(
        mesh, glb, (perf_counter() - started) * 1000, float(gaps.min() * 100), inflated
    )
