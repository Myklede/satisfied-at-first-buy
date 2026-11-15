from dataclasses import dataclass

import numpy as np
import trimesh

from . import config
from .anatomy import detect_anatomy, neck_plane
from .landmarks import nearest, surface_path
from .measure import Tape, polyline_length, search_tape, section, signed_volume, stature
from .schemas import Measurement
from .surface_query import SurfaceQuery


@dataclass
class Geometry:
    measurements: dict[str, Measurement]
    tapes: dict[str, Tape]
    paths: dict[str, np.ndarray]
    landmarks: dict[str, np.ndarray]
    volume: float
    indices: dict[str, int]
    attachments: dict[str, tuple[np.ndarray, np.ndarray]]
    surface_paths: dict[str, np.ndarray]


def measure_body(
    vertices: np.ndarray,
    faces: np.ndarray,
    indices: dict[str, int],
    joints: dict[str, np.ndarray],
    gender: float = 0.5,
) -> Geometry:
    indices, landmarks = detect_anatomy(vertices, faces, indices, joints, gender)
    centre = joints["waist_anchor"][1] / stature(vertices)
    waist_window = (centre - config.WAIST_ANCHOR_RADIUS, centre + config.WAIST_ANCHOR_RADIUS)
    tapes = {
        "chest": search_tape(vertices, faces, config.CHEST_WINDOW, True, separate_arms=True),
        "waist": search_tape(vertices, faces, waist_window, False),
        "hip": search_tape(vertices, faces, config.HIP_WINDOW, True),
    }
    neck, normal = neck_plane(landmarks["C7"], landmarks["jugular_notch"])
    tapes["neck_base"] = section(vertices, faces, neck, normal, neck)
    shoulder, elbow, wrist = (landmarks[f"{name}_L"] for name in ("acromion", "elbow", "wrist"))
    origin = shoulder + config.ARM_SECTION_FRACTION * (elbow - shoulder)
    tapes["upper_arm"] = section(vertices, faces, origin, elbow - shoulder, origin)
    # Slightly proximal to wrist to avoid hand webbing at an exactly coplanar vertex.
    origin = wrist + config.WRIST_PROXIMAL_FRACTION * (elbow - wrist)
    tapes["wrist"] = section(vertices, faces, origin, wrist - elbow, origin)
    values = {
        name: Measurement(
            value_cm=tape.perimeter * 100, method="connected plane section / 2D convex hull tape"
        )
        for name, tape in tapes.items()
    }
    values["stature"] = Measurement(value_cm=stature(vertices) * 100, method="rest vertical extent")
    values["shoulder_width"] = Measurement(
        value_cm=float(np.linalg.norm(landmarks["acromion_L"] - landmarks["acromion_R"])) * 100,
        method="biacromial straight surface-point distance",
    )
    paths = {
        "arm_length": np.array([indices["acromion_L"], indices["elbow_L"], indices["wrist_L"]])
    }
    waist = tapes["waist"].points
    back_waist = waist[np.argmin(waist[:, 2])]
    landmarks["waist_level"] = np.array([0.0, waist[:, 1].mean(), 0.0])
    landmarks["hip_level"] = np.array([0.0, tapes["hip"].points[:, 1].mean(), 0.0])
    c7 = indices["C7"]
    # Posterior half-space includes the outer shoulder points, excludes chest shortcuts.
    posterior = (
        vertices[:, 2]
        <= max(landmarks["acromion_L"][2], landmarks["acromion_R"][2], 0.0)
        + config.POSTERIOR_MARGIN
    )
    posterior[[indices["acromion_L"], indices["acromion_R"], c7]] = True
    top = posterior & (
        vertices[:, 1]
        >= min(landmarks["acromion_L"][1], landmarks["acromion_R"][1]) - config.SHOULDER_TOP_MARGIN
    )
    left = surface_path(vertices, faces, indices["acromion_L"], c7, top)
    right = surface_path(vertices, faces, c7, indices["acromion_R"], top)
    paths["shoulder_arc"] = np.r_[left, right[1:]]
    midline = (abs(vertices[:, 0]) < config.MIDLINE_WIDTH) & posterior
    end = nearest(vertices, back_waist, midline)
    paths["back_length"] = surface_path(vertices, faces, c7, end, midline)
    for name, path in paths.items():
        values[name] = Measurement(
            value_cm=polyline_length(vertices[path]) * 100,
            method="ISO 8559-1 5.4.3 surface via C7"
            if name == "shoulder_arc"
            else "surface edge geodesic"
            if name != "arm_length"
            else "acromion-elbow-wrist surface polyline",
        )
    values["neck_base"].method = "inclined C7-jugular-notch plane / convex hull"
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    surface = SurfaceQuery(mesh)
    # ISO across-shoulder is over the BACK. Whole-mesh nearest projections may
    # jump to the anterior shoulder/chest and shorten the route through C7.
    back_faces = (mesh.face_normals[:, 2] <= 0) & (
        mesh.triangles_center[:, 1]
        >= min(landmarks["acromion_L"][1], landmarks["acromion_R"][1]) - config.SHOULDER_TOP_MARGIN
    )
    shoulder_surface = trimesh.Trimesh(vertices, faces[back_faces], process=False)
    shoulder_query = SurfaceQuery(shoulder_surface)
    attachments = {}
    routes = {}
    for side in ("L", "R"):
        point, _, face = surface.exact_closest(landmarks[f"acromion_{side}"][None])
        triangle = faces[face[0]]
        weights = trimesh.triangles.points_to_barycentric(vertices[triangle][None], point)[0]
        attachments[f"acromion_{side}"] = (triangle, weights)
        landmarks[f"acromion_{side}"] = point[0]
        line = np.linspace(landmarks["C7"], point[0], config.SURFACE_ROUTE_SAMPLES)
        projected, _, _ = shoulder_query.exact_closest(line)
        projected[0], projected[-1] = landmarks["C7"], point[0]
        routes[f"shoulder_{side}"] = projected
        routes[f"arm_{side}"] = np.array(
            [point[0], landmarks[f"elbow_{side}"], landmarks[f"wrist_{side}"]]
        )
    routes["shoulder_arc"] = np.vstack((routes["shoulder_L"][::-1], routes["shoulder_R"][1:]))
    arc_points, _, arc_faces = surface.exact_closest(routes["shoulder_arc"])
    arc_triangles = faces[arc_faces]
    arc_weights = trimesh.triangles.points_to_barycentric(vertices[arc_triangles], arc_points)
    attachments["shoulder_arc"] = (arc_triangles, arc_weights)
    values["shoulder_arc"].value_cm = polyline_length(routes["shoulder_arc"]) * 100
    values["shoulder_width"].value_cm = (
        float(np.linalg.norm(landmarks["acromion_L"] - landmarks["acromion_R"])) * 100
    )
    values["arm_length"].value_cm = polyline_length(routes["arm_L"]) * 100
    line = np.linspace(landmarks["C7"], back_waist, config.SURFACE_ROUTE_SAMPLES)
    projected, _, face_ids = surface.exact_closest(line)
    route_faces = faces[face_ids]
    weights = trimesh.triangles.points_to_barycentric(vertices[route_faces], projected)
    attachments["back_length"] = (route_faces, weights)
    routes["back_length"] = projected
    values["back_length"] = Measurement(
        value_cm=polyline_length(projected) * 100,
        method="contoured C7-to-waist centre-back surface route",
    )
    return Geometry(
        values,
        tapes,
        paths,
        landmarks,
        signed_volume(vertices, faces),
        indices,
        attachments,
        routes,
    )
