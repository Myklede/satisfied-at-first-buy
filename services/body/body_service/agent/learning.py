"""Personal ease offsets learned from "how did it fit?" answers. Pure, bounded, explainable.

Each answer is compared with what the engine predicted for that zone of the size bought (the
prediction without personal offsets, so every answer is independent and can be undone alone):
- the answer agrees with the prediction → nothing to learn ("confirmed");
- "tight" where we predicted fit or roomier → the shopper wants more room: +step;
- "loose" where we predicted fit or tighter → wants less room: −step;
- "right" where we predicted tight → tolerates less room: −step; predicted roomy → +step.
The offset of a zone is the clamped sum of its steps (agent_config.LEARN_STEP_CM / LEARN_MAX_CM).
A positive offset means "you prefer X cm more room here"; convert.apply_offsets applies it.
"""

from __future__ import annotations

from . import agent_config as ac

_ROOMY = {"relaxed", "too_big"}


def step(answer: str, predicted: str, zone: str) -> float:
    size = ac.LEARN_STEP_CM[zone]
    if predicted == "unknown":
        return 0.0
    if answer == "tight":
        return 0.0 if predicted == "tight" else size
    if answer == "loose":
        return 0.0 if predicted in _ROOMY else -size
    # "right"
    if predicted == "tight":
        return -size
    if predicted in _ROOMY:
        return size
    return 0.0


def offsets(purchases: list[dict]) -> tuple[dict[str, float], list[dict]]:
    """Return ({zone: offset_cm}, explanation items) from stored purchases with feedback."""
    totals = {zone: 0.0 for zone in ac.FEEDBACK_ZONES}
    items: list[dict] = []
    for purchase in purchases:
        feedback = purchase.get("feedback")
        if not feedback:
            continue
        for zone, answer in feedback["answers"].items():
            if zone not in totals:
                continue
            snap = purchase.get("snapshot", {}).get(zone, {"status": "unknown"})
            delta = step(answer, snap.get("status", "unknown"), zone)
            totals[zone] += delta
            value = snap.get("value_cm")
            predicted = snap.get("status", "unknown") + (
                f" ({value:+.1f} cm)" if isinstance(value, int | float) else ""
            )
            items.append(
                {
                    "purchase_id": purchase["id"],
                    "zone": zone,
                    "answer": answer,
                    "predicted": predicted,
                    "delta_cm": delta,
                    "text": (
                        f"{ac.ZONE_LABELS[zone]}: you said '{answer}' for size "
                        f"{purchase['size']} of "
                        f"{purchase.get('title') or purchase['asin']}; we predicted {predicted}"
                        + (f" → {delta:+.1f} cm" if delta else " → confirmed, nothing to change")
                    ),
                }
            )
    clamped = {
        zone: max(-ac.LEARN_MAX_CM[zone], min(ac.LEARN_MAX_CM[zone], total))
        for zone, total in totals.items()
    }
    return {zone: round(value, 2) for zone, value in clamped.items() if value}, items


def describe(offsets_cm: dict[str, float]) -> list[str]:
    return [
        f"You prefer {abs(value):.1f} cm ({abs(value) / ac.IN_TO_CM:.1f} in) "
        f"{'more' if value > 0 else 'less'} room at {ac.ZONE_LABELS[zone].lower()} "
        f"({value:+.1f} cm {zone} ease)"
        for zone, value in offsets_cm.items()
    ]
