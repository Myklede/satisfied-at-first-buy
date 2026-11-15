"""Explicit local predicted-vs-worn export. Never fills a missing human reading."""

import json
from datetime import datetime
from typing import Annotated

from pydantic import Field

from ..config import ROOT
from ..fit import Fitter
from ..model import BodyEngine
from ..schemas import FitRequest, Number, PersonData, StrictModel
from .models import GarmentFitRequest, ProductId, SizeName
from .service import GarmentService


class WornObservation(StrictModel):
    person_id: Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,48}$")]
    product_id: ProductId
    size: SizeName
    shoulder_offset_cm: Annotated[Number | None, Field(ge=-30, le=50)] = None
    cuff_offset_cm: Annotated[Number | None, Field(ge=-30, le=50)] = None
    hem_vs_hip_cm: Annotated[Number | None, Field(ge=-100, le=50)] = None
    notes: Annotated[str, Field(max_length=2000)] = ""


def comparison(predicted: float | None, observed: float | None) -> tuple[str, str, str]:
    return (
        "unknown" if predicted is None else f"{predicted:+.2f}",
        "pending" if observed is None else f"{observed:+.2f}",
        "pending" if predicted is None or observed is None else f"{predicted - observed:+.2f}",
    )


def main() -> None:
    fitter = Fitter(BodyEngine())
    service = GarmentService(fitter)
    observed = [
        WornObservation.model_validate_json(p.read_text(encoding="utf-8-sig"))
        for p in (ROOT / "data/ground-truth/worn").glob("*.json")
    ]
    lines = [
        "# Private garment validation",
        "",
        f"Computed {datetime.now().isoformat(timespec='seconds')}.",
        "",
        "Personal derived data: gitignored. "
        "Positive seam = dropped; cuff = past wrist; hem = above hip.",
        "",
        "Layer: t-shirt preset; preference: regular. Worn readings remain pending until supplied.",
        "",
    ]
    people = 0
    for path in sorted((ROOT / "data/ground-truth").glob("*.json")):
        if path.name.endswith(".example.json"):
            continue
        person = PersonData.model_validate_json(path.read_text(encoding="utf-8-sig"))
        people += 1
        body = fitter.fit(FitRequest(**person.model_dump(exclude={"person_id", "notes"})))
        lines += [
            f"## Person {people}",
            "",
            f"Body converged: {body.response.converged}; "
            f"density {body.response.density_kg_m3:.0f} kg/m3.",
            "",
            "Use these as model predictions, not validated worn fit. "
            "Body residuals (cm / kg): " + json.dumps(body.response.residuals, sort_keys=True),
            "",
        ]
        for product in service.products.values():
            name = product.owned_size
            if name is None:
                continue
            bundle = service.fit(
                GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
            )
            result = bundle.response.sizes[name]
            match = next(
                (
                    row
                    for row in observed
                    if row.person_id == person.person_id
                    and row.product_id == product.product_id
                    and row.size == name
                ),
                None,
            )
            predictions = {
                "shoulder_offset_cm": result.zones["shoulder"].value_cm,
                "cuff_offset_cm": result.zones["sleeve"].value_cm,
                "hem_vs_hip_cm": result.zones["hem"].position_vs_hip_cm,
            }
            build_ms = service.get_mesh(bundle.response.fit_id, name).build_ms
            lines += [
                f"### {product.style} / {name}",
                "",
                f"Product: `{product.product_id}`",
                "",
                "| Metric | Predicted cm | Worn tape cm | Error cm |",
                "| --- | ---: | ---: | ---: |",
            ]
            for metric, prediction in predictions.items():
                values = comparison(prediction, getattr(match, metric) if match else None)
                lines.append(f"| {metric} | {' | '.join(values)} |")
            lines += [
                "",
                f"Legacy diagnostic GLB build {build_ms:.1f} ms; "
                f"recommended available size {bundle.response.recommended_size}.",
                "",
            ]
            print(
                product.style,
                name,
                "prediction exported; worn readings",
                "present" if match else "pending",
            )
    directory = ROOT / "docs/validation"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"garment-personal-{datetime.now():%Y-%m-%d}.md"
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Personal files: {people}; local report: {destination}")


if __name__ == "__main__":
    main()
