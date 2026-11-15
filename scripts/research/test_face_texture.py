"""Synthetic texture/UV/coordinate regressions; no face fixture or camera."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "face_texture", Path(__file__).with_name("face-texture.py")
)
face = importlib.util.module_from_spec(spec)
spec.loader.exec_module(face)
np = face.np


def test_canonical_obj_keeps_separate_uv_indices_and_rejects_bad_faces():
    class Text:
        def __init__(self, text):
            self.text = text

        def read_text(self, **_):
            return self.text

    text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/3 2/1 3/2\n"
    vertices, uv, faces = face.read_canonical(Text(text))
    assert len(vertices) == len(uv) == 3
    assert faces == [[(0, 2), (1, 0), (2, 1)]]
    with pytest.raises(ValueError, match="index"):
        face.read_canonical(Text(text.replace("1/3", "4/3")))


def test_model_crop_predictions_map_to_native_image_without_hidden_resize():
    raw = np.zeros((1, 478, 3), np.float32)
    raw[:] = [30, 40, -5]
    inverse = np.array([[2, 0, 10], [0, 2, 20]], np.float64)
    points = face.source_landmarks(raw, inverse, 512)
    assert points[0].tolist() == pytest.approx([70, 100, -10])


def test_head_units_are_scale_invariant_and_explicitly_not_physical_ipd():
    points = np.zeros((478, 3), np.float64)
    points[468] = [60, 100, 0]
    points[473] = [120, 100, 0]
    points[152] = [90, 160, -12]
    points[105] = [70, 80, 0]
    points[334] = [110, 80, 0]
    xyz, info = face.head_units(points)
    scaled, _ = face.head_units(points * 2 + [10, 20, 30])
    assert xyz.shape == (468, 3)
    assert np.allclose(xyz, scaled)
    assert xyz[152].tolist() == pytest.approx([0, -1, 0.2])
    assert info["chin_to_brow_over_ipd"] == pytest.approx(80 / 60)
    assert "NOT metres" in info["units"]
    points[468] = points[473]
    with pytest.raises(ValueError, match="Coincident"):
        face.head_units(points)


def test_uv_y_flip_and_triangle_warp_preserve_source_texels_and_alpha():
    image = np.zeros((5, 5, 3), np.uint8)
    for y in range(5):
        for x in range(5):
            image[y, x] = [20 * x, 30 * y, 100]
    points = np.array([[0, 0], [4, 0], [0, 4]], np.float32)
    uv = [[0, 1], [1, 1], [0, 0]]
    texture = face.bake_texture(image, points, uv, [[(0, 0), (1, 1), (2, 2)]], 5)
    assert texture[1, 1, :3].tolist() == [20, 30, 100]
    assert texture[1, 1, 3] == 255
    assert texture[4, 4, 3] == 0


def test_eye_openness_is_dimensionless_and_closed_eye_is_zero():
    points = np.array([[0, 0], [2, -1], [3, -1], [5, 0], [3, 1], [2, 1]], np.float64)
    assert face.eye_aspect(points, list(range(6))) == pytest.approx(0.4)
    assert face.eye_aspect(points * 3, list(range(6))) == pytest.approx(0.4)
    points[:, 1] = 0
    assert face.eye_aspect(points, list(range(6))) == 0


def test_front_audit_preserves_aspect_instead_of_stretching_face_to_a_square():
    uv = np.array(face.frontal_uv(np.array([[0, 0], [1, 0], [0, 2]], np.float64)))
    assert (uv[1, 0] - uv[0, 0]) / (uv[0, 1] - uv[2, 1]) == pytest.approx(0.5)
    assert uv.min() >= 0 and uv.max() <= 1
