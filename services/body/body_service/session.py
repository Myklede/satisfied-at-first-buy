"""Kiosk reset: drop every in-memory cache entry derived from one person's body.

The service keeps bodies, garment fits, legacy meshes and cloth/SDF assets in bounded
RAM LRUs (nothing is written to disk). When a judge's session ends the kiosk asks the
service to forget that body now instead of waiting for LRU eviction.

The garment/simulation caches belong to another module that is being rewritten, so
this walks them defensively (getattr with defaults) and reports exactly what it removed.
"""

from __future__ import annotations

from typing import Any

from .fit import Fitter


def _pop_matching(mapping: Any, predicate) -> int:
    if not hasattr(mapping, "keys") or not hasattr(mapping, "pop"):
        return 0
    removed = 0
    for key in list(mapping.keys()):
        try:
            match = predicate(key, mapping[key])
        except (AttributeError, IndexError, KeyError, TypeError):
            match = False
        if match:
            mapping.pop(key, None)
            removed += 1
    return removed


def forget_body(
    fitter: Fitter, garments: Any | None, simulation: Any | None, body_id: str
) -> dict[str, int]:
    """Remove body_id (and its scan base body) from every known cache. Returns counts."""
    counts = {"bodies": 0, "garment_fits": 0, "garment_meshes": 0, "cloth_assets": 0, "sdf": 0}
    with fitter.lock:
        body_ids = {body_id}
        body = fitter.cache.get(body_id)
        scan = getattr(getattr(body, "response", None), "scan", None)
        if scan is not None:
            body_ids.add(scan.base_body_id)
        for bid in body_ids:
            if fitter.cache.pop(bid, None) is not None:
                counts["bodies"] += 1

    fit_ids: set[str] = set()
    if garments is not None:
        with getattr(garments, "lock", fitter.lock):
            cache = getattr(garments, "cache", None) or {}
            for fit_id in list(cache):
                if getattr(getattr(cache[fit_id], "response", None), "body_id", None) in body_ids:
                    fit_ids.add(fit_id)
                    cache.pop(fit_id, None)
                    counts["garment_fits"] += 1
            counts["garment_meshes"] += _pop_matching(
                getattr(garments, "mesh_cache", None),
                lambda key, _value: (key[0] if isinstance(key, tuple) else key) in fit_ids,
            )

    if simulation is not None:
        bodies = getattr(simulation, "bodies", None)
        sdf_bytes = getattr(simulation, "sdf_bytes", None)
        sdf_ids: set[str] = set()
        for bid in body_ids:
            entry = bodies.pop(bid, None) if hasattr(bodies, "pop") else None
            if entry is not None:
                sdf = entry[1] if isinstance(entry, tuple) and len(entry) > 1 else None
                sdf_id = getattr(sdf, "sdf_id", None)
                if sdf_id:
                    sdf_ids.add(sdf_id)
        if hasattr(sdf_bytes, "pop"):
            for sdf_id in sdf_ids:
                if sdf_bytes.pop(sdf_id, None) is not None:
                    counts["sdf"] += 1
        counts["cloth_assets"] += _pop_matching(
            getattr(simulation, "assets", None),
            lambda key, value: (
                (key[0] if isinstance(key, tuple) else key) in fit_ids
                or getattr(getattr(value, "sdf", None), "sdf_id", None) in sdf_ids
            ),
        )
        _pop_matching(
            getattr(simulation, "arm_profiles", None),
            lambda key, _value: isinstance(key, tuple) and key[0] in body_ids,
        )
        for name, keys in (
            ("preps", body_ids),
            ("shell_caches", body_ids),
            ("sdf_futures", sdf_ids),
        ):
            mapping = getattr(simulation, name, None)
            if hasattr(mapping, "pop"):
                for key in keys:
                    mapping.pop(key, None)
        pending = getattr(simulation, "pending", None)
        _pop_matching(
            pending,
            lambda key, _value: (key[0] if isinstance(key, tuple) else key) in fit_ids,
        )
    return counts
