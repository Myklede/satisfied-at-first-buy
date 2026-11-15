"""Analytic / actual browser simulation / real worn readings, local exports only."""

import json

from body_service.config import ROOT
from body_service.garment.validation import WornObservation
from body_service.schemas import PersonData


def performance_report() -> None:
    directory = ROOT / "docs/validation"
    profiles = json.loads((directory / "realism-cpu-profile.json").read_text())
    bench = json.loads((directory / "realism-browser-bench.json").read_text())
    quality = json.loads((ROOT / ".cache/realism/quality.json").read_text())
    verdict = "PASS" if quality and all(row["pass"] for row in quality) else "FAIL"
    lines = [
        "# Measured CPU and headed Chrome performance",
        "",
        f"Acceptance: {verdict}. Low cost does not approve stretched/intersecting cloth.",
        f"Browser: {bench['browser']}; headed; viewport 1280×1000.",
        f"Actual renderer: {bench['renderer']}.",
        "",
        "## Node profile",
        "",
        "15 warm-up +60 measured steps. Initial stages share the 11,530-particle fixture; "
        "the final row uses corrected 12,571-particle geometry and 2×1 rather than 2×2. "
        "These stages were measured at different machine loads; do not treat the whole table "
        "as a controlled speedup. Small-step trials with failed quality are rejected.",
        "",
        "| Stage | Particles | Substeps × iterations | Mean ms | p95 ms "
        "| Bend ms | Body ms | Self ms |",
        "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    labels = {
        "baseline",
        "sqrt",
        "analytic-sdf",
        "precomputed-compliance",
        "dense-self-collision",
        "final-v19-2x1",
    }
    for row in profiles:
        if row["label"] not in labels:
            continue
        p = row["phases"]
        lines.append(
            f"| {row['label']} | {row['particles']} | {row['substeps']}×{row['iterations']} "
            f"| {row['meanStepMs']:.2f} | {row['p95StepMs']:.2f} "
            f"| {p['bend']:.2f} | {p['projectBody']:.2f} | {p['selfCollide']:.2f} |"
        )
    final = profiles[-1]
    lines += [
        "",
        f"Normal snapshot with recycled buffers: {final['normalSnapshotMs']:.3f}ms; "
        f"full gap+strain snapshot: {final['snapshotMs']:.2f}ms.",
        "",
        "## Actual worker delivery versus render",
        "",
        "180 frames per measurement; p5 FPS = 1000/p95 RAF interval. "
        "The render thread shows the newest available worker frame without waiting. "
        "All data are local. Service RAM caches may be warm; cached flags refer to cloth state.",
        "",
        "| Body / jacket | Quality | Static FPS p50/p5 | Interactive render FPS p50/p5 "
        "| Worker mean/p95 ms | Delivered physics Hz |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for result in bench["results"]:
        for static, live in zip(result["qualities"], result["interactive"], strict=True):
            p, r = live["physics"], live["render"]
            lines.append(
                f"| {result['label']} / {result['style']} | {live['quality']} "
                f"| {static['p50']:.2f}/{static['p5']:.2f} | {r['p50']:.2f}/{r['p5']:.2f} "
                f"| {p['meanStepMs']:.2f}/{p['p95StepMs']:.2f} | {p['deliveredHz']:.2f} |"
            )
    lines += [
        "",
        "## Size click timing",
        "",
        "Milliseconds, including asset transfer/preparation and 400ms morph when applicable. "
        "Settle is real wall time; every uncached result stopped at the 4s simulation-time "
        "cap, not kinetic convergence. That cap is not the 4s wall-time budget.",
        "",
        "| Body / jacket | Particles | S settle | M settle | S click | M click | Cached S click "
        "| JSON MB (no SDF) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for result in bench["results"]:
        a, b, c = (result[k] for k in ("initial", "next", "cached"))
        lines.append(
            f"| {result['label']} / {result['style']} | {a['particles']} "
            f"| {a['settleMs']:.1f} | {b['settleMs']:.1f} | {a['sizeSwitchMs']:.1f} "
            f"| {b['sizeSwitchMs']:.1f} | {c['sizeSwitchMs']:.1f} | {a['assetBytes'] / 1e6:.3f} |"
        )
    lines += [
        "",
        f"Browser errors: {len(bench['errors'])}. "
        "SDF is binary once per body, shared across sizes. "
        "Current 2×1/selfEvery2 settings are provisional because quality gates fail. "
        "No WebGPU implementation. No M3 work.",
        "",
    ]
    (directory / "realism-performance.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    observations = [
        WornObservation.model_validate_json(p.read_text(encoding="utf-8-sig"))
        for p in (ROOT / "data/ground-truth/worn").glob("*.json")
    ]
    person = PersonData.model_validate_json(
        (ROOT / "data/ground-truth/me.json").read_text(encoding="utf-8-sig")
    )
    for label in ("reference", "personal"):
        lines = [
            f"# Realism {label}: analytic / simulated / worn",
            "",
            "Diagnostic predictions: cloth stretch/collision acceptance has not passed.",
            "No measured worn reading has been invented. Positive shoulder = dropped; "
            "cuff = past wrist; hem = above hip. All values in centimetres.",
            "",
            "Analytic uncertainty is a grading assumption; SIM has no calibrated uncertainty band.",
            "",
        ]
        for style in ("FB7675-100", "DQ4920-206"):
            path = ROOT / f".cache/realism/browser-{label}-{style}.json"
            data = json.loads(path.read_text())
            asset, analytic, simulated = (data[k] for k in ("asset", "analytic", "simulated"))
            product_id, size, *_ = asset["key"].split(":")
            # asset key begins with the fit id; use the catalogue's stable style mapping.
            product = next(
                json.loads(p.read_text())
                for p in (ROOT / "data/products").glob("*.json")
                if json.loads(p.read_text())["style"] == style
            )
            product_id = product["product_id"]
            match = next(
                (
                    o
                    for o in observations
                    if label == "personal"
                    and o.person_id == person.person_id
                    and o.product_id == product_id
                    and o.size == size
                ),
                None,
            )
            lines += [
                f"## {style} / {size}",
                "",
                "| Metric | Analytic | SIM (diagnostic) | Worn tape | SIM − worn |",
                "| --- | ---: | ---: | ---: | ---: |",
            ]
            for zone, field, worn_key in (
                ("shoulder", "value_cm", "shoulder_offset_cm"),
                ("sleeve", "value_cm", "cuff_offset_cm"),
                ("hem", "position_vs_hip_cm", "hem_vs_hip_cm"),
            ):
                a, s = analytic["zones"][zone].get(field), simulated["zones"][zone].get(field)
                worn = getattr(match, worn_key) if match else None

                def fmt(value):
                    return "pending" if value is None else f"{value:+.2f}"

                error = None if worn is None or s is None else s - worn
                lines.append(f"| {zone} | {fmt(a)} | {fmt(s)} | {fmt(worn)} | {fmt(error)} |")
            lines += ["", *asset["warnings"], ""]
        destination = ROOT / f"docs/validation/realism-{label}-worn.md"
        destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"{label}: analytic / actual SIM / worn table exported; missing worn = pending.")
    gallery = [
        "# Actual headed Chrome evidence",
        "",
        "84 unedited application screenshots: 2 bodies × 2 jackets × 7 views × 3 modes.",
        "These are diagnostic evidence of failing cloth acceptance, not an approved visual result.",
        "Personal images are local, gitignored exports. No AI-generated or sculpted image is used.",
        "",
    ]
    for label in ("reference", "personal"):
        for style in ("FB7675-100", "DQ4920-206"):
            gallery += [
                f"## {label} / {style} / S",
                "",
                "| View | Normal | X-ray | Tension |",
                "| --- | --- | --- | --- |",
            ]
            for view in ("front", "back", "side", "shoulder", "cuff", "hood", "quilting"):
                links = []
                for mode in ("normal", "xray", "tension"):
                    filename = f"realism-{label}-{style}-{mode}-{view}.png"
                    if not (ROOT / "docs/validation" / filename).is_file():
                        raise FileNotFoundError(f"Missing actual screenshot: {filename}")
                    links.append(f"[{mode}]({filename})")
                gallery.append(f"| {view} | {' | '.join(links)} |")
            gallery.append("")
    (ROOT / "docs/validation/realism-evidence.md").write_text(
        "\n".join(gallery) + "\n", encoding="utf-8"
    )
    print("Evidence index verified: 84 actual PNG files present.")
    performance_report()


if __name__ == "__main__":
    main()
