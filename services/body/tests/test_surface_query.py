import numpy as np
import pytest
import trimesh
from body_service import config
from body_service.measure import search_tape, section_loops, stature
from body_service.surface_query import SurfaceQuery


def test_certified_query_matches_independent_exact_reference_across_chunks():
    mesh = trimesh.creation.icosphere(subdivisions=2)
    points = np.random.default_rng(42).normal(size=(257, 3)) * 1.3
    actual, distance, faces = SurfaceQuery(mesh).exact_closest(points)
    expected, reference, _ = trimesh.proximity.closest_point(mesh, points)
    np.testing.assert_allclose(distance, reference, atol=1e-10, rtol=1e-10)
    np.testing.assert_allclose(actual, expected, atol=1e-9)
    assert faces.min() >= 0 and faces.max() < len(mesh.faces)
    empty = SurfaceQuery(mesh).exact_closest(np.empty((0, 3)))
    assert empty[0].shape == (0, 3) and len(empty[1]) == 0
    with pytest.raises(ValueError):
        SurfaceQuery(trimesh.Trimesh())


def test_conservative_bound_does_not_miss_a_large_far_centred_triangle():
    vertices = [[-100.0, 0.0, -100.0], [100.0, 0.0, -100.0], [0.0, 0.0, 100.0]]
    faces = [[0, 1, 2]]
    for i in range(40):
        base = len(vertices)
        x = i * 0.001
        vertices.extend([[x, 1.0, 0.0], [x + 0.001, 1.0, 0.0], [x, 1.0, 0.001]])
        faces.append([base, base + 1, base + 2])
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    query = SurfaceQuery(mesh)
    point = np.array([[0.0, 0.1, 0.0]])
    assert query.closest(point)[1][0] > 0.5
    projected, distance, face = query.exact_closest(point)
    np.testing.assert_allclose(projected, [[0.0, 0.0, 0.0]], atol=1e-12)
    assert distance[0] == pytest.approx(0.1) and face[0] == 0


def test_pruned_torso_search_preserves_full_mesh_section_result():
    mesh = trimesh.creation.icosphere(subdivisions=2)
    window = (0.4, 0.8)
    exact = []
    for fraction in np.linspace(*window, config.SECTION_SAMPLES):
        origin = np.array([0.0, mesh.vertices[:, 1].min() + stature(mesh.vertices) * fraction, 0.0])
        loops = section_loops(mesh.vertices, mesh.faces, origin, np.array([0.0, 1.0, 0.0]))
        exact.append(min(loops, key=lambda tape: abs(tape.points[:, 0].mean())))
    for maximum in (True, False):
        expected = (max if maximum else min)(exact, key=lambda tape: tape.perimeter)
        result = search_tape(mesh.vertices, mesh.faces, window, maximum)
        np.testing.assert_array_equal(result.points, expected.points)
        np.testing.assert_array_equal(result.edges, expected.edges)


def test_feature_pseudonormals_match_independent_parity_on_nonconvex_mesh():
    body = trimesh.creation.annulus(r_min=0.5, r_max=1, height=0.4)
    points = np.random.default_rng(12).uniform(-1.2, 1.2, (300, 3))
    query = SurfaceQuery(body)
    closest, _, faces = query.exact_closest(points)
    normals = query.pseudonormals(closest, faces)
    inside = np.einsum("ij,ij->i", points - closest, normals) < 0
    np.testing.assert_array_equal(inside, body.contains(points))
