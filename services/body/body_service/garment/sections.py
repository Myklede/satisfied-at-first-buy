"""Ordered, concavity-preserving cloth cross-sections (never a convex-hull test)."""

import numpy as np

from .. import config


def surface_loops(
    vertices: np.ndarray, faces: np.ndarray, origin: np.ndarray, normal: np.ndarray
) -> list[np.ndarray]:
    distance = (vertices - origin) @ (normal / np.linalg.norm(normal))
    distance[abs(distance) < config.PLANE_VERTEX_EPS] = config.PLANE_VERTEX_EPS
    tri_distance = distance[faces]
    triangles = faces[(tri_distance.min(1) < 0) & (tri_distance.max(1) > 0)]
    edges = triangles[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2)
    edges = np.sort(edges[(distance[edges[:, 0]] < 0) != (distance[edges[:, 1]] < 0)], axis=1)
    if not len(edges):
        return []
    unique, inverse = np.unique(edges, axis=0, return_inverse=True)
    fraction = distance[unique[:, 0]] / (distance[unique[:, 0]] - distance[unique[:, 1]])
    points = (
        vertices[unique[:, 0]] * (1 - fraction[:, None])
        + vertices[unique[:, 1]] * fraction[:, None]
    )
    neighbours: dict[int, set[int]] = {}
    for a, b in inverse.reshape(-1, 2):
        neighbours.setdefault(int(a), set()).add(int(b))
        neighbours.setdefault(int(b), set()).add(int(a))
    remaining = set(neighbours)
    loops = []
    while remaining:
        start = min(remaining)
        stack = [start]
        component = set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            stack.extend(neighbours[current] - component)
        remaining -= component
        if len(component) < 3 or any(len(neighbours[i]) != 2 for i in component):
            continue
        order = [start]
        previous = -1
        current = start
        while True:
            nxt = min(neighbours[current] - {previous})
            if nxt == start:
                break
            order.append(nxt)
            previous, current = current, nxt
        loops.append(points[order])
    return loops


def polygon_contains(points: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    a, b = polygon, np.roll(polygon, -1, axis=0)
    edge = b - a
    delta = points[:, None, :] - a[None, :, :]
    denominator = np.einsum("ij,ij->i", edge, edge)
    fraction = np.clip(
        np.einsum("nij,ij->ni", delta, edge) / np.maximum(denominator, config.PLANE_VERTEX_EPS),
        0,
        1,
    )
    distance = np.linalg.norm(delta - fraction[:, :, None] * edge, axis=2).min(1)
    dy = edge[:, 1]
    crossing = (a[None, :, 1] > points[:, None, 1]) != (b[None, :, 1] > points[:, None, 1])
    x = a[None, :, 0] + np.divide(
        (points[:, None, 1] - a[None, :, 1]) * edge[None, :, 0],
        dy[None, :],
        out=np.zeros_like(crossing, dtype=float),
        where=abs(dy[None, :]) > config.PLANE_VERTEX_EPS,
    )
    inside = ((crossing & (points[:, None, 0] < x)).sum(1) % 2).astype(bool)
    return inside | (distance <= config.CLOTH_QUALITY_ENDPOINT_EPS_M)
