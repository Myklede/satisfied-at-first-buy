"""Transcribe user-approved Update 2; no network requests or invented grades."""

import json

from body_service.config import ROOT
from body_service.garment.models import GarmentSpec
from body_service.garment.products import product_hash


def tape(value: float, detail: str) -> dict:
    return {"value_cm": float(value), "source": "tape_measured", "source_detail": detail}


def chart(values: list[float], url: str) -> dict:
    return {
        "min_cm": float(values[0]),
        "max_cm": float(values[1]),
        "source": "retailer_chart",
        "source_detail": url + "; body range, not garment size",
    }


def main() -> None:
    womens = {
        "XXS": [70, 76, 54, 60, 78, 84],
        "XS": [76, 83, 60, 67, 84, 91],
        "S": [83, 90, 67, 74, 91, 98],
        "M": [90, 97, 74, 81, 98, 105],
        "L": [97, 104, 81, 88, 105, 112],
        "XL": [104, 114, 88, 98, 112, 120],
        "2XL": [114, 124, 98, 108, 120, 128],
    }
    mens = {
        "XS": [80.0, 88.9, 64.8, 73.7, 80.0, 88.9],
        "S": [88.9, 95.3, 73.7, 81.3, 88.9, 95.3],
        "M": [95.3, 104.1, 81.3, 88.9, 95.3, 104.1],
        "L": [104.1, 111.8, 88.9, 96.5, 104.1, 111.8],
        "XL": [111.8, 123.2, 96.5, 109.2, 111.8, 119.4],
    }
    records = [
        {
            "title": "Nike Sportswear Classic Puffer — Women's Therma-FIT Parka",
            "style": "FB7675-100",
            "colourway": "White/Black",
            "url": "https://www.amazon.com/dp/B0C9TQTNYH",
            "url_aliases": [
                "https://www.amazon.com/dp/B0C9TPL7ZZ",
                "https://www.amazon.com/dp/B0C9TRHGZV",
                "https://www.nike.com/t/sportswear-classic-puffer-womens-therma-fit-loose-hooded-parka-BVM2pD",
            ],
            "chart": womens,
            "chart_url": "https://img.nike.com.hk/resources/sizecart/womens-tops-sizing-chart_en.html",
            "owned": {
                "shoulder": 60,
                "chest": 108,
                "hem": 108,
                "length_hps": 90,
                "sleeve": 53,
                "sleeve_cb": 82,
                "bicep": 40,
            },
            "loft_cm": 1.0,
            "loft_uncertainty_cm": 0.0,
            "hem_elastic": False,
        },
        {
            "title": "Nike Life Therma-FIT Men's Puffer",
            "style": "DQ4920-206",
            "colourway": "Rattan/Rattan",
            "url": "https://www.ebay.com/itm/278055652565",
            "url_aliases": ["https://www.nike.com/t/life-therma-fit-mens-puffer-jacket-dt05Gx"],
            "chart": mens,
            "chart_url": "https://www.nike.com/size-fit/mens_tops_alpha",
            "owned": {
                "shoulder": 47,
                "chest": 120,
                "hem": 110,
                "length_hps": 65,
                "sleeve": 65,
                "bicep": 48,
            },
            "loft_cm": 2.75,
            "loft_uncertainty_cm": 0.25,
            "hem_elastic": True,
        },
    ]
    directory = ROOT / "data/products"
    directory.mkdir(parents=True, exist_ok=True)
    for record in records:
        body_chart = {
            size: {
                name: chart(values[i : i + 2], record["chart_url"])
                for name, i in (("chest", 0), ("waist", 2), ("hip", 4))
            }
            for size, values in record["chart"].items()
        }
        raw = record["owned"]
        owned = {}
        for name, value in raw.items():
            detail = "User tape, zipped and laid flat; Update 2. "
            if name in ("chest", "hem", "bicep"):
                detail += f"Raw flat {value / 2:g} cm × 2 = {value:g} cm circumference."
                if name == "hem" and record["hem_elastic"]:
                    detail += " Elastic hem measured relaxed; stretched maximum was not supplied."
            else:
                detail += f"{name}: {value:g} cm, measured along the stated endpoints."
            if name == "sleeve" and record["style"] == "FB7675-100":
                detail += (
                    " Corrected 53 cm replaces erroneous 70 cm. "
                    "CB sleeve independently measured 82 cm."
                )
            owned[name] = tape(value, detail)
        sizes = {"S": owned}
        for size, values in record["chart"].items():
            if size in ("S", "XXS"):
                continue
            sizes[size] = {}
            for name, offset in (("chest", 0), ("hem", 4)):
                grade = (
                    sum(values[offset : offset + 2]) / 2
                    - sum(record["chart"]["S"][offset : offset + 2]) / 2
                )
                sizes[size][name] = {
                    "value_cm": raw[name] + grade,
                    "source": "derived_grading",
                    "source_detail": f"Owned S outer {name} {raw[name]} "
                    f"+ Nike body-chart midpoint grade {grade:+g} cm. "
                    "Equivalent to constant inner design ease with unchanged loft. "
                    "Hem uses hip chart grade; estimated. "
                    "No shoulder, length, sleeve or bicep grade is assumed.",
                }
        product = GarmentSpec.model_validate(
            {
                "product_id": "0" * 64,
                "brand": "Nike",
                "category": "jacket",
                "chart_type": "garment",
                "owned_size": "S",
                "construction": "set_in",
                "fit_intent": "loose",
                "fabric": {
                    "composition": "100% polyester; synthetic insulation"
                    if record["style"] == "FB7675-100"
                    else "100% polyester ripstop shell; Thermore EcoDown synthetic insulation"
                },
                "body_chart": body_chart,
                "sizes": sizes,
                "notes": "Source: user-approved prompts/02b-demo-jackets-addendum.md Update 2. "
                "Nike chart is BODY data, stored separately; "
                "other garment girths are explicitly derived grading. "
                "Owned shoulder/sleeve geometry is authorised. Missing dimensions stay absent. "
                "Loft is an effective shell thickness estimate, "
                "not a direct lining-girth measurement.",
                **{k: v for k, v in record.items() if k not in ("chart", "chart_url", "owned")},
            }
        )
        product.product_id = product_hash(product)
        destination = directory / f"{product.product_id}.json"
        destination.write_text(
            json.dumps(product.model_dump(exclude_none=True), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(product.style, product.product_id, len(product.sizes), "sizes")


if __name__ == "__main__":
    main()
