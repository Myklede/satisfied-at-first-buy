import numpy as np
from body_service.garment.arap import BoundedWrap, MetricWrap


def sheet():
    x, y = np.meshgrid(np.arange(8) * 0.02, np.arange(6) * 0.02)
    rest = np.c_[x.ravel(), y.ravel(), np.zeros(x.size)]
    edges = []
    for row in range(6):
        for col in range(8):
            i = row * 8 + col
            if col < 7:
                edges.append((i, i + 1))
            if row < 5:
                edges.append((i, i + 8))
            if row < 5 and col < 7:
                edges.append((i, i + 9))
    return rest, np.array(edges)


def test_metric_wrap_preserves_rigid_motion_and_never_rewrites_rest():
    rest, edges = sheet()
    before = rest.copy()
    rotation = np.array([[0.0, -1, 0], [1, 0, 0], [0, 0, 1]])
    target = rest @ rotation.T + [0.5, 0.7, 0.1]
    solver = MetricWrap(rest, edges)
    np.testing.assert_allclose(solver.project(target), target, atol=1e-12)
    np.testing.assert_array_equal(before, rest)


def test_metric_projection_reduces_nonrigid_distortion_deterministically():
    rest, edges = sheet()
    target = rest.copy()
    target[:, 0] *= 1.4
    a = MetricWrap(rest, edges).project(target)
    b = MetricWrap(rest, edges).project(target)
    np.testing.assert_array_equal(a, b)
    lengths = np.linalg.norm(rest[edges[:, 0]] - rest[edges[:, 1]], axis=1)
    ratio = np.linalg.norm(a[edges[:, 0]] - a[edges[:, 1]], axis=1) / lengths
    assert ratio.max() < 1.15
    assert np.linalg.norm(a - target, axis=1).max() < 0.05


def test_contact_planes_are_one_sided_constraints_not_world_position_pins():
    rest, edges = sheet()
    target = rest - [0, 0.05, 0]
    normal = np.tile([0.0, 1.0, 0.0], (len(rest), 1))
    result = MetricWrap(rest, edges).project(
        target, iterations=1, planes=(normal, np.zeros(len(rest)))
    )
    assert result[:, 1].min() >= -1e-12
    np.testing.assert_allclose(result[:, 0], target[:, 0], atol=1e-10)


def test_bounded_wrap_enforces_material_limit_and_contact_without_rebinding_rest():
    rest, edges = sheet()
    original = rest.copy()
    target = rest * [1.4, 1, 1] - [0, 0, 0.03]
    normal = np.tile([0.0, 0.0, 1.0], (len(rest), 1))
    solver = BoundedWrap(rest, edges, np.full(len(edges), 1.08), 0.001)
    result = solver.project(target, 1200, (normal, np.zeros(len(rest))))
    lengths = np.linalg.norm(rest[edges[:, 0]] - rest[edges[:, 1]], axis=1)
    ratio = np.linalg.norm(result[edges[:, 0]] - result[edges[:, 1]], axis=1) / lengths
    assert ratio.max() <= 1.08001
    assert result[:, 2].min() >= -1e-10
    np.testing.assert_array_equal(rest, original)
    np.testing.assert_array_equal(
        result, solver.project(target, 1200, (normal, np.zeros(len(rest))))
    )
