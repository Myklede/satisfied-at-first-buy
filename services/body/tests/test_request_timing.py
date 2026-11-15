from concurrent.futures import ThreadPoolExecutor

from body_service.request_timing import install_timing, timed_asset
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel


class Payload(BaseModel):
    values: list[float]


def application():
    app = FastAPI()

    @app.get("/asset", response_model=Payload)
    def asset():
        return timed_asset(lambda: Payload(values=[0.1, 1 / 3, 2.5]))

    return app


def test_timing_preserves_exact_json_and_openapi_and_is_opt_in():
    baseline, measured = application(), application()
    schema = measured.openapi()
    install_timing(measured)
    install_timing(measured)  # Idempotent, no duplicate wrappers/middleware.
    plain, timed = TestClient(baseline).get("/asset"), TestClient(measured).get("/asset")
    assert timed.content == plain.content
    assert measured.openapi() == schema
    assert "server-timing" not in plain.headers
    header = timed.headers["server-timing"]
    assert all(f"{key};dur=" in header for key in ("app", "dispatch", "asset_wait", "json_encode"))
    assert "values" not in header
    assert all(float(metric.split("=")[1]) >= 0 for metric in header.split(", "))


def test_parallel_requests_have_separate_contexts_and_no_leaked_state():
    app = application()
    install_timing(app)
    with TestClient(app) as client, ThreadPoolExecutor(3) as pool:
        responses = list(pool.map(lambda _: client.get("/asset"), range(9)))
    assert all(response.status_code == 200 for response in responses)
    assert all("asset_wait;dur=" in response.headers["server-timing"] for response in responses)
    assert timed_asset(lambda: 7) == 7
