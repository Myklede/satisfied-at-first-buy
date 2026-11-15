import numpy as np
from body_service.garment.pattern import perimeter
from body_service.garment.wrap import (
    closest_route_distance,
    limb_frames,
    neck_frame,
    perimeter_ring,
    resample_closed,
    ring_fractions,
    sleeve_stations,
)


def test_arc_length_resampling_preserves_order_and_origin():
    polygon = np.array([[0.0, 0, 0], [2.0, 0, 0], [2.0, 1.0, 0], [0, 1.0, 0]])
    fractions = ring_fractions(polygon)
    np.testing.assert_allclose(resample_closed(polygon, fractions), polygon)
    sampled = resample_closed(polygon, np.arange(12) / 12)
    np.testing.assert_allclose(np.linalg.norm(np.roll(sampled, -1, 0) - sampled, axis=1), 0.5)


def test_section_wrap_root_solves_tape_and_matches_material_arc_lengths():
    angles = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    support = np.c_[0.05 * np.cos(angles), 0.03 * np.sin(angles), np.zeros(len(angles))]
    reference = np.c_[0.08 * np.cos(angles), 0.08 * np.sin(angles), np.zeros(len(angles))]
    ring = perimeter_ring(
        support,
        np.zeros(3),
        np.array([1.0, 0, 0]),
        np.array([0, 1.0, 0]),
        angles,
        perimeter(reference),
        reference,
    )
    assert abs(perimeter(ring) - perimeter(reference)) < 1e-8
    lengths = np.linalg.norm(np.roll(ring, -1, 0) - ring, axis=1)
    assert lengths.max() / lengths.min() < 1.005


def test_limb_frames_have_no_elbow_roll_jump_and_mirror_by_anatomical_side():
    route = np.array([[0.2, 1.4, 0], [0.32, 1.15, 0], [0.43, 0.9, 0.06]])
    distances = np.linspace(0, np.linalg.norm(np.diff(route, axis=0), axis=1).sum(), 101)
    centres, tangent, normal, front = limb_frames(route, distances, 1)
    np.testing.assert_allclose(np.linalg.norm(tangent, axis=1), 1)
    np.testing.assert_allclose(np.einsum("ij,ij->i", normal, front), 0, atol=1e-12)
    assert np.linalg.norm(np.diff(normal, axis=0), axis=1).max() < 0.03
    right = route * [-1, 1, 1]
    c2, _, n2, f2 = limb_frames(right, distances, -1)
    np.testing.assert_allclose(c2, centres * [-1, 1, 1])
    np.testing.assert_allclose(n2, normal * [-1, 1, 1])
    np.testing.assert_allclose(f2, front * [-1, 1, 1])


def test_closest_route_distance_clamps_to_real_segments():
    route = np.array([[0.0, 0, 0], [1.0, 0, 0], [1.0, 1.0, 0]])
    assert closest_route_distance(route, np.array([0.25, 0.1, 0])) == 0.25
    assert closest_route_distance(route, np.array([1.1, 0.4, 0])) == 1.4


def test_neck_frame_follows_anatomical_base_slope_without_changing_landmarks():
    landmarks = {"C7": np.array([0.0, 1.5, -0.05]), "jugular_notch": np.array([0.0, 1.46, 0.05])}
    saved = {k: p.copy() for k, p in landmarks.items()}
    centre, frame = neck_frame(landmarks)
    np.testing.assert_allclose(frame.T @ frame, np.eye(3), atol=1e-12)
    assert np.linalg.det(frame) > 0
    assert frame[1, 2] < 0  # front of the collar is below its posterior base
    np.testing.assert_allclose(centre, [0, 1.48, 0])
    for key in saved:
        np.testing.assert_array_equal(saved[key], landmarks[key])


def test_sleeve_material_keeps_cap_length_and_stacks_excess_after_elbow():
    material = np.linspace(0, 0.65, 14)
    stations = sleeve_stations(material, 0.02, 0.28, 0.54)
    np.testing.assert_allclose(stations[material <= 0.26], 0.02 + material[material <= 0.26])
    assert abs(stations[-1] - 0.54) < 1e-12
    assert (np.diff(stations) > 0).all()
    short = sleeve_stations(np.linspace(0, 0.3, 8), 0.02, 0.28, 0.54)
    assert abs(short[-1] - 0.32) < 1e-12
