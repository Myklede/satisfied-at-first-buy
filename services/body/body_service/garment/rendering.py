"""Material coordinates and a transportable, product-derived outer reference."""

from dataclasses import dataclass

import numpy as np

from .. import config
from .models import GarmentSpec
from .pattern import Pattern


@dataclass
class FabricRenderData:
    uv: np.ndarray
    quilt: np.ndarray
    stitch_distance: np.ndarray
    frames: np.ndarray
    puff_components: np.ndarray
    triangles: np.ndarray


def surface_normals(positions: np.ndarray, faces: np.ndarray) -> np.ndarray:
    normal = np.zeros_like(positions)
    triangle = positions[faces]
    area = np.cross(triangle[:, 1] - triangle[:, 0], triangle[:, 2] - triangle[:, 0])
    for corner in range(3):
        np.add.at(normal, faces[:, corner], area)
    length = np.linalg.norm(normal, axis=1)
    normal /= np.maximum(length[:, None], config.SECTION_EPS)
    return normal


def surface_frames(positions: np.ndarray, frames: np.ndarray, faces: np.ndarray) -> np.ndarray:
    z = surface_normals(positions, faces)[frames[:, 0]]
    x = positions[frames[:, 1]] - positions[frames[:, 0]]
    x -= z * np.einsum("ij,ij->i", x, z)[:, None]
    x /= np.linalg.norm(x, axis=1)[:, None]
    return np.stack((x, np.cross(z, x), z), axis=2)


def fabric_render_data(pattern: Pattern, product: GarmentSpec) -> FabricRenderData:
    """UV units are metres; the reference puff never enters the physics positions."""
    visual = product.visual
    if visual is None:
        raise ValueError("Quilting requires the sourced visual specification")
    mesh = pattern.mesh
    count = len(mesh.vertices)
    uv = np.zeros((count, 2))
    quilt = np.zeros((count, 4))  # width, height, yoke depth, kind (0/plain,1/horizontal,2/box)
    rows, columns = pattern.torso_grid.shape
    angles = np.arange(columns) * 2 * np.pi / columns
    reference = pattern.torso_reference
    measurements = pattern.measurements()
    for row, ids in enumerate(pattern.torso_grid):
        valid = ids >= 0
        depth = -reference[row, :, 1]
        t = max(0.0, (row - config.CLOTH_CHEST_ROW) / (rows - 1 - config.CLOTH_CHEST_ROW))
        circumference = (measurements["chest"] * (1 - t) + measurements["hem"] * t) / 100
        arc = np.abs(np.arctan2(np.cos(angles), np.sin(angles))) * circumference / (2 * np.pi)
        uv[ids[valid]] = np.c_[arc, depth][valid]
        if row > config.CLOTH_SHOULDER_ROW and row < rows - 2:
            quilt[ids[valid]] = [
                visual.chamber_width.value_cm / 100 if visual.chamber_width else 0,
                visual.chamber_height.value_cm / 100,
                visual.yoke_depth.value_cm / 100,
                2 if visual.quilting.value == "box" else 1,
            ]
    for side, sign in (("L", 1), ("R", -1)):
        grid = pattern.sleeve_grids[side]
        seam = pattern.landmarks[f"seam_{side}"]
        length = (mesh.vertices[grid[-1], 0].mean() - mesh.vertices[seam, 0]) * sign
        cell = visual.sleeve_chamber_height.value_cm / 100
        for row, ids in enumerate(grid):
            uv[ids, 0] = np.arange(len(ids)) / len(ids) * measurements["bicep"] / 100
            uv[ids, 1] = length * ((row + 1 - config.CLOTH_BICEP_ROW) / len(grid)) + cell / 2
            if row < len(grid) - 2:
                quilt[ids] = [0, cell, 0, 1]
    hood = pattern.panels == 7
    uv[hood] = np.c_[
        mesh.vertices[hood, 0], config.GARMENT_COLLAR_HEIGHT_M - mesh.vertices[hood, 1]
    ]
    quilt[hood] = [0, config.CLOTH_HOOD_CHAMBER_M, 0, 1]

    def distance_to_stitch(coordinate, period):
        phase = np.mod(coordinate, np.maximum(period, config.SECTION_EPS))
        return np.minimum(phase, period - phase)

    distance = distance_to_stitch(uv[:, 1] - quilt[:, 2], quilt[:, 1])
    box = quilt[:, 3] == 2
    distance[box] = np.minimum(distance[box], distance_to_stitch(uv[box, 0], quilt[box, 0]))
    distance[(quilt[:, 3] == 0) | (uv[:, 1] < quilt[:, 2])] = 0

    incident = mesh.vertex_faces
    areas = np.where(incident >= 0, mesh.area_faces[np.maximum(0, incident)], -1)
    chosen = incident[np.arange(count), areas.argmax(1)]
    triangles = mesh.faces[chosen]
    pivot = (triangles == np.arange(count)[:, None]).argmax(1)
    frames = np.take_along_axis(triangles, (np.arange(3)[None, :] + pivot[:, None]) % 3, axis=1)
    frames[pattern.attachments[:, 0]] = pattern.attachments[:, 1:]
    axes = surface_frames(mesh.vertices, frames, mesh.faces)
    components = np.einsum("ni,nij->nj", pattern.render_offsets, axes)
    return FabricRenderData(uv, quilt, distance, frames, components, mesh.faces)


def transported_puff(data: FabricRenderData, positions: np.ndarray) -> np.ndarray:
    axes = surface_frames(positions, data.frames, data.triangles)
    return np.einsum("nij,nj->ni", axes, data.puff_components)
