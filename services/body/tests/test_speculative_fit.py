"""P2: a speculative garment fit is reused (never recomputed) and forgotten at reset."""

from body_service.garment.models import GarmentFitRequest
from body_service.garment.service import GarmentService
from body_service.schemas import FitRequest


def test_client_fit_takes_the_speculative_fit_and_reset_forgets_unclaimed(fitter):
    garments = GarmentService(fitter)
    body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male")).response.body_id
    first, second = list(garments.products)[:2]
    request = GarmentFitRequest(body_id=body, product_id=first)
    speculative = garments.fit(request, register=False)
    assert speculative.response.fit_id not in garments.cache
    assert speculative.response.fit_id in garments.speculative
    # Same request again (still speculative) returns the same object, unregistered.
    assert garments.fit(request, register=False) is speculative
    claimed = garments.fit(request)
    assert claimed is speculative  # the client's fit is the very same computed object
    assert speculative.response.fit_id in garments.cache
    assert speculative.response.fit_id not in garments.speculative
    # A fresh service computes the identical response (fit ids hash every input).
    fresh = GarmentService(fitter).fit(request)
    assert fresh.response.model_dump_json() == claimed.response.model_dump_json()
    other = garments.fit(GarmentFitRequest(body_id=body, product_id=second), register=False)
    assert garments.forget_speculative({"f" * 64}) == 0
    assert garments.forget_speculative({body}) == 1
    assert other.response.fit_id not in garments.speculative
    assert speculative.response.fit_id in garments.cache  # claimed fits are session.py's
