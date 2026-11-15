"""Explicit local ground-truth export; no example is ever counted as a person."""

import argparse
import json
from datetime import datetime
from statistics import mean

from jsonschema import Draft202012Validator

from .config import DENSITY_CHOICES, MODEL_VERSION, ROOT
from .fit import Fitter
from .model import BodyEngine
from .schemas import FitRequest, FitResponse, PersonData

REFERENCES = [("female", 158, 52), ("female", 170, 68), ("male", 172, 65), ("male", 185, 92)]


def measurement_errors(result: FitResponse, known: dict[str, float]) -> dict[str, float]:
    return {name: result.measurements[name].value_cm - target for name, target in known.items()}


def mean_absolute_error(errors: dict[str, float]) -> float | None:
    return mean(abs(value) for value in errors.values()) if errors else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--before", action="store_true", help="Label this actual run as pre-change evidence"
    )
    args = parser.parse_args()
    fitter = Fitter(BodyEngine())
    now = datetime.now().strftime("%Y-%m-%d")
    lines = [
        f"# Body validation — {now}",
        "",
        f"Engine: {MODEL_VERSION}. Every fit in this report was computed in this run.",
        "",
        "Local explicit export. Reference fits check supplied constraints, "
        "not human girth accuracy.",
        "",
        "## Reference constraint checks",
        "",
        "| Density kg/m3 | Sex | Height cm | Mass kg | "
        "Height error cm | Mass error kg | Straight shoulder cm | "
        "Back arc cm | Neck cm | Fit ms | Pass |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    reference_results = []
    for density, sex, height, weight in [
        (d, *case) for d in DENSITY_CHOICES for case in REFERENCES
    ]:
        result = fitter.fit(
            FitRequest(height_cm=height, weight_kg=weight, sex=sex, density_kg_m3=density)
        ).response
        reference_results.append(result)
        lines.append(
            f"| {density:.0f} | {sex} | {height} | {weight} | {result.residuals['stature']:.6f} | "
            f"{result.residuals['mass_kg']:.6f} | "
            f"{result.measurements['shoulder_width'].value_cm:.3f} | "
            f"{result.measurements['shoulder_arc'].value_cm:.3f} | "
            f"{result.measurements['neck_base'].value_cm:.3f} | "
            f"{result.fit_ms:.1f} | {result.converged} |"
        )
    # Deliberately export only synthetic reference rows into the public file.
    directory = ROOT / "docs/validation"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "body-reference.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    paths = sorted(
        path
        for path in (ROOT / "data/ground-truth").glob("*.json")
        if not path.name.endswith(".example.json")
    )
    lines += ["", "## Tape-measured people", "", f"Personal files found: {len(paths)}.", ""]
    if not paths:
        lines += [
            "**No personal ground truth provided. "
            "Human accuracy / Gate A is not yet established.**",
            "Copy me.example.json to me.json and replace all values with tape measurements.",
            "",
        ]
    schema = json.loads((ROOT / "data/schemas/person.schema.json").read_text())
    validator = Draft202012Validator(schema)
    for index, (path, density) in enumerate(
        [(p, d) for p in paths for d in DENSITY_CHOICES], start=1
    ):
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        validator.validate(data)
        person = PersonData.model_validate({**data, "density_kg_m3": density})
        base = FitRequest(
            height_cm=person.height_cm,
            weight_kg=person.weight_kg,
            sex=person.sex,
            shape_reference=person.shape_reference,
            density_kg_m3=density,
        )
        targets = {
            name.removesuffix("_cm"): value
            for name, value in person.known_measurements.model_dump(exclude_none=True).items()
        }
        before = fitter.fit(base).response
        after = fitter.fit(FitRequest(**person.model_dump(exclude={"person_id", "notes"}))).response
        before_errors, after_errors = (
            measurement_errors(result, targets) for result in (before, after)
        )
        lines += [
            f"### Person comparison {index} / density {density:.0f} kg/m3",
            "",
            "Pseudonym and notes omitted from report.",
            "",
            "| Measurement | Tape cm | Baseline cm | Error cm | Assisted cm | Error cm |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
        for name, target in targets.items():
            lines.append(
                f"| {name} | {target:.2f} | {before.measurements[name].value_cm:.2f} | "
                f"{before_errors[name]:+.3f} | {after.measurements[name].value_cm:.2f} | "
                f"{after_errors[name]:+.3f} |"
            )
        for label, errors in (("Baseline", before_errors), ("Assisted", after_errors)):
            mae = mean_absolute_error(errors)
            lines += [
                "",
                f"{label} tape-length MAE: {mae:.3f} cm."
                if mae is not None
                else f"{label} MAE unavailable: no known tape lengths.",
            ]
        lines += ["", f"Assisted converged: {after.converged}; fit {after.fit_ms:.1f} ms.", ""]
    phase = "before" if args.before else "after"
    destination = directory / f"body-{phase}-{now}.md"
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(
        f"Reference checks: {sum(r.converged for r in reference_results)}/8 (both densities); "
        f"personal ground-truth files: {len(paths)}"
    )
    print(f"Local report: {destination}")
    if not all(r.converged for r in reference_results):
        raise SystemExit("Reference accuracy gates failed")


if __name__ == "__main__":
    main()
