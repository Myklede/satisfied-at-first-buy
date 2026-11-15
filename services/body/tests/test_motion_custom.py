"""POST /motion/{body_id}/custom/frames.bin: recorded moves through the preset code path."""

import json
import logging
import math

import pytest
from body_service.motion import config
from body_service.motion.api import _SERVICES, create_router, forget_motion_body
from body_service.motion.container import decode, encode
from body_service.motion.custom import CustomMotionRequest, custom_frame_times, custom_motion
from body_service.motion.presets import MOTIONS, frame_times
from body_service.schemas import FitRequest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError


@pytest.fixture(scope="module")
def client(fitter):
    app = FastAPI()
    app.include_router(create_router(lambda: fitter))
    body_id = fitter.fit(FitRequest(sex="male", height_cm=178, weight_kg=72)).response.body_id
    return TestClient(app), body_id


def preset_request(motion_id: str) -> dict:
    """A custom request built from a preset's own keyframes (partial poses, seconds)."""
    motion = MOTIONS[motion_id]
    return {"fps": 30, "poses": [{"t": k.t_s, "pose": k.pose} for k in motion.keyframes]}


def first_blob(data: bytes) -> int:
    header, _ = decode(data)
    return min(b["offset"] for b in header["blobs"])


@pytest.mark.parametrize("motion_id", list(MOTIONS))
def test_custom_request_from_preset_keyframes_is_bit_identical(client, motion_id):
    api, body_id = client
    preset = api.get(f"/motion/{body_id}/{motion_id}/frames.bin")
    custom = api.post(f"/motion/{body_id}/custom/frames.bin", json=preset_request(motion_id))
    assert custom.status_code == 200 and custom.headers["cache-control"] == "no-store"
    p_header, p_blobs = decode(preset.content)
    c_header, c_blobs = decode(custom.content)
    # Every blob byte (driver matrices and all anchors, with padding) is identical.
    assert (
        custom.content[first_blob(custom.content) :] == preset.content[first_blob(preset.content) :]
    )
    assert list(c_blobs) == list(p_blobs)
    # The header differs only by the motion descriptor (id, label, hold = recorded window).
    strip = lambda h: {k: v for k, v in h.items() if k not in ("motion", "blobs")}  # noqa: E731
    assert strip(c_header) == strip(p_header)
    assert c_header["motion"]["keyframes"] == p_header["motion"]["keyframes"]
    assert c_header["motion"]["duration_s"] == p_header["motion"]["duration_s"]
    assert c_header["motion"]["id"] == "custom"
    # Whole file: the preset's frames.bin with its motion descriptor swapped is the custom one.
    meta = {k: v for k, v in p_header.items() if k not in ("kind", "blobs")}
    swapped = encode(p_header["kind"], {**meta, "motion": c_header["motion"]}, p_blobs)
    assert swapped == custom.content


def test_frame_times_match_presets():
    for motion in MOTIONS.values():
        assert custom_frame_times(motion) == frame_times(motion)


def test_recording_gets_a_neutral_lead_in_and_out(client):
    api, body_id = client
    up = {"shoulder_L_elevation": 160.0, "shoulder_R_elevation": 160.0, "elbow_L_flexion": 20.0}
    poses = [{"t": round(i / 30, 6), "pose": up} for i in range(0, 76)]  # 2.5 s held overhead
    request = {"fps": 30, "poses": poses}
    data = api.post(f"/motion/{body_id}/custom/frames.bin", json=request)
    assert data.status_code == 200
    header, blobs = decode(data.content)
    span = poses[-1]["t"]
    motion = header["motion"]
    neutral = decode(api.get(f"/motion/{body_id}/sit/frames.bin").content)[0]["poses"][0]
    # Arms from the display pose (~27 deg) to 160 deg: longer than the minimum lead so the
    # transition is no faster than the presets' ramp (110 deg/s mean).
    change = 160.0 - min(neutral["shoulder_L_elevation"], neutral["shoulder_R_elevation"])
    lead = change / config.CUSTOM_LEAD_SPEED_DEG_S
    assert lead > config.CUSTOM_LEAD_S
    assert motion["keyframes"][0] == {"t_s": 0.0, "pose": {}}
    assert motion["keyframes"][1]["t_s"] == pytest.approx(lead)
    assert motion["keyframes"][-1]["t_s"] == pytest.approx(lead + span + lead)
    assert motion["hold"]["start_s"] == pytest.approx(lead)
    assert motion["hold"]["end_s"] == pytest.approx(lead + span)
    count = math.ceil(round(motion["duration_s"] * config.FPS, 6)) + 1
    assert header["frame_count"] == count == blobs["driver_matrices"].shape[0]
    assert header["poses"][0] == neutral
    # The last frame is presets.sample's a + (b - a) * ease(1): neutral up to rounding, as in
    # every preset.
    assert header["poses"][-1] == pytest.approx(neutral, abs=1e-9)
    # Inside the recorded window: the requested DOFs, the rest at the body's neutral.
    middle = header["poses"][round((lead + span / 2) * config.FPS)]
    assert middle["shoulder_L_elevation"] == pytest.approx(160.0)
    assert middle["elbow_L_flexion"] == pytest.approx(20.0)
    assert middle["elbow_R_flexion"] == pytest.approx(neutral["elbow_R_flexion"])
    assert middle["hip_L_flexion"] == pytest.approx(neutral["hip_L_flexion"])
    assert all(not f["clamps"] for f in header["frames"])


def test_lead_length_follows_the_angle_change():
    from body_service.motion.angles import AnatomicalPose
    from body_service.motion.custom import lead_s

    neutral = AnatomicalPose(shoulder_L_elevation=27.0, elbow_L_flexion=12.0)
    assert lead_s({}, neutral) == 0.0
    assert lead_s({"elbow_L_flexion": 20.0}, neutral) == config.CUSTOM_LEAD_S  # small change
    assert lead_s({"shoulder_L_elevation": 170.0}, neutral) == pytest.approx(143.0 / 110.0)
    assert lead_s({"pelvis_drop_m": 0.5}, neutral) == config.CUSTOM_LEAD_S  # metres ignored
    assert lead_s({"shoulder_L_elevation": 170.0}, None) == config.CUSTOM_LEAD_S


def test_a_recording_that_starts_and_ends_neutral_gets_no_lead():
    request = CustomMotionRequest(
        fps=30,
        poses=[
            {"t": 0, "pose": {}},
            {"t": 1.0, "pose": {"shoulder_R_elevation": 90.0}},
            {"t": 2.0, "pose": {}},
        ],
    )
    motion = custom_motion(request)
    assert [k.t_s for k in motion.keyframes] == [0.0, 1.0, 2.0]
    assert motion.hold.start_s == 0 and motion.hold.end_s == 2.0


def post(api, body_id, payload):
    return api.post(f"/motion/{body_id}/custom/frames.bin", json=payload)


def valid() -> dict:
    return {"fps": 30, "poses": [{"t": 0, "pose": {}}, {"t": 0.5, "pose": {"elbow_L_flexion": 30}}]}


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.update(extra=1),  # unknown top-level field
        lambda r: r["poses"][1].update(confidence=0.9),  # unknown sample field
        lambda r: r["poses"][1]["pose"].update(neck_flexion=10),  # unknown DOF
        lambda r: r["poses"][1]["pose"].update(shoulder_L_elevation=181),  # above the limit
        lambda r: r["poses"][1]["pose"].update(shoulder_R_plane=-91),  # below the limit
        lambda r: r["poses"][1]["pose"].update(knee_L_flexion=141),
        lambda r: r["poses"][1]["pose"].update(pelvis_drop_m=0.7),
        lambda r: r["poses"][1]["pose"].update(trunk_twist="10"),  # string number
        lambda r: r["poses"][1]["pose"].update(trunk_twist=True),
        lambda r: r["poses"][1].update(t=8.5),  # longer than 8 s
        lambda r: r["poses"][0].update(t=0.1),  # does not start at 0
        lambda r: r["poses"][1].update(t=0),  # not strictly increasing
        lambda r: r.update(fps=0.5),
        lambda r: r.update(fps=61),
        lambda r: r.update(poses=r["poses"][:1]),  # a single pose
        lambda r: r.update(fps=1, poses=[{"t": i * 0.1, "pose": {}} for i in range(11)]),
        lambda r: r.pop("fps"),
    ],
)
def test_invalid_requests_are_rejected(client, mutate):
    api, body_id = client
    payload = valid()
    mutate(payload)
    assert post(api, body_id, payload).status_code == 422


def test_errors_never_echo_the_poses(client):
    api, body_id = client
    payload = valid()
    payload["poses"][1]["pose"]["shoulder_L_elevation"] = 181.2345
    response = post(api, body_id, payload)
    assert response.status_code == 422 and "181.2345" not in response.text
    assert response.json()["detail"][0]["loc"][-1] == "pose"


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_numbers_are_rejected(client, token):
    api, body_id = client
    for text in (
        '{"fps": 30, "poses": [{"t": 0, "pose": {}}, {"t": 0.5, "pose": {"elbow_L_flexion": %s}}]}',
        '{"fps": 30, "poses": [{"t": 0, "pose": {}}, {"t": %s, "pose": {}}]}',
        '{"fps": %s, "poses": [{"t": 0, "pose": {}}, {"t": 0.5, "pose": {}}]}',
    ):
        response = api.post(
            f"/motion/{body_id}/custom/frames.bin",
            content=text % token,
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 422


def test_body_boundaries(client):
    api, _ = client
    assert post(api, "0" * 64, valid()).status_code == 404
    assert post(api, "not-a-hash", valid()).status_code == 422
    # GET on the custom path is not a preset.
    assert api.get("/motion/" + "0" * 64 + "/custom/frames.bin").status_code == 404


def test_poses_are_not_kept_or_logged_and_forget_drops_the_body(fitter, caplog):
    app = FastAPI()
    app.include_router(create_router(lambda: fitter))
    api = TestClient(app)
    body_id = fitter.fit(FitRequest(sex="female", height_cm=163, weight_kg=57)).response.body_id
    payload = valid()
    payload["poses"][1]["pose"]["elbow_L_flexion"] = 123.4567
    with caplog.at_level(logging.DEBUG):
        assert post(api, body_id, payload).status_code == 200
    assert "123.4567" not in caplog.text
    service = _SERVICES[0]
    item = service.cache[body_id]
    assert "custom" not in item.frames and set(item.frames) <= set(MOTIONS)
    assert "frames.custom" in item.timings_ms
    assert forget_motion_body(body_id) == 1
    assert body_id not in service.cache
    assert forget_motion_body(body_id) == 0


def test_request_model_bounds():
    with pytest.raises(ValidationError):
        CustomMotionRequest(fps=30, poses=[{"t": 0, "pose": {}}] * 2)  # equal times
    too_many = math.ceil(config.CUSTOM_MAX_DURATION_S * 60) + 2
    with pytest.raises(ValidationError):
        CustomMotionRequest(fps=60, poses=[{"t": i / 60.01, "pose": {}} for i in range(too_many)])
    ok = CustomMotionRequest(fps=60, poses=[{"t": i / 60, "pose": {}} for i in range(481)])
    assert len(ok.poses) == 481
    json.dumps(custom_motion(ok).model_dump())  # the header stays JSON
