"""Benchmark both real owned-size jackets on a reference body (not the user's body)."""

from body_service.fit import Fitter
from body_service.garment.models import GarmentFitRequest
from body_service.garment.service import GarmentService
from body_service.model import BodyEngine
from body_service.schemas import FitRequest

fitter = Fitter(BodyEngine())
body = fitter.fit(FitRequest(height_cm=172, weight_kg=65, sex="male"))
service = GarmentService(fitter)
for product in service.products.values():
    print("Building", product.style, flush=True)
    result = service.fit(
        GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
    )
    owned = result.response.sizes["S"]
    built = service.get_mesh(result.response.fit_id, "S")
    print(
        product.style,
        "vertices",
        len(built.mesh.vertices),
        "faces",
        len(built.mesh.faces),
        "build_ms",
        built.build_ms,
        "min_gap_cm",
        built.min_gap_cm,
        "metrics",
        {zone: metric.value_cm for zone, metric in owned.zones.items()},
        flush=True,
    )
