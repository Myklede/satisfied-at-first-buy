"""Bounded, in-memory fit/mesh caches; immutable catalogue loaded from validated data."""

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock

from .. import collar_config, config
from ..fit import Fitter
from ..neck_girth import body_neck_girth
from .builder import BuiltGarment, build_garment
from .fit_math import arm_route, back_route, exact, fit_size, rank_sizes
from .grading import grading_hash, prepare_product
from .models import GarmentFitRequest, GarmentFitResponse
from .products import load_products


@dataclass
class GarmentFit:
    response: GarmentFitResponse
    meshes: dict[str, BuiltGarment]


class GarmentService:
    def __init__(self, fitter: Fitter) -> None:
        self.fitter = fitter
        raw = load_products()
        reports = {
            key: json.loads((config.ROOT / "data/grading" / f"{key}.json").read_text())
            for key in raw
        }
        self.products = {key: prepare_product(value, reports[key]) for key, value in raw.items()}
        self.grades = {key: grading_hash(report) for key, report in reports.items()}
        self.cache: OrderedDict[str, GarmentFit] = OrderedDict()
        # Fits computed ahead of the client (app.speculate_cloth), not yet requested by it:
        # the client's identical request takes the same object instead of recomputing it.
        self.speculative: OrderedDict[str, GarmentFit] = OrderedDict()
        self.mesh_cache: OrderedDict[tuple, BuiltGarment] = OrderedDict()
        self.lock = RLock()

    def fit(self, request: GarmentFitRequest, register: bool = True) -> GarmentFit:
        """The fit for this request (cached by a hash of every input).

        ``register=False`` (speculation): computed for the cloth build but kept out of the
        garment cache until the client asks for the same fit (P2: never computed twice)."""
        with self.lock:
            body = self.fitter.get(request.body_id)
            product = self.products[request.product_id]
            payload = {
                "engine": config.MODEL_VERSION,
                "ranking": config.FIT_RANKING_VERSION,
                "asset": config.GARMENT_ASSET_VERSION,
                "grading": self.grades[request.product_id],
                "visual": product.visual.model_dump() if product.visual else None,
                "collar_fit": collar_config.COLLAR_FIT_VERSION,
                "neck_label_validated": collar_config.NECK_LABEL_VALIDATED,
                "collar_tapes": {
                    name: {
                        field: value.model_dump() if value else None
                        for field in ("collar_inner", "collar_height")
                        for value in (getattr(size, field),)
                    }
                    for name, size in product.sizes.items()
                },
                **request.model_dump(),
                "uncertainty": body.uncertainty.model_dump(exclude={"compute_ms"})
                if body.uncertainty
                else None,
            }
            fit_id = hashlib.sha256(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            if fit_id in self.cache:
                self.cache.move_to_end(fit_id)
                return self.cache[fit_id]
            speculative = self._speculative()
            if fit_id in speculative:
                bundle = speculative[fit_id]
                if register:
                    del speculative[fit_id]
                    self._register(fit_id, bundle)
                return bundle
            routes = {
                "L": arm_route(body, "L"),
                "R": arm_route(body, "R"),
                "back": back_route(body),
            }
            necks = {}
            engine = getattr(self.fitter, "engine", None)
            for size in product.sizes.values():
                height = exact(size.collar_height)
                if engine is None or height is None or height in necks:
                    continue
                try:
                    necks[height] = body_neck_girth(body, engine, height)
                except ValueError:
                    # Explicit unknown collar result; never borrow a jaw/head
                    # section to make an incomplete neck region measurable.
                    necks[height] = None
            sizes = {
                name: fit_size(
                    body,
                    product,
                    name,
                    request.layer_cm,
                    request.preference,
                    routes,
                    necks.get(exact(product.sizes[name].collar_height)),
                )
                for name in product.sizes
            }
            meshes = {}
            best, comparison_zones = rank_sizes(sizes, product.owned_size)
            result = GarmentFitResponse(
                fit_id=fit_id,
                body_id=request.body_id,
                product_id=request.product_id,
                sizes=sizes,
                recommended_size=best.size if best else None,
                comparison_zones=comparison_zones,
                explanation=(
                    f"{best.size}: highest score on common zones ({', '.join(comparison_zones)}); "
                    f"{best.coverage * 100:.0f}% measurement coverage"
                    + (
                        "; estimated / incomplete dimensions"
                        if best.estimated or best.coverage < 1
                        else ""
                    )
                )
                if best
                else "No common measured zones support a fair recommendation",
                layer_cm=request.layer_cm,
                preference=request.preference,
                loft_cm=product.loft_cm,
                loft_uncertainty_cm=product.loft_uncertainty_cm,
                note="Ranking uses analytic uncompressed girths on common zones. "
                "The cloth view reports simulated positions with provisional compressible fill. "
                "Cuff openings, material coefficients and derived grades await worn calibration.",
            )
            bundle = GarmentFit(result, meshes)
            if register:
                self._register(fit_id, bundle)
            else:
                speculative[fit_id] = bundle
                while len(speculative) > config.CACHE_SIZE:
                    speculative.popitem(last=False)
            return bundle

    def _speculative(self) -> OrderedDict[str, GarmentFit]:
        # Also for services assembled without __init__ (unit tests build them field by field).
        return self.__dict__.setdefault("speculative", OrderedDict())

    def _register(self, fit_id: str, bundle: GarmentFit) -> None:
        self.cache[fit_id] = bundle
        while len(self.cache) > config.CACHE_SIZE:
            self.cache.popitem(last=False)

    def forget_speculative(self, body_ids: set[str]) -> int:
        """Kiosk reset: drop speculative fits of these bodies (the cache is session.py's)."""
        with self.lock:
            speculative = self._speculative()
            gone = [k for k, v in speculative.items() if v.response.body_id in body_ids]
            for fit_id in gone:
                del speculative[fit_id]
            return len(gone)

    def get(self, fit_id: str) -> GarmentFit:
        with self.lock:
            bundle = self.cache[fit_id]
            self.cache.move_to_end(fit_id)
            return bundle

    def get_mesh(self, fit_id: str, size: str) -> BuiltGarment:
        """Legacy diagnostic GLB is lazy; the realism UI uses the dense cloth asset."""
        with self.lock:
            bundle = self.get(fit_id)
            metrics = bundle.response.sizes[size]
            if not metrics.geometry_available:
                raise ValueError("Missing garment measurements")
            if size not in bundle.meshes:
                body = self.fitter.get(bundle.response.body_id)
                product = self.products[bundle.response.product_id]
                routes = {
                    "L": arm_route(body, "L"),
                    "R": arm_route(body, "R"),
                    "back": back_route(body),
                }
                built = build_garment(
                    body, product, size, metrics, routes, bundle.response.layer_cm
                )
                bundle.meshes[size] = built
                metrics.build_ms = built.build_ms
            return bundle.meshes[size]
