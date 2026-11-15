"""Bounded native caches for long-lived processes (the API and its asset workers)."""

import ctypes
from collections.abc import Iterator

from rtree import core as rtree_core
from rtree import index as rtree_index


def _bounded_rtree_ids(_index: object, handle: object, count: int) -> Iterator[int]:
    """rtree 1.4.1's ID iterator, without one global ctypes type per result count.

    The pinned implementation casts to POINTER(c_int64 * count); ctypes retains each
    distinct array/pointer class globally. Cast to a single element-pointer type
    instead. Native result order, signed int64 IDs and Index_Free ownership are
    unchanged, including an empty or partially consumed iterator.
    """
    ids = ctypes.cast(handle, ctypes.POINTER(ctypes.c_int64))
    try:
        for index in range(count):
            yield ids[index]
    finally:
        rtree_core.rt.Index_Free(ctypes.cast(ids, ctypes.POINTER(ctypes.c_void_p)))


def install_rtree_ids() -> None:
    """Local compatibility adapter for the locked rtree==1.4.1; no dependency files or
    global ctypes caches are modified. Install before any body measurement is run.
    Asset workers install it too: since P2 they live across judges (no reset respawn)."""
    rtree_index.Index._get_ids = _bounded_rtree_ids
