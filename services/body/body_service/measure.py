"""Exact mesh measurements in metres; API conversion happens once in measure_body."""

from dataclasses import dataclass

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

from . import config


@dataclass
class Tape:
    points: np.ndarray
    # Each point lies on edge (a,b) at t; reusable differentiable section proxy.
    edges: np.ndarray
    fractions: np.ndarray

    @property
    def perimeter(self) -> float:
        return float(np.linalg.norm(self.points - np.roll(self.points, 1, axis=0), axis=1).sum())


def stature(vertices: np.ndarray) -> float:
    return float(np.ptp(vertices[:, 1]))


def signed_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """Only closed, consistently wound meshes define a reliable signed volume."""
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    if not mesh.is_watertight or not mesh.is_winding_consistent:
        raise ValueError("Volume requires a watertight, consistently wound mesh")
    a, b, c = vertices[faces].transpose(1, 0, 2)
    return float(abs(np.einsum("ij,ij->i", np.cross(a, b), c).sum() / 6))


def hull_perimeter(points_2d: np.ndarray) -> float:
    hull = points_2d[ConvexHull(points_2d).vertices]
    return float(np.linalg.norm(hull - np.roll(hull, 1, axis=0), axis=1).sum())


def section_loops(
    vertices: np.ndarray, faces: np.ndarray, origin: np.ndarray, normal: np.ndarray
) -> list[Tape]:
    """Intersect triangles, weld endpoints, isolate connected loops before hulling."""
    normal = normal / np.linalg.norm(normal)
    work = vertices.astype(np.float64)
    distances = (work - origin.astype(np.float64)) @ normal
    distances[abs(distances) < config.PLANE_VERTEX_EPS] = config.PLANE_VERTEX_EPS
    triangle_distances = distances[faces]
    crossing = (triangle_distances.min(axis=1) < 0) & (triangle_distances.max(axis=1) > 0)
    triangles = faces[crossing]
    edges = triangles[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2)
    d = distances[edges]
    edges = edges[(d[:, 0] < 0) != (d[:, 1] < 0)]
    edges = np.sort(edges, axis=1)  # identical arithmetic for both faces sharing an edge
    if not len(edges):
        raise ValueError("Section does not intersect this mesh")
    d = distances[edges]
    t = d[:, 0] / (d[:, 0] - d[:, 1])
    points = work[edges[:, 0]] * (1 - t[:, None]) + work[edges[:, 1]] * t[:, None]
    # Every crossing triangle contributes two points. Endpoints shared by faces connect loops.
    keys = edges  # shared topological edge, robust even when a section passes through a vertex
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    adjacency: dict[int, set[int]] = {}
    for a, b in inverse.reshape(-1, 2):
        adjacency.setdefault(int(a), set()).add(int(b))
        adjacency.setdefault(int(b), set()).add(int(a))
    remaining = set(adjacency)
    loops = []
    # Projection basis for arbitrary limb-perpendicular planes.
    axis = np.eye(3)[np.argmin(abs(normal))]
    u = np.cross(normal, axis)
    u /= np.linalg.norm(u)
    basis = np.stack((u, np.cross(normal, u)), axis=1)
    while remaining:
        stack = [min(remaining)]
        component: set[int] = set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            stack.extend(adjacency[current] - component)
        remaining -= component
        if len(component) < 3 or any(len(adjacency[i]) != 2 for i in component):
            continue  # An open section is never silently treated as a tape loop.
        ids = first[sorted(component)]
        hull = ConvexHull((points[ids] - origin) @ basis).vertices
        ids = ids[hull]
        loops.append(Tape(points[ids], edges[ids], t[ids]))
    if not loops:
        raise ValueError("No closed connected section loop")
    return loops


def section(
    vertices: np.ndarray,
    faces: np.ndarray,
    origin: np.ndarray,
    normal: np.ndarray,
    anchor: np.ndarray,
) -> Tape:
    loops = section_loops(vertices, faces, origin, normal)
    return min(loops, key=lambda loop: float(np.linalg.norm(loop.points.mean(axis=0) - anchor)))


def torso_tape(vertices: np.ndarray, faces: np.ndarray, level: float) -> Tape:
    origin = np.array([0.0, level, 0.0])
    return section(vertices, faces, origin, np.array([0.0, 1.0, 0.0]), origin)


def search_tape(
    vertices: np.ndarray,
    faces: np.ndarray,
    window: tuple[float, float],
    maximum: bool,
    separate_arms: bool = False,
) -> Tape:
    floor = vertices[:, 1].min()
    h = stature(vertices)
    tapes = []
    face_y = vertices[:, 1].astype(np.float64)[faces]
    low_y, high_y = face_y.min(axis=1), face_y.max(axis=1)
    for fraction in np.linspace(*window, config.SECTION_SAMPLES):
        origin = np.array([0.0, floor + h * fraction, 0.0])
        # Conservative vertical bounds prune full-mesh triangle scans; the exact
        # section routine still applies its original symbolic-vertex convention.
        candidates = (low_y <= origin[1] + config.PLANE_VERTEX_EPS) & (
            high_y >= origin[1] - config.PLANE_VERTEX_EPS
        )
        loops = section_loops(vertices, faces[candidates], origin, np.array([0.0, 1.0, 0.0]))
        if separate_arms and len(loops) < 3:
            continue  # Above axilla, a connected contour includes arms and is not chest girth.
        tapes.append(min(loops, key=lambda tape: abs(tape.points[:, 0].mean())))
    if not tapes:
        raise ValueError("No isolated torso section in anatomical search window")
    return (max if maximum else min)(tapes, key=lambda tape: tape.perimeter)


def polyline_length(points: np.ndarray) -> float:
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
