"""Fit Agent service on its own port (until the router is mounted in app.py; see QUESTIONS F5).

    python -m uvicorn body_service.agent.standalone:app --host 127.0.0.1 --port 8011

Same loopback/privacy rules as app.py: 127.0.0.1 only, trusted hosts, no-store responses. It
loads its own Anny model (about 1 GB RAM), so do not run it next to a second body service on a
machine that is short of memory.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ..fit import Fitter
from ..model import BodyEngine
from .router import create_router

fitter: Fitter | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global fitter
    fitter = Fitter(BodyEngine())
    previous = None
    if os.environ.get("FIT_AGENT_STUDIO") == "1":
        from .. import app as studio

        # One model/cache in this own-port process; no other service is contacted.
        previous = studio.fitter
        studio.fitter = fitter
    try:
        yield
    finally:
        if os.environ.get("FIT_AGENT_STUDIO") == "1":
            studio.fitter = previous
            studio.garment_engine = None
            studio.simulation_engine = None
        fitter = None


def service() -> Fitter:
    if fitter is None:
        raise HTTPException(503, "Anny is still loading")
    return fitter


app = FastAPI(title="Satisfy — Fit Agent (standalone)", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.middleware("http")
async def private_responses(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health")
def health() -> dict:
    return {"model_loaded": fitter is not None, "service": "fit-agent-standalone"}


app.include_router(create_router(service))

# Explicit local-demo opt-in: reuse the existing service routes/math for the studio.
# The mounted app's lifespan is not run (it would allocate a second model).
if os.environ.get("FIT_AGENT_STUDIO") == "1":
    from ..app import app as studio_app

    app.mount("/", studio_app)
