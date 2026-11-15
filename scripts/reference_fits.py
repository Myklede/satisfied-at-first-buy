"""Compute reference results from real Anny fits; no canned measurements."""

import json

from body_service.config import ROOT
from body_service.fit import Fitter
from body_service.model import BodyEngine
from body_service.schemas import FitRequest

fitter = Fitter(BodyEngine())
results = []
for sex, height, weight in (
    ("female", 158, 52),
    ("female", 170, 68),
    ("male", 172, 65),
    ("male", 185, 92),
):
    result = fitter.fit(FitRequest(height_cm=height, weight_kg=weight, sex=sex))
    summary = {"sex": sex, "height_cm": height, "weight_kg": weight, **result.response.model_dump()}
    results.append(summary)
    print(json.dumps(summary), flush=True)
(ROOT / ".cache/reference-fits.json").write_text(json.dumps(results, indent=2))
