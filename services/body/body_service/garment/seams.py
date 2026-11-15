"""Shared cloth seams and local-frame accessory attachments, without long welds."""

from dataclasses import replace
from typing import TYPE_CHECKING

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from .. import config

if TYPE_CHECKING:
    from .pattern import Pattern


def triangle_frame(points: np.ndarray) -> np.ndarray:
    x = points[1] - points[0]
    x /= np.linalg.norm(x)
    z = np.cross(x, points[2] - points[0])
    z /= np.linalg.norm(z)
    return np.c_[x, np.cross(z, x), z]


def connect_cloth(pattern: "Pattern") -> "Pattern":
    vertices = pattern.mesh.vertices
    parents = np.arange(len(vertices))

    def root(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = int(parents[index])
        return index

    hardware_parent = {}
    for child, parent in pattern.welds:
        if pattern.panels[child] in (6, 7):
            if np.linalg.norm(vertices[child] - vertices[parent]) > config.SECTION_EPS:
                raise ValueError("Cloth seams must coincide before they are shared")
            parents[root(int(child))] = root(int(parent))
        else:
            hardware_parent[int(child)] = int(parent)
    representatives = np.array([root(i) for i in range(len(vertices))])
    used, reverse = np.unique(representatives, return_inverse=True)
    new_vertices = vertices[used]
    new_panels = pattern.panels[used]
    faces = reverse[pattern.mesh.faces]
    physical = (new_panels <= 7) | (new_panels == 13)
    cloth_faces = faces[physical[faces].all(1)]
    cloth = trimesh.Trimesh(new_vertices, cloth_faces, process=False)
    accessories = np.flatnonzero(~physical)
    anchored = np.array(sorted(hardware_parent))
    attachments, offsets = [], []
    face_cache = {}
    for vertex in accessories:
        old = int(used[vertex])
        if old not in hardware_parent:
            candidates = anchored[pattern.panels[anchored] == pattern.panels[old]]
            if not len(candidates):
                raise ValueError("Accessory has no sewn frame anchor")
            nearest = int(cKDTree(vertices[candidates]).query(vertices[old])[1])
            old = int(candidates[nearest])
        parent = int(reverse[hardware_parent[old]])
        if parent not in face_cache:
            valid = [f for f in cloth.vertex_faces[parent] if f >= 0]
            face_id = max(valid, key=lambda f: cloth.area_faces[f])
            triangle = cloth.faces[face_id].copy()
            triangle = np.roll(triangle, -int(np.flatnonzero(triangle == parent)[0]))
            face_cache[parent] = (triangle, triangle_frame(new_vertices[triangle]))
        triangle, frame = face_cache[parent]
        attachments.append([vertex, *triangle])
        offsets.append((new_vertices[vertex] - new_vertices[parent]) @ frame)

    def grid_map(grid: np.ndarray) -> np.ndarray:
        return np.where(grid >= 0, reverse[np.maximum(grid, 0)], -1)

    mesh = trimesh.Trimesh(new_vertices, faces, process=False)
    trimesh.repair.fix_winding(mesh)
    return replace(
        pattern,
        mesh=mesh,
        panels=new_panels,
        elastic=pattern.elastic[used],
        stitch=pattern.stitch[used],
        loft=pattern.loft[used],
        render_offsets=pattern.render_offsets[used],
        welds=np.empty((0, 2), dtype=int),
        tapes={key: reverse[path].tolist() for key, path in pattern.tapes.items()},
        landmarks={key: int(reverse[index]) for key, index in pattern.landmarks.items()},
        torso_grid=grid_map(pattern.torso_grid),
        sleeve_grids={key: grid_map(grid) for key, grid in pattern.sleeve_grids.items()},
        attachments=np.array(attachments, dtype=int),
        attachment_offsets=np.array(offsets),
    )


def attach_accessories(pattern: "Pattern", positions: np.ndarray) -> np.ndarray:
    result = positions.copy()
    for attachment, offset in zip(pattern.attachments, pattern.attachment_offsets, strict=True):
        child, a, b, c = attachment
        frame = triangle_frame(result[[a, b, c]])
        result[child] = result[a] + frame @ offset
    return result
