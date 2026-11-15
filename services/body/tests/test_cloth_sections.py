import numpy as np
from body_service.garment.pattern import perimeter
from body_service.garment.sections import polygon_contains, surface_loops


def test_concave_cloth_section_is_not_replaced_by_its_convex_hull():
    polygon = np.array([[0.0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]])
    vertices = np.vstack((np.c_[polygon, np.full(6, -0.1)], np.c_[polygon, np.full(6, 0.1)]))
    faces = []
    for i in range(6):
        j = (i + 1) % 6
        faces.extend(((i, j, j + 6), (i, j + 6, i + 6)))
    loops = surface_loops(vertices, np.array(faces), np.zeros(3), np.array([0.0, 0, 1.0]))
    assert len(loops) == 1
    assert abs(perimeter(loops[0]) - 8) < 1e-10
    np.testing.assert_array_equal(
        polygon_contains(np.array([[0.5, 1.5], [1.5, 1.5], [0, 0]]), loops[0][:, :2]),
        [True, False, True],
    )
