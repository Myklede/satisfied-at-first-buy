import json

import pytest
from body_service import config
from body_service.garment.grading import anchored_grades, isotonic, prepare_product
from body_service.garment.products import load_products, product_hash
from pydantic import ValidationError


def test_projection_and_anchor():
    assert isotonic([1, 3, 2, 4]) == [1, 2.5, 2.5, 4]
    assert anchored_grades([2, 0, -1, 3], 1) == [0, 0, 0, 3]


def test_public_reference_grading_and_visual_provenance():
    for product in load_products().values():
        report = json.loads(
            (config.ROOT / "data/grading" / f"{product.product_id}.json").read_text()
        )
        assert all(row["converged"] for row in report["references"].values())
        prepared = prepare_product(product, report)
        assert product_hash(product) == product.product_id
        assert prepared.sizes[product.owned_size] == product.sizes[product.owned_size]
        for name, size in prepared.sizes.items():
            for field in ("shoulder", "sleeve", "length_hps", "bicep"):
                item = getattr(size, field)
                assert item.value_cm > 0
                if name != product.owned_size:
                    assert item.source == "derived_grading" and item.uncertainty_cm >= 3
        visual = product.visual
        assert visual.logo == "omitted" and visual.chamber_height.approximate
        assert visual.colour_hex.approximate
        with pytest.raises(ValidationError):
            visual.model_validate({**visual.model_dump(), "finish": {"value": "magic"}})
