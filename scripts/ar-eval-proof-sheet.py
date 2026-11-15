"""Local native-compositor proof sheets. No registration or geometry correction."""

import argparse
import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def private_path(value: str) -> Path:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / ".cache"):
        raise ValueError("Proof pixels must stay in .cache")
    return path


def compose(report_path: Path) -> list[Path]:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    out = private_path(".cache/cx-day/frozen/sheets")
    subprocess.run(["git", "check-ignore", "-q", str(out / "probe.png")], cwd=ROOT, check=True)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(report["source"]).stem
    if not stem.replace("-", "").isalnum():
        raise ValueError("Invalid source name")
    written: list[Path] = []
    for case in report["cases"]:
        proofs = case.get("proofPaths", [])
        name = f"{stem}-s{int(case['still'])}-f{int(case['finish'])}"
        sheet = Image.new("RGB", (3 * 600, 4 * 285), "#202020")
        strip = Image.new("RGB", (12 * 240, 230), "#202020")
        draw, strip_draw = ImageDraw.Draw(sheet), ImageDraw.Draw(strip)
        for i, proof in enumerate(proofs[:12]):
            x, y = i % 3 * 600, i // 3 * 285
            draw.text((x + 5, y + 5), f"{name} #{i} camera={proof.get('cameraFrame')}")
            for k, channel in enumerate(["raw", "ar", "mirror"]):
                if not proof.get(channel):
                    continue
                with Image.open(private_path(proof[channel])) as opened:
                    image = opened.convert("RGB")
                tile = ImageOps.contain(image, (194, 245))
                sheet.paste(tile, (x + k * 200 + 3, y + 34))
                draw.text((x + k * 200 + 5, y + 20), channel)
                if channel == "ar":
                    # Fixed central crop in native canvas coordinates. Never align frames.
                    w, h = image.size
                    crop = image.crop((w // 4, h // 8, 3 * w // 4, 7 * h // 8))
                    strip.paste(ImageOps.contain(crop, (236, 200)), (i * 240 + 2, 28))
                    strip_draw.text((i * 240 + 4, 5), f"#{i} cam={proof.get('cameraFrame')}")
        for label, artifact in [("views", sheet), ("ar-strip", strip)]:
            path = out / f"{name}-{label}.png"
            artifact.save(path)
            written.append(path)
    return written


def compose_testset(report_path: Path, real: bool = False) -> list[Path]:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    out = private_path(".cache/cx-day/look/sheets" if real else ".cache/cx-day/testset/sheets")
    subprocess.run(["git", "check-ignore", "-q", str(out / "probe.png")], cwd=ROOT, check=True)
    out.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[dict]] = {}
    for row in report["rows"]:
        match = re.search(r"mixkit-(\d+)", row["file"])
        if not match and not real:
            raise ValueError("Expected numeric clip ID")
        clip_id = Path(row["file"]).stem if real else match[1]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", clip_id):
            raise ValueError("Invalid clip ID")
        groups.setdefault(clip_id, []).append(row)
    written: list[Path] = []
    for clip_id, rows in groups.items():
        segment_count = max(
            (
                len(
                    {
                        p["key"]
                        for p in r.get("visual", {}).get("proofs", [])
                        if p["key"].startswith("segment-")
                    }
                )
                for r in rows
            ),
            default=1,
        )
        sheet = Image.new("RGB", (max(1, segment_count) * 450, len(rows) * 245), "#202020")
        strip = Image.new("RGB", (12 * 200, len(rows) * 215), "#202020")
        draw, strip_draw = ImageDraw.Draw(sheet), ImageDraw.Draw(strip)
        for row_index, row in enumerate(rows):
            proofs = row.get("visual", {}).get("proofs", [])
            y = row_index * 245
            label = f"clip{clip_id} {row['style']} still{row['still']}"
            draw.text((5, y + 4), label)
            strip_draw.text((5, row_index * 215 + 4), label)
            keys = sorted({p["key"] for p in proofs if p["key"].startswith("segment-")})
            for column, key in enumerate(keys):
                for channel_index, channel in enumerate(["raw", "ar", "mirror"]):
                    proof = next(
                        (p for p in proofs if p["key"] == key and p["channel"] == channel), None
                    )
                    if not proof:
                        draw.text((column * 450 + channel_index * 150 + 2, y + 50), "N/A")
                        continue
                    with Image.open(private_path(proof["path"])) as image:
                        tile = ImageOps.contain(image.convert("RGB"), (145, 194))
                    x = column * 450 + channel_index * 150
                    sheet.paste(tile, (x + 2, y + 44))
                    draw.text((x + 2, y + 20), f"{channel} {proof['kind']}")
            for i in range(12):
                proof = next(
                    (p for p in proofs if p["key"] == f"still-{i:02}" and p["channel"] == "ar"),
                    None,
                )
                if not proof:
                    strip_draw.text((i * 200 + 2, row_index * 215 + 40), "N/A")
                    continue
                with Image.open(private_path(proof["path"])) as image:
                    tile = ImageOps.contain(image.convert("RGB"), (196, 178))
                strip.paste(tile, (i * 200 + 2, row_index * 215 + 35))
                strip_draw.text(
                    (i * 200 + 2, row_index * 215 + 19), f"{proof['timeMs'] / 1000:.2f}s"
                )
        for label, artifact in [("segments", sheet), ("still-strip", strip)]:
            path = out / f"clip-{clip_id}-{label}.png"
            artifact.save(path)
            written.append(path)
    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("--testset", action="store_true")
    parser.add_argument("--real", action="store_true")
    args = parser.parse_args()
    report = (ROOT / args.report).resolve()
    if not report.is_relative_to(ROOT / "docs/validation"):
        raise ValueError("Expected numeric validation report")
    artifacts = compose_testset(report, args.real) if args.testset or args.real else compose(report)
    for artifact in artifacts:
        print(artifact.relative_to(ROOT))
