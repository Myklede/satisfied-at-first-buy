"""Additive collar tapes preserve saved IDs but never reuse an outdated fit."""

import json
from collections import OrderedDict
from pathlib import Path
from threading import RLock
from types import SimpleNamespace

import pytest
from body_service.garment import service
from body_service.garment.models import GarmentFitRequest, GarmentSpec, SizeFit, SourcedMeasurement
from body_service.garment.products import load_products, product_hash


def measured(value: float) -> SourcedMeasurement:
    return SourcedMeasurement(
        value_cm=value, source="tape_measured", source_detail="Synthetic catalogue test"
    )


def with_collar(product: GarmentSpec) -> GarmentSpec:
    copy = product.model_copy(deep=True)
    size = next(iter(copy.sizes.values()))
    size.collar_inner = measured(35)
    size.collar_height = measured(8)
    return copy


def test_existing_ids_and_catalogue_survive_additive_collar_tapes(tmp_path: Path) -> None:
    for original in load_products().values():
        amended = with_collar(original)
        assert product_hash(amended) == original.product_id
        path = tmp_path / f"{original.product_id}.json"
        path.write_text(amended.model_dump_json(), encoding="utf-8")
    assert set(load_products(tmp_path)) == set(load_products())


@pytest.mark.parametrize("field", ["chest", "notes"])
def test_catalogue_still_rejects_other_content_changes(tmp_path: Path, field: str) -> None:
    product = with_collar(next(iter(load_products().values())))
    data = product.model_dump(mode="json")
    if field == "chest":
        size = next(iter(data["sizes"].values()))
        size["chest"]["value_cm"] += 1
    else:
        data["notes"] += "changed"
    (tmp_path / f"{product.product_id}.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="content hash mismatch"):
        load_products(tmp_path)


def test_fit_cache_keys_include_collar_value_height_and_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Run the actual service/cache path; geometry work is isolated out of this unit test.
    product = with_collar(next(iter(load_products().values())))
    body = SimpleNamespace(uncertainty=None)
    target = service.GarmentService.__new__(service.GarmentService)
    target.fitter = SimpleNamespace(get=lambda _body_id: body)
    target.products = {product.product_id: product}
    target.grades = {product.product_id: "synthetic-grade"}
    target.cache = OrderedDict()
    target.lock = RLock()
    monkeypatch.setattr(service, "arm_route", lambda *_: [])
    monkeypatch.setattr(service, "back_route", lambda *_: [])
    monkeypatch.setattr(service, "rank_sizes", lambda *_: (None, []))
    monkeypatch.setattr(
        service,
        "fit_size",
        lambda _body, _product, name, *_: SizeFit(
            size=name,
            zones={},
            score=None,
            coverage=0,
            estimated=False,
            geometry_available=False,
            missing_fields=[],
            anchors={},
            polylines={},
            warnings=[],
        ),
    )
    request = GarmentFitRequest(body_id="a" * 64, product_id=product.product_id)
    first = target.fit(request)
    assert target.fit(request) is first
    keys = {first.response.fit_id}
    size = next(iter(product.sizes.values()))
    for field, patch in [
        ("collar_inner", {"value_cm": 36}),
        ("collar_height", {"value_cm": 9}),
        ("collar_inner", {"source_detail": "New tape session"}),
        ("collar_inner", {"uncertainty_cm": 0.1}),
    ]:
        setattr(size, field, getattr(size, field).model_copy(update=patch))
        changed = target.fit(request)
        assert changed.response.fit_id not in keys
        assert changed is not first
        keys.add(changed.response.fit_id)
        assert product_hash(product) == product.product_id
