"""Loopback-only service; no measurements persist to disk or leave the machine."""

# Native allocator policy must precede Anny / torch loading their DLLs.
# ruff: noqa: E402

import gc
import logging
import os
import threading
import time
from collections.abc import AsyncIterator
from contextlib import ExitStack, asynccontextmanager
from typing import Annotated

from . import config

if config.API_DISABLE_MKL_FAST_MM:
    os.environ.setdefault("MKL_DISABLE_FAST_MM", "1")

import anny
from fastapi import FastAPI, HTTPException, Path, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .fit import FittedBody, Fitter
from .garment.models import GarmentFitRequest, GarmentFitResponse, GarmentOptions, GarmentSpec
from .garment.service import GarmentService
from .garment.simulation import (
    AssetSessionReset,
    ClothAsset,
    SimulationAssets,
    asset_pool,
    forget_in_workers,
    warm_asset_pool,
)
from .garment.workers import PRIORITY_LATER, PRIORITY_SHOWN
from .model import BodyEngine
from .native_cache import _bounded_rtree_ids, install_rtree_ids  # noqa: F401 - re-export
from .request_timing import install_timing, timed_asset
from .schemas import (
    CapabilitiesResponse,
    FitRequest,
    FitResponse,
    ForgetResponse,
    HealthResponse,
    LandmarkResponse,
    UncertaintyResponse,
)
from .session import forget_body

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
fitter: Fitter | None = None
garment_engine: GarmentService | None = None
simulation_engine: SimulationAssets | None = None


# rtree 1.4.1 ID-iterator adapter (C, bounded memory): see native_cache.py.
install_rtree_ids()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global fitter, garment_engine
    fitter = Fitter(BodyEngine())
    garment_engine = GarmentService(fitter)
    # Cloth-asset worker processes start now (their imports take seconds), not on the
    # first jacket. Daemon thread: startup does not wait for them.
    threading.Thread(target=warm_asset_pool, daemon=True).start()
    yield
    fitter = None
    garment_engine = None


app = FastAPI(title="Satisfy at the First Buy — Body Engine", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5710", "http://localhost:5710"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
BodyId = Annotated[str, Path(pattern=r"^[a-f0-9]{64}$")]


active_requests = 0


@app.middleware("http")
async def private_responses(request: Request, call_next) -> Response:
    global active_requests
    active_requests += 1  # the background cloth warm-up yields while any request is active
    try:
        response = await call_next(request)
    finally:
        active_requests -= 1
    response.headers["Cache-Control"] = "no-store"
    return response


def service() -> Fitter:
    if fitter is None:
        raise HTTPException(503, "Anny is still loading")
    return fitter


# Fit-in-motion: rig, presets, articulated collision fields and anchors (agent P1).
from .motion.api import create_router as motion_router  # noqa: E402
from .motion.api import forget_motion_body  # noqa: E402

app.include_router(motion_router(service))

# Fit Agent (M5): Amazon size chart → fit recommendation; opt-in local profile (agent/router.py).
from .agent.router import create_router as fit_agent_router  # noqa: E402

app.include_router(fit_agent_router(service))


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        model_loaded=fitter is not None,
        anny_version=anny.__version__,
        engine_version=config.MODEL_VERSION,
    )


@app.get("/body/capabilities", response_model=CapabilitiesResponse)
def capabilities() -> CapabilitiesResponse:
    return CapabilitiesResponse(
        phenotype_labels=service().engine.model.phenotype_labels,
        shape_reference_supported=True,
        shape_references=["neutral", "african", "asian", "caucasian"],
        measurements=[
            "stature",
            "chest",
            "waist",
            "hip",
            "neck_base",
            "upper_arm",
            "wrist",
            "shoulder_width",
            "shoulder_arc",
            "back_length",
            "arm_length",
        ],
    )


@app.post("/body/fit", response_model=FitResponse)
def fit(request: FitRequest) -> FitResponse:
    try:
        response = service().fit(request).response
        threading.Thread(target=speculate_cloth, args=(response.body_id,), daemon=True).start()
        return response
    except (ValueError, RuntimeError) as error:
        logging.exception("Body geometry computation failed")
        raise HTTPException(
            422, "Unable to measure this shape reliably; try less extreme targets"
        ) from error


@app.delete("/body/{body_id}", response_model=ForgetResponse)
def forget(body_id: BodyId) -> ForgetResponse:
    """Kiosk reset: drop this body and everything derived from it from RAM now."""
    judge_ids = {body_id}
    # Same lock order as asset requests: garment -> simulation -> fitter. A late
    # worker callback cannot store an asset between the body and asset removals.
    with ExitStack() as locks:
        if garment_engine is not None:
            locks.enter_context(garment_engine.lock)
        if simulation_engine is not None:
            locks.enter_context(simulation_engine.lock)
        with service().lock:
            scan = getattr(getattr(service().cache.get(body_id), "response", None), "scan", None)
            if scan is not None:
                judge_ids.add(scan.base_body_id)
        counts = forget_body(service(), garment_engine, simulation_engine, body_id)
        if garment_engine is not None:
            counts["speculative_fits"] = garment_engine.forget_speculative(judge_ids)
        if simulation_engine is not None:
            # Cancel this judge's in-flight builds (outer waiters), including unregistered
            # speculative fits of the same body, before releasing the lock. Other bodies'
            # builds keep running: since P2 the workers are cancelled per body too (see
            # forget_in_workers below), so another client's cloth request is not 410'd.
            counts["cloth_builds_cancelled"] = simulation_engine.cancel_pending(judge_ids)
            simulation_engine.forget_timings(judge_ids)
    counts["motion"] = sum(forget_motion_body(bid) for bid in judge_ids)
    # Worker processes cache body sections: their queued jobs are cancelled, a worker still
    # building for this body is terminated (and replaced), every other worker drops them
    # (P2: warm workers stay warm for the next judge; see garment/workers.py).
    counts["asset_workers_recycled"] = forget_in_workers(judge_ids)
    # Trimesh also has legitimate internal cycles; collect at this explicit privacy
    # boundary instead of retaining forgotten geometry until a later judge. This is
    # normal collection, not an OS working-set trim or a change to the LRU limits.
    counts["gc_objects"] = gc.collect()
    return ForgetResponse(body_id=body_id, removed=counts)


def cached(body_id: str) -> FittedBody:
    try:
        return service().get(body_id)
    except KeyError as error:
        raise HTTPException(404, "Body expired from memory; fit again") from error


@app.get(
    "/body/{body_id}/mesh.glb",
    response_class=Response,
    responses={200: {"content": {"model/gltf-binary": {}}}},
)
def mesh(body_id: BodyId) -> Response:
    return Response(
        cached(body_id).glb, media_type="model/gltf-binary", headers={"Cache-Control": "no-store"}
    )


@app.get("/body/{body_id}/landmarks", response_model=LandmarkResponse)
def landmarks(body_id: BodyId) -> LandmarkResponse:
    return cached(body_id).landmarks


@app.get("/body/{body_id}/uncertainty", response_model=UncertaintyResponse)
def uncertainty(body_id: BodyId) -> UncertaintyResponse:
    cached(body_id)
    return service().uncertainty(body_id)


def garment_service() -> GarmentService:
    global garment_engine
    body_fitter = service()
    if garment_engine is None or garment_engine.fitter is not body_fitter:
        garment_engine = GarmentService(body_fitter)
    return garment_engine


@app.get("/products", response_model=list[GarmentSpec])
def products() -> list[GarmentSpec]:
    return list(garment_service().products.values())


@app.get("/products/{product_id}", response_model=GarmentSpec)
def product(product_id: BodyId) -> GarmentSpec:
    try:
        return garment_service().products[product_id]
    except KeyError as error:
        raise HTTPException(404, "Unknown product") from error


@app.get("/garment/options", response_model=GarmentOptions)
def garment_options() -> GarmentOptions:
    return GarmentOptions()


def cloth_engine() -> SimulationAssets:
    global simulation_engine
    garments = garment_service()
    if simulation_engine is None or simulation_engine.garments is not garments:
        simulation_engine = SimulationAssets(garments)
    return simulation_engine


def speculate_cloth(body_id: str) -> None:
    """Start what the kiosk shows next while it is still displaying the body (03c speed).

    Body-only work (pose, SDF, sections) and the recommended size of every jacket for the
    default request (the kiosk's: t-shirt under-layer, regular preference) start in the
    asset workers now. A later identical garment fit gets the same fit_id, so its cloth
    request joins these builds instead of starting new ones. Nothing is sent anywhere.
    """
    if asset_pool() is None:
        return  # inline builds would hold the service locks; speculate only with workers
    try:
        garments = garment_service()
        engine = cloth_engine()
        engine.prepare(body_id)
        for product in garments.products.values():
            if product.visual is None:
                continue
            # Computed like the kiosk's own garment fit (same fit_id) but not kept in the
            # garment cache: only the client's own fit request registers a fit (and then
            # takes this one instead of computing it again).
            response = garments.fit(
                GarmentFitRequest(body_id=body_id, product_id=product.product_id),
                register=False,
            ).response
            size = response.recommended_size
            if size and response.sizes[size].geometry_available:
                engine.request(response.fit_id, size, fit=response)
    except (HTTPException, KeyError, ValueError, RuntimeError):
        return


def warm_cloth(fit_id: str, sizes: list[str]) -> None:
    """Build every size's cloth asset in the background right after a garment fit (03c).

    The first (recommended) size starts at once, so a jacket request that arrives a moment
    later joins that build. Further sizes start one at a time and only while no request is
    active and no shown (recommended or requested) build of any jacket is in flight, so they
    never delay what the shopper is waiting for (P2: not even the other jacket's).
    """
    engine = cloth_engine()
    for index, size in enumerate(sizes):
        while index and (active_requests or engine.shown_pending()):
            time.sleep(0.05)
        try:
            engine.get(fit_id, size, PRIORITY_LATER if index else PRIORITY_SHOWN)
        except (KeyError, ValueError, RuntimeError):  # RuntimeError: workers shut down
            return


def recommended(fit_id: str) -> str | None:
    try:
        return garment_service().get(fit_id).response.recommended_size
    except (KeyError, HTTPException):
        return None  # unregistered (speculative) fit, or no model yet: the asset path decides


@app.get("/fit/{fit_id}/{size}/cloth", response_model=ClothAsset)
def cloth_asset(
    fit_id: BodyId, size: Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$")]
) -> ClothAsset:
    engine = cloth_engine()
    try:
        # No outer lock: the engine locks its caches itself, so both jackets build at once.
        # The recommended size is what the kiosk dresses right after the scan: its build is
        # raised while the shopper waits (other sizes, e.g. the client's precompute, are not).
        waited = size == recommended(fit_id)
        return timed_asset(
            lambda: engine.get(fit_id, size, PRIORITY_SHOWN, waited),
            lambda since: engine.asset_timing(fit_id, size, since),
        )
    except AssetSessionReset as error:
        raise HTTPException(410, "Session reset; fit the body again") from error
    except KeyError as error:
        raise HTTPException(404, "Fit expired or size unknown") from error


@app.get(
    "/collision/{sdf_id}.bin",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
def collision_binary(sdf_id: BodyId) -> Response:
    # The field is built in a worker in parallel with the jackets; wait for it if needed.
    field = None if simulation_engine is None else simulation_engine.sdf(sdf_id, timeout=60)
    if field is None:
        raise HTTPException(404, "Collision field expired; request cloth again")
    return Response(field, media_type="application/octet-stream")


@app.post("/fit/garment", response_model=GarmentFitResponse)
def fit_garment(request: GarmentFitRequest) -> GarmentFitResponse:
    try:
        response = garment_service().fit(request).response
    except KeyError as error:
        raise HTTPException(404, "Body expired or product unknown; fit body again") from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    owned = garment_service().products[response.product_id].owned_size
    names = list(response.sizes)
    first = response.recommended_size or owned
    origin = names.index(first) if first in names else 0
    # The recommended size first (the kiosk dresses it at once), then the nearest sizes
    # (the shopper's likely next click), larger first on ties.
    order = sorted(names, key=lambda size: (abs(names.index(size) - origin), -names.index(size)))
    threading.Thread(target=warm_cloth, args=(response.fit_id, order), daemon=True).start()
    return response


@app.get(
    "/fit/{fit_id}/{size}/garment.glb",
    response_class=Response,
    responses={200: {"content": {"model/gltf-binary": {}}}},
)
def garment_mesh(
    fit_id: BodyId, size: Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$")]
) -> Response:
    try:
        bundle = garment_service().get(fit_id)
        if size not in bundle.response.sizes:
            raise KeyError(size)
    except KeyError as error:
        raise HTTPException(404, "Garment fit expired or size unknown") from error
    if not bundle.response.sizes[size].geometry_available:
        raise HTTPException(
            409, "Garment geometry unavailable: missing measurements; dimensions were not invented"
        )
    return Response(garment_service().get_mesh(fit_id, size).glb, media_type="model/gltf-binary")


if os.environ.get("SATISFY_TIMINGS") == "1":
    install_timing(app)
