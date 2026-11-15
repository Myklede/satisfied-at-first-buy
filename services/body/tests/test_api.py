import pytest
from body_service import app as module
from fastapi.testclient import TestClient


@pytest.fixture
def client(fitter, monkeypatch):
    # Share an already loaded real model; service lifespan itself is smoke-tested by npm run dev.
    monkeypatch.setattr(module, "fitter", fitter)
    return TestClient(module.app)


@pytest.mark.slow
def test_full_api(client):
    assert client.get("/health").json()["model_loaded"]
    capabilities = client.get("/body/capabilities").json()
    assert capabilities["shape_reference_supported"]
    response = client.post("/body/fit", json={"height_cm": 172, "weight_kg": 65, "sex": "male"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    assert data["converged"]
    body_id = data["body_id"]
    mesh = client.get(f"/body/{body_id}/mesh.glb")
    assert mesh.content[:4] == b"glTF"
    assert mesh.headers["content-type"] == "model/gltf-binary"
    landmarks = client.get(f"/body/{body_id}/landmarks").json()
    assert landmarks["coordinate_frame"] == "metres Y-up +Z-front A-pose"
    assert len(landmarks["girth_polylines"]["chest"]) > 3


def test_boundary_and_cors(client):
    payload = {"height_cm": 172, "weight_kg": 65, "sex": "male"}
    for bad in (
        {"height_cm": 119},
        {"weight_kg": "65"},
        {"unknown": 1},
        {"known_measurements": {"chest_cm": -3}},
        {"shape_reference": "unknown"},
    ):
        assert client.post("/body/fit", json={**payload, **bad}).status_code == 422
    assert client.get("/body/bad/mesh.glb").status_code == 422
    assert client.get(f"/body/{'0' * 64}/landmarks").status_code == 404
    assert client.get("/health", headers={"Host": "evil.example"}).status_code == 400
    for origin, allowed in (("http://127.0.0.1:5710", True), ("https://evil.example", False)):
        response = client.get("/health", headers={"Origin": origin})
        assert ("access-control-allow-origin" in response.headers) is allowed


def test_loading_and_lru(fitter, monkeypatch):
    monkeypatch.setattr(module, "fitter", None)
    client = TestClient(module.app)
    assert client.get("/health").json()["model_loaded"] is False
    assert client.get("/body/capabilities").status_code == 503
    with pytest.raises(KeyError):
        fitter.get("f" * 64)
