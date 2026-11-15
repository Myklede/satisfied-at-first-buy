"""Transcribe the approved realism table; preserve tape/measurement identity."""

import json

from body_service.config import ROOT
from body_service.garment.products import load_products, product_hash
from body_service.garment.visual import ProductVisual

SOURCE = (
    "User-approved prompts/03-realism.md Part B; "
    "Claude's photo estimates scaled by owned HPS length. "
)


def fact(
    value: str, source: str = "retailer_copy", approximate: bool = False, detail: str = ""
) -> dict:
    return {
        "value": value,
        "source": source,
        "approximate": approximate,
        "source_detail": SOURCE + detail,
    }


def measure(value: float, spread: float, method: str = "") -> dict:
    return {
        "value_cm": value,
        "source": "photo_estimate",
        "approximate": True,
        "uncertainty_cm": spread,
        "source_detail": SOURCE + "Approximate, not garment tape; user may override." + method,
    }


# Look-dev (agent L) parka pocket estimate: closed-front catalogue photo, scaled by the user's
# taped 90 cm HPS->hem over the 594 px HPS->hem distance (0.1515 cm/px). The vertical slits run
# from 216 px to 309 px below HPS, just outside the first vertical quilting line.
PARKA_POCKET = (
    " Method: closed-front retailer photo, 0.1515 cm/px from the taped 90 cm HPS-to-hem;"
    " slit from 216 px to 309 px below HPS (32.7 cm, 14.1 cm long)."
)


def main() -> None:
    for product in load_products().values():
        parka = product.style == "FB7675-100"
        raw = {
            "quilting": fact("box" if parka else "horizontal", "photo_estimate", True),
            "chamber_height": measure(15.0 if parka else 14.5, 1.5),
            "yoke_depth": measure(13.5 if parka else 7.0, 1.5),
            "sleeve_chamber_height": measure(10.5, 1.0),
            "hood": fact("attached" if parka else "removable"),
            "hood_features": [
                fact("quilted_centre_panel", "photo_estimate", True),
                fact("bungee_toggles" if parka else "metal_attachment_zip"),
                fact("foldable_storm_bill" if parka else "side_panels"),
            ],
            "front": fact("two_way_zip" if parka else "storm_flap"),
            "pockets": fact("vertical_zip" if parka else "angled_welt"),
            "cuffs": fact("inner_elastic" if parka else "hook_and_loop", "photo_estimate", True),
            "hem": fact(
                "open" if parka else "elastic",
                "photo_estimate",
                True,
                "Men's elastic relaxed hem independently confirmed by user tape.",
            ),
            "finish": fact("satin_matte" if parka else "glossy_ripstop"),
            "colour_hex": fact(
                "#e7e6df" if parka else "#b19b74",
                "model_assumption",
                True,
                "Uncalibrated preview colour from the named colourway; "
                "awaiting a user calibration photo.",
            ),
        }
        if parka:
            raw["chamber_width"] = measure(14.0, 1.5)
            raw["pocket_top"] = measure(32.5, 2.5, PARKA_POCKET)
            raw["pocket_length"] = measure(14.0, 2.0, PARKA_POCKET)
        else:
            raw.update(
                storm_flap_width=measure(6.5, 1.0),
                pocket_top=measure(37.0, 2.0),
                pocket_length=measure(16.0, 1.0),
            )
        product.visual = ProductVisual.model_validate(raw)
        assert product_hash(product) == product.product_id
        path = ROOT / "data/products" / f"{product.product_id}.json"
        path.write_text(
            json.dumps(product.model_dump(exclude_none=True), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(product.style, "sourced visual metadata saved; tape identity unchanged")


if __name__ == "__main__":
    main()
