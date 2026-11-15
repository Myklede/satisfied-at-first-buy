"""Generate non-personal representative bodies/grades from public brand charts."""

import json

from body_service.config import ROOT
from body_service.fit import Fitter
from body_service.garment.grading import compute_grading
from body_service.garment.products import load_products
from body_service.model import BodyEngine


def main() -> None:
    fitter = Fitter(BodyEngine())
    directory = ROOT / "data/grading"
    directory.mkdir(parents=True, exist_ok=True)
    for product in load_products().values():
        report = compute_grading(fitter, product)
        (directory / f"{product.product_id}.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
        print(
            product.style,
            "chart reference passes",
            sum(row["converged"] for row in report["references"].values()),
            "/",
            len(report["references"]),
            flush=True,
        )


if __name__ == "__main__":
    main()
