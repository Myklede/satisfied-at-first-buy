import json

import numpy as np
import pytest
import trimesh
from body_service import config
from body_service.garment.grading import prepare_product
from body_service.garment.pattern import build_pattern, quilt
from body_service.garment.products import load_products
from body_service.garment.sections import surface_loops


def test_cosine_loft_zero_stitches_peak_and_smoothness():
    np.testing.assert_allclose(quilt(np.array([0, 0.1, 0.2]), 0.2), [0, 1, 0], atol=1e-12)
    assert abs(quilt(np.array(1e-6), 0.2)) < 1e-8


@pytest.mark.parametrize("quilted", [True, False])
def test_rest_tapes_actual_mesh_and_size_topology(quilted):
    for raw in load_products().values():
        report = json.loads((config.ROOT / "data/grading" / f"{raw.product_id}.json").read_text())
        product = prepare_product(raw, report)
        faces = None
        for name, size in product.sizes.items():
            pattern = build_pattern(product, name, quilted=quilted)
            mesh = trimesh.Trimesh(pattern.reference_vertices, pattern.mesh.faces, process=False)
            assert 8000 <= len(mesh.vertices) <= 15000
            assert np.isfinite(mesh.vertices).all()
            left = mesh.vertices[pattern.panels == 4]
            right = mesh.vertices[pattern.panels == 5].copy()
            right[:, 0] *= -1
            np.testing.assert_allclose(left, right, atol=1e-10)
            assert len(np.unique(mesh.faces)) == len(mesh.vertices)
            if faces is not None:
                np.testing.assert_array_equal(faces, mesh.faces)
            faces = mesh.faces
            measured = pattern.measurements()
            for field in ("chest", "hem", "shoulder", "length_hps", "bicep"):
                assert abs(measured[field] - getattr(size, field).value_cm) < 0.5
            for side in ("L", "R"):
                assert abs(measured[f"sleeve_{side}"] - size.sleeve.value_cm) < 0.5
            # Independently section the mesh at its indexed chest tape height.
            path = pattern.tapes["chest"]
            y = mesh.vertices[path[0], 1]
            cross = trimesh.intersections.mesh_plane(mesh, [0, 1, 0], [0, y + 1e-7, 0])
            torso = cross[(np.abs(cross[:, :, 0]).max(1) < size.shoulder.value_cm / 200)]
            assert len(torso) > 40
            loops = surface_loops(
                mesh.vertices, mesh.faces, np.array([0.0, y + 1e-7, 0]), np.array([0.0, 1, 0])
            )
            section = min(loops, key=lambda loop: np.linalg.norm(loop.mean(0) - [0, y, 0]))
            actual = np.linalg.norm(section - np.roll(section, 1, axis=0), axis=1).sum() * 100
            assert abs(actual - size.chest.value_cm) < 0.5
            assert pattern.measurements(mesh.vertices.copy()) == pytest.approx(measured)
            if not quilted:
                lining = pattern.measurements(pattern.mesh.vertices)
                assert lining["bicep"] < measured["bicep"]
                assert lining["chest"] < measured["chest"]
                assert np.linalg.norm(pattern.render_offsets, axis=1).max() <= (
                    product.loft_cm / 100 + config.SECTION_EPS
                )
