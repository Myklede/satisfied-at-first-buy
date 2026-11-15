"""Neck-only tape sections; never borrow jaw/head vertices to close a contour.

The Anny neck bone group supplies a fixed semantic region, not a neck-size prior.
The requested collar heights are capped at the highest closed neck-only section.
The cap is reported explicitly; it is not a measurement at the requested height.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import ConvexHull

from . import collar_config as c
from .measure import Tape, section_loops

if TYPE_CHECKING:
    from .fit import FittedBody
    from .model import BodyEngine


@dataclass(frozen=True)
class NeckGirth:
    girth_cm: float
    requested_height_cm: float
    actual_height_cm: float
    band_requested_cm: tuple[float, float]
    band_girth_cm: tuple[float, float]
    band_actual_height_cm: tuple[float, float]
    capped: bool
    points: np.ndarray


def neck_vertex_mask(indices: np.ndarray, weights: np.ndarray, labels: list[str]) -> np.ndarray:
    """The combined neck group must dominate every non-neck bone influence.

    Combining the three neck bones avoids artificially excluding a vertex whose
    neck influence is split between adjacent neck bones. Head/chin/jaw weights
    are never added to this region.
    """
    if indices.shape != weights.shape or indices.ndim != 2 or not np.isfinite(weights).all():
        raise ValueError("Invalid packed skinning weights")
    neck_ids = [i for i, name in enumerate(labels) if name in c.NECK_BONE_LABELS]
    if len(neck_ids) != len(c.NECK_BONE_LABELS):
        raise ValueError("Anny neck-bone labels are unavailable")
    in_neck = np.isin(indices, neck_ids)
    neck_weight = np.where(in_neck, weights, 0).sum(axis=1)
    other_weight = np.where(in_neck, 0, weights).max(axis=1)
    return neck_weight > other_weight


def _neck_component(
    vertices: np.ndarray, faces: np.ndarray, mask: np.ndarray, base: np.ndarray, axis: np.ndarray
) -> np.ndarray:
    allowed_faces = faces[np.asarray(mask, dtype=bool)[faces].all(axis=1)]
    if not len(allowed_faces):
        raise ValueError("No neck-only faces")
    edges = allowed_faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2)
    graph = coo_matrix(
        (np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(len(vertices), len(vertices))
    ).tocsr()
    _, labels = connected_components(graph, directed=False)
    active = np.unique(allowed_faces)
    delta = vertices[active] - base
    distance = np.linalg.norm(delta - np.outer(delta @ axis, axis), axis=1)
    near = active[np.argmin(distance)]
    return allowed_faces[(labels[allowed_faces] == labels[near]).all(axis=1)]


def measure_neck(
    vertices: np.ndarray,
    faces: np.ndarray,
    mask: np.ndarray,
    base: np.ndarray,
    head_base: np.ndarray,
    height_cm: float,
) -> NeckGirth:
    """Pure section measurement; inputs are never modified.

    Only topologically closed loops enclosing the skeletal neck axis count.
    A hull bridges concavities in a complete tape, never a missing neck arc.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    faces = np.asarray(faces)
    base, head_base = np.asarray(base, dtype=float), np.asarray(head_base, dtype=float)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or not np.isfinite(vertices).all():
        raise ValueError("Expected finite body vertices")
    if not np.isfinite(height_cm) or not c.HEIGHT_RANGE_CM[0] <= height_cm <= c.HEIGHT_RANGE_CM[1]:
        raise ValueError("Collar height is outside physical input bounds")
    axis = head_base - base
    length = float(np.linalg.norm(axis))
    if not np.isfinite(axis).all() or length <= 1e-9:
        raise ValueError("Neck-base and head-base landmarks must differ")
    axis /= length
    faces = _neck_component(vertices, faces, mask, base, axis)
    lateral = np.eye(3)[np.argmin(abs(axis))]
    lateral = np.cross(axis, lateral)
    lateral /= np.linalg.norm(lateral)
    plane_basis = np.c_[lateral, np.cross(axis, lateral)]

    def at(height: float) -> Tape:
        origin = base + axis * (height / 100)
        loops = section_loops(vertices, faces, origin, axis)
        enclosing = []
        for tape in loops:
            hull = ConvexHull((tape.points - origin) @ plane_basis)
            if np.all(hull.equations[:, -1] <= c.NECK_AXIS_ENCLOSURE_EPS_M):
                enclosing.append(tape)
        if not enclosing:
            raise ValueError("No closed neck-only section around the neck axis")
        return min(enclosing, key=lambda t: np.linalg.norm(t.points.mean(axis=0) - origin))

    valid: list[tuple[float, Tape]] = []
    # This search is independent of girth, targets, sex, height and mass. Its only
    # purpose is finding the upper closed semantic-neck boundary before the head.
    for height in np.arange(0, length * 100, c.NECK_SECTION_STEP_CM):
        try:
            valid.append((float(height), at(float(height))))
        except ValueError:
            pass
    if not valid:
        raise ValueError("Neck semantic region contains no complete closed section")
    cap_height, cap_tape = valid[-1]

    def requested(height: float) -> tuple[float, Tape]:
        if height > cap_height:
            return cap_height, cap_tape
        return height, at(height)

    actual, tape = requested(height_cm)
    band_heights = np.arange(
        c.NECK_SENSITIVITY_BAND_CM[0],
        c.NECK_SENSITIVITY_BAND_CM[1] + c.NECK_BAND_STEP_CM / 2,
        c.NECK_BAND_STEP_CM,
    )
    band = [requested(float(h)) for h in band_heights]
    girths = [t.perimeter * 100 for _, t in band]
    return NeckGirth(
        girth_cm=tape.perimeter * 100,
        requested_height_cm=height_cm,
        actual_height_cm=actual,
        band_requested_cm=c.NECK_SENSITIVITY_BAND_CM,
        band_girth_cm=(min(girths), max(girths)),
        band_actual_height_cm=(min(h for h, _ in band), max(h for h, _ in band)),
        capped=actual != height_cm
        or any(
            h < requested for h, requested in zip((h for h, _ in band), band_heights, strict=True)
        ),
        points=tape.points.copy(),
    )


def body_neck_girth(body: FittedBody, engine: BodyEngine, height_cm: float) -> NeckGirth:
    """Use the existing fitted phenotypes and rig, without re-fitting or mutation."""
    # torch / anny (.model) only here (P2 proposal 5): asset workers import this module via
    # garment/fit_math (NeckGirth), but never measure a neck, so they skip the torch import.
    import torch

    from .model import scene_points

    model = engine.model
    with torch.no_grad():
        coeff = model.get_phenotype_blendshape_coefficients(
            **body.response.phenotypes, local_changes=body.response.local_changes
        )
        rest = model.get_rest_model(coeff)
    floor = float(rest["rest_vertices"][0, :, 2].min())
    bones = scene_points(rest["rest_bone_heads"][0].numpy(), floor)
    labels = model.bone_labels
    mask = neck_vertex_mask(
        model.vertex_bone_indices.numpy(), model.vertex_bone_weights.numpy(), labels
    )
    return measure_neck(
        body.mesh.vertices,
        body.mesh.faces,
        mask,
        bones[labels.index(c.NECK_BASE_BONE)],
        bones[labels.index(c.HEAD_BASE_BONE)],
        height_cm,
    )
