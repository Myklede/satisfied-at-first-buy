import numpy as np
import pytest
import trimesh
from body_service.landmarks import nearest, surface_path
from body_service.measure import (
    hull_perimeter,
    polyline_length,
    search_tape,
    section,
    section_loops,
    signed_volume,
    stature,
    torso_tape,
)
from body_service.model import scene_points


def test_closed_box_volume_and_height():
    box = trimesh.creation.box(extents=[2, 3, 4])
    assert signed_volume(box.vertices, box.faces) == pytest.approx(24)
    assert stature(box.vertices) == 3
    with pytest.raises(ValueError, match="watertight"):
        signed_volume(box.vertices, box.faces[:-1])


def test_sphere_volume():
    sphere = trimesh.creation.icosphere(subdivisions=3, radius=1)
    assert signed_volume(sphere.vertices, sphere.faces) == pytest.approx(4 * np.pi / 3, rel=0.01)


def test_cylinder_girth_and_edge_attachments():
    cylinder = trimesh.creation.cylinder(radius=0.2, height=1.0, sections=128)
    tape = section(
        cylinder.vertices,
        cylinder.faces,
        np.array([0.0, 0.0, 0.123]),
        np.array([0.0, 0.0, 1.0]),
        np.zeros(3),
    )
    assert tape.perimeter == pytest.approx(2 * np.pi * 0.2, rel=0.001)
    t = tape.fractions[:, None]
    np.testing.assert_allclose(
        tape.points,
        cylinder.vertices[tape.edges[:, 0]] * (1 - t) + cylinder.vertices[tape.edges[:, 1]] * t,
    )


def test_hull_tape_bridges_concavity():
    points = np.array([[0, 0], [1, 0], [1, 1], [0.5, 0.5], [0, 1]])
    assert hull_perimeter(points) == pytest.approx(4)


def test_loop_isolation():
    torso = trimesh.creation.cylinder(radius=0.2, height=1, sections=64)
    arm = trimesh.creation.cylinder(radius=0.05, height=1, sections=64)
    arm.apply_translation([0.5, 0, 0])
    mesh = trimesh.util.concatenate([torso, arm])
    loops = section_loops(mesh.vertices, mesh.faces, np.array([0, 0, 0.01]), np.array([0, 0, 1]))
    assert len(loops) == 2
    tape = section(
        mesh.vertices,
        mesh.faces,
        np.array([0, 0, 0.01]),
        np.array([0, 0, 1]),
        np.array([0.5, 0, 0]),
    )
    assert tape.perimeter == pytest.approx(2 * np.pi * 0.05, rel=0.002)
    with pytest.raises(ValueError, match="intersect"):
        section_loops(mesh.vertices, mesh.faces, np.array([0, 0, 10]), np.array([0, 0, 1]))


def test_torso_search_and_scene_frame():
    box = trimesh.creation.box(extents=[2, 3, 4])
    assert torso_tape(box.vertices, box.faces, 0.01).perimeter == pytest.approx(12)
    assert search_tape(box.vertices, box.faces, (0.3, 0.7), True).perimeter == pytest.approx(12)
    with pytest.raises(ValueError, match="isolated"):
        search_tape(box.vertices, box.faces, (0.3, 0.7), True, separate_arms=True)
    np.testing.assert_array_equal(scene_points(np.array([[1.0, -2.0, 3.0]]), 1), [[1.0, 2.0, 2.0]])


def test_surface_path_and_nearest():
    vertices = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]])
    faces = np.array([[0, 1, 2], [0, 2, 3]])
    path = surface_path(vertices, faces, 0, 2, np.ones(4, dtype=bool))
    assert polyline_length(vertices[path]) == pytest.approx(np.sqrt(2))
    assert nearest(vertices, np.array([0.1, 0.1, 0.0])) == 0
    with pytest.raises(ValueError, match="Empty"):
        nearest(vertices, vertices[0], np.zeros(4, dtype=bool))
    with pytest.raises(ValueError, match="disconnected"):
        surface_path(vertices, faces, 0, 2, np.array([True, False, False, True]))
