"""FastAPI router for motion data. Not mounted here: app.py (agent C) includes it with

    from .motion.api import create_router as motion_router
    app.include_router(motion_router(service))

Loopback-only like the rest of the service (binding and CORS live in app.py). Body data is
looked up in the existing Fitter memory cache by its sha256 body_id and never persisted.
"""

from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict

from .custom import CustomMotionRequest
from .presets import MOTIONS, Motion
from .service import MotionService

BodyId = Annotated[str, Path(pattern=r"^[a-f0-9]{64}$")]
MotionId = Annotated[str, Path(pattern=r"^[a-z_]{1,32}$")]
BINARY = {200: {"content": {"application/octet-stream": {}}}}


class AttachmentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vertices: list[list[int]]
    weights: list[list[float]]
    rest: list[list[float]]


class AnchorsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str
    frame: str
    ring_samples: int
    ring_index: dict[str, int]
    rings: dict[str, AttachmentModel]
    tapes: dict[str, AttachmentModel]
    points: dict[str, int]
    heights_m: dict[str, float]
    exposure_vertices: dict[str, list[int]]
    waistband_default: str


_SERVICES: list[MotionService] = []


class PrivateBodyRoute(APIRoute):
    """A route whose request body is body data (recorded poses). Its 422 lists where and why
    the request is invalid but never echoes the input: FastAPI's default error body repeats
    the offending values, and fails with a 500 on JSON NaN / Infinity (which json.loads
    accepts and the finite-number check then rejects)."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def route(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as error:
                detail = [
                    {"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]}
                    for e in error.errors()
                ]
                return JSONResponse({"detail": detail}, status_code=422)

        return route


def forget_motion_body(body_id: str) -> int:
    """Kiosk reset: drop this body's rig, anchors, collision fields and frames from RAM.
    Custom (recorded) motions are never stored, so nothing of them remains to drop."""
    removed = 0
    for svc in _SERVICES:
        with svc.lock:
            if svc.cache.pop(body_id, None) is not None:
                removed += 1
    return removed


def create_router(get_fitter: Callable[[], object]) -> APIRouter:
    """`get_fitter` returns the live Fitter or raises HTTPException(503) while loading."""
    router = APIRouter(prefix="/motion", tags=["motion"])
    holder: dict[str, MotionService] = {}

    def service() -> MotionService:
        fitter = get_fitter()
        current = holder.get("service")
        if current is None or current.fitter is not fitter:
            holder["service"] = current = MotionService(fitter)
            _SERVICES[:] = [current]
        return current

    def private(data: bytes) -> Response:
        return Response(
            data, media_type="application/octet-stream", headers={"Cache-Control": "no-store"}
        )

    def expired(error: KeyError) -> HTTPException:
        return HTTPException(404, "Body expired from memory; fit again")

    @router.get("/presets", response_model=list[Motion])
    def presets() -> list[Motion]:
        return list(MOTIONS.values())

    @router.get("/{body_id}/rig.bin", response_class=Response, responses=BINARY)
    def rig(body_id: BodyId) -> Response:
        try:
            return private(service().rig_bytes(body_id))
        except KeyError as error:
            raise expired(error) from error

    @router.get("/{body_id}/sdf.bin", response_class=Response, responses=BINARY)
    def sdf(body_id: BodyId) -> Response:
        try:
            return private(service().sdf_bytes(body_id))
        except KeyError as error:
            raise expired(error) from error

    @router.get("/{body_id}/anchors", response_model=AnchorsResponse)
    def anchors(body_id: BodyId) -> AnchorsResponse:
        try:
            return AnchorsResponse(**service().anchors_json(body_id))
        except KeyError as error:
            raise expired(error) from error

    def custom_frames(body_id: BodyId, request: CustomMotionRequest) -> Response:
        """A recorded pose sequence (prompt 14 "Record a move") as motion frames, through the
        preset code path (custom.py). The poses are body data: never logged, never kept."""
        try:
            return private(service().custom_frames_bytes(body_id, request))
        except KeyError as error:
            raise expired(error) from error

    router.add_api_route(
        "/{body_id}/custom/frames.bin",
        custom_frames,
        methods=["POST"],
        response_class=Response,
        responses=BINARY,
        route_class_override=PrivateBodyRoute,
    )

    @router.get("/{body_id}/{motion_id}/frames.bin", response_class=Response, responses=BINARY)
    def frames(body_id: BodyId, motion_id: MotionId) -> Response:
        if motion_id not in MOTIONS:
            raise HTTPException(404, "Unknown motion")
        try:
            return private(service().frames_bytes(body_id, motion_id))
        except KeyError as error:
            raise expired(error) from error

    return router
