import numpy as np
import trimesh
from body_service.garment.quality import body_penetration, panel_crossings


def test_independent_penetration_check_detects_missed_facet_samples():
    body = trimesh.creation.icosphere(subdivisions=2, radius=1)
    cloth = trimesh.Trimesh([[1.2, 0, 0], [-1.2, 0, 0], [0, 1.2, 0]], [[0, 1, 2]], process=False)
    report = body_penetration(cloth, body)
    assert report["inside_samples"] > 0
    cloth.apply_translation([0, 0, 3])
    assert body_penetration(cloth, body)["inside_samples"] == 0


def test_panel_crossings_detects_edge_through_triangle_without_nearby_vertices():
    cloth = trimesh.Trimesh(
        [[-1, -1, 0], [1, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [2, 0, 1]],
        [[0, 1, 2], [3, 4, 5]],
        process=False,
    )
    panels = np.array([2, 2, 2, 4, 4, 4])
    assert panel_crossings(cloth, panels)["sleeve_torso"] > 0
    cloth.vertices[3:, 0] += 4
    assert panel_crossings(cloth, panels)["sleeve_torso"] == 0


def test_exact_face_side_and_boundary_rays_match_full_parity_on_nonconvex_body():
    body = trimesh.creation.annulus(r_min=0.5, r_max=1, height=0.4)
    random = np.random.default_rng(42)
    cloth = trimesh.Trimesh(
        random.uniform(-1.2, 1.2, (90, 3)), np.arange(90).reshape(-1, 3), process=False
    )
    points = np.vstack(
        (cloth.vertices, cloth.vertices[cloth.edges_unique].mean(1), cloth.triangles_center)
    )
    report = body_penetration(cloth, body)
    assert report["inside_samples"] == body.contains(points).sum()
    assert report["boundary_ray_samples"] > 0
