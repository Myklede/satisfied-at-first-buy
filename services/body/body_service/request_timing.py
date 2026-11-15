"""Opt-in local timing; numeric headers only, no telemetry, measurements or logs.

Compatibility: pinned FastAPI 0.162's ModelField.serialize_json fast path is
wrapped, never replaced with a slower JSONResponse/model_dump pipeline.
"""

from collections.abc import Callable
from contextvars import ContextVar
from functools import wraps
from time import perf_counter

from fastapi import FastAPI, Request
from fastapi.routing import APIRoute
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

_current: ContextVar[dict[str, float] | None] = ContextVar("local_request_timing", default=None)


def timed_asset[T](
    get: Callable[[], T], phases: Callable[[float], dict[str, float]] | None = None
) -> T:
    """``phases(request_start)``: optional numeric build phases (ms), added as ``build_*``."""
    state = _current.get()
    if state is None:
        return get()
    started = perf_counter()
    state["dispatch"] = (started - state["started"]) * 1000
    try:
        return get()
    finally:
        state["asset_wait"] = (perf_counter() - started) * 1000
        if phases is not None:
            for name, value in phases(state["started"]).items():
                state[f"build_{name}"] = float(value)


class LocalTimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        state = {"started": perf_counter()}
        token = _current.set(state)
        try:
            response = await call_next(request)
            state["app"] = (perf_counter() - state["started"]) * 1000
            response.headers["Server-Timing"] = ", ".join(
                f"{name};dur={value:.3f}" for name, value in state.items() if name != "started"
            )
            return response
        finally:
            _current.reset(token)


def install_timing(app: FastAPI) -> None:
    """Call once before startup, only when SATISFY_TIMINGS=1."""
    if getattr(app.state, "local_timing_installed", False):
        return
    for route in app.routes:
        if not isinstance(route, APIRoute) or route.response_field is None:
            continue
        field = route.response_field
        original = field.serialize_json

        @wraps(original)
        def serialize(*args, _original=original, **kwargs):
            state = _current.get()
            if state is None:
                return _original(*args, **kwargs)
            started = perf_counter()
            try:
                return _original(*args, **kwargs)
            finally:
                state["json_encode"] = (perf_counter() - started) * 1000

        field.serialize_json = serialize
    app.add_middleware(LocalTimingMiddleware)
    app.state.local_timing_installed = True
