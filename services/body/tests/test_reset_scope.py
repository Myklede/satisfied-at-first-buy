"""A kiosk reset cancels only its own body's in-flight cloth builds (no 410 for other clients)."""

from concurrent.futures import Future

import pytest
from body_service.garment.simulation import SimulationAssets
from body_service.garment.workers import AssetSessionReset

A, B = "a" * 64, "b" * 64


def _pending(engine: SimulationAssets, fit_id: str, size: str, body_id: str) -> Future:
    """Register an in-flight build the way ``request`` does (pending + its body)."""
    outer: Future = Future()
    engine.pending[(fit_id, size)] = outer
    engine.pending_bodies[(fit_id, size)] = body_id
    return outer


def test_reset_cancels_only_the_forgotten_bodys_builds():
    engine = SimulationAssets(garments=None)
    a_m, a_l = _pending(engine, "fa", "M", A), _pending(engine, "fa", "L", A)
    b_m = _pending(engine, "fb", "M", B)

    assert engine.cancel_pending({A}) == 2

    for future in (a_m, a_l):
        with pytest.raises(AssetSessionReset):
            future.result(timeout=0)
    assert not b_m.done()  # the other client's build keeps running
    assert set(engine.pending) == {("fb", "M")}
    assert engine.pending_bodies == {("fb", "M"): B}


def test_reset_skips_finished_builds_and_unknown_bodies():
    engine = SimulationAssets(garments=None)
    done = _pending(engine, "fa", "M", A)
    done.set_result("asset")
    assert engine.cancel_pending({A}) == 0  # already finished: nothing to cancel
    assert done.result() == "asset"
    assert engine.pending == {}
    assert engine.cancel_pending({B}) == 0
