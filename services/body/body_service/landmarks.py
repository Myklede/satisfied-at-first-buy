"""Fixed topology landmarks generated once from neutral adult bones + surface rules."""

import json
from functools import lru_cache

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

from . import config


def nearest(vertices: np.ndarray, target: np.ndarray, mask: np.ndarray | None = None) -> int:
    ids = np.flatnonzero(mask) if mask is not None else np.arange(len(vertices))
    if not len(ids):
        raise ValueError("Empty landmark region")
    return int(ids[np.argmin(np.linalg.norm(vertices[ids] - target, axis=1))])


def generate(vertices: np.ndarray, bones: np.ndarray, labels: list[str]) -> dict[str, dict]:
    joints = dict(zip(labels, bones, strict=True))
    result: dict[str, dict] = {}

    def add(name: str, target: np.ndarray, rule: str, mask: np.ndarray | None = None) -> None:
        result[name] = {"vertex_index": nearest(vertices, target, mask), "rule": rule}

    for side, sign in (("L", 1), ("R", -1)):
        shoulder = joints[f"upperarm01.{side}"]
        region = np.linalg.norm(vertices - shoulder, axis=1) < config.SHOULDER_RADIUS
        region &= sign * vertices[:, 0] >= sign * shoulder[0]
        target = shoulder + np.array(config.ACROMION_OFFSET) * np.array([sign, 1, 1])
        acromion = nearest(vertices, target, region)
        result[f"acromion_{side}"] = {
            "vertex_index": int(acromion),
            "rule": f"superior-lateral surface within {config.SHOULDER_RADIUS}m "
            f"of upperarm01.{side}",
        }
        for name, bone in (("elbow", "lowerarm01"), ("wrist", "wrist")):
            add(f"{name}_{side}", joints[f"{bone}.{side}"], f"surface nearest {bone}.{side}")
        neck = joints["neck01"]
        target = neck.copy()
        target[0] = sign * config.NECK_RADIUS * config.HPS_OFFSET_FACTOR
        add(
            f"HPS_{side}",
            target,
            "lateral neck base surface nearest offset neck01",
            (sign * vertices[:, 0] > 0) & (abs(vertices[:, 0]) < config.NECK_RADIUS),
        )
        add(
            f"heel_{side}",
            joints[f"foot.{side}"],
            "lowest posterior foot surface",
            (sign * vertices[:, 0] > 0)
            & (vertices[:, 1] < vertices[:, 1].min() + config.HEEL_REGION_HEIGHT)
            & (vertices[:, 2] < joints[f"foot.{side}"][2]),
        )
        bust_region = (
            (sign * vertices[:, 0] > config.BUST_X_WINDOW[0])
            & (sign * vertices[:, 0] < config.BUST_X_WINDOW[1])
            & (vertices[:, 1] > vertices[:, 1].max() * config.BUST_HEIGHT_WINDOW[0])
            & (vertices[:, 1] < vertices[:, 1].max() * config.BUST_HEIGHT_WINDOW[1])
        )
        ids = np.flatnonzero(bust_region)
        i = int(ids[np.argmax(vertices[ids, 2])])
        result[f"bust_{side}"] = {"vertex_index": i, "rule": "anterior maximum in chest quadrant"}
    neck = joints["neck01"]
    midline = abs(vertices[:, 0]) < config.MIDLINE_WIDTH
    neck_region = midline & (abs(vertices[:, 1] - neck[1]) < config.NECK_LEVEL_BAND)
    for name, front in (("C7", False), ("neck_base_back", False), ("neck_base_front", True)):
        ids = np.flatnonzero(neck_region)
        i = ids[(np.argmax if front else np.argmin)(vertices[ids, 2])]
        result[name] = {
            "vertex_index": int(i),
            "rule": "neck01-level midline anterior/posterior extreme",
        }
    result["top_of_head"] = {"vertex_index": int(vertices[:, 1].argmax()), "rule": "maximum Y"}
    crotch_region = (
        midline & (vertices[:, 1] < joints["root"][1]) & (vertices[:, 1] > config.CROTCH_MIN_Y)
    )
    ids = np.flatnonzero(crotch_region)
    result["crotch"] = {
        "vertex_index": int(ids[np.argmin(vertices[ids, 1])]),
        "rule": "lowest surface in midline below root (above knee)",
    }
    return result


def load_indices() -> dict[str, int]:
    data = json.loads((config.ROOT / "services/body/landmarks.json").read_text())
    return {name: item["vertex_index"] for name, item in data["landmarks"].items()}


@lru_cache(maxsize=4)
def edge_topology(face_bytes: bytes) -> np.ndarray:
    faces = np.frombuffer(face_bytes, dtype=np.int32).reshape(-1, 3)
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    return np.unique(np.sort(edges, axis=1), axis=0)


def surface_path(
    vertices: np.ndarray, faces: np.ndarray, start: int, end: int, mask: np.ndarray
) -> np.ndarray:
    """Shortest edge path on posterior surface; explicit mesh-resolution approximation."""
    edges = edge_topology(faces.astype(np.int32, copy=False).tobytes())
    edges = edges[mask[edges].all(axis=1)]
    lengths = np.linalg.norm(vertices[edges[:, 0]] - vertices[edges[:, 1]], axis=1)
    graph = coo_matrix(
        (np.r_[lengths, lengths], (edges.T.ravel(), edges[:, ::-1].T.ravel())),
        shape=(len(vertices), len(vertices)),
    ).tocsr()
    distances, predecessors = dijkstra(
        graph, directed=False, indices=start, return_predecessors=True
    )
    if not np.isfinite(distances[end]):
        raise ValueError("Surface path is disconnected")
    path = [end]
    while path[-1] != start:
        path.append(int(predecessors[path[-1]]))
    return np.array(path[::-1])
