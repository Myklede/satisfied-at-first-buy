"""Real catalogue/neck service. Synthetic chart carrier is not a retailer page."""

import pytest
from body_service.agent.extract import Resolved
from body_service.agent.models import FeedbackIn, PageContent, PageTable
from body_service.agent.recommend import recommend
from body_service.agent.rules import parse_rules
from body_service.garment.fit_math import exact
from body_service.garment.models import GarmentFitRequest
from body_service.garment.service import GarmentService
from body_service.schemas import FitRequest


@pytest.mark.slow
def test_catalogue_collar_is_the_existing_service_result(fitter, monkeypatch):
    import importlib

    module = importlib.import_module("body_service.agent.recommend")
    body = fitter.fit(FitRequest(height_cm=170, weight_kg=70, sex="male"))
    service = GarmentService(fitter)
    product = next(
        p for p in service.products.values() if any(s.collar_inner for s in p.sizes.values())
    )
    # The real measured-collar jacket currently has an eBay URL, not an Amazon ASIN.
    # A labelled synthetic carrier exercises the adapter without inventing production identity.
    asin = "B0TAPE0001"
    monkeypatch.setattr(module, "catalogue_match", lambda value: product if value == asin else None)
    rows = [["Size", "Chest", "Shoulder", "Sleeve", "Length"]]
    for name, size in product.sizes.items():
        rows.append(
            [
                name,
                *[
                    str(exact(getattr(size, field)))
                    if exact(getattr(size, field)) is not None
                    else "not measured"
                    for field in ["chest", "shoulder", "sleeve", "length_hps"]
                ],
            ]
        )
    page = PageContent(
        asin=asin,
        title="Local catalogue jacket test carrier",
        url=f"https://www.amazon.com/dp/{asin}",
        tables=[
            PageTable(
                heading="Garment measurements cm; local tapes and estimated grades", rows=rows
            )
        ],
    )
    result = recommend(
        body, Resolved(parse_rules(page), "rules", []), "regular", "t-shirt", {}, "test", service
    )
    direct = service.fit(
        GarmentFitRequest(
            body_id=body.response.body_id,
            product_id=product.product_id,
            layer_cm=0.1,
            preference="regular",
        )
    ).response
    known = 0
    for size in result.sizes:
        actual = next(z for z in size.zones if z.zone == "collar")
        if size.size not in direct.sizes:
            continue
        metric = direct.sizes[size.size].zones["collar"]
        assert actual.status == metric.status
        if metric.value_cm is not None:
            assert actual.value_cm == pytest.approx(metric.value_cm, abs=0.005)
            known += 1
            assert "estimated neck" in actual.text
            assert "uncalibrated" in actual.text
        else:
            assert actual.value_cm is None
    assert known > 0
    page = page.model_copy(update={"asin": "B0CHART001"})
    chart = recommend(
        body, Resolved(parse_rules(page), "rules", []), "regular", "t-shirt", {}, "test", service
    )
    assert all(
        next(z for z in size.zones if z.zone == "collar").status == "unknown"
        for size in chart.sizes
    )


def test_collar_is_not_silently_treated_as_calibrated_learning():
    with pytest.raises(ValueError, match="display-only"):
        FeedbackIn(purchase_id="a" * 32, answers={"collar": "tight"})
