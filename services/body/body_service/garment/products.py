"""Validated local catalogue. Lookup IDs never become filesystem paths."""

import hashlib
import json
from pathlib import Path

from ..config import ROOT
from .models import GarmentSpec


def product_hash(product: GarmentSpec) -> str:
    # Stable measurement identity. Appearance has its own full cache-key payload,
    # so adding sourced visual metadata never invalidates saved tape observations.
    payload = product.model_dump(exclude={"product_id", "visual"}, exclude_none=True)
    # Prompt 09 §6, user-approved 2026-11-12: additive measured collar tapes keep
    # legacy catalogue IDs/tape observations valid, like visual metadata. Every
    # derived fit/asset cache must include these fields separately in its key.
    for size in payload["sizes"].values():
        size.pop("collar_inner", None)
        size.pop("collar_height", None)
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def load_products(directory: Path | None = None) -> dict[str, GarmentSpec]:
    result = {}
    for path in sorted((directory or ROOT / "data/products").glob("*.json")):
        product = GarmentSpec.model_validate_json(path.read_text(encoding="utf-8-sig"))
        if product_hash(product) != product.product_id:
            raise ValueError(f"Product content hash mismatch: {path.name}")
        if product.product_id in result:
            raise ValueError("Duplicate product hash")
        result[product.product_id] = product
    return result
