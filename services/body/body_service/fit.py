"""Bounded deterministic autograd fitting; exact tape reporting with relinearisation."""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from time import perf_counter
from typing import TYPE_CHECKING

import numpy as np
import trimesh

from . import config, scan_config
from .landmarks import load_indices
from .measure_body import Geometry, measure_body

if TYPE_CHECKING:
    from .model import BodyEngine

# torch / anny (via .model) are imported inside the fitting code only (P2 proposal 5): asset
# worker processes unpickle FittedBody and import this module, but never fit, so they no longer
# pay the ~3 s torch/anny import. The API process imports both at start-up anyway (app.py).
from .schemas import (
    FitRequest,
    FitResponse,
    LandmarkResponse,
    ScanFitEntry,
    ScanFitReport,
    UncertaintyResponse,
)


def input_hash(request: FitRequest) -> str:
    payload = {"engine": config.MODEL_VERSION, **request.model_dump(exclude_none=True)}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


@dataclass
class FittedBody:
    response: FitResponse
    landmarks: LandmarkResponse
    glb: bytes
    mesh: trimesh.Trimesh
    geometry: Geometry
    request: FitRequest
    uncertainty: UncertaintyResponse | None = None


class Fitter:
    def __init__(self, engine: BodyEngine) -> None:
        self.engine = engine
        self.indices = load_indices()
        self.cache: OrderedDict[str, FittedBody] = OrderedDict()
        self.lock = RLock()  # Serial CPU fits; also protects LRU reads against eviction.

    def get(self, body_id: str) -> FittedBody:
        with self.lock:
            if body_id not in self.cache:
                raise KeyError(body_id)
            self.cache.move_to_end(body_id)
            return self.cache[body_id]

    def fit(self, request: FitRequest) -> FittedBody:
        with self.lock:
            body_id = input_hash(request)
            if body_id in self.cache:
                return self.get(body_id)
            base: FitResponse | None = None
            if request.scan_measurements is not None and request.scan_measurements.entries():
                # Soft scan solve starts from, and is anchored to, the no-scan body.
                base = self.fit(request.model_copy(update={"scan_measurements": None})).response
            result = self._fit(request, body_id, base=base)
            self.cache[body_id] = result
            while len(self.cache) > config.CACHE_SIZE:
                self.cache.popitem(last=False)
            return result

    def fit_chart_reference(self, request: FitRequest) -> FittedBody:
        """Public-chart reference only: mass is computed, not treated as observed.

        request.weight_kg is an initialisation label, never a target in this mode.
        The HTTP personal-body API continues to require and constrain actual mass.
        """
        body_id = hashlib.sha256(("free-mass-chart-v1:" + input_hash(request)).encode()).hexdigest()
        with self.lock:
            return self._fit(request, body_id, constrain_mass=False)

    def uncertainty(self, body_id: str) -> UncertaintyResponse:
        from .uncertainty import conditional_bands

        with self.lock:
            body = self.get(body_id)
            if body.uncertainty is None:
                body.uncertainty = conditional_bands(self.engine, body.request, body.response)
            return body.uncertainty

    def _fit(
        self,
        request: FitRequest,
        body_id: str,
        constrain_mass: bool = True,
        base: FitResponse | None = None,
    ) -> FittedBody:
        import torch

        from .model import scene_points

        started = perf_counter()
        model = self.engine.model
        known = {
            key.removesuffix("_cm"): value
            for key, value in request.known_measurements.model_dump(exclude_none=True).items()
        }
        # Webcam scan: soft residuals weighted by 1/sigma^2. A tape value of the same
        # name wins; the scan entry is then reported as overridden, not fitted.
        scan_all = request.scan_measurements.entries() if request.scan_measurements else {}
        scan = {
            key.removesuffix("_cm"): entry
            for key, entry in scan_all.items()
            if key.removesuffix("_cm") not in known
        }
        overridden = sorted(key for key in scan_all if key.removesuffix("_cm") in known)
        if scan and base is None:
            raise ValueError("A scan fit needs its no-scan base body (use Fitter.fit)")
        # name -> (target cm, residual scale cm). Tapes keep today's tolerance scale.
        soft: dict[str, tuple[float, float]] = {
            name: (
                target,
                config.BACK_PROXY_SCALE_CM if name == "back_length" else config.GIRTH_TOLERANCE,
            )
            for name, target in known.items()
        } | {name: (entry.value_cm, entry.sigma_cm) for name, entry in scan.items()}
        anchored = bool(scan)
        free_names = ["height", "weight"]
        if soft:
            free_names += ["muscle", "proportions", "cupsize", "firmness"]
        raw = torch.zeros(len(free_names), requires_grad=True)
        local_raw = torch.zeros(len(config.LOCAL_LABELS), requires_grad=True)
        anchor_phenotypes = anchor_local = None
        if anchored and base is not None:
            # Start at the no-scan body; the anchor below makes sigma -> inf reproduce it.
            start = torch.tensor([base.phenotypes[name] for name in free_names]).clamp(0.001, 0.999)
            start_local = torch.tensor(
                [base.local_changes.get(name, 0.0) for name in config.LOCAL_LABELS]
            ).clamp(-0.999, 0.999)
            raw = torch.logit(start).detach().requires_grad_()
            local_raw = torch.atanh(start_local).detach().requires_grad_()
            anchor_phenotypes, anchor_local = start, start_local
        fixed: dict[str, float] = {
            "gender": float(request.sex == "female"),
            "age": config.ADULT_AGE,
        }
        # Two scalar observations cannot identify six shape coordinates. Keep the
        # unobserved skeletal/muscle coordinates at Anny's own prior means instead
        # of letting the optimiser shrink the shoulder skeleton to satisfy mass.
        if not soft:
            fixed.update(self.engine.unobserved_shape(request.sex == "female"))
        for label in ("african", "asian", "caucasian"):
            fixed[label] = (
                1 / 3
                if request.shape_reference == "neutral"
                else float(label == request.shape_reference)
            )

        def parameters() -> tuple[dict, dict]:
            phenotypes = {**fixed, **dict(zip(free_names, raw.sigmoid(), strict=True))}
            # Local changes use their native [-1,1] semantics; free phenotypes use sigmoid [0,1].
            local = dict(zip(config.LOCAL_LABELS, local_raw.tanh(), strict=True)) if soft else {}
            return phenotypes, local

        def vertices() -> torch.Tensor:
            phenotypes, local = parameters()
            return self.engine.rest(phenotypes, local)

        proxy: Geometry | None = None
        proxy_scene: np.ndarray | None = None

        def loss() -> torch.Tensor:
            native = vertices()
            height = self.engine.anthropometry.height(native)[0] * 100
            mass = self.engine.anthropometry.volume(native)[0] * request.density_kg_m3
            result = ((height - request.height_cm) / config.HEIGHT_TOLERANCE).square()
            if constrain_mass:
                result = result + ((mass - request.weight_kg) / config.MASS_TOLERANCE).square()
            if proxy is not None:
                # Rotation/translation preserve distance; proxy attachments live on mesh edges.
                v = native[0]
                for name, (target, scale) in soft.items():
                    if name in proxy.tapes:
                        tape = proxy.tapes[name]
                        edges = torch.as_tensor(tape.edges)
                        t = torch.as_tensor(tape.fractions, dtype=v.dtype)[:, None]
                        p = v[edges[:, 0]] * (1 - t) + v[edges[:, 1]] * t
                        measured = torch.linalg.vector_norm(p - p.roll(1, 0), dim=1).sum() * 100
                    elif name == "shoulder_width":
                        a, wa = proxy.attachments["acromion_L"]
                        b, wb = proxy.attachments["acromion_R"]
                        measured = (
                            torch.linalg.vector_norm(
                                (v[a] * torch.as_tensor(wa, dtype=v.dtype)[:, None]).sum(0)
                                - (v[b] * torch.as_tensor(wb, dtype=v.dtype)[:, None]).sum(0)
                            )
                            * 100
                        )
                    elif name == "arm_length":
                        ids, weights = proxy.attachments["acromion_L"]
                        acromion = (v[ids] * torch.as_tensor(weights, dtype=v.dtype)[:, None]).sum(
                            0
                        )
                        p = torch.stack(
                            (acromion, v[proxy.indices["elbow_L"]], v[proxy.indices["wrist_L"]])
                        )
                        measured = torch.linalg.vector_norm(p.diff(dim=0), dim=1).sum() * 100
                    else:
                        ids, weights = proxy.attachments[name]
                        p = (v[ids] * torch.as_tensor(weights, dtype=v.dtype)[:, :, None]).sum(1)
                        measured = torch.linalg.vector_norm(p.diff(dim=0), dim=1).sum() * 100
                    # Tape: tolerance scale; scan: its sigma, i.e. weight 1/sigma^2.
                    result = result + ((measured - target) / scale).square()
            if anchor_phenotypes is not None and anchor_local is not None:
                # Scan solve: Gaussian anchor to the no-scan body (scan_config.py).
                anchor = (
                    (raw.sigmoid() - anchor_phenotypes) / scan_config.SCAN_ANCHOR_PHENOTYPE_SIGMA
                ).square().sum() + (
                    (local_raw.tanh() - anchor_local) / scan_config.SCAN_ANCHOR_LOCAL_SIGMA
                ).square().sum()
                return result + anchor
            prior = (raw.sigmoid() - 0.5).square().sum() + local_raw.tanh().square().sum()
            return result + config.PRIOR_WEIGHT * prior

        active = [raw, local_raw] if soft else [raw]
        if soft:
            # Use every supplied constraint from the first gradient step. Warming
            # up only height/mass can send the unobserved skeleton the wrong way.
            native = vertices().detach().numpy()[0]
            proxy_scene = scene_points(native, float(native[:, 2].min()))
            p, loc = parameters()
            joints = self.engine.rest_joints(p, loc, float(native[:, 2].min()))
            proxy = measure_body(
                proxy_scene, self.engine.faces, self.indices, joints, fixed["gender"]
            )
        adam = torch.optim.Adam(active, lr=config.ADAM_LEARNING_RATE)
        # Adam's normalised steps would wander from the anchor even when every scan sigma
        # is huge; the anchored solve starts converged for height/mass, so L-BFGS only.
        for _ in range(0 if anchored else config.ADAM_STEPS):
            adam.zero_grad()
            loss().backward()
            adam.step()

        def optimise() -> None:
            optimiser = torch.optim.LBFGS(
                active,
                max_iter=config.KNOWN_LBFGS_STEPS if soft else config.LBFGS_STEPS,
                line_search_fn="strong_wolfe",
                tolerance_grad=config.LBFGS_GRAD_TOLERANCE,
            )

            def closure() -> torch.Tensor:
                optimiser.zero_grad()
                objective = loss()
                objective.backward()
                return objective

            optimiser.step(closure)

        # Known tape constraints enter the first L-BFGS solve below. An extra
        # unconstrained solve here spends time fitting a shape we will replace.
        if not soft:
            optimise()
        if not soft:
            with torch.no_grad():
                native = vertices()
                height_error = abs(
                    float(self.engine.anthropometry.height(native)[0]) * 100 - request.height_cm
                )
                mass_error = abs(
                    float(self.engine.anthropometry.volume(native)[0]) * request.density_kg_m3
                    - request.weight_kg
                )
            if height_error >= config.HEIGHT_TOLERANCE or mass_error >= config.MASS_TOLERANCE:
                # At the weight morph's boundary, heavier bodies need the muscle
                # morph as another mass degree of freedom. Keep skeletal proportions
                # fixed; only release this mass-bearing coordinate when necessary.
                muscle = torch.tensor(fixed.pop("muscle"))
                free_names.append("muscle")
                raw = torch.cat(
                    (
                        raw.detach().clamp(-config.FALLBACK_RAW_LIMIT, config.FALLBACK_RAW_LIMIT),
                        torch.logit(muscle)[None],
                    )
                ).requires_grad_()
                active = [raw]
                optimise()
        # Refresh exact minimum/maximum sections between differentiable optimisation passes.
        for refresh in range(config.PROXY_REFRESH_PASSES if soft else 0):
            native = vertices().detach().numpy()[0]
            scene = scene_points(native, float(native[:, 2].min()))
            proxy_scene = scene
            p, loc = parameters()
            joints = self.engine.rest_joints(p, loc, float(native[:, 2].min()))
            proxy = measure_body(scene, self.engine.faces, self.indices, joints, fixed["gender"])
            if (
                # Scan terms are soft (no tolerance gate): run at least one solve for them.
                not (anchored and refresh == 0)
                and all(
                    abs(proxy.measurements[name].value_cm - target)
                    < config.GIRTH_TOLERANCE * config.PROXY_EARLY_STOP_FRACTION
                    for name, target in known.items()
                )
                and abs(proxy.measurements["stature"].value_cm - request.height_cm)
                < config.HEIGHT_TOLERANCE * config.PROXY_EARLY_STOP_FRACTION
                and (
                    not constrain_mass
                    or abs(proxy.volume * request.density_kg_m3 - request.weight_kg)
                    < config.MASS_TOLERANCE * config.PROXY_EARLY_STOP_FRACTION
                )
            ):
                break
            optimise()

        phenotypes, local = parameters()
        # Native rest pose is already A-pose. Anny's default None pose recentres the root
        # and uses reference orientations, so explicitly pose every bone at its own rest
        # world matrix. This produces identity skinning for mesh and attached geometry.
        with torch.no_grad():
            coefficients = model.get_phenotype_blendshape_coefficients(
                **phenotypes, local_changes=local
            )
            out = model.get_rest_model(coefficients)
            transforms, _ = model.get_bone_transforms(
                out["rest_bone_poses"], out["rest_bone_poses"], pose_parameterization="world"
            )
            out["vertices"] = model.get_skinned_vertices(out["rest_vertices"], transforms)
        rest = out["rest_vertices"][0].numpy()
        floor = float(rest[:, 2].min())
        scene = scene_points(rest, floor)
        joints = self.engine.rest_joints(phenotypes, local, floor)
        # A passing proxy already is the exact measurement of these same vertices.
        # Reuse it only after a bitwise coordinate comparison, never a tolerance.
        exact = (
            proxy
            if proxy is not None and np.array_equal(scene, proxy_scene)
            else measure_body(scene, self.engine.faces, self.indices, joints, fixed["gender"])
        )
        display = scene_points(out["vertices"][0].numpy(), floor)
        if not np.allclose(display, scene, atol=config.IDENTITY_SKINNING_ATOL):
            raise RuntimeError("Identity A-pose skinning changed rest coordinates")
        targets = {"stature": request.height_cm, "mass_kg": request.weight_kg, **known}
        if not constrain_mass:
            targets.pop("mass_kg")
        mass = exact.volume * request.density_kg_m3
        residuals = {
            name: (mass if name == "mass_kg" else exact.measurements[name].value_cm) - target
            for name, target in targets.items()
        }
        converged = all(
            abs(error)
            < (
                config.MASS_TOLERANCE
                if name == "mass_kg"
                else config.HEIGHT_TOLERANCE
                if name == "stature"
                else config.GIRTH_TOLERANCE
            )
            for name, error in residuals.items()
        )
        mesh = trimesh.Trimesh(display, self.engine.faces, process=False)
        glb = mesh.export(file_type="glb", include_normals=True)
        warnings = [
            "Shape inferred from limited inputs; "
            "density and surface landmarks require tape validation."
        ]
        if not converged:
            warnings.append(
                "Some targets exceed accuracy gates; "
                "this target combination may be outside model capacity."
            )
        scan_report: ScanFitReport | None = None
        if request.scan_measurements is not None and scan_all:
            scan_report = ScanFitReport(
                calibration=request.scan_measurements.calibration,
                weighting="soft residual ((fitted - value) / sigma)^2, i.e. weight 1/sigma^2, "
                "anchored to the no-scan body; tape known_measurements take precedence",
                entries={
                    f"{name}_cm": ScanFitEntry(
                        value_cm=entry.value_cm,
                        sigma_cm=entry.sigma_cm,
                        fitted_cm=exact.measurements[name].value_cm,
                        residual_cm=exact.measurements[name].value_cm - entry.value_cm,
                        method=entry.method,
                    )
                    for name, entry in scan.items()
                },
                overridden_by_tape=overridden,
                base_body_id=base.body_id if base is not None else body_id,
            )
            warnings.append(
                "Webcam scan values were fitted as soft constraints weighted by 1/sigma^2 "
                f"(calibration '{request.scan_measurements.calibration}')."
            )
            if request.scan_measurements.calibration == "uncalibrated":
                warnings.append(
                    "The scan calibration is 'uncalibrated': scan values are raw silhouette "
                    "geometry, not validated against tape for this camera."
                )
        response = FitResponse(
            body_id=body_id,
            phenotypes={
                k: float(v.detach()) if isinstance(v, torch.Tensor) else v
                for k, v in phenotypes.items()
            },
            local_changes={k: float(v.detach()) for k, v in local.items()},
            measurements=exact.measurements,
            mass_kg=mass,
            volume_m3=exact.volume,
            density_kg_m3=request.density_kg_m3,
            targets=targets,
            residuals=residuals,
            fit_ms=(perf_counter() - started) * 1000,
            converged=converged,
            warnings=warnings,
            scan=scan_report,
        )
        landmarks = LandmarkResponse(
            landmarks={k: tuple(float(c) for c in p) for k, p in exact.landmarks.items()},
            girth_polylines={
                k: [tuple(float(c) for c in p) for p in tape.points]
                for k, tape in exact.tapes.items()
            },
        )
        return FittedBody(response, landmarks, glb, mesh, exact, request)
