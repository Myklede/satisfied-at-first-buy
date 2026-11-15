"""Explicit user-authorised local body/cloth exports for reproducible image evidence."""

from body_service import config
from body_service.fit import Fitter
from body_service.garment.models import GarmentFitRequest
from body_service.garment.service import GarmentService
from body_service.garment.simulation import SimulationAssets
from body_service.model import BodyEngine
from body_service.schemas import FitRequest, PersonData


def main() -> None:
    fitter = Fitter(BodyEngine())
    garments = GarmentService(fitter)
    assets = SimulationAssets(garments)
    requests = {"reference": FitRequest(height_cm=172, weight_kg=65, sex="male")}
    private = config.ROOT / "data/ground-truth/me.json"
    if private.exists():
        person = PersonData.model_validate_json(private.read_text(encoding="utf-8-sig"))
        requests["personal"] = FitRequest.model_validate(
            person.model_dump(exclude={"person_id", "notes"})
        )
    directory = config.ROOT / ".cache/realism"
    directory.mkdir(parents=True, exist_ok=True)
    for label, request in requests.items():
        body = fitter.fit(request)
        for product in garments.products.values():
            fit = garments.fit(
                GarmentFitRequest(body_id=body.response.body_id, product_id=product.product_id)
            )
            asset = assets.get(fit.response.fit_id, "S")
            # The SDF builds in a worker in parallel with the jackets; wait for it.
            (directory / f"sdf-{asset.sdf.sdf_id}.bin").write_bytes(
                assets.sdf(asset.sdf.sdf_id, timeout=300)
            )
            stem = f"{label}-{product.style}"
            (directory / f"{stem}.json").write_text(asset.model_dump_json(), encoding="utf-8")
            (directory / f"{stem}-analytic.json").write_text(
                fit.response.model_dump_json(), encoding="utf-8"
            )
            print(
                stem,
                len(asset.rest) // 3,
                "particles, asset",
                round(asset.build_ms, 1),
                "ms",
                flush=True,
            )


if __name__ == "__main__":
    main()
