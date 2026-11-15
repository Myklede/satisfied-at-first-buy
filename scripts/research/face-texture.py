"""P32 B. Local Face Landmarker ONNX -> canonical-UV face texture and OBJ.

Run through face-texture.mjs/py with the repository venv. No camera/MediaPipe
Python dependency: the MediaPipe 478-point network executes with existing OpenCV.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

from camera_study_common import ROOT, private_directory, wait_for_cpu

sys.path.insert(0, str(ROOT / ".cache/research/cv"))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

cv2.setNumThreads(1)
# Model/export and canonical topology sources are pinned by SHA in private
# models/face/provenance.json. All quality gates below are research heuristics,
# not biometric accuracy guarantees. Native source pixels are never downsampled
# for the UV bake; the network uses its required 256 square input.
CONFIG = {
    "model_size": 256,
    "texture_size": 1024,
    "min_pose_score": 0.65,
    "max_candidates": 32,
    "candidate_spacing_ms": 200,
    "roi_sides_over_ipd": [3.5, 4.0, 4.5],
    "roi_centre_below_eyes": 0.55,
    "max_coarse_nose_offset": 0.30,
    "min_ipd_px": 12,
    "min_presence": 0.95,
    "min_eye_aspect": 0.15,
    "max_nose_offset": 0.20,
    "max_cheek_asymmetry": 0.35,
    "min_triangle_area_px": 1e-4,
    "iris": [468, 473],
    "chin": 152,
    "brows": [105, 334],
    "left_eye": [33, 160, 158, 133, 153, 144],
    "right_eye": [362, 385, 387, 263, 373, 380],
}
ASSETS = ROOT / ".cache/research/models/face"
CLIP = "venue-khong-ao"
SOURCE = ROOT / "data/reference-photos/FB7675-100-parka-trang/video/venue-khong-ao.mp4"


def read_canonical(path: Path) -> tuple[list, list, list]:
    vertices, uv, faces = [], [], []
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "v":
            vertices.append([float(x) for x in fields[1:4]])
        elif fields[0] == "vt":
            uv.append([float(x) for x in fields[1:3]])
        elif fields[0] == "f":
            if len(fields) != 4:
                raise ValueError("Canonical face must be triangular")
            faces.append([tuple(int(x) - 1 for x in item.split("/")[:2]) for item in fields[1:]])
    if not vertices or not uv or not faces:
        raise ValueError("Missing canonical mesh data")
    if any(not (0 <= v < len(vertices) and 0 <= t < len(uv)) for face in faces for v, t in face):
        raise ValueError("Canonical OBJ index out of bounds")
    return vertices, uv, faces


def eye_aspect(points: np.ndarray, indices: list[int]) -> float:
    a, b, c, d, e, f = points[indices, :2]
    return float(
        (np.linalg.norm(b - f) + np.linalg.norm(c - e)) / max(1e-9, 2 * np.linalg.norm(a - d))
    )


def fit_roi(
    image: np.ndarray, eyes: np.ndarray, multiplier: float
) -> tuple[np.ndarray, np.ndarray, float]:
    """One bilinear sample into the model crop; inverse maps predictions to source."""
    eyes = eyes[np.argsort(eyes[:, 0])]
    centre = eyes.mean(axis=0)
    ipd = float(np.linalg.norm(eyes[1] - eyes[0]))
    side = ipd * multiplier
    centre[1] += CONFIG["roi_centre_below_eyes"] * ipd
    angle = math.degrees(math.atan2(*(eyes[1] - eyes[0])[::-1]))
    size = CONFIG["model_size"]
    matrix = cv2.getRotationMatrix2D(tuple(centre), angle, size / side)
    matrix[0, 2] += size / 2 - centre[0]
    matrix[1, 2] += size / 2 - centre[1]
    return cv2.warpAffine(image, matrix, (size, size)), cv2.invertAffineTransform(matrix), side


def source_landmarks(raw: np.ndarray, inverse: np.ndarray, side: float) -> np.ndarray:
    xyz = raw.reshape(478, 3).astype(np.float64)
    xyz[:, :2] = np.column_stack([xyz[:, :2], np.ones(478)]) @ inverse.T
    xyz[:, 2] *= side / CONFIG["model_size"]
    return xyz


def head_units(points: np.ndarray) -> tuple[np.ndarray, dict]:
    if points.shape != (478, 3) or not np.isfinite(points).all():
        raise ValueError("Expected 478 finite xyz landmarks")
    left, right = points[CONFIG["iris"], :2]
    ipd = float(np.linalg.norm(right - left))
    if ipd <= 0:
        raise ValueError("Coincident iris centres")
    centre = points[CONFIG["iris"]].mean(axis=0)
    xyz = (points[:468] - centre) / ipd
    xyz[:, 1:] *= -1  # Image camera axes -> Y up, +Z toward viewer.
    brow = points[CONFIG["brows"], :2].mean(axis=0)
    return xyz, {
        "ipd_px": ipd,
        "chin_to_brow_over_ipd": float(np.linalg.norm(points[CONFIG["chin"], :2] - brow) / ipd),
        "cheek_width_over_ipd": float(np.linalg.norm(points[234, :2] - points[454, :2]) / ipd),
        "origin_source_xyz": centre.tolist(),
        "units": "one detected image interpupillary distance, NOT metres or measured physical IPD",
    }


def bake_texture(
    image: np.ndarray, points: np.ndarray, uv: list, faces: list, size: int
) -> np.ndarray:
    """Piecewise affine source-image triangles -> OBJ UV, retaining UV seam indices."""
    texture = np.zeros((size, size, 4), np.uint8)
    for face in faces:
        source = np.array([points[v, :2] for v, _ in face], np.float32)
        dest = np.array(
            [[uv[t][0] * (size - 1), (1 - uv[t][1]) * (size - 1)] for _, t in face], np.float32
        )
        if (
            abs(cv2.contourArea(source)) < CONFIG["min_triangle_area_px"]
            or abs(cv2.contourArea(dest)) < CONFIG["min_triangle_area_px"]
        ):
            continue
        sx, sy, sw, sh = cv2.boundingRect(source)
        dx, dy, dw, dh = cv2.boundingRect(dest)
        if (
            sx < 0
            or sy < 0
            or sx + sw > image.shape[1]
            or sy + sh > image.shape[0]
            or dx < 0
            or dy < 0
            or dx + dw > size
            or dy + dh > size
        ):
            continue
        matrix = cv2.getAffineTransform(
            (source - [sx, sy]).astype(np.float32), (dest - [dx, dy]).astype(np.float32)
        )
        warped = cv2.warpAffine(
            image[sy : sy + sh, sx : sx + sw],
            matrix,
            (dw, dh),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        mask = np.zeros((dh, dw), np.uint8)
        cv2.fillConvexPoly(
            mask, np.rint(dest - [dx, dy]).astype(np.int32), 255, lineType=cv2.LINE_AA
        )
        tile = texture[dy : dy + dh, dx : dx + dw]
        keep = mask > tile[:, :, 3]
        tile[keep, :3] = warped[keep]
        tile[:, :, 3] = np.maximum(tile[:, :, 3], mask)
    return texture


def select_candidates(reference: dict) -> list[dict]:
    pool = []
    for frame in reference["frames"]:
        p = frame.get("keypoints")
        if not p or not all(p[k]["score"] >= CONFIG["min_pose_score"] for k in (0, 1, 2)):
            continue
        eyes = np.array([[p[k]["x"], p[k]["y"]] for k in (1, 2)], np.float64)
        ipd = float(np.linalg.norm(eyes[1] - eyes[0]))
        offset = abs(p[0]["x"] - eyes[:, 0].mean()) / max(1e-9, ipd)
        if ipd >= CONFIG["min_ipd_px"] and offset < CONFIG["max_coarse_nose_offset"]:
            pool.append((ipd * (1 - offset), frame))
    chosen = []
    for _, frame in sorted(pool, key=lambda p: p[0], reverse=True):
        if all(abs(frame["tMs"] - f["tMs"]) >= CONFIG["candidate_spacing_ms"] for f in chosen):
            chosen.append(frame)
        if len(chosen) >= CONFIG["max_candidates"]:
            break
    return sorted(chosen, key=lambda f: f["index"])


def frontal_uv(points: np.ndarray) -> list:
    """Project into a square audit image, preserving source-image aspect ratio."""
    native = points[:468, :2]
    lo, hi = native.min(axis=0), native.max(axis=0)
    span = float(max(hi - lo))
    if span <= 0:
        raise ValueError("Degenerate frontal extent")
    projected = (native - (lo + hi) / 2) / span + 0.5
    projected[:, 1] = 1 - projected[:, 1]
    return projected.tolist()


def run() -> None:
    out = private_directory("face")
    provenance = json.loads((ASSETS / "provenance.json").read_text(encoding="utf-8"))
    for name in ("face_landmarker.onnx", "canonical_face_model.obj"):
        if hashlib.sha256((ASSETS / name).read_bytes()).hexdigest() != provenance[name]["sha256"]:
            raise ValueError("Model/topology asset changed after provenance was recorded")
    reference = json.loads((ROOT / ".cache/research/tracks" / (CLIP + ".json")).read_text())
    if (
        not reference["complete"]
        or hashlib.sha256(SOURCE.read_bytes()).hexdigest() != reference["sourceSha256"]
    ):
        raise ValueError("Missing/stale source RTMO reference")
    vertices, uv, faces = read_canonical(ASSETS / "canonical_face_model.obj")
    if len(vertices) != 468:
        raise ValueError("Canonical template is not MediaPipe 468 topology")
    net = cv2.dnn.readNetFromONNX(str(ASSETS / "face_landmarker.onnx"))
    candidates = select_candidates(reference)
    cap = cv2.VideoCapture(str(SOURCE), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 1])
    if not cap.isOpened():
        raise RuntimeError("Saved source video failed to open")
    best, evaluations, decoded = None, [], -1
    try:
        for frame in candidates:
            wait_for_cpu()
            while decoded < frame["index"]:
                if not cap.grab():
                    raise RuntimeError("Source ended before reference frame")
                decoded += 1
            ok, image = cap.retrieve()
            if not ok or abs(cap.get(cv2.CAP_PROP_POS_MSEC) - frame["tMs"]) > 2:
                raise RuntimeError("Source PTS mismatch")
            eyes = np.array(
                [[frame["keypoints"][k]["x"], frame["keypoints"][k]["y"]] for k in (1, 2)],
                np.float64,
            )
            for multiplier in CONFIG["roi_sides_over_ipd"]:
                wait_for_cpu()
                crop, inverse, side = fit_roi(image, eyes, multiplier)
                net.setInput(cv2.dnn.blobFromImage(crop, 1 / 255, swapRB=True))
                raw, logit = net.forward(["landmarks", "score"])
                presence = 1 / (1 + math.exp(-float(np.clip(logit.item(), -80, 80))))
                points = source_landmarks(raw, inverse, side)
                _, head = head_units(points)
                centre = points[CONFIG["iris"], :2].mean(axis=0)
                nose_offset = abs(points[1, 0] - centre[0]) / head["ipd_px"]
                cheek_left = abs(points[234, 0] - points[1, 0])
                cheek_right = abs(points[454, 0] - points[1, 0])
                cheek_asymmetry = abs(cheek_left - cheek_right) / max(cheek_left, cheek_right, 1e-9)
                eye_open = [eye_aspect(points, CONFIG[k]) for k in ("left_eye", "right_eye")]
                inside = bool(
                    np.all(points[:, 0] >= 1)
                    and np.all(points[:, 0] < image.shape[1] - 1)
                    and np.all(points[:, 1] >= 1)
                    and np.all(points[:, 1] < image.shape[0] - 1)
                )
                valid = (
                    presence >= CONFIG["min_presence"]
                    and min(eye_open) >= CONFIG["min_eye_aspect"]
                    and nose_offset <= CONFIG["max_nose_offset"]
                    and cheek_asymmetry <= CONFIG["max_cheek_asymmetry"]
                    and inside
                )
                x0, y0 = np.floor(points[:468, :2].min(axis=0)).astype(int)
                x1, y1 = np.ceil(points[:468, :2].max(axis=0)).astype(int)
                sharpness = (
                    float(
                        cv2.Laplacian(
                            cv2.cvtColor(
                                image[
                                    max(0, y0) : min(y1 + 1, image.shape[0]),
                                    max(0, x0) : min(x1 + 1, image.shape[1]),
                                ],
                                cv2.COLOR_BGR2GRAY,
                            ),
                            cv2.CV_64F,
                        ).var()
                    )
                    if inside
                    else 0
                )
                quality = sharpness * head["ipd_px"]
                record = {
                    "index": frame["index"],
                    "t_ms": frame["tMs"],
                    "presence": presence,
                    "eye_aspects": eye_open,
                    "nose_offset_over_ipd": nose_offset,
                    "cheek_asymmetry": cheek_asymmetry,
                    "face_inside": inside,
                    "valid": valid,
                    "sharpness": sharpness,
                    "quality": quality,
                    "roi_multiplier": multiplier,
                    "source_face_size_px": [int(x1 - x0 + 1), int(y1 - y0 + 1)],
                    **head,
                }
                evaluations.append(record)
                if valid and (best is None or quality > best["record"]["quality"]):
                    best = {"record": record, "points": points, "image": image.copy(), "crop": crop}
    finally:
        cap.release()
    (out / "selection.json").write_text(
        json.dumps({"config": CONFIG, "evaluations": evaluations}, indent=2), encoding="utf-8"
    )
    if best is None:
        raise RuntimeError(
            "No in-frame, open-eye, frontal face passed quality gates; see private selection.json"
        )
    wait_for_cpu()
    texture = bake_texture(best["image"], best["points"], uv, faces, CONFIG["texture_size"])
    cv2.imwrite(str(out / "face-texture.png"), texture)
    cv2.imwrite(str(out / "selected-roi.png"), best["crop"])
    # UV round-trip audit, NOT a Fit Lab render or a novel-view reconstruction.
    projected = frontal_uv(best["points"])
    tex_edge = CONFIG["texture_size"] - 1
    uv_pixels = np.array([[u * tex_edge, (1 - v) * tex_edge] for u, v in uv], np.float32)
    front_check = bake_texture(
        texture[:, :, :3],
        uv_pixels,
        projected,
        [[(t, v) for v, t in face] for face in faces],
        512,
    )
    cv2.imwrite(str(out / "face-front-check.png"), front_check)
    xyz, head = head_units(best["points"])
    obj = [
        "# Local estimated face mesh, units = image IPD; no hair or rear head",
        "mtllib face.mtl",
        "o CameraFace",
    ]
    obj += ["v " + " ".join(f"{x:.8f}" for x in p) for p in xyz]
    obj += ["vt " + " ".join(f"{x:.8f}" for x in p) for p in uv]
    obj += ["usemtl face"]
    obj += ["f " + " ".join(f"{v + 1}/{t + 1}" for v, t in face) for face in faces]
    (out / "face.obj").write_text("\n".join(obj) + "\n", encoding="utf-8")
    (out / "face.mtl").write_text(
        "newmtl face\nKd 1 1 1\nmap_Kd face-texture.png\n", encoding="utf-8"
    )
    metadata = {
        "schema": "satisfy.face-texture/1",
        "clip": CLIP,
        "source_sha256": reference["sourceSha256"],
        "assets": provenance,
        "selected": best["record"],
        "head": head,
        "landmarks_source_xyz": best["points"].tolist(),
        "vertex_count": len(xyz),
        "uv_count": len(uv),
        "triangle_count": len(faces),
        "uv_mapping": {
            "kind": (
                "canonical OBJ separate vertex/texture indices; "
                "MediaPipe landmark i -> OBJ vertex i+1"
            ),
            "image_y_from_v": "(1-v)*(texture_size-1)",
            "iris_not_in_mesh": CONFIG["iris"],
        },
        "config": CONFIG,
    }
    (out / "face.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "face": "exported locally",
                "tested_crops": len(evaluations),
                "valid_crops": sum(r["valid"] for r in evaluations),
                "vertices": len(xyz),
                "triangles": len(faces),
                "texture_size": CONFIG["texture_size"],
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    wait_for_cpu()
    run()
