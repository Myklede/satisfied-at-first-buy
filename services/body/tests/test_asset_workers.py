"""P2: addressable asset workers (priority order, promotion, forget, crash recovery)."""

import os
import time
from concurrent.futures.process import BrokenProcessPool

import numpy as np
import pytest
from body_service.garment import simulation
from body_service.garment.workers import PRIORITY_BODY, PRIORITY_LATER, PRIORITY_SHOWN


@pytest.fixture
def one_worker(monkeypatch):
    previous = simulation._POOL
    monkeypatch.setattr(simulation, "_POOL", None)
    monkeypatch.setattr(simulation.config, "ASSET_WORKERS", 1)
    pool = simulation.asset_pool()
    assert pool is not None and pool.wait_ready(120)
    try:
        yield pool
    finally:
        pool.shutdown()
        simulation._POOL = previous


def test_priority_order_then_fifo_and_promotion(one_worker):
    pool = one_worker
    blocker = pool.submit(time.sleep, 1.0, priority=PRIORITY_BODY)
    later = pool.submit(time.perf_counter, priority=PRIORITY_LATER)
    later2 = pool.submit(time.perf_counter, priority=PRIORITY_LATER)
    promoted = pool.submit(time.perf_counter, priority=PRIORITY_LATER)
    shown = pool.submit(time.perf_counter, priority=PRIORITY_SHOWN)
    assert pool.promote(promoted, PRIORITY_SHOWN)
    blocker.result(timeout=60)
    order = sorted(
        [
            ("later", later.result(60)),
            ("later2", later2.result(60)),
            ("promoted", promoted.result(60)),
            ("shown", shown.result(60)),
        ],
        key=lambda item: item[1],
    )
    # Same priority runs in submission order: promoted (submitted first) before shown.
    assert [name for name, _ in order] == ["promoted", "shown", "later", "later2"]
    assert not pool.promote(later, PRIORITY_SHOWN)  # already done


def test_job_errors_reach_the_future_and_the_worker_survives(one_worker):
    pool = one_worker
    pid = pool.pids()[0]
    with pytest.raises(ValueError):
        pool.submit(int, "not a number").result(timeout=60)
    assert pool.submit(simulation._worker_ping).result(timeout=60) == pid


def test_unexpected_worker_exit_is_an_error_and_the_worker_is_replaced(one_worker):
    pool = one_worker
    pid = pool.pids()[0]
    with pytest.raises(BrokenProcessPool):
        pool.submit(os._exit, 3).result(timeout=60)
    assert pool.wait_ready(120)
    assert pool.submit(simulation._worker_ping).result(timeout=60) != pid


def test_forget_runs_in_idle_workers_before_their_next_job(one_worker):
    pool = one_worker
    pid = pool.pids()[0]
    assert simulation.forget_in_workers({"a" * 64}) == 0  # nothing running: no worker stopped
    # The forget call ran first (FIFO per worker); the same warm process serves the next job.
    assert pool.submit(simulation._worker_ping).result(timeout=60) == pid
    assert pool.submit(simulation._forget_worker_bodies, {"a" * 64}).result(timeout=60) == 0


def test_shutdown_cancels_and_rejects(one_worker):
    pool = one_worker
    running = pool.submit(time.sleep, 30)
    queued = pool.submit(time.sleep, 30)
    deadline = time.monotonic() + 30
    while not running.running() and time.monotonic() < deadline:
        time.sleep(0.05)
    pool.shutdown()
    assert queued.cancelled()
    with pytest.raises(simulation.AssetSessionReset):
        running.result(timeout=5)
    with pytest.raises(RuntimeError):
        pool.submit(time.sleep, 0)


def test_meshes_ship_without_their_cache_and_compute_the_same(one_worker):
    import trimesh

    mesh = trimesh.creation.icosphere(subdivisions=2)
    _ = mesh.triangles_tree  # an rtree index in the cache must not be pickled
    data = one_worker.submit(getattr, mesh, "vertices").result(timeout=60)
    assert np.array_equal(data, mesh.vertices)
    assert one_worker.submit(getattr, mesh, "area").result(timeout=60) == mesh.area
    query = np.array([[0.0, 0.0, 2.0]])
    closest = one_worker.submit(trimesh.proximity.closest_point, mesh, query).result(timeout=60)
    expected = trimesh.proximity.closest_point(mesh, query)
    assert all(np.array_equal(a, b) for a, b in zip(closest, expected, strict=True))


def test_a_failed_worker_build_falls_back_in_process_with_the_same_asset(
    one_worker, fitter, monkeypatch
):
    """A judge never gets an error for a worker failure: the API builds the asset itself."""
    from concurrent.futures import Future

    from body_service.garment.models import GarmentFitRequest
    from body_service.garment.service import GarmentService
    from body_service.schemas import FitRequest

    garments = GarmentService(fitter)
    body = fitter.fit(FitRequest(height_cm=168, weight_kg=62, sex="female")).response.body_id
    product = next(p for p in garments.products.values() if p.visual)
    fit = garments.fit(GarmentFitRequest(body_id=body, product_id=product.product_id)).response
    size = fit.recommended_size
    submit = one_worker.submit

    def broken(fn, *args, **kwargs):
        if fn is simulation._shell_job:
            failed: Future = Future()
            failed.set_exception(BrokenProcessPool("synthetic worker crash"))
            return failed
        return submit(fn, *args, **kwargs)

    monkeypatch.setattr(one_worker, "submit", broken)
    fallback = simulation.SimulationAssets(garments).get(fit.fit_id, size)
    monkeypatch.setattr(one_worker, "submit", submit)
    normal = simulation.SimulationAssets(garments).get(fit.fit_id, size)
    exclude = {"build_ms"}
    assert fallback.model_dump_json(exclude=exclude) == normal.model_dump_json(exclude=exclude)


def _priority_class(pid: int) -> int:
    import ctypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.GetPriorityClass.argtypes = (ctypes.c_void_p,)
    kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel.OpenProcess(0x1000, 0, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    try:
        return kernel.GetPriorityClass(handle)
    finally:
        kernel.CloseHandle(handle)


def _becomes(pid: int, expected: int) -> bool:
    # The class is set right after dispatch / completion, outside the pool lock: poll briefly.
    deadline = time.monotonic() + 5
    while _priority_class(pid) != expected and time.monotonic() < deadline:
        time.sleep(0.01)
    return _priority_class(pid) == expected


@pytest.mark.skipif(os.name != "nt", reason="Windows priority classes")
def test_a_waited_job_runs_raised_and_the_worker_returns_to_its_base_class(one_worker):
    from body_service.garment.workers import WAITED_PRIORITY_CLASS

    pid = one_worker.pids()[0]
    base = simulation.config.ASSET_WORKER_PRIORITY_CLASS
    assert _priority_class(pid) == base
    running = one_worker.submit(time.sleep, 1.5)
    queued = one_worker.submit(time.sleep, 1.5)
    deadline = time.monotonic() + 30
    while not running.running() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert one_worker.boost(running, WAITED_PRIORITY_CLASS)
    assert _priority_class(pid) == WAITED_PRIORITY_CLASS
    assert one_worker.boost(queued, WAITED_PRIORITY_CLASS)  # raised when it is dispatched
    running.result(timeout=30)
    deadline = time.monotonic() + 30
    while not queued.running() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert _becomes(pid, WAITED_PRIORITY_CLASS)
    queued.result(timeout=30)
    assert one_worker.submit(simulation._worker_ping).result(timeout=30) == pid
    assert _becomes(pid, base)


def test_a_long_lived_idle_worker_is_rotated_at_a_reset(one_worker):
    from body_service.garment.workers import WORKER_MAX_SESSIONS

    pid = one_worker.pids()[0]
    for _ in range(WORKER_MAX_SESSIONS - 1):
        assert simulation.forget_in_workers({"b" * 64}) == 0
        one_worker.submit(simulation._worker_ping).result(timeout=60)  # forget call ran
    assert simulation.forget_in_workers({"b" * 64}) == 1
    assert one_worker.wait_ready(120)
    assert one_worker.submit(simulation._worker_ping).result(timeout=60) != pid
