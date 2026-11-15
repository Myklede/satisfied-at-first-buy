"""P32 saved-file tools: repository-local privacy and cooperative CPU holds."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# CPU only; these tools never open a device or acquire a browser/heavy lease.
for _key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_key] = "1"


def private_directory(name: str) -> Path:
    if name not in {"body", "face"}:
        raise ValueError("Unknown private study directory")
    path = ROOT / ".cache/research" / name
    subprocess.run(
        ["git", "check-ignore", "-q", str(path / "privacy-probe.png")],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def sync_state(text: str) -> bool:
    hold = False
    timing: set[str] = set()
    for line in text.splitlines():
        match = re.match(r"^\d{4}-\d\d-\d\d \d\d:\d\d (lead|[A-Z][\w-]*)([^:]*):\s*(.*)", line)
        if not match:
            continue
        who, title, body = match.groups()
        event = (title.strip() + " " + body).strip()
        if who == "lead":
            if re.match(r"(?:USER TEST END|HOLD lifted)(?! FOR SAVING ONLY)", event, re.I):
                hold = False
            elif re.match(r"(?:USER TEST.*(?:NOW|HOLD|starts now)|FULL HOLD)", event, re.I):
                hold = True
        elif who == "F6" and re.match(r"(?:USER TEST.*HOLD|FULL HOLD)", event, re.I):
            hold = True
        if re.match(r"(?:timing-begin|TIMING\b.*\bstart\b)", event, re.I):
            timing.add(who)
        if re.match(
            r"(?:timing-end|TIMING\b.*\bend\b|RESULT\b.*(?:fps|kiosk-live|gate))", event, re.I
        ):
            timing.discard(who)
    return hold or bool(timing)


def cpu_blocked() -> bool:
    blocked = sync_state((ROOT / "docs/requests/codex-sync.md").read_text(encoding="utf-8"))
    controls = ROOT / ".cache/lead/service/control"
    for file in controls.glob("timing*.json"):
        # The pivot permanently parks the obsolete AR render lane, not the
        # newly authorized offline P32 study. All actual timing reservations count.
        if file.name == "timing-PIVOT.json":
            continue
        try:
            if json.loads(file.read_text(encoding="utf-8"))["expiresAt"] > time.time() * 1000:
                return True
        except FileNotFoundError:
            pass
    return blocked or (ROOT / ".cache/locks/heavy").exists()


def wait_for_cpu() -> None:
    announced = False
    while cpu_blocked():
        if not announced:
            print("P32 CPU paused for timing/user hold", flush=True)
            announced = True
        time.sleep(0.5)


def person_profile() -> dict:
    """Read only the user-provided local profile; no defaults or printing values."""
    text = (ROOT / "data/reference-photos/toi.txt").read_text(encoding="utf-8")
    fields = {}
    for line in text.splitlines():
        match = re.match(r"^(height_cm|weight_kg|sex):\s*(\S+)", line)
        if match:
            fields[match[1]] = match[2]
    profile = {
        "height_cm": float(fields["height_cm"]),
        "weight_kg": float(fields["weight_kg"]),
        "sex": fields["sex"],
    }
    if (
        not 120 <= profile["height_cm"] <= 220
        or not 30 <= profile["weight_kg"] <= 200
        or profile["sex"] not in {"male", "female"}
    ):
        raise ValueError("Local profile is outside service ranges")
    return profile
