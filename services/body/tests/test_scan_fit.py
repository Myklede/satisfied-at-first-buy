"""Webcam scan values as soft constraints (prompt 04 Part C) and kiosk reset (Part B.8)."""

import ctypes
import gc
import multiprocessing
import os
import time
import weakref
from concurrent.futures import Future

import numpy as np
import pytest
from body_service import app as module
from body_service.garment import simulation
from body_service.schemas import FitRequest, KnownMeasurements, ScanMeasurements, ScanValue
from fastapi.testclient import TestClient
from pydantic import ValidationError
from rtree.index import Index

BASE = FitRequest(height_cm=172, weight_kg=65, sex="male")
SHOULDER_DELTA_CM = 3.0  # synthetic scan offsets for the tests; not person data
CHEST_DELTA_CM = 6.0


def test_rtree_queries_do_not_cache_a_pointer_type_per_result_count():
    # rtree 1.4.1's POINTER(c_int64 * n) retained a new class globally for each
    # unseen query cardinality. It cannot be reclaimed by gc.collect() at reset.
    before = set(ctypes._pointer_type_cache)
    cached_lengths = {
        key._length_
        for key in before
        if isinstance(key, type) and issubclass(key, ctypes.Array) and key._type_ is ctypes.c_int64
    }
    counts = [n for n in range(1000, 2000) if n not in cached_lengths][:32]
    assert len(counts) == 32
    tree = Index((i, (i, 0, i + 0.5, 1), None) for i in range(2000))
    try:
        for count in counts:
            assert sorted(tree.intersection((0, 0, count - 0.1, 1))) == list(range(count))
        assert list(tree.intersection((-2, -2, -1, -1))) == []
        # Closing a partially consumed result must still release its native buffer.
        results = tree.intersection((0, 0, 1999.9, 1))
        next(results)
        results.close()
    finally:
        tree.close()
    signed = Index([(-7, (0, 0, 1, 1), None), (2**63 - 2, (2, 0, 3, 1), None)])
    try:
        assert sorted(signed.intersection((-1, -1, 4, 2))) == [-7, 2**63 - 2]
    finally:
        signed.close()
    added = set(ctypes._pointer_type_cache) - before
    assert not any(
        isinstance(key, type) and issubclass(key, ctypes.Array) and key._type_ is ctypes.c_int64
        for key in added
    )


def test_completed_preparation_releases_futures_without_cyclic_gc():
    """A reset must release completed body preps now, not at a later generation-2 GC."""
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        children = [Future() for _ in range(3)]
        combined = simulation._gather(children)
        refs = [weakref.ref(future) for future in [*children, combined]]
        for index in range(len(children)):
            children[index].set_result(index)
        assert combined.result() == [0, 1, 2]
        del children, combined
        assert all(ref() is None for ref in refs)
    finally:
        if was_enabled:
            gc.enable()
        gc.collect()


def test_preparation_cancel_and_first_failure():
    children = [Future(), Future(), Future()]
    combined = simulation._gather(children)
    children[0].cancel()
    children[1].set_exception(ValueError("later failure"))
    children[2].set_result(3)
    with pytest.raises(RuntimeError, match="session reset"):
        combined.result()
    assert simulation._gather([]).result(timeout=1) == []


def test_expired_asset_request_is_not_a_worker_crash(monkeypatch):
    class ResetEngine:
        def get(self, *_args):
            raise simulation.AssetSessionReset("session reset")

    monkeypatch.setattr(module, "cloth_engine", lambda: ResetEngine())
    response = TestClient(module.app).get(f"/fit/{'a' * 64}/S/cloth")
    assert response.status_code == 410
    assert response.json()["detail"] == "Session reset; fit the body again"

    class BrokenEngine:
        def get(self, *_args):
            raise RuntimeError("genuine geometry failure")

    monkeypatch.setattr(module, "cloth_engine", lambda: BrokenEngine())
    with pytest.raises(RuntimeError, match="genuine geometry failure"):
        TestClient(module.app).get(f"/fit/{'a' * 64}/S/cloth")


def test_reset_stops_running_asset_process(monkeypatch):
    """A worker still running a forgotten body's job is terminated (and replaced); queued
    jobs of that body are cancelled; a worker busy with another body is kept warm."""
    previous = simulation._POOL
    monkeypatch.setattr(simulation, "_POOL", None)
    monkeypatch.setattr(simulation.config, "ASSET_WORKERS", 2)
    pool = simulation.asset_pool()
    assert pool is not None
    processes = []
    try:
        assert pool.wait_ready(120)
        processes = [worker.process for worker in pool._workers]
        running = pool.submit(time.sleep, 30, owner="judge")
        other = pool.submit(time.sleep, 2, owner="reference")
        queued = pool.submit(time.sleep, 30, owner="judge")
        deadline = time.monotonic() + 30
        while not (running.running() and other.running()) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert running.running() and other.running()
        assert simulation.forget_in_workers({"judge"}) == 1
        with pytest.raises(simulation.AssetSessionReset):
            running.result(timeout=5)
        assert queued.cancelled()
        assert other.result(timeout=30) is None  # the other body's job finished normally
        stopped = [p for p in processes if p.pid not in pool.pids()]
        assert len(stopped) == 1
        stopped[0].join(timeout=5)
        assert not stopped[0].is_alive()
        assert pool.wait_ready(120)  # replacement started; both workers still serve jobs
        assert len({pool.submit(simulation._worker_ping).result(timeout=60)}) == 1
    finally:
        pool.shutdown()
        simulation._POOL = previous


def _pool_controller(pipe):
    simulation.config.ASSET_WORKERS = 1
    pool = simulation.asset_pool()
    pipe.send(pool.submit(simulation._worker_ping).result(timeout=60))
    pipe.close()
    time.sleep(60)


@pytest.mark.skipif(os.name != "nt", reason="Windows watchdog process-handle check")
def test_asset_worker_exits_when_api_parent_is_killed():
    context = multiprocessing.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    controller = context.Process(target=_pool_controller, args=(writer,))
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    kernel.TerminateProcess.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
    worker = None
    try:
        controller.start()
        writer.close()
        assert reader.poll(60)
        # Pin our worker's handle before killing its parent (no PID reuse race).
        worker = kernel.OpenProcess(0x00100001, False, reader.recv())
        assert worker
        controller.terminate()
        controller.join(timeout=5)
        assert kernel.WaitForSingleObject(worker, 5000) == 0
    finally:
        if controller.is_alive():
            controller.terminate()
        controller.join(timeout=5)
        if worker:
            if kernel.WaitForSingleObject(worker, 0) != 0:
                kernel.TerminateProcess(worker, 1)
            kernel.CloseHandle(worker)
        reader.close()


def scan_request(base, sigma: float) -> FitRequest:
    measurements = base.measurements
    return BASE.model_copy(
        update={
            "scan_measurements": ScanMeasurements(
                shoulder_width_cm=ScanValue(
                    value_cm=measurements["shoulder_width"].value_cm + SHOULDER_DELTA_CM,
                    sigma_cm=sigma,
                ),
                chest_cm=ScanValue(
                    value_cm=measurements["chest"].value_cm + CHEST_DELTA_CM, sigma_cm=sigma
                ),
                calibration="test-synthetic",
            )
        }
    )


def test_scan_validation():
    payload = {"height_cm": 172, "weight_kg": 65, "sex": "male"}
    ok = {"chest_cm": {"value_cm": 98, "sigma_cm": 2.5, "method": "front+side ellipse"}}
    FitRequest.model_validate({**payload, "scan_measurements": ok})
    for bad in (
        {"chest_cm": {"value_cm": 98, "sigma_cm": 0}},  # sigma must be > 0 (vision clamps 0.1)
        {"chest_cm": {"value_cm": 98, "sigma_cm": -1}},
        {"chest_cm": {"value_cm": 300, "sigma_cm": 2}},  # outside physical range
        {"shoulder_width_cm": {"value_cm": 10, "sigma_cm": 2}},
        {"chest_cm": {"value_cm": 98, "sigma_cm": 2, "extra": 1}},  # extra="forbid"
        {"neck_cm": {"value_cm": 38, "sigma_cm": 2}},  # not a ScanMeasurementName
        {"chest_cm": {"value_cm": "98", "sigma_cm": 2}},  # strict numbers
        {"calibration": "../etc"},
    ):
        with pytest.raises(ValidationError):
            FitRequest.model_validate({**payload, "scan_measurements": bad})


@pytest.mark.slow
def test_scan_pulls_in_proportion_to_weight(fitter):
    base = fitter.fit(BASE).response
    moves = {}
    for sigma in (1.5, 6.0):
        result = fitter.fit(scan_request(base, sigma)).response
        assert result.converged  # height and mass stay hard targets
        assert result.scan is not None and result.scan.source == "webcam_scan"
        assert result.scan.base_body_id == base.body_id
        assert set(result.scan.entries) == {"shoulder_width_cm", "chest_cm"}
        assert "chest" not in result.targets  # soft, not a hard target
        moves[sigma] = {
            name: result.measurements[name].value_cm - base.measurements[name].value_cm
            for name in ("shoulder_width", "chest")
        }
    print("scan moves (cm) by sigma:", moves)
    for name, delta in (("shoulder_width", SHOULDER_DELTA_CM), ("chest", CHEST_DELTA_CM)):
        # Toward the scan value, and more strongly with the larger weight 1/sigma^2.
        assert 0 < moves[6.0][name] < moves[1.5][name]
        assert moves[1.5][name] > 0.5 * delta
        assert moves[6.0][name] < 0.75 * delta


@pytest.mark.slow
def test_huge_sigma_gives_the_no_scan_body(fitter):
    plain = fitter.fit(BASE)
    huge = fitter.fit(scan_request(plain.response, 1.0e4))
    assert huge.response.body_id != plain.response.body_id
    for name, measurement in plain.response.measurements.items():
        assert huge.response.measurements[name].value_cm == pytest.approx(
            measurement.value_cm, abs=0.05
        )
    assert np.abs(huge.mesh.vertices - plain.mesh.vertices).max() < 1e-3  # metres


@pytest.mark.slow
def test_tape_value_overrides_scan_of_same_name(fitter):
    base = fitter.fit(BASE).response
    request = scan_request(base, 2.0).model_copy(
        update={
            "known_measurements": KnownMeasurements(chest_cm=base.measurements["chest"].value_cm)
        }
    )
    result = fitter.fit(request).response
    assert result.scan is not None
    assert result.scan.overridden_by_tape == ["chest_cm"]
    assert set(result.scan.entries) == {"shoulder_width_cm"}
    assert abs(result.residuals["chest"]) < 1.5


@pytest.mark.slow
def test_scan_narrows_uncertainty_band(fitter):
    base = fitter.fit(BASE).response
    scanned = fitter.fit(scan_request(base, 2.0)).response
    before = fitter.uncertainty(base.body_id).bands["chest"]
    after = fitter.uncertainty(scanned.body_id).bands["chest"]
    assert before is not None and after is not None
    print("chest band width", before.upper_cm - before.lower_cm, after.upper_cm - after.lower_cm)
    assert after.upper_cm - after.lower_cm < before.upper_cm - before.lower_cm


@pytest.mark.slow
def test_api_scan_report_and_forget(fitter, monkeypatch):
    monkeypatch.setattr(module, "fitter", fitter)
    client = TestClient(module.app)
    plain = client.post("/body/fit", json={"height_cm": 172, "weight_kg": 65, "sex": "male"})
    assert plain.status_code == 200 and "scan" not in plain.json()
    base = plain.json()
    scan = {
        "shoulder_width_cm": {
            "value_cm": base["measurements"]["shoulder_width"]["value_cm"] + 2,
            "sigma_cm": 2.0,
            "method": "test",
        },
        "calibration": "uncalibrated",
    }
    response = client.post(
        "/body/fit",
        json={"height_cm": 172, "weight_kg": 65, "sex": "male", "scan_measurements": scan},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["scan"]["source"] == "webcam_scan"
    assert any("uncalibrated" in warning for warning in data["warnings"])
    product_id = client.get("/products").json()[0]["product_id"]
    garment = client.post(
        "/fit/garment", json={"body_id": data["body_id"], "product_id": product_id}
    )
    assert garment.status_code == 200
    fit_id = garment.json()["fit_id"]
    assert client.get(f"/motion/{data['body_id']}/anchors").status_code == 200
    assert client.get(f"/motion/{base['body_id']}/anchors").status_code == 200
    gone = client.delete(f"/body/{data['body_id']}")
    assert gone.status_code == 200
    assert gone.json()["removed"]["bodies"] == 2  # scan body and its no-scan base
    # Motion rig/anchors/collision fields and asset-worker caches are forgotten too.
    assert gone.json()["removed"]["motion"] == 2
    assert "asset_workers_recycled" in gone.json()["removed"]
    assert client.get(f"/motion/{data['body_id']}/anchors").status_code == 404
    assert client.get(f"/motion/{base['body_id']}/anchors").status_code == 404
    assets = module.simulation_engine
    assert assets is not None
    with assets.lock:
        assert not ({data["body_id"], base["body_id"]} & assets.bodies.keys())
        assert not ({data["body_id"], base["body_id"]} & assets.preps.keys())
        assert not assets.pending  # includes speculative fits missing from garment cache
    assert gone.json()["removed"]["garment_fits"] == 1
    assert client.get(f"/fit/{fit_id}/S/garment.glb").status_code == 404
    assert client.get(f"/body/{data['body_id']}/landmarks").status_code == 404
    assert client.get(f"/body/{base['body_id']}/landmarks").status_code == 404
    assert client.delete("/body/not-a-hash").status_code == 422
