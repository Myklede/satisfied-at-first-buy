"""The optional own-port studio reuses the real service and the same Anny cache."""

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.mark.slow
def test_standalone_mount_shares_one_fitter(monkeypatch, tmp_path):
    from body_service import app as studio
    from body_service.agent import standalone

    monkeypatch.setenv("FIT_AGENT_STUDIO", "1")
    monkeypatch.setenv("FIT_AGENT_STORE_DIR", str(tmp_path))
    module = importlib.reload(standalone)
    # This test measures route/cache identity, not background cloth prefetch workers.
    monkeypatch.setattr(studio, "speculate_cloth", lambda _body_id: None)
    try:
        with TestClient(module.app, base_url="http://127.0.0.1") as client:
            assert studio.service() is module.service()
            assert client.get("/body/capabilities").status_code == 200
            response = client.post(
                "/body/fit", json={"sex": "male", "height_cm": 175, "weight_kg": 62}
            )
            assert response.status_code == 200, response.text
            assert (
                module.service().get(response.json()["body_id"]).response.body_id
                == response.json()["body_id"]
            )
        assert module.fitter is None
    finally:
        monkeypatch.delenv("FIT_AGENT_STUDIO")
        importlib.reload(standalone)
