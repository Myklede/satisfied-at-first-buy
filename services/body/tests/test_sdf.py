import numpy as np
import trimesh
from body_service.garment.sdf import body_sdf


def test_triangle_refined_contact_band_against_exact_sphere_mesh():
    mesh = trimesh.creation.icosphere(subdivisions=2, radius=0.08)
    field, origin, spacing = body_sdf(mesh)
    candidates = np.argwhere(np.abs(field) < 0.02)[::17]
    points = origin + candidates * spacing
    _, distance, _ = trimesh.proximity.closest_point(mesh, points)
    expected = np.where(mesh.contains(points), -distance, distance)
    np.testing.assert_allclose(field[tuple(candidates.T)], expected, atol=spacing)
    assert field.dtype == np.dtype("<f4")
