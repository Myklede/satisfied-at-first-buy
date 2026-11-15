"""compute fit → choose → explain, on the existing analytic engine (garment/fit_math.py).

No second fit engine: fit_size / rank_sizes run unchanged. One basis per product, never mixed:
- printed chart (every product): the page's chart → convert.to_spec → fit_size / rank_sizes;
- tape-measured catalogue jacket (the ASIN is in data/products and the garment service is
  available): the ranking and every zone, collar included, are GarmentService.fit's — the same
  request (body, product, layer_cm, preference) the 3D studio sends, so the pick equals the
  studio's "Best available". The printed chart stays only as a labelled cross-check line.
Personal offsets are applied by running fit_size once more on convert.apply_offsets(spec) — the
shown numbers stay the real ones.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from .. import collar_config, config
from ..fit import FittedBody
from ..garment.fit_math import arm_route, back_route, fit_size, rank_sizes
from ..garment.models import GarmentFitRequest, GarmentSpec, SizeFit
from . import agent_config as ac
from .convert import apply_offsets, catalogue_match, estimated_garment, to_spec
from .explanation import explain_ranking
from .extract import Resolved
from .models import (
    ExtractionView,
    RecommendResponse,
    SizeView,
    TraceStep,
    ZoneView,
)

if TYPE_CHECKING:
    from ..garment.service import GarmentService

_ORDER = ("shoulder", "chest", "sleeve", "bicep", "hem", "collar")


@dataclass
class Ranking:
    """One basis: the real zones (base), the personal-offset re-run (adjusted) and both picks."""

    base: dict[str, SizeFit]
    base_best: SizeFit | None
    adjusted: dict[str, SizeFit]
    best: SizeFit | None
    common: list[str]


def _routes(body: FittedBody) -> dict:
    return {"L": arm_route(body, "L"), "R": arm_route(body, "R"), "back": back_route(body)}


def _fit_all(
    body: FittedBody,
    spec: GarmentSpec,
    layer_cm: float,
    preference: str,
    routes: dict | None,
    owned_size: str | None = None,
) -> tuple[dict[str, SizeFit], SizeFit | None, list[str]]:
    sizes = {name: fit_size(body, spec, name, layer_cm, preference, routes) for name in spec.sizes}
    best, common = rank_sizes(sizes, owned_size)
    return sizes, best, common


def chart_ranking(
    body: FittedBody, spec: GarmentSpec, layer_cm: float, preference: str, offsets: dict
) -> Ranking:
    """The printed chart's ranking (the basis for every product without a catalogue entry)."""
    routes = _routes(body) if spec.chart_type == "garment" else None
    base, base_best, common = _fit_all(body, spec, layer_cm, preference, routes)
    adjusted, best = base, base_best
    if any(offsets.values()):
        adjusted, best, common = _fit_all(
            body, apply_offsets(spec, offsets), layer_cm, preference, routes
        )
    return Ranking(base, base_best, adjusted, best, common)


def engine_ranking(
    service: GarmentService,
    body: FittedBody,
    product_id: str,
    layer_cm: float,
    preference: str,
    offsets: dict,
) -> Ranking:
    """The studio's own GarmentService.fit; personal offsets re-run its fit_size on the shifted
    catalogue spec with the same owned-size tie-break (rank_sizes), as on the chart path."""
    response = service.fit(
        GarmentFitRequest(
            body_id=body.response.body_id,
            product_id=product_id,
            layer_cm=layer_cm,
            preference=preference,
        )
    ).response
    base = response.sizes
    base_best = base[response.recommended_size] if response.recommended_size else None
    adjusted, best, common = base, base_best, list(response.comparison_zones)
    if any(offsets.values()):
        product = service.products[product_id]
        # The collar is display-only (not in ZONE_WEIGHTS) and has no learned offset, so the
        # re-run needs no neck section; the shown collar stays the engine's base result.
        adjusted, best, common = _fit_all(
            body,
            apply_offsets(product, offsets),
            layer_cm,
            preference,
            _routes(body),
            product.owned_size,
        )
    return Ranking(base, base_best, adjusted, best, common)


def _chest_design_ease(ranking: Ranking) -> float | None:
    return next(
        (
            size.zones["chest"].design_ease_cm
            for size in ranking.base.values()
            if size.zones["chest"].design_ease_cm is not None
        ),
        None,
    )


def _cross_check(chart: Ranking, engine: Ranking, fit_intent: str) -> str:
    """One line for "How I decided": what the printed chart alone gives. Never the basis."""
    pick = chart.base_best.size if chart.base_best else None
    agree = pick is not None and engine.base_best is not None and pick == engine.base_best.size
    chart_ease, engine_ease = _chest_design_ease(chart), _chest_design_ease(engine)
    line = (
        "Cross-check only, not the basis: the printed chart alone, at its printed precision, "
        + (f"also picks {pick}" if agree else f"would pick {pick or 'no size'}")
        + f" (zones {', '.join(chart.common) or 'none'}"
        + (
            f"; generic '{fit_intent}' chest design ease {chart_ease:.1f} cm"
            if chart_ease is not None
            else ""
        )
        + ")."
    )
    if not agree:
        line += f" The full engine uses the tape-measured jacket: zones {', '.join(engine.common)}"
        line += f"; chest design ease {engine_ease:.1f} cm." if engine_ease is not None else "."
    return line


def _inches(value: float | None) -> float | None:
    return None if value is None else round(value / ac.IN_TO_CM, 2)


_STATUS_WORDS = {
    "fit": "fits",
    "tight": "tight",
    "relaxed": "roomy",
    "too_big": "too big",
    "unknown": "unknown",
}


def _zone_text(zone: str, metric: str, value: float | None, code: str, raw_text: str) -> str:
    status = _STATUS_WORDS.get(code, code)
    if value is None:
        return raw_text
    cm, inch = f"{value:+.1f} cm", f"{value / ac.IN_TO_CM:+.1f} in"
    if metric == "inner_ease_cm":
        return f"{cm} ({inch}) of room around your {ac.ZONE_LABELS[zone].lower()}: {status}"
    if metric == "body_chart_distance_cm":
        where = "inside" if value == 0 else "above" if value > 0 else "below"
        size = abs(value)
        return (
            f"your {ac.ZONE_LABELS[zone].lower()} is {where} this size's body range"
            + (f" by {size:.1f} cm ({size / ac.IN_TO_CM:.1f} in)" if value else "")
            + f": {status}"
        )
    if zone == "shoulder":
        side = "past" if value >= 0 else "inside"
        size = f"{abs(value):.1f} cm ({abs(value) / ac.IN_TO_CM:.1f} in)"
        return f"seam sits {size} {side} your shoulder point: {status}"
    if zone == "sleeve":
        side = "past" if value >= 0 else "short of"
        size = f"{abs(value):.1f} cm ({abs(value) / ac.IN_TO_CM:.1f} in)"
        return f"cuff {size} {side} your wrist: {status}"
    return f"{cm} ({inch}): {status}"


def _insulation_unknown(spec: GarmentSpec, name: str, zone: str) -> bool:
    """Printed chart lists the outer girth of an insulated garment with no measured loft."""
    return (
        spec.chart_type == "garment"
        and zone in ("chest", "bicep", "hem")
        and getattr(spec.sizes[name], zone) is not None
        and spec.loft_cm is None
    )


def recommend(
    body: FittedBody,
    resolved: Resolved,
    preference: str,
    layer: str,
    offsets: dict[str, float],
    body_label: str,
    catalogue_service: GarmentService | None = None,
) -> RecommendResponse:
    extraction = resolved.extraction
    trace = list(resolved.trace)
    spec, chart_notes = to_spec(extraction)
    notes = list(resolved.notes)
    # The studio sends GarmentOptions.layer_presets_cm[...] = this same table (garment/models.py).
    layer_cm = config.LAYER_PRESETS_CM[layer]
    catalogue = catalogue_match(extraction.asin)
    chart_names = [size.name for size in extraction.sizes]
    if catalogue is not None and catalogue_service is not None:
        ranking = engine_ranking(
            catalogue_service, body, catalogue.product_id, layer_cm, preference, offsets
        )
        chart = chart_ranking(body, spec, layer_cm, preference, {})
        jacket = catalogue.style or catalogue.title or "catalogue jacket"
        names = [n for n in chart_names if n in ranking.base]
        names += [n for n in ranking.base if n not in names]
        unmeasured = [n for n in chart_names if n not in ranking.base]
        notes += [
            f"Ranked by the full fit engine on the tape-measured catalogue jacket {jacket} "
            "(the 3D studio's own computation); every zone shown is the engine's.",
            _cross_check(chart, ranking, extraction.fit_intent),
            *chart_notes,
        ]
        if unmeasured:
            notes.append(
                "Printed-chart sizes with no catalogue entry, not ranked: " + ", ".join(unmeasured)
            )
        basis = (
            f"full engine (GarmentService.fit, the 3D studio's computation) on the "
            f"tape-measured catalogue jacket {jacket}"
        )
        garment_est: dict[str, dict[str, list[float]]] = {}
        chart_spec = None
    else:
        ranking = chart_ranking(body, spec, layer_cm, preference, offsets)
        names = list(spec.sizes)
        notes += chart_notes
        basis = (
            "garment geometry" if spec.chart_type == "garment" else "retailer body ranges"
        ) + " from the printed chart"
        garment_est = estimated_garment(extraction)
        chart_spec = spec
    base, adjusted, best, base_best = (
        ranking.base,
        ranking.adjusted,
        ranking.best,
        ranking.base_best,
    )
    common = ranking.common
    known = sorted({z for s in base.values() for z, m in s.zones.items() if m.status != "unknown"})
    trace.append(
        TraceStep(
            step="compute_fit",
            status="done" if known else "failed",
            detail=f"{len(base)} sizes × zones {', '.join(known) or 'none'} on {body_label}; "
            f"{basis}; layer {layer} ({layer_cm} cm), preference {preference}",
        )
    )
    views = []
    for name in names:
        fit, adj = base[name], adjusted[name]
        zones = []
        for zone in _ORDER:
            metric = fit.zones[zone]
            # Collar is display-only and never offset: always the base (engine or chart) result.
            a = metric if zone == "collar" else adj.zones[zone]
            offset = offsets.get(zone, 0.0)
            # Display only: the marker's centre/scale come from the existing engine bands.
            delta, scale = None, None
            if a.value_cm is not None and a.status != "unknown":
                if a.metric == "body_chart_distance_cm":
                    delta, scale = -a.value_cm, config.GIRTH_TOLERANCE
                elif a.metric == "inner_ease_cm":
                    delta = a.value_cm - a.design_ease_cm
                    scale = config.EASE_TOLERANCE_CM[zone]
                elif zone in config.OFFSET_BANDS_CM:
                    low, high = config.OFFSET_BANDS_CM[zone]
                    delta, scale = a.value_cm - (low + high) / 2, (high - low) / 2
                elif zone == "collar":
                    low, high = collar_config.SNUG_EASE_MAX_CM, collar_config.REGULAR_EASE_MAX_CM
                    delta, scale = a.value_cm - (low + high) / 2, (high - low) / 2
            zones.append(
                ZoneView(
                    zone=zone,
                    label=ac.ZONE_LABELS[zone],
                    status=metric.status,
                    value_cm=None if metric.value_cm is None else round(metric.value_cm, 2),
                    value_in=_inches(metric.value_cm),
                    metric=metric.metric,
                    adjusted_status=a.status if offset else None,
                    adjusted_value_cm=None
                    if not offset or a.value_cm is None
                    else round(a.value_cm, 2),
                    personal_offset_cm=offset,
                    estimated=metric.estimated,
                    text=(
                        f"chart lists outer {ac.ZONE_LABELS[zone].lower()}; inner room unknown "
                        "(insulation not measured)"
                    )
                    if metric.value_cm is None
                    and chart_spec is not None
                    and _insulation_unknown(chart_spec, name, zone)
                    else metric.explanation
                    if zone == "collar"
                    else _zone_text(
                        zone, metric.metric, metric.value_cm, metric.status, metric.explanation
                    ),
                    display_delta_cm=delta,
                    display_scale_cm=scale,
                )
            )
        views.append(
            SizeView(
                size=name,
                score=None if adj.score is None else round(adj.score, 1),
                coverage=round(adj.coverage, 3),
                zones=zones,
                estimated_garment_cm=garment_est.get(name, {}),
            )
        )
    if best is None:
        trace.append(
            TraceStep(
                step="choose",
                status="failed",
                detail="No zone is known for every size; no fair comparison",
            )
        )
    else:
        trace.append(
            TraceStep(
                step="choose",
                status="done",
                detail=f"{best.size}: best score {best.score:.1f} on common zones "
                f"{', '.join(common)} (coverage {best.coverage * 100:.0f}%)"
                + ("; full engine, the same request as the 3D studio" if chart_spec is None else "")
                + (f"; personal offsets {offsets}" if any(offsets.values()) else ""),
            )
        )
    explanation = explain_ranking(
        views, best.size if best else None, base_best.size if base_best else None, offsets
    )
    trace.append(
        TraceStep(
            step="explain",
            status="done",
            detail=f"{len(explanation)} lines; source {resolved.label}",
        )
    )
    three_d = None
    if catalogue is not None:
        three_d = {
            "product_id": catalogue.product_id,
            "url": f"{ac.WEB_APP_ORIGIN}/?product={catalogue.product_id}",
            "label": "See 3D / X-ray (tape-measured catalogue jacket)",
        }
        if chart_spec is None:
            three_d["basis"] = ac.CATALOGUE_ENGINE_BASIS
    return RecommendResponse(
        asin=extraction.asin,
        title=extraction.title,
        recommended_size=best.size if best else None,
        sizes=views,
        comparison_zones=common,
        explanation=explanation,
        trace=trace,
        extraction=ExtractionView(
            extraction=extraction,
            source_label=resolved.label,
            garment_estimated=spec.chart_type == "body",
            notes=notes,
        ),
        personal_offsets_cm=offsets,
        preference=preference,
        layer=layer,
        three_d=three_d,
    )
