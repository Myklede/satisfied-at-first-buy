import numpy as np
import pytest
from body_service.motion import config
from body_service.motion.api import create_router
from body_service.motion.container import decode
from body_service.motion.presets import MOTIONS
from body_service.schemas import FitRequest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(fitter):
    app = FastAPI()
    app.include_router(create_router(lambda: fitter))
    body_id = fitter.fit(FitRequest(sex="male", height_cm=172, weight_kg=65)).response.body_id
    return TestClient(app), body_id


def test_presets(client):
    api, _ = client
    data = api.get("/motion/presets").json()
    assert [m["id"] for m in data] == list(MOTIONS)


def test_boundaries(client):
    api, body_id = client
    assert api.get("/motion/" + "0" * 64 + "/rig.bin").status_code == 404
    assert api.get("/motion/not-a-hash/rig.bin").status_code == 422
    assert api.get(f"/motion/{body_id}/dance/frames.bin").status_code == 404
    assert api.get(f"/motion/{body_id}/../x/frames.bin").status_code == 404


def test_rig_frames_anchors_and_sdf(client):
    api, body_id = client
    rig = api.get(f"/motion/{body_id}/rig.bin")
    assert rig.status_code == 200 and rig.headers["cache-control"] == "no-store"
    meta, blobs = decode(rig.content)
    assert meta["kind"] == "rig" and len(meta["bones"]) == 104
    assert blobs["skin_weights"].shape == blobs["skin_indices"].shape
    frames = api.get(f"/motion/{body_id}/sit/frames.bin")
    header, data = decode(frames.content)
    count = header["frame_count"]
    assert count == round(MOTIONS["sit"].duration_s * config.FPS) + 1
    assert data["driver_matrices"].shape == (count, len(meta["drivers"]), 3, 4)
    assert data["anchor.ring.waistband_mid"].shape == (count, config.RING_SAMPLES, 3)
    assert max(p["pelvis_drop_m"] for p in header["poses"]) > 0.2  # sitting drops the hips
    # Reconstruct skinning on the client side: driver map + weights reproduce frame 0 = rest.
    skin = np.concatenate(
        (data["driver_matrices"][0], np.tile([[[0, 0, 0, 1.0]]], (len(meta["drivers"]), 1, 1))), 1
    )
    per_bone = skin[blobs["driver_of_bone"]]
    v = blobs["rest_vertices"].astype(float)
    blend = np.einsum("vk,vkij->vij", blobs["skin_weights"], per_bone[blobs["skin_indices"]])
    posed = np.einsum("vij,vj->vi", blend[:, :3, :3], v) + blend[:, :3, 3]
    assert np.isfinite(posed).all() and abs(posed[:, 1].min()) < 1e-3
    anchors = api.get(f"/motion/{body_id}/anchors").json()
    assert anchors["ring_samples"] == config.RING_SAMPLES
    assert set(anchors["exposure_vertices"]) == {"low", "mid", "high"}
    sdf_header, sdf = decode(api.get(f"/motion/{body_id}/sdf.bin").content)
    names = [s["name"] for s in sdf_header["segments"]]
    assert set(names) <= set(config.SEGMENTS) and {"upperarm.L", "thigh.R"} <= set(names)
    assert sdf["zone_faces"].shape[1] == 3 and sdf["zone_border_edges"].shape[1] == 2
    for segment in sdf_header["segments"]:
        assert sdf[segment["blob"]].shape == tuple(segment["dims"])
