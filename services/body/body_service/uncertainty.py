"""Deterministic conditional phenotype ensemble; no fabricated population precision."""

from time import perf_counter

import numpy as np
import torch
from scipy.stats import qmc

from . import config, scan_config
from .landmarks import load_indices
from .measure_body import measure_body
from .model import BodyEngine, scene_points
from .schemas import FitRequest, FitResponse, MeasurementBand, UncertaintyResponse


def conditional_bands(
    engine: BodyEngine, request: FitRequest, result: FitResponse
) -> UncertaintyResponse:
    started = perf_counter()
    count = config.UNCERTAINTY_SAMPLES
    coordinates = qmc.Sobol(4, scramble=True, seed=config.SEED).random_base2(int(np.log2(count)))
    names = ["muscle", "proportions", "cupsize", "firmness"]
    known = {
        name.removesuffix("_cm"): value
        for name, value in request.known_measurements.model_dump(exclude_none=True).items()
    }
    # Webcam scan: a sample must agree with each scan value within k*sigma (never tighter
    # than the tape tolerance). Sampling stays as without a scan, so any narrowing of the
    # band comes from the scan's information alone (scan_config.py).
    scan_entries = request.scan_measurements.entries() if request.scan_measurements else {}
    scan_limits = {
        name.removesuffix("_cm"): (
            entry.value_cm,
            max(
                config.GIRTH_TOLERANCE,
                scan_config.SCAN_UNCERTAINTY_ACCEPT_SIGMAS * entry.sigma_cm,
            ),
        )
        for name, entry in scan_entries.items()
        if name.removesuffix("_cm") not in known
    }
    ph = {name: torch.full((count,), value) for name, value in result.phenotypes.items()}
    for i, name in enumerate(names):
        if known:
            values = np.clip(
                result.phenotypes[name]
                + (coordinates[:, i] * 2 - 1) * config.UNCERTAINTY_KNOWN_PERTURB,
                0.001,
                0.999,
            )
        else:
            lo, hi = config.UNCERTAINTY_FREE_RANGE
            values = lo + coordinates[:, i] * (hi - lo)
        ph[name] = torch.tensor(values, dtype=torch.float32)
    initial = torch.tensor([result.phenotypes["height"], result.phenotypes["weight"]]).clamp(
        0.001, 0.999
    )
    raw = torch.logit(initial).repeat(count, 1).requires_grad_()

    def vertices() -> torch.Tensor:
        return engine.rest(
            {**ph, "height": raw[:, 0].sigmoid(), "weight": raw[:, 1].sigmoid()},
            result.local_changes,
        )

    def objective() -> torch.Tensor:
        v = vertices()
        h = engine.anthropometry.height(v) * 100
        mass = engine.anthropometry.volume(v) * request.density_kg_m3
        return (
            ((h - request.height_cm) / config.HEIGHT_TOLERANCE).square()
            + ((mass - request.weight_kg) / config.MASS_TOLERANCE).square()
        ).mean()

    adam = torch.optim.Adam([raw], lr=config.ADAM_LEARNING_RATE)
    for _ in range(config.UNCERTAINTY_STEPS):
        adam.zero_grad()
        objective().backward()
        adam.step()
    lbfgs = torch.optim.LBFGS(
        [raw], max_iter=config.UNCERTAINTY_LBFGS_STEPS, line_search_fn="strong_wolfe"
    )

    def closure() -> torch.Tensor:
        lbfgs.zero_grad()
        loss = objective()
        loss.backward()
        return loss

    lbfgs.step(closure)
    native = vertices().detach().numpy()
    heights = np.ptp(native[:, :, 2], axis=1) * 100
    with torch.no_grad():
        masses = (
            engine.anthropometry.volume(torch.as_tensor(native)).numpy() * request.density_kg_m3
        )
    samples = {name: [measurement.value_cm] for name, measurement in result.measurements.items()}
    accepted = 1  # include the actual fitted solution; fewer than three never produces a band
    for i, value in enumerate(native):
        if (
            abs(heights[i] - request.height_cm) >= config.HEIGHT_TOLERANCE
            or abs(masses[i] - request.weight_kg) >= config.MASS_TOLERANCE
        ):
            continue
        phenotypes = {name: float(values[i]) for name, values in ph.items()}
        phenotypes.update(
            height=float(raw[i, 0].detach().sigmoid()), weight=float(raw[i, 1].detach().sigmoid())
        )
        floor = float(value[:, 2].min())
        joints = engine.rest_joints(phenotypes, result.local_changes, floor)
        geometry = measure_body(
            scene_points(value, floor),
            engine.faces,
            load_indices(),
            joints,
            result.phenotypes["gender"],
        )
        if any(
            abs(geometry.measurements[name].value_cm - target) >= config.GIRTH_TOLERANCE
            for name, target in known.items()
        ) or any(
            abs(geometry.measurements[name].value_cm - value) >= limit
            for name, (value, limit) in scan_limits.items()
        ):
            continue
        accepted += 1
        for name, measurement in geometry.measurements.items():
            samples[name].append(measurement.value_cm)
    bands = {}
    for name, values in samples.items():
        lo, hi = np.quantile(values, config.UNCERTAINTY_QUANTILES)
        bands[name] = (
            MeasurementBand(
                lower_cm=float(lo),
                upper_cm=float(hi),
                accepted_samples=accepted,
                attempted_samples=count + 1,
            )
            if accepted >= 3
            else None
        )
    return UncertaintyResponse(
        bands=bands,
        accepted_samples=accepted,
        attempted_samples=count + 1,
        compute_ms=(perf_counter() - started) * 1000,
        note="Conditional shape sensitivity, not population confidence or tape error. "
        "No band when fewer than three samples satisfy every supplied target.",
    )
