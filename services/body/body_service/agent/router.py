"""FastAPI router for the Fit Agent (M5). Mount with `app.include_router(create_router(service))`.

Privacy:
- Personal endpoints (profile, purchases, feedback, learning, recommend with a body) refuse any
  http(s) web Origin — only the extension (chrome-extension://) or a local non-browser client.
  This keeps the kiosk page and arbitrary websites out of the profile (no CSRF via loopback).
- Kiosk mode (SATISFY_KIOSK_MODE=1): no profile or feedback is read or written.
- Nothing body-related is cached here: bodies live in the Fitter's RAM LRU, which the kiosk's
  DELETE /body/{id} already clears.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import ValidationError

from ..fit import FittedBody, Fitter
from ..garment.service import GarmentService
from ..schemas import FitRequest
from . import agent_config as ac
from . import learning, store
from .convert import catalogue_match
from .extract import ExtractionFailed, resolve, resolve_cached
from .models import (
    CompareRequest,
    CompareResponse,
    ExtractionView,
    ExtractRequest,
    FeedbackIn,
    ProfileBody,
    ProfileIn,
    PurchaseIn,
    RecommendRequest,
    RecommendResponse,
    SessionBody,
)
from .providers import PROVIDERS, LLMProvider
from .recommend import recommend

log = logging.getLogger("fit_agent")
PurchaseId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]


def personal_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin is None:
        return  # local non-browser client (tests, CLI)
    pinned = os.environ.get(ac.EXTENSION_ID_ENV)
    allowed = (
        origin == f"chrome-extension://{pinned}"
        if pinned
        else origin.startswith("chrome-extension://")
    )
    if not allowed:
        raise HTTPException(403, "Personal Fit Agent data is only available to the extension")


def create_router(
    fitter: Callable[[], Fitter],
    providers: dict[str, LLMProvider] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/agent", tags=["fit-agent"])
    pool = (
        providers
        if providers is not None
        else {name: PROVIDERS[name]() for name in ac.PROVIDER_ORDER}
    )
    garments: GarmentService | None = None

    def catalogue_service(asin: str) -> GarmentService | None:
        """The garment engine for a tape-measured catalogue ASIN: it ranks that jacket."""
        nonlocal garments
        if catalogue_match(asin) is None:
            return None
        engine = fitter()
        if garments is None or garments.fitter is not engine:
            garments = GarmentService(engine)
        return garments

    def body_for(choice: ProfileBody | SessionBody) -> tuple[FittedBody, str]:
        if isinstance(choice, SessionBody):
            request, label = choice.fit_request, "your session body (not stored)"
        else:
            if store.kiosk_mode():
                raise HTTPException(403, "Kiosk mode: no stored profile")
            saved = store.load_profile()
            if saved is None:
                raise HTTPException(404, "No saved profile; create one or use a session body")
            request, label = FitRequest.model_validate(saved["fit_request"]), "your saved profile"
        try:
            return fitter().fit(request), label
        except (ValueError, RuntimeError) as error:
            log.exception("Fit Agent body fit failed")
            raise HTTPException(422, "Unable to fit this body") from error

    def current_offsets(choice: ProfileBody | SessionBody) -> dict[str, float]:
        if isinstance(choice, SessionBody) or store.kiosk_mode():
            return {}  # learning belongs to the opt-in profile only
        return learning.offsets(store.load_learning()["purchases"])[0]

    def failed(error: ExtractionFailed) -> HTTPException:
        return HTTPException(
            422,
            {
                "message": str(error),
                "unclear": error.unclear,
                "trace": [step.model_dump() for step in error.trace],
                "notes": error.notes,
            },
        )

    @router.get("/status")
    def status() -> dict:
        states = [vars(p.status()) for p in pool.values()]
        for state in states:
            if state["paid"] and not state["available"]:
                log.info("Fit Agent provider %s: %s", state["name"], state["reason"])
        return {
            "kiosk_mode": store.kiosk_mode(),
            "profile_saved": store.load_profile() is not None,
            "resolution_order": [
                "reviewed extraction",
                "rules",
                *[f"LLM ({name})" for name in ac.PROVIDER_ORDER],
            ],
            "providers": states,
        }

    @router.post("/extract", response_model=ExtractionView)
    def extract(request: ExtractRequest) -> ExtractionView:
        try:
            resolved = resolve(request.page, request.chart_type_override, pool)
        except ExtractionFailed as error:
            raise failed(error) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return ExtractionView(
            extraction=resolved.extraction,
            source_label=resolved.label,
            garment_estimated=resolved.extraction.chart_type == "body",
            notes=resolved.notes,
        )

    @router.post(
        "/recommend", response_model=RecommendResponse, dependencies=[Depends(personal_origin)]
    )
    def recommend_endpoint(request: RecommendRequest) -> RecommendResponse:
        try:
            resolved = resolve(request.page, request.chart_type_override, pool)
        except ExtractionFailed as error:
            raise failed(error) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        body, label = body_for(request.body)
        try:
            return recommend(
                body,
                resolved,
                request.preference,
                request.layer,
                current_offsets(request.body),
                label,
                catalogue_service(resolved.extraction.asin),
            )
        except (ValueError, ValidationError) as error:
            raise HTTPException(422, f"Fit computation failed: {error}") from error

    @router.post(
        "/compare", response_model=CompareResponse, dependencies=[Depends(personal_origin)]
    )
    def compare(request: CompareRequest) -> CompareResponse:
        body, label = body_for(request.body)
        offsets = current_offsets(request.body)
        results = []
        for asin in request.asins:
            try:
                resolved = resolve_cached(asin)
            except KeyError as error:
                raise HTTPException(
                    404, f"{asin} has not been read yet; open its page first"
                ) from error
            results.append(
                recommend(
                    body,
                    resolved,
                    request.preference,
                    request.layer,
                    offsets,
                    label,
                    catalogue_service(asin),
                )
            )
        summary = []
        for result in results:
            chosen = next((s for s in result.sizes if s.size == result.recommended_size), None)
            zones = (
                ", ".join(
                    f"{z.label.lower()} {z.value_cm:+.1f} cm ({z.value_in:+.1f} in)"
                    for z in chosen.zones
                    if z.value_cm is not None
                )
                if chosen
                else ""
            )
            summary.append(
                f"{result.title or result.asin}: "
                + (f"size {result.recommended_size} — {zones}" if chosen else "no recommendation")
                + f" [{(result.three_d or {}).get('basis', result.extraction.source_label)}]"
            )
        return CompareResponse(products=results, summary=summary)

    @router.get("/profile", dependencies=[Depends(personal_origin)])
    def get_profile() -> dict:
        saved = store.load_profile()
        return {
            "saved": saved is not None,
            "kiosk_mode": store.kiosk_mode(),
            "profile": saved,
            "location": "local file .cache/fit-agent/profile.json (never uploaded)",
        }

    @router.put("/profile", dependencies=[Depends(personal_origin)])
    def put_profile(profile: ProfileIn) -> dict:
        try:
            saved = store.save_profile(
                profile.fit_request.model_dump(mode="json", exclude_none=True),
                profile.choices.model_dump(),
            )
        except store.PrivacyRefused as error:
            raise HTTPException(403, str(error)) from error
        return {"saved": True, "profile": saved}

    @router.delete("/profile", dependencies=[Depends(personal_origin)])
    def delete_profile() -> dict:
        return {"deleted": store.delete_personal(), "saved": False}

    def learning_view() -> dict:
        data = store.load_learning()
        offsets, items = learning.offsets(data["purchases"])
        return {
            "purchases": data["purchases"],
            "offsets_cm": offsets,
            "learned": learning.describe(offsets),
            "items": items,
            "kiosk_mode": store.kiosk_mode(),
        }

    @router.get("/learning", dependencies=[Depends(personal_origin)])
    def get_learning() -> dict:
        return learning_view()

    @router.post("/purchases", dependencies=[Depends(personal_origin)])
    def add_purchase(purchase: PurchaseIn) -> dict:
        if store.kiosk_mode() or store.load_profile() is None:
            raise HTTPException(403, "Fit feedback is stored only with a saved (opt-in) profile")
        try:
            resolved = resolve_cached(purchase.asin)
        except KeyError as error:
            raise HTTPException(404, "Open the product page first") from error
        body, label = body_for(ProfileBody(mode="profile"))
        # Snapshot of the prediction WITHOUT personal offsets (learning.py compares against it).
        result = recommend(
            body, resolved, "regular", "t-shirt", {}, label, catalogue_service(purchase.asin)
        )
        size = next((s for s in result.sizes if s.size == purchase.size), None)
        if size is None:
            raise HTTPException(422, f"Size {purchase.size} is not in this chart")
        data = store.load_learning()
        entry = {
            "id": store.new_id(),
            "asin": purchase.asin,
            "title": (purchase.title or result.title)[:200],
            "size": purchase.size,
            "snapshot": {z.zone: {"status": z.status, "value_cm": z.value_cm} for z in size.zones},
            "feedback": None,
        }
        data["purchases"].append(entry)
        store.save_learning(data)
        return entry

    @router.post("/feedback", dependencies=[Depends(personal_origin)])
    def feedback(answer: FeedbackIn) -> dict:
        data = store.load_learning()
        purchase = next((p for p in data["purchases"] if p["id"] == answer.purchase_id), None)
        if purchase is None:
            raise HTTPException(404, "Unknown purchase")
        purchase["feedback"] = {"answers": dict(answer.answers)}
        try:
            store.save_learning(data)
        except store.PrivacyRefused as error:
            raise HTTPException(403, str(error)) from error
        return learning_view()

    @router.delete("/learning/{purchase_id}", dependencies=[Depends(personal_origin)])
    def undo(purchase_id: PurchaseId) -> dict:
        data = store.load_learning()
        before = len(data["purchases"])
        data["purchases"] = [p for p in data["purchases"] if p["id"] != purchase_id]
        if len(data["purchases"]) == before:
            raise HTTPException(404, "Unknown purchase")
        store.save_learning(data)
        return learning_view()

    @router.delete("/learning", dependencies=[Depends(personal_origin)])
    def reset_learning() -> dict:
        if store.learning_path().exists():
            store.learning_path().unlink()
        return learning_view()

    return router
