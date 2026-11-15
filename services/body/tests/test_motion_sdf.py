import numpy as np
import pytest
import trimesh
from body_service.motion import config
from body_service.motion.collision import (
    body_distance,
    build_fields,
    close_patch,
    outer_faces,
    parity_inside,
    segment_weights,
)
from body_service.motion.container import decode, encode
from body_service.motion.presets import MOTIONS, resolve, sample
from body_service.motion.rig import build_rig, lbs, neutral_pose, pose_skeleton
from body_service.schemas import FitRequest


def test_container_round_trip_and_alignment():
    blobs = {
        "a": np.arange(7, dtype=np.float32).reshape(7, 1),
        "b": np.array([[1, 2, 3]], dtype=np.uint16),
        "c": np.array([5], dtype=np.uint8),
    }
    data = encode("test", {"note": "x"}, blobs)
    header, out = decode(data)
    assert header["kind"] == "test" and header["note"] == "x"
    for name, array in blobs.items():
        assert np.array_equal(out[name], array) and out[name].dtype == array.dtype
    assert all(entry["offset"] % 16 == 0 for entry in header["blobs"])
    with pytest.raises(ValueError):
        encode("bad", {}, {"x": np.zeros(2, dtype=np.float64)})


def test_parity_inside_matches_a_sphere():
    sphere = trimesh.creation.icosphere(subdivisions=4, radius=0.1)
    h = 0.006
    origin = np.array([-0.13, -0.13, -0.13])
    dims = (44, 44, 44)
    inside = parity_inside(sphere.triangles, origin, dims, h)
    grid = origin + np.argwhere(np.ones(dims, bool)) * h
    radius = np.linalg.norm(grid, axis=1).reshape(dims)
    # Polyhedral sphere: inscribed radius is within 0.2% of 0.1 at this subdivision.
    assert inside[radius < 0.0995].all() and not inside[radius > 0.1].any()


def test_close_patch_caps_an_open_tube():
    tube = trimesh.creation.cylinder(radius=0.05, height=0.2, sections=24)
    keep = np.abs(tube.triangles_center[:, 2]) < 0.099  # drop both end caps
    vertices, faces = close_patch(tube.vertices, tube.faces[keep])
    closed = trimesh.Trimesh(vertices, faces, process=False)
    edges = np.sort(closed.edges, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    assert (counts == 2).all()


@pytest.fixture(scope="module")
def setup(fitter):
    body = fitter.fit(FitRequest(sex="male", height_cm=175, weight_kg=75))
    rig = build_rig(fitter.engine, body)
    return body, rig, neutral_pose(fitter.engine, body, rig), build_fields(rig)


def test_every_skin_face_is_in_a_rigid_core_or_the_joint_zone(setup):
    _, rig, _, body = setup
    assert np.allclose(segment_weights(rig).sum(1), 1, atol=1e-5)
    faces = {tuple(f) for f in outer_faces(rig).tolist()}
    zone = {tuple(f) for f in body.zone.faces.tolist()}
    cores = set()
    for field in body.fields:
        member = np.zeros(len(rig.vertices), bool)
        member[field.vertex_ids] = True
        cores |= {f for f in faces if member[list(f)].all()}
    assert faces == cores | zone
    names = [f.name for f in body.fields]
    assert names == [n for n in config.SEGMENTS if n in names] and "thigh.L" in names


def shell(mesh, ids, rng, count=1500):
    pick = rng.choice(ids, count)
    return mesh.vertices[pick] + mesh.vertex_normals[pick] * rng.uniform(-0.005, 0.03, (count, 1))


def test_rest_distance_matches_the_exact_body_distance_away_from_joints(setup):
    body, rig, _, fields = setup
    rng = np.random.default_rng(3)
    joints = np.array(
        [
            rig.head(f"{j}.{s}")
            for j in ("upperarm01", "lowerarm01", "upperleg01", "lowerleg01")
            for s in "LR"
        ]
    )
    far = np.linalg.norm(body.mesh.vertices[:, None] - joints[None], axis=2).min(1) > 0.12
    far &= body.mesh.vertices[:, 1] < rig.head("neck01")[1]
    points = shell(body.mesh, np.flatnonzero(far), rng)
    exact = -trimesh.proximity.signed_distance(body.mesh, points)
    identity = np.tile(np.eye(4), (len(rig.labels), 1, 1))
    error = np.abs(body_distance(rig, fields, rig.rest, identity, points) - exact)
    # Measured (docs/validation/motion-sdf.md): p95 ~1.5-2 mm. Rare outliers up to ~1 cm where
    # a rigid core's centroid-fan cap pokes out of the concave upper back (known gap).
    assert np.percentile(error, 95) < 0.003 and np.mean(error > 0.005) < 0.005
    assert error.max() < 0.015


def test_posed_distance_near_joints_stays_bounded(setup):
    _, rig, neutral, fields = setup
    rng = np.random.default_rng(4)
    for motion_id, bone in (("reach_up_both", "upperarm01.L"), ("sit", "lowerleg01.R")):
        motion = MOTIONS[motion_id]
        posed = pose_skeleton(rig, sample(resolve(motion, neutral), motion.hold.start_s))
        mesh = trimesh.Trimesh(lbs(rig, posed.skin), rig.faces, process=False)
        centre = posed.world[rig.bone(bone), :3, 3]
        near = np.linalg.norm(mesh.vertices - centre, axis=1) < 0.08
        points = shell(mesh, np.flatnonzero(near), rng, 600)
        exact = -trimesh.proximity.signed_distance(mesh, points)
        error = np.abs(body_distance(rig, fields, posed.world, posed.skin, points) - exact)
        outside = error[exact > 0]
        # Outside the skin (where cloth is): measured p95 <= ~4 mm (docs/validation/motion-sdf.md).
        assert np.percentile(outside, 95) < 0.005, motion_id
