"""A short explanation of the engine's ranking, never a second ranking rule."""

from .. import config
from . import agent_config as ac
from .models import SizeView, ZoneView


def status_words(zone: ZoneView) -> str:
    status = zone.adjusted_status or zone.status
    return {
        "fit": "fits",
        "tight": "tight" if zone.zone != "sleeve" else "too short",
        "relaxed": "roomy",
        "too_big": "too roomy" if zone.zone != "sleeve" else "too long",
        "unknown": "not measured",
    }[status]


def room_cm(zone: ZoneView) -> float | None:
    """Body-chart distance is body minus range; room has the opposite sign."""
    if zone.value_cm is None:
        return None
    return -zone.value_cm if zone.metric == "body_chart_distance_cm" else zone.value_cm


def zone_summary(zone: ZoneView) -> str:
    value = room_cm(zone)
    units = f" ({signed(value)} cm / {signed(value / ac.IN_TO_CM)} in)" if value is not None else ""
    return f"{zone.label.lower()} {status_words(zone)}{units}"


def signed(value: float) -> str:
    rounded = round(value, 1)
    return "0.0" if rounded == 0 else f"{rounded:+.1f}"


def explain_ranking(
    sizes: list[SizeView], pick: str | None, base_pick: str | None, offsets: dict[str, float]
) -> list[str]:
    if pick is None:
        return ["No fair pick: this chart has no comparable measured zone across all sizes."]
    chosen = next(size for size in sizes if size.size == pick)
    known = [
        z
        for z in chosen.zones
        if z.zone in config.ZONE_WEIGHTS and z.value_cm is not None and z.status != "unknown"
    ]
    problems = [z for z in known if (z.adjusted_status or z.status) in ("tight", "too_big")]
    focus = problems or known
    headline = (
        (f"{pick} is the closest fit: " if problems else f"{pick} is the best match: ")
        + "; ".join(f"{z.label.lower()} {status_words(z)}" for z in focus[:2])
        + "."
    )
    lines = [headline]
    if focus:
        lines.append(f"{pick}: {zone_summary(focus[0])}.")
    if base_pick is not None and base_pick != pick:
        preference = ", ".join(
            f"{value:+.1f} cm {ac.ZONE_LABELS[name].lower()}"
            for name, value in offsets.items()
            if value and name in ac.ZONE_LABELS
        )
        lines.append(
            f"Your provisional {preference} preference favors {pick}. "
            f"Without it we would pick {base_pick}. Undo in Profile & learning."
        )
    elif any(offsets.values()):
        lines.append("Your provisional fit preferences are included; they did not change the pick.")
    return lines[:3]
