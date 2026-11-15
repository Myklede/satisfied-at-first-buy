"""Pure centimetre fit mathematics and scene-coordinate annotation placement."""

import numpy as np
import trimesh

from .. import collar_config, config
from ..fit import FittedBody
from ..measure import hull_perimeter, polyline_length, section_loops
from ..neck_girth import NeckGirth
from ..schemas import MeasurementBand
from .models import GarmentSize, GarmentSpec, SizeFit, SourcedMeasurement, ZoneMetric


def midpoint(value: SourcedMeasurement) -> float:
    return value.value_cm if value.value_cm is not None else (value.min_cm + value.max_cm) / 2


def exact(value: SourcedMeasurement | None) -> float | None:
    return value.value_cm if value is not None else None


def walk(points: np.ndarray, distance_m: float) -> np.ndarray:
    segments = np.diff(points, axis=0)
    lengths = np.linalg.norm(segments, axis=1)
    valid = lengths > 1e-9
    if not valid.any():
        raise ValueError("Cannot walk a zero-length surface path")
    indices = np.flatnonzero(valid)
    if distance_m < 0:
        i = indices[0]
        return points[0] + segments[i] / lengths[i] * distance_m
    cumulative = np.r_[0.0, np.cumsum(lengths)]
    i = min(int(np.searchsorted(cumulative, distance_m, side="right") - 1), len(lengths) - 1)
    if i >= len(lengths) or lengths[i] <= 1e-9:
        i = indices[-1]
    return points[i] + segments[i] / lengths[i] * (distance_m - cumulative[i])


def arm_route(body: FittedBody, side: str) -> np.ndarray:
    g = body.geometry
    start = g.surface_paths[f"shoulder_{side}"]
    control = g.surface_paths[f"arm_{side}"]
    pieces = np.vstack(
        [
            np.linspace(a, b, config.GARMENT_ARM_ROUTE_SAMPLES)
            for a, b in zip(control[:-1], control[1:], strict=True)
        ]
    )
    projected, _, _ = trimesh.proximity.closest_point(body.mesh, pieces)
    projected[0], projected[-1] = control[0], control[-1]
    return np.vstack((start, projected[1:]))


def back_route(body: FittedBody) -> np.ndarray:
    g = body.geometry
    start = g.landmarks["HPS_L"]
    end_y = float(body.mesh.vertices[:, 1].min()) + config.GARMENT_SURFACE_MARGIN_M
    ys = np.linspace(start[1], end_y, config.GARMENT_BACK_ROUTE_SAMPLES)
    # Sagittal posterior envelope, resampled to avoid sparse mesh-vertex stair steps.
    segments = trimesh.intersections.mesh_plane(
        body.mesh, np.array([1.0, 0.0, 0.0]), np.array([start[0], 0.0, 0.0])
    )
    points = [start]
    for y in ys[1:]:
        a, b = segments[:, 0], segments[:, 1]
        mask = (np.minimum(a[:, 1], b[:, 1]) <= y) & (np.maximum(a[:, 1], b[:, 1]) >= y)
        mask &= abs(b[:, 1] - a[:, 1]) > 1e-9
        if mask.any():
            t = (y - a[mask, 1]) / (b[mask, 1] - a[mask, 1])
            z = a[mask, 2] + t * (b[mask, 2] - a[mask, 2])
            points.append(np.array([start[0], y, z.min()]))
    return np.asarray(points)


def wrapped_section(body: FittedBody, level: float) -> np.ndarray:
    loops = section_loops(
        body.mesh.vertices, body.mesh.faces, np.array([0.0, level, 0.0]), np.array([0.0, 1.0, 0.0])
    )
    hip = body.geometry.tapes["hip"].points
    radius = np.max(abs(hip[:, 0]))
    selected = [t.points for t in loops if abs(t.points[:, 0].mean()) <= radius]
    if not selected:
        raise ValueError("No torso/leg support for garment section")
    points = np.vstack(selected)
    from scipy.spatial import ConvexHull

    return points[ConvexHull(points[:, [0, 2]]).vertices]


def inner_girth(size: GarmentSize, field: str, product: GarmentSpec) -> float | None:
    lining = getattr(size, f"{field}_inner", None)
    if exact(lining) is not None:
        return exact(lining)
    outer = exact(getattr(size, field))
    if outer is None or product.loft_cm is None:
        return None
    return outer - 2 * np.pi * product.loft_cm


def design_ease(product: GarmentSpec, zone: str) -> float:
    chart_field = "hip" if zone == "hem" else "chest"
    if product.owned_size in product.sizes and product.owned_size in product.body_chart:
        chart = getattr(product.body_chart[product.owned_size], chart_field)
        owned = inner_girth(product.sizes[product.owned_size], zone, product)
        if chart is not None and owned is not None:
            return owned - midpoint(chart)
    return config.DESIGN_EASE_FALLBACK_CM[product.fit_intent]


def offset_metric(
    zone: str, value: float, estimated: bool = False, intent: str = "regular"
) -> ZoneMetric:
    lower, upper = config.OFFSET_BANDS_CM[zone]
    status = "tight" if value < lower else "too_big" if value > upper else "fit"
    if zone == "shoulder" and upper < value <= upper + config.INTENT_SHOULDER_DROP_CM[intent]:
        status = "relaxed"
    text = (
        f"Seam {'drops' if value >= 0 else 'inside shoulder'} {abs(value):.1f} cm"
        if zone == "shoulder"
        else f"Analytic flat-length cuff {abs(value):.1f} cm "
        f"{'past' if value >= 0 else 'short of'} wrist; stacking not yet included, unverified"
    )
    return ZoneMetric(
        value_cm=value,
        lower_cm=value,
        upper_cm=value,
        metric=f"{zone}_offset_cm",
        status=status,
        explanation=text,
        estimated=estimated,
    )


def unknown(zone: str, reason: str) -> ZoneMetric:
    return ZoneMetric(metric=zone, status="unknown", explanation=reason)


def collar_ease_metric(neck_cm: float, inner_cm: float, height_cm: float) -> ZoneMetric:
    """Skin-neck ease: never subtract torso clothing layers or insulation twice."""
    for name, value, limits in (
        ("neck", neck_cm, collar_config.NECK_RANGE_CM),
        ("collar inner", inner_cm, collar_config.INNER_RANGE_CM),
        ("collar height", height_cm, collar_config.HEIGHT_RANGE_CM),
    ):
        if not np.isfinite(value) or not limits[0] <= value <= limits[1]:
            raise ValueError(f"{name} must be finite and in {limits} cm")
    ease = inner_cm - neck_cm
    if ease <= collar_config.TIGHT_EASE_MAX_CM:
        status, label = "tight", "tight: no positive uncompressed neck ease"
    elif ease <= collar_config.SNUG_EASE_MAX_CM:
        status, label = "tight", "slightly snug at the neck"
    elif ease <= collar_config.REGULAR_EASE_MAX_CM:
        status, label = "fit", "provisionally regular at the neck"
    else:
        status, label = "relaxed", "provisionally roomy at the neck"
    return ZoneMetric(
        value_cm=float(ease),
        metric="collar_inner_ease_cm",
        status=status,
        estimated=True,
        explanation=f"Collar: {label}; inner tape {inner_cm:.1f} cm - estimated neck "
        f"{neck_cm:.1f} cm = {ease:+.1f} cm ease; measured collar height {height_cm:.1f} cm. "
        "Based on one measured collar; other sizes not measured. "
        "The 2 cm ease observation was slightly snug; comfort boundaries and the "
        "neck-plane placement are uncalibrated. No total error band is available.",
    )


def collar_fit(
    body: FittedBody, size: GarmentSize, neck: NeckGirth | None = None
) -> tuple[ZoneMetric, np.ndarray | None]:
    inner, height = exact(size.collar_inner), exact(size.collar_height)
    if inner is None or height is None:
        return unknown(
            "collar_inner_ease_cm", "Collar: not measured for this size; no neck-fit claim"
        ), None
    if neck is None or not collar_config.NECK_LABEL_VALIDATED:
        return unknown(
            "collar_inner_ease_cm",
            "Collar: neck-only section unavailable or not "
            "validated; jaw/head are excluded and no neck-fit claim is made.",
        ), None
    metric = collar_ease_metric(neck.girth_cm, inner, height)
    first, separator, rest = metric.explanation.partition(";")
    cue = "estimated neck near its base, capped below jaw" if neck.capped else "estimated neck"
    metric.explanation = f"{first} ({cue}){separator}{rest}"
    low, high = neck.band_girth_cm
    metric.explanation += (
        f" Requested {height:.1f} cm up the neck axis; evaluated at {neck.actual_height_cm:.1f} cm "
        "above the neck01 skeletal base. "
        + (
            "Capped at the last closed neck-only section before the head-weighted region; "
            "this is not an actual collar-top measurement. "
            if neck.capped
            else ""
        )
        + f"Requested 5-9 cm sensitivity band: estimated neck {low:.1f}-{high:.1f} cm, "
        f"actual heights {neck.band_actual_height_cm[0]:.1f}-"
        f"{neck.band_actual_height_cm[1]:.1f} cm. "
        "A collapsed capped band is not a zero-uncertainty claim."
    )
    return metric, neck.points


def ease_metric(
    zone: str,
    inner: float,
    body_cm: float,
    product: GarmentSpec,
    layer_cm: float,
    preference: str,
    estimated: bool,
    body_band: MeasurementBand | None = None,
    direct_inner: bool = False,
) -> ZoneMetric:
    ease = inner - body_cm - 2 * np.pi * layer_cm
    expected = design_ease(product, zone) + config.PREFERENCE_EASE_SHIFT_CM[preference]
    if zone == "bicep":
        expected = (
            config.BICEP_DESIGN_EASE_CM[product.fit_intent]
            + config.PREFERENCE_EASE_SHIFT_CM[preference]
        )
    tolerance = config.EASE_TOLERANCE_CM[zone]
    if zone == "hem" and product.hem_elastic:
        tolerance += config.ELASTIC_HEM_TOLERANCE_CM
    status = (
        "tight"
        if ease < 0
        else "fit"
        if abs(ease - expected) <= tolerance
        else "relaxed"
        if ease > expected
        else "tight"
    )
    if ease > expected + 2 * tolerance:
        status = "too_big"
    delta = 0 if direct_inner else 2 * np.pi * product.loft_uncertainty_cm
    low_body = body_band.lower_cm if body_band is not None else body_cm
    high_body = body_band.upper_cm if body_band is not None else body_cm
    return ZoneMetric(
        value_cm=ease,
        lower_cm=inner - high_body - 2 * np.pi * layer_cm - delta,
        upper_cm=inner - low_body - 2 * np.pi * layer_cm + delta,
        metric="inner_ease_cm",
        status=status,
        explanation=f"Inner ease {ease:+.1f} cm; design ease {expected:.1f} cm"
        + ("; elastic relaxed hem, tolerant" if zone == "hem" and product.hem_elastic else ""),
        estimated=estimated,
        design_ease_cm=expected,
    )


def geometry_missing(product: GarmentSpec, size: GarmentSize) -> list[str]:
    if product.chart_type == "body":
        return ["body_chart_mode"]
    fields = ["chest", "hem", "length_hps", "bicep"]
    fields += ["sleeve_cb"] if product.construction == "raglan" else ["shoulder", "sleeve"]
    missing = [name for name in fields if exact(getattr(size, name)) is None]
    if product.loft_cm is None:
        missing.append("loft_cm")
    return missing


def score_zones(
    zones: dict[str, ZoneMetric], comparison_zones: set[str] | None = None
) -> tuple[float | None, float]:
    total = sum(config.ZONE_WEIGHTS.values())
    # Collar is informational: only one size is taped, so it must not change
    # recommendation coverage/ranking or penalise sizes with no collar evidence.
    known_weight = sum(
        weight for key, weight in config.ZONE_WEIGHTS.items() if zones[key].status != "unknown"
    )
    basis = (
        comparison_zones
        if comparison_zones is not None
        else {key for key in config.ZONE_WEIGHTS if zones[key].status != "unknown"}
    )
    basis = basis & set(config.ZONE_WEIGHTS)
    coverage = known_weight / total
    if not basis or any(zones[key].status == "unknown" for key in basis):
        return None, coverage
    penalties = config.STATUS_PENALTIES
    contributions = []
    for zone, value in zones.items():
        if zone not in basis:
            continue
        severity = 0.0
        if value.value_cm is not None:
            if value.metric == "inner_ease_cm":
                tolerance = config.EASE_TOLERANCE_CM[zone]
                severity = (
                    max(0.0, abs(value.value_cm - value.design_ease_cm) - tolerance) / tolerance
                )
            elif value.metric == "body_chart_distance_cm":
                severity = abs(value.value_cm) / config.GIRTH_TOLERANCE
            elif value.status in ("tight", "too_big"):
                lower, upper = config.OFFSET_BANDS_CM[zone]
                severity = max(lower - value.value_cm, value.value_cm - upper, 0.0) / (
                    upper - lower
                )
        contributions.append(config.ZONE_WEIGHTS[zone] * (penalties[value.status] + severity**2))
    penalty = sum(contributions) / sum(config.ZONE_WEIGHTS[key] for key in basis)
    return 100 / (1 + penalty), coverage


def rank_sizes(
    sizes: dict[str, SizeFit], owned_size: str | None
) -> tuple[SizeFit | None, list[str]]:
    """Compare identical evidence; extra known problem zones cannot disadvantage one size."""
    common = set(config.ZONE_WEIGHTS)
    for size in sizes.values():
        common &= {key for key, metric in size.zones.items() if metric.status != "unknown"}
    for size in sizes.values():
        size.score, size.coverage = score_zones(size.zones, common)
    candidates = [size for size in sizes.values() if size.score is not None]
    best = (
        max(candidates, key=lambda size: (size.score, size.coverage, size.size == owned_size))
        if candidates
        else None
    )
    return best, sorted(common)


def fit_size(
    body: FittedBody,
    product: GarmentSpec,
    name: str,
    layer_cm: float,
    preference: str,
    routes: dict[str, np.ndarray] | None = None,
    collar_neck: NeckGirth | None = None,
) -> SizeFit:
    size = product.sizes[name]
    zones = {k: unknown(k, "Required garment measurement is absent") for k in config.ZONE_WEIGHTS}
    anchors = {
        k: tuple(float(x) for x in p)
        for k, p in body.geometry.landmarks.items()
        if k.startswith(("acromion", "wrist", "HPS"))
    }
    polylines = {}
    measurements = body.response.measurements
    estimated = product.chart_type == "body" or any(
        v is not None and v.source != "tape_measured"
        for v in (size.shoulder, size.chest, size.hem, size.length_hps, size.sleeve, size.bicep)
    )
    warnings = []
    zones["collar"], collar_ring = collar_fit(body, size, collar_neck)
    if collar_ring is not None:
        polylines["collar_neck_section"] = [tuple(float(c) for c in p) for p in collar_ring]
    if product.chart_type == "body":
        for zone, field, body_name in (
            ("chest", "chest", "chest"),
            ("hem", "hem", "hip"),
            ("shoulder", "shoulder", "shoulder_width"),
            ("sleeve", "sleeve", "arm_length"),
            ("bicep", "bicep", "upper_arm"),
        ):
            value = getattr(size, field)
            if value is None:
                continue
            low = value.min_cm if value.min_cm is not None else value.value_cm
            high = value.max_cm if value.max_cm is not None else value.value_cm
            body_value = measurements[body_name].value_cm
            error = (
                body_value - high
                if body_value > high
                else body_value - low
                if body_value < low
                else 0.0
            )
            zones[zone] = ZoneMetric(
                value_cm=error,
                metric="body_chart_distance_cm",
                lower_cm=error,
                upper_cm=error,
                estimated=True,
                status="tight" if error > 0 else "too_big" if error < 0 else "fit",
                explanation=f"Body {body_value:.1f} cm vs retailer BODY range "
                f"{low:.1f}–{high:.1f} cm; estimated, no garment geometry",
            )
    else:
        routes = routes or {
            "L": arm_route(body, "L"),
            "R": arm_route(body, "R"),
            "back": back_route(body),
        }
        shoulder = exact(size.shoulder)
        if product.construction == "raglan":
            zones["shoulder"] = unknown(
                "shoulder_room", "Raglan has no shoulder seam; yoke-girth measurement unavailable"
            )
        elif shoulder is not None:
            offsets = []
            for side in ("L", "R"):
                arc = polyline_length(body.geometry.surface_paths[f"shoulder_{side}"]) * 100
                offsets.append(shoulder / 2 - arc)
                anchors[f"seam_{side}"] = tuple(walk(routes[side], shoulder / 200))
            zones["shoulder"] = offset_metric(
                "shoulder", float(np.mean(offsets)), estimated, product.fit_intent
            )
        for zone, field, body_name in (
            ("chest", "chest", "chest"),
            ("bicep", "bicep", "upper_arm"),
        ):
            inner = inner_girth(size, field, product)
            if inner is not None:
                band = body.uncertainty.bands[body_name] if body.uncertainty is not None else None
                zones[zone] = ease_metric(
                    zone,
                    inner,
                    measurements[body_name].value_cm,
                    product,
                    layer_cm,
                    preference,
                    estimated or exact(getattr(size, f"{field}_inner", None)) is None,
                    band,
                    exact(getattr(size, f"{field}_inner", None)) is not None,
                )
        length = exact(size.length_hps)
        if length is not None:
            hem = walk(routes["back"], length / 100)
            ring = wrapped_section(body, float(hem[1]))
            body_hem = hull_perimeter(ring[:, [0, 2]]) * 100
            inner = inner_girth(size, "hem", product)
            if inner is not None:
                zones["hem"] = ease_metric(
                    "hem",
                    inner,
                    body_hem,
                    product,
                    layer_cm,
                    preference,
                    estimated or size.hem_inner is None,
                    direct_inner=size.hem_inner is not None,
                )
                hip_offset = (hem[1] - body.geometry.landmarks["hip_level"][1]) * 100
                zones["hem"].explanation += f"; hem {hip_offset:+.1f} cm vs hip"
                zones["hem"].position_vs_hip_cm = float(
                    (hem[1] - body.geometry.landmarks["hip_level"][1]) * 100
                )
            anchors["hem_back"] = tuple(hem)
            anchors["hem_front"] = tuple(ring[np.argmax(ring[:, 2])])
            anchors["hip_line"] = tuple(body.geometry.landmarks["hip_level"])
            polylines["hem"] = [tuple(float(c) for c in p) for p in ring]
        sleeve = exact(size.sleeve_cb) if product.construction == "raglan" else exact(size.sleeve)
        if sleeve is not None and (shoulder is not None or product.construction == "raglan"):
            offsets = []
            for side in ("L", "R"):
                distance_cm = sleeve if product.construction == "raglan" else shoulder / 2 + sleeve
                offsets.append(distance_cm - polyline_length(routes[side]) * 100)
                anchors[f"cuff_{side}"] = tuple(walk(routes[side], distance_cm / 100))
                if product.construction == "raglan":
                    anchors[f"shoulder_point_{side}"] = tuple(
                        body.geometry.landmarks[f"acromion_{side}"]
                    )
            zones["sleeve"] = offset_metric("sleeve", float(np.mean(offsets)), estimated)
        if size.sleeve_cb is not None and shoulder is not None and exact(size.sleeve) is not None:
            warnings.append(
                "Tape consistency: shoulder/2 + sleeve = "
                f"{shoulder / 2 + exact(size.sleeve):.1f} cm; "
                f"independent CB sleeve = {exact(size.sleeve_cb):.1f} cm"
            )
    # Carry the actual source grade allowance into the displayed fit interval.
    allowances = {
        "shoulder": (size.shoulder.uncertainty_cm or 0) / 2 if size.shoulder else 0,
        "sleeve": (size.sleeve.uncertainty_cm or 0) if size.sleeve else 0,
        "chest": (size.chest.uncertainty_cm or 0) if size.chest else 0,
        "hem": (size.hem.uncertainty_cm or 0) if size.hem else 0,
        "bicep": (size.bicep.uncertainty_cm or 0) if size.bicep else 0,
    }
    allowances["sleeve"] += allowances["shoulder"]
    for zone, allowance in allowances.items():
        metric = zones[zone]
        if metric.value_cm is not None and allowance:
            metric.lower_cm = (
                metric.lower_cm if metric.lower_cm is not None else metric.value_cm
            ) - allowance
            metric.upper_cm = (
                metric.upper_cm if metric.upper_cm is not None else metric.value_cm
            ) + allowance
            metric.explanation += f"; garment grade allowance ±{allowance:.1f} cm (uncalibrated)"
    missing = geometry_missing(product, size)
    score, coverage = score_zones(zones)
    if missing:
        warnings.append(
            "Geometry unavailable: " + ", ".join(missing) + "; absent dimensions were not invented"
        )
    if product.loft_cm is not None:
        warnings.append(
            f"Insulation deducted radially: {product.loft_cm:.2f} "
            f"± {product.loft_uncertainty_cm:.2f} cm"
        )
    return SizeFit(
        size=name,
        zones=zones,
        score=score,
        coverage=coverage,
        estimated=estimated,
        geometry_available=not missing,
        missing_fields=missing,
        anchors=anchors,
        polylines=polylines,
        warnings=warnings,
        elastic_zones=(["hem"] if product.hem_elastic else [])
        + (["sleeve"] if product.style in config.ADJUSTABLE_CUFF_STYLES else []),
    )
