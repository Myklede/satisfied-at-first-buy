"""Extraction (chart units) → GarmentSpec (cm) for the existing analytic engine (fit_math.py).

Conversions documented here:
- inches → cm: × IN_TO_CM (2.54, exact);
- flat half-width columns ("pit to pit", "1/2 chest") → circumference: × 2;
- BODY chart: the sizes keep the retailer's body ranges (fit_math's body-chart mode compares the
  shopper's body with them). For display, the estimated garment = body + standard ease
  (agent_config.STANDARD_*_EASE_CM), always labelled "estimated".
- GarmentSpec.category is the local catalogue's single label ("jacket"); fit_math never reads it.
  The listing's real category stays in Extraction.category.
"""

from __future__ import annotations

import hashlib
import json

from ..garment.models import Fabric, GarmentSize, GarmentSpec, SourcedMeasurement
from ..garment.products import load_products
from . import agent_config as ac
from .models import ChartValue, Extraction, Zone

_GARMENT_FIELDS = {
    "chest": "chest",
    "hem": "hem",
    "length": "length_hps",
    "shoulder": "shoulder",
    "sleeve": "sleeve",
    "sleeve_cb": "sleeve_cb",
    "bicep": "bicep",
}
# fit_math body-chart mode reads sizes.<field> as the BODY range: hem ↔ hip, sleeve ↔ arm length.
_BODY_FIELDS = {"chest": "chest", "hip": "hem", "shoulder": "shoulder", "bicep": "bicep"}


def catalogue_match(asin: str) -> GarmentSpec | None:
    """The tape-measured local catalogue entry whose Amazon URL names this ASIN, if any."""
    for product in load_products().values():
        urls = [product.url, *product.url_aliases]
        if any(url.rstrip("/").endswith(f"/dp/{asin}") for url in urls):
            return product
    return None


def _cm(value: ChartValue, extraction: Extraction, field: str) -> tuple[float | None, ...]:
    scale = (ac.IN_TO_CM if extraction.unit == "in" else 1.0) * (
        2.0 if field in extraction.flat_fields else 1.0
    )
    return tuple(None if v is None else v * scale for v in (value.value, value.min, value.max))


def _sourced(value: ChartValue, extraction: Extraction, field: str) -> SourcedMeasurement:
    exact, low, high = _cm(value, extraction, field)
    header = extraction.headers.get(field, field)
    detail = (
        f"Amazon {extraction.asin} {extraction.chart_type} chart '{header}' = '{value.raw}' "
        f"{extraction.unit}"
        + ("; flat half-width ×2" if field in extraction.flat_fields else "")
        + (f"; {extraction.unit}→cm ×{ac.IN_TO_CM}" if extraction.unit == "in" else "")
        + f"; extraction: {extraction.provenance.source}"
    )
    return SourcedMeasurement(
        value_cm=exact, min_cm=low, max_cm=high, source="retailer_chart", source_detail=detail
    )


def insulated(extraction: Extraction) -> bool:
    text = f" {extraction.title} {extraction.fabric} ".lower()
    return any(word in text for word in ac.INSULATED_WORDS)


def to_spec(extraction: Extraction) -> tuple[GarmentSpec, list[str]]:
    """Build the engine's GarmentSpec; returns it with notes on every skipped or assumed field."""
    notes: list[str] = []
    mapping = _GARMENT_FIELDS if extraction.chart_type == "garment" else _BODY_FIELDS
    sizes: dict[str, GarmentSize] = {}
    for size in extraction.sizes:
        fields = {}
        for name, value in size.measurements.items():
            target = mapping.get(name)
            if (
                extraction.chart_type == "garment"
                and name == "hip"
                and "hem" not in size.measurements
            ):
                target = "hem"
            if target is None:
                continue
            fields[target] = _sourced(value, extraction, name)
        sizes[size.name] = GarmentSize(**fields)
    skipped = sorted(
        {n for s in extraction.sizes for n in s.measurements}
        - set(mapping)
        - ({"hip"} if extraction.chart_type == "garment" else set())
    )
    if skipped:
        notes.append(
            "Not used by the fit engine for tops: "
            + ", ".join(skipped)
            + (
                " (body-chart sleeve/length are not shoulder-to-wrist arm lengths)"
                if extraction.chart_type == "body"
                else ""
            )
        )
    catalogue = catalogue_match(extraction.asin)
    if catalogue is not None and catalogue.loft_cm is not None:
        loft, loft_sigma = catalogue.loft_cm, catalogue.loft_uncertainty_cm
        notes.append(
            f"Insulation loft {loft:.2f} ± {loft_sigma:.2f} cm from the tape-measured "
            "catalogue entry for this ASIN"
        )
    elif insulated(extraction):
        loft, loft_sigma = None, 0.0
        notes.append(
            "Insulated garment and no measured loft: inner girth (chest/upper arm/hem "
            "ease) cannot be computed and is reported unknown, not invented"
        )
    else:
        loft, loft_sigma = ac.THIN_LOFT_CM, 0.0
    payload = extraction.model_dump(exclude={"provenance"}, mode="json")
    product_id = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    spec = GarmentSpec(
        product_id=product_id,
        url=f"https://www.amazon.com/dp/{extraction.asin}",
        brand=extraction.brand or "brand not on page",
        category="jacket",
        chart_type=extraction.chart_type,
        sizes=sizes,
        fabric=Fabric(composition=extraction.fabric or "not stated on the page"),
        title=extraction.title[:200],
        construction=extraction.construction,
        fit_intent=extraction.fit_intent,
        loft_cm=loft,
        loft_uncertainty_cm=loft_sigma,
    )
    return spec, notes


def estimated_garment(extraction: Extraction) -> dict[str, dict[str, list[float]]]:
    """BODY chart only: estimated garment girth range = body range + standard ease (cm)."""
    if extraction.chart_type != "body":
        return {}
    ease = {
        "chest": ac.STANDARD_CHEST_EASE_CM[extraction.fit_intent],
        "bicep": ac.STANDARD_BICEP_EASE_CM[extraction.fit_intent],
    }
    out: dict[str, dict[str, list[float]]] = {}
    for size in extraction.sizes:
        for name, extra in ease.items():
            value = size.measurements.get(name)
            if value is None:
                continue
            exact, low, high = _cm(value, extraction, name)
            ends = [exact] if exact is not None else [low, high]
            out.setdefault(size.name, {})[name] = [round(v + extra, 1) for v in ends]
    return out


def _shift(m: SourcedMeasurement | None, delta: float) -> SourcedMeasurement | None:
    if m is None or delta == 0:
        return m
    return m.model_copy(
        update={
            k: (getattr(m, k) - delta if getattr(m, k) is not None else None)
            for k in ("value_cm", "min_cm", "max_cm")
        }
    )


def apply_offsets(spec: GarmentSpec, offsets: dict[Zone, float]) -> GarmentSpec:
    """A personal "+X cm room in zone Z" preference, applied by making each size X cm smaller in Z.

    Exactly equivalent to raising the target ease / band by X in fit_math, without a second fit
    engine: the analytic engine runs unchanged on the shifted spec, and the real (unshifted)
    numbers are still the ones shown. Shoulder offsets are per side (seam offset), so the width
    moves by 2X and the sleeve by +X to keep the cuff where it was.

    A tape-measured catalogue jacket's TARGET is its own design ease: owned-size inner girth minus
    the brand's body-chart midpoint (fit_math.design_ease, chest↔chest, hem↔hip). Shrinking the
    owned size alone would move that target by −X and cancel the preference, so the body chart
    moves by the same X and the target stays the jacket's. A printed-chart spec has no body chart
    (to_spec), so nothing changes there.
    """
    sizes = {}
    garment = spec.chart_type == "garment"
    for name, size in spec.sizes.items():
        update = {}
        for zone, delta in offsets.items():
            if not delta:
                continue
            if zone == "shoulder":
                update["shoulder"] = _shift(size.shoulder, 2 * delta if garment else delta)
                if garment and size.shoulder is not None:
                    update["sleeve"] = _shift(update.get("sleeve", size.sleeve), -delta)
            elif zone == "sleeve":
                update["sleeve"] = _shift(update.get("sleeve", size.sleeve), delta)
                update["sleeve_cb"] = _shift(size.sleeve_cb, delta)
            else:
                update[zone] = _shift(getattr(size, zone), delta)
                inner = f"{zone}_inner"
                if inner in GarmentSize.model_fields:
                    update[inner] = _shift(getattr(size, inner), delta)
        sizes[name] = size.model_copy(update=update)
    chart = {
        name: row.model_copy(
            update={
                "chest": _shift(row.chest, offsets.get("chest", 0.0)),
                "hip": _shift(row.hip, offsets.get("hem", 0.0)),
            }
        )
        for name, row in spec.body_chart.items()
    }
    return spec.model_copy(update={"sizes": sizes, "body_chart": chart})
