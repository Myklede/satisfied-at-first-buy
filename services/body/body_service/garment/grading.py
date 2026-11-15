"""Anny chart-reference grading; never a claim of published garment dimensions."""

import hashlib
import json

from .. import config
from ..fit import Fitter
from ..schemas import FitRequest, KnownMeasurements
from .fit_math import midpoint
from .models import GarmentSpec, SourcedMeasurement

ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"]
FIELD_MAP = {
    "shoulder": "shoulder_arc",
    "sleeve": "arm_length",
    "length_hps": "back_length",
    "bicep": "upper_arm",
}


def isotonic(values: list[float]) -> list[float]:
    """Equal-weight monotone least-squares projection (PAVA)."""
    blocks = []
    for value in values:
        blocks.append([float(value), 1])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            b, a = blocks.pop(), blocks.pop()
            blocks.append([(a[0] * a[1] + b[0] * b[1]) / (a[1] + b[1]), a[1] + b[1]])
    return [value for value, count in blocks for _ in range(count)]


def anchored_grades(raw: list[float], owned: int) -> list[float]:
    left = [min(0.0, value) for value in isotonic(raw[:owned])]
    right = [max(0.0, value) for value in isotonic(raw[owned + 1 :])]
    return left + [0.0] + right


def reference_request(product: GarmentSpec, size: str) -> FitRequest:
    sex = "female" if product.style == "FB7675-100" else "male"
    h = config.GRADING_HEIGHT_CM[sex]
    chart = product.body_chart[size]
    return FitRequest(
        height_cm=h,
        weight_kg=config.GRADING_SEED_BMI * (h / 100) ** 2,
        sex=sex,
        known_measurements=KnownMeasurements(
            chest_cm=midpoint(chart.chest),
            waist_cm=midpoint(chart.waist),
            hip_cm=midpoint(chart.hip),
        ),
    )


def compute_grading(fitter: Fitter, product: GarmentSpec) -> dict:
    names = sorted(product.sizes, key=ORDER.index)
    references = {}
    for name in names:
        body = fitter.fit_chart_reference(reference_request(product, name))
        references[name] = {
            "measurements": {
                key: value.value_cm for key, value in body.response.measurements.items()
            },
            "phenotypes": body.response.phenotypes,
            "local_changes": body.response.local_changes,
            "residuals": body.response.residuals,
            "converged": body.response.converged,
            "mass_kg_computed": body.response.mass_kg,
        }
    owned = names.index(product.owned_size)
    sex = reference_request(product, product.owned_size).sex
    fields = {}
    for field, body_metric in FIELD_MAP.items():
        raw = [
            references[name]["measurements"][body_metric]
            - references[product.owned_size]["measurements"][body_metric]
            for name in names
        ]
        projected = anchored_grades(raw, owned)
        fields[field] = {
            name: {
                "raw_delta_cm": raw[i],
                "delta_cm": projected[i],
                "uncertainty_cm": config.GRADING_DELTA_UNCERTAINTY_CM
                + abs(raw[i] - projected[i])
                + abs(projected[i])
                * config.GRADING_HEIGHT_SD_CM[sex]
                / config.GRADING_HEIGHT_CM[sex],
            }
            for i, name in enumerate(names)
        }
    return {
        "version": config.GRADING_VERSION,
        "body_engine": config.MODEL_VERSION,
        "product_id": product.product_id,
        "height_cm": config.GRADING_HEIGHT_CM[sex],
        "height_sd_cm": config.GRADING_HEIGHT_SD_CM[sex],
        "height_source": config.GRADING_HEIGHT_SOURCE,
        "references": references,
        "fields": fields,
        "note": (
            "Estimated model-based grades; monotone projection anchored at owned tape. "
            "Bands are uncalibrated sensitivity allowances, not brand measurements "
            "or confidence intervals."
        ),
    }


def prepare_product(product: GarmentSpec, report: dict) -> GarmentSpec:
    if (
        report["version"] != config.GRADING_VERSION
        or report["body_engine"] != config.MODEL_VERSION
        or report["product_id"] != product.product_id
    ):
        raise ValueError("Stale garment grading; run npm run prepare:garments")
    result = product.model_copy(deep=True)
    owned = product.sizes[product.owned_size]
    for name, size in result.sizes.items():
        if name != product.owned_size:
            for field in ("chest", "hem"):
                value = getattr(size, field)
                if value is not None and value.uncertainty_cm is None:
                    value.uncertainty_cm = config.GRADING_DELTA_UNCERTAINTY_CM
    for field, rows in report["fields"].items():
        for name, row in rows.items():
            if name == product.owned_size or getattr(result.sizes[name], field) is not None:
                continue
            base = getattr(owned, field)
            setattr(
                result.sizes[name],
                field,
                SourcedMeasurement(
                    value_cm=base.value_cm + row["delta_cm"],
                    source="derived_grading",
                    uncertainty_cm=row["uncertainty_cm"],
                    source_detail=f"Anny chart-midpoint {FIELD_MAP[field]} delta "
                    f"{row['raw_delta_cm']:+.3f} cm; "
                    f"monotone applied {row['delta_cm']:+.3f} cm from owned tape. "
                    f"Reference height {report['height_cm']} cm; {report['height_source']}. "
                    "Uncalibrated model uncertainty; no retailer garment grade was supplied.",
                ),
            )
    return result


def grading_hash(report: dict) -> str:
    return hashlib.sha256(
        json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
