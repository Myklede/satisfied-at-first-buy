import json

import pytest
from body_service.config import ROOT
from body_service.schemas import FitResponse, Measurement, PersonData
from body_service.validation import mean_absolute_error, measurement_errors
from jsonschema import Draft202012Validator, ValidationError


def test_error_and_mae_math():
    result = FitResponse(
        body_id="a" * 64,
        phenotypes={},
        local_changes={},
        measurements={"chest": Measurement(value_cm=92, method="test")},
        mass_kg=65,
        volume_m3=0.064,
        targets={},
        residuals={},
        fit_ms=1,
        converged=True,
        warnings=[],
    )
    assert measurement_errors(result, {"chest": 95}) == {"chest": -3}
    assert mean_absolute_error({"chest": -3, "waist": 1}) == 2
    assert mean_absolute_error({}) is None


def test_person_schema_and_example():
    schema = json.loads((ROOT / "data/schemas/person.schema.json").read_text())
    data = json.loads((ROOT / "data/ground-truth/me.example.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    validator.validate(data)
    PersonData.model_validate(data)
    with pytest.raises(ValidationError):
        validator.validate({**data, "unknown": 1})


def test_garment_contract():
    schema = json.loads((ROOT / "data/schemas/garment.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    value = {"value_cm": 45, "source": "tape_measured", "source_detail": "synthetic unit fixture"}
    fields = ["shoulder", "chest", "hem", "length_hps", "length_back", "sleeve", "bicep"]
    data = {
        "product_id": "a" * 64,
        "url": "https://example.com/jacket",
        "brand": "Test",
        "category": "jacket",
        "chart_type": "garment",
        "unit": "cm",
        "fabric": {"composition": "test", "elastane_pct": 0, "stretch_max": 1.03},
        "sizes": {"M": dict.fromkeys(fields, value)},
    }
    validator = Draft202012Validator(schema)
    validator.validate(data)
    with pytest.raises(ValidationError):
        validator.validate({**data, "chart_type": "unknown"})
