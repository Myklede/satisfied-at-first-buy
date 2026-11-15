import pytest
from body_service import config
from body_service.garment.fit_math import fit_size, offset_metric, rank_sizes, unknown
from body_service.garment.models import SizeFit, ZoneMetric
from body_service.garment.products import load_products
from body_service.schemas import FitRequest, PersonData


def candidate(name: str, complete: bool) -> SizeFit:
    zones = {key: unknown(key, "not measured") for key in config.ZONE_WEIGHTS}
    zones["chest"] = ZoneMetric(
        value_cm=10,
        design_ease_cm=10,
        metric="inner_ease_cm",
        status="fit",
        explanation="synthetic common chest",
    )
    if complete:
        zones["sleeve"] = offset_metric("sleeve", 11)
    return SizeFit(
        size=name,
        zones=zones,
        score=None,
        coverage=0,
        estimated=not complete,
        geometry_available=False,
        missing_fields=[],
        anchors={},
        polylines={},
        warnings=[],
    )


def test_missing_sleeve_cannot_win_by_hiding_a_penalty():
    sizes = {"S": candidate("S", True), "XS": candidate("XS", False)}
    best, basis = rank_sizes(sizes, "S")
    assert basis == ["chest"]
    assert sizes["S"].score == sizes["XS"].score
    assert best.size == "S"
    assert sizes["S"].coverage > sizes["XS"].coverage


def test_no_common_evidence_means_no_recommendation():
    sizes = {"S": candidate("S", True), "XS": candidate("XS", False)}
    sizes["XS"].zones["chest"] = unknown("chest", "absent")
    best, basis = rank_sizes(sizes, "S")
    assert best is None and basis == []
    assert all(value.score is None for value in sizes.values())


@pytest.mark.slow
def test_personal_ground_truth_dq4920_missing_data_regression(fitter):
    path = config.ROOT / "data/ground-truth/me.json"
    if not path.exists():
        pytest.skip("Private tape input absent; generic missing-data regression still runs")
    person = PersonData.model_validate_json(path.read_text(encoding="utf-8-sig"))
    body = fitter.fit(FitRequest(**person.model_dump(exclude={"person_id", "notes"})))
    product = next(product for product in load_products().values() if product.style == "DQ4920-206")
    sizes = {name: fit_size(body, product, name, 0.3, "regular") for name in product.sizes}
    best, basis = rank_sizes(sizes, product.owned_size)
    assert basis == ["chest"]
    assert sizes["XS"].zones["sleeve"].status == "unknown"
    assert best.size == "S"
