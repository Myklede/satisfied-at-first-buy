"""Local files for the Fit Agent. Nothing here is ever sent anywhere.

- profile.json / learning.json: personal (opt-in body profile; purchases and fit feedback).
  Never written in kiosk mode (SATISFY_KIOSK_MODE=1). One DELETE removes both.
- extractions/<ASIN>.json: product content only (page fields + extraction), so the demo runs from
  cache without wifi. reviewed/<ASIN>.json (coordinator-checked) live under data/amazon-pages.
File names are built from validated ASINs / fixed names only, never from free user input.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from datetime import date
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from . import agent_config as ac
from .models import Extraction, PageContent, ReviewedExtraction

_ASIN = re.compile(r"^[A-Z0-9]{10}$")


class PrivacyRefused(PermissionError):
    pass


def kiosk_mode() -> bool:
    return os.environ.get(ac.KIOSK_MODE_ENV) == "1"


def store_dir() -> Path:
    return Path(os.environ.get(ac.STORE_DIR_ENV) or ac.DEFAULT_STORE_DIR)


def reviewed_dir() -> Path:
    return Path(os.environ.get("FIT_AGENT_REVIEWED_DIR") or ac.REVIEWED_DIR)


def _asin_path(directory: Path, asin: str) -> Path:
    if not _ASIN.fullmatch(asin):
        raise ValueError("Invalid ASIN")
    return directory / f"{asin}.json"


def _write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None


# --- Personal -----------------------------------------------------------------------------
def profile_path() -> Path:
    return store_dir() / "profile.json"


def learning_path() -> Path:
    return store_dir() / "learning.json"


def load_profile() -> dict | None:
    if kiosk_mode():
        return None  # kiosk: a profile file from another session is never read either
    return _read(profile_path())


def save_profile(fit_request: dict, choices: dict) -> dict:
    if kiosk_mode():
        raise PrivacyRefused("Kiosk mode: body profiles are never stored")
    data = {
        "version": 1,
        "saved_on": date.today().isoformat(),
        "fit_request": fit_request,
        "choices": choices,
    }
    _write(profile_path(), data)
    return data


def delete_personal() -> list[str]:
    """Delete the profile and everything learned from feedback. Returns the files removed."""
    removed = []
    for path in (profile_path(), learning_path()):
        if path.exists():
            path.unlink()
            removed.append(path.name)
    return removed


def load_learning() -> dict:
    data = None if kiosk_mode() else _read(learning_path())
    return data or {"version": 1, "purchases": []}


def save_learning(data: dict) -> None:
    if kiosk_mode():
        raise PrivacyRefused("Kiosk mode: purchases and feedback are never stored")
    data["purchases"] = data["purchases"][-ac.MAX_FEEDBACK_EVENTS :]
    _write(learning_path(), data)


def new_id() -> str:
    return secrets.token_hex(16)


# --- Product content (not personal) ---------------------------------------------------------
def load_reviewed(asin: str) -> ReviewedExtraction | None:
    raw = _read(_asin_path(reviewed_dir(), asin))
    if raw is None:
        return None
    try:
        return ReviewedExtraction.model_validate(raw)
    except ValidationError as error:
        raise ValueError(
            f"Reviewed extraction for {asin} is invalid: {error.error_count()} errors"
        ) from error


def cache_extraction(page: PageContent, extraction: Extraction, label: str, page_hash: str) -> None:
    _write(
        _asin_path(store_dir() / "extractions", page.asin),
        {
            "page": page.model_dump(mode="json"),
            "page_hash": page_hash,
            "label": label,
            "extraction": extraction.model_dump(mode="json"),
        },
    )


def cached_extraction(asin: str) -> tuple[PageContent, Extraction, str, str] | None:
    raw = _read(_asin_path(store_dir() / "extractions", asin))
    if raw is None:
        return None
    try:
        return (
            PageContent.model_validate(raw["page"]),
            Extraction.model_validate(raw["extraction"]),
            str(raw["label"]),
            str(raw["page_hash"]),
        )
    except (KeyError, ValidationError):
        return None
