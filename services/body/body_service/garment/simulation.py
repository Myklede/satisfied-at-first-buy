"""RAM-only procedural rest/dressing assets for the shared client cloth solver."""

import atexit
import ctypes
import dataclasses
import gc
import hashlib
import logging
import multiprocessing
import os
import threading
from collections import OrderedDict
from concurrent.futures import CancelledError, Future
from concurrent.futures.process import BrokenProcessPool
from functools import partial
from time import perf_counter
from typing import Literal

import numpy as np
import trimesh
from pydantic import Field

from .. import config
from ..native_cache import install_rtree_ids
from ..pose import DisplayBody, display_body
from ..schemas import Point, StrictModel
from ..surface_query import SurfaceQuery
from .aperture import ArmProfile, CuffCollider, arm_profile, cuff_collider, neck_collider
from .arap import BoundedWrap
from .pattern import Pattern, build_pattern
from .rendering import fabric_render_data
from .sdf import body_sdf, sdf_grid
from .seams import attach_accessories
from .shell import (
    ShellBodyCache,
    armpit_level,
    build_shell,
    shell_measurements,
    shell_render_data,
    shell_render_details,
    shell_tethers,
)
from .supports import fabric_supports
from .workers import (
    PRIORITY_BODY,
    PRIORITY_FIELD,
    PRIORITY_SHOWN,
    WAITED_PRIORITY_CLASS,
    AssetSessionReset,
    AssetWorkers,
)
from .wrap import wrap_cloth


class SdfData(StrictModel):
    sdf_id: str
    origin: Point
    dimensions: list[int]
    spacing: float
    byte_length: int
    distance_bias_m: float = 0


class ClothAsset(StrictModel):
    key: str
    pose: str = config.DISPLAY_POSE_VERSION
    rest: list[float]
    initial: list[float]
    triangles: list[int]
    panels: list[int]
    elastic: list[float]
    stitch: list[float]
    loft: list[float]
    welds: list[int]
    tethers: list[int] = Field(default_factory=list)
    tether_lengths: list[float] = Field(default_factory=list)
    cuff_colliders: dict[str, CuffCollider] = Field(default_factory=dict)
    paths: dict[str, list[int]]
    landmarks: dict[str, int]
    body_landmarks: dict[str, Point]
    body_positions: list[float]
    body_triangles: list[int]
    sdf: SdfData
    config: dict[str, float]
    rest_measurements_cm: dict[str, float]
    colour: str
    finish: str
    layer_m: float
    stretch_max_source: str
    build_ms: float
    warnings: list[str] = Field(default_factory=list)
    fabric_surface: Literal["outer", "neutral"] = "outer"
    render_offsets: list[float] = Field(default_factory=list)
    attachments: list[int] = Field(default_factory=list)
    attachment_offsets: list[float] = Field(default_factory=list)
    body_arm_faces: dict[str, list[int]] = Field(default_factory=dict)
    body_arm_routes: dict[str, list[Point]] = Field(default_factory=dict)
    render_uv: list[float] = Field(default_factory=list)
    quilt: list[float] = Field(default_factory=list)
    stitch_distance_m: list[float] = Field(default_factory=list)
    puff_frames: list[int] = Field(default_factory=list)
    puff_components: list[float] = Field(default_factory=list)
    maximum_loft_m: float = 0
    neck_collider: CuffCollider | None = None
    # Sourced product details for the renderer (metres / feature codes), see shell.py.
    render_details: dict[str, float] = Field(default_factory=dict)
    # Material (rest) arc along each sleeve (metres; equals render_uv v off the sleeves).
    # Stacked sleeves: larger than the shown arc, so the shader can compress chambers.
    render_material_v: list[float] = Field(default_factory=list)


# Asset worker processes (spawned once and kept across judges; RAM only, nothing is
# written to disk). See workers.py for why this is not a ProcessPoolExecutor.
_POOL: AssetWorkers | None = None
_POOL_LOCK = threading.Lock()


def _exit_with_parent() -> None:
    """A watchdog-killed API must not leave orphan workers holding body data."""
    parent = multiprocessing.parent_process()
    if parent is not None:
        parent.join()  # waits on the inherited parent-process sentinel (no polling)
        os._exit(0)  # only this worker; its entire RAM cache goes with it


def _init_asset_worker() -> None:
    """Deprioritise only this pool's own Windows process, never another app."""
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        kernel.SetPriorityClass.restype = ctypes.c_int
        if not kernel.SetPriorityClass(
            kernel.GetCurrentProcess(), config.ASSET_WORKER_PRIORITY_CLASS
        ):
            raise ctypes.WinError(ctypes.get_last_error())
    # Workers now live across judges: bound rtree's native type cache like the API does.
    install_rtree_ids()
    threading.Thread(target=_exit_with_parent, daemon=True).start()


def asset_pool() -> AssetWorkers | None:
    global _POOL
    if config.ASSET_WORKERS <= 0:
        return None
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = AssetWorkers(
                config.ASSET_WORKERS,
                _init_asset_worker,
                config.ASSET_WORKER_PRIORITY_CLASS if os.name == "nt" else None,
            )
            # Before multiprocessing's own exit handler (atexit is LIFO) terminates the
            # workers: closed first, so their exits are not replaced while Python shuts down.
            atexit.register(_POOL.shutdown)
        return _POOL


def _forget_worker_bodies(body_ids: set[str]) -> int:
    """In a worker: drop these bodies' shell sections and collect the garbage they leave."""
    removed = sum(_WORKER_BODIES.pop(body_id, None) is not None for body_id in body_ids)
    gc.collect()
    return removed


def forget_in_workers(body_ids: set[str]) -> int:
    """Kiosk reset: make every worker forget these bodies (RAM only).

    Queued jobs of these bodies are cancelled; a worker running one of their jobs is
    terminated and replaced (it would otherwise keep the body until the job ends); every
    other worker drops their shell sections before its next job. Warm workers stay warm, so
    the next judge does not wait for fresh processes to import. Returns the number of
    workers terminated."""
    with _POOL_LOCK:
        pool = _POOL
    if pool is None:
        return 0
    return pool.forget(set(body_ids), (_forget_worker_bodies, (set(body_ids),)))


def _worker_ping() -> int:
    return os.getpid()


def warm_asset_pool() -> None:
    """Start every worker now (imports take seconds) instead of on the first jacket."""
    pool = asset_pool()
    if pool is not None:
        pool.wait_ready()


def _sdf_job(vertices: np.ndarray, faces: np.ndarray) -> bytes:
    field, _, _ = body_sdf(trimesh.Trimesh(vertices, faces, process=False))
    return field.tobytes()


def _armpit_job(posed: DisplayBody) -> float:
    return armpit_level(posed)


def _arm_job(posed: DisplayBody, side: str) -> ArmProfile:
    return arm_profile(posed.mesh, posed.hand_routes[side])


def _gather(futures: list[Future]) -> Future:
    """One future for several, with no child-Future/callback reference cycle."""
    combined: Future = Future()
    remaining = len(futures)
    results = [None] * remaining
    lock = threading.Lock()

    def one(index: int, done: Future) -> None:
        nonlocal remaining
        with lock:
            if combined.done():
                return
            if done.cancelled():
                combined.set_exception(AssetSessionReset("Cancelled (session reset)"))
            elif done.exception() is not None:
                combined.set_exception(done.exception())
            else:
                results[index] = done.result()
                remaining -= 1
                if remaining == 0:
                    combined.set_result(results)

    if not futures:
        combined.set_result([])
    for index, future in enumerate(futures):
        future.add_done_callback(partial(one, index))
    return combined


_WORKER_BODIES: OrderedDict[str, ShellBodyCache] = OrderedDict()


def _shell_job(
    fit_id, fit, product, size, body, posed, sdf, prep
) -> tuple[ClothAsset, dict[str, float]]:
    """One cloth asset in a worker, plus its local phase stamps (``asset_timing``)."""
    stamps = {"worker_start": perf_counter()}
    armpit, left, right = prep
    # Per worker: the last few bodies' section indices and hulls (sizes/products reuse them).
    cache = _WORKER_BODIES.get(fit.body_id)
    if cache is None:
        cache = _WORKER_BODIES[fit.body_id] = ShellBodyCache(posed, armpit)
        while len(_WORKER_BODIES) > config.ASSET_WORKER_BODIES:
            _WORKER_BODIES.popitem(last=False)
    _WORKER_BODIES.move_to_end(fit.body_id)
    stamps["cache_ms"] = (perf_counter() - stamps["worker_start"]) * 1000
    profiles = {(fit.body_id, "L"): left, (fit.body_id, "R"): right}
    asset = build_shell_asset(
        fit_id, fit, product, size, body, posed, sdf, cache, profiles, stamps=stamps
    )
    stamps["worker_end"] = perf_counter()
    return asset, stamps


def _relay(submit, out: Future) -> None:
    """Submit now and mirror the job's outcome (result, error or cancellation) into ``out``."""
    try:
        job = submit()
    except RuntimeError as error:  # workers shut down
        out.set_exception(error)
        return

    def copy(done: Future) -> None:
        if out.done():
            return
        if done.cancelled():
            out.cancel()
        elif done.exception() is not None:
            out.set_exception(done.exception())
        else:
            out.set_result(done.result())

    job.add_done_callback(copy)


def _done(value) -> Future:
    future: Future = Future()
    future.set_result(value)
    return future


class SimulationAssets:
    """Cloth assets per (fit, size). Thread-safe: callers must not hold ``garments.lock``
    while waiting, so both jackets (and the body SDF) build in parallel worker processes."""

    def __init__(self, garments):
        self.garments = garments
        self.lock = threading.RLock()
        self.bodies: OrderedDict[str, tuple[DisplayBody, SdfData]] = OrderedDict()
        self.patterns: dict[tuple, Pattern] = {}
        self.assets: OrderedDict[tuple, ClothAsset] = OrderedDict()
        self.pending: dict[tuple, Future] = {}
        # Body behind each pending build, so a reset cancels only its own builds
        # (``timings`` also records it, but that map is a bounded LRU).
        self.pending_bodies: dict[tuple, str] = {}
        self.sdf_bytes: dict[str, bytes] = {}
        self.sdf_futures: dict[str, Future] = {}
        self.preps: dict[str, Future] = {}
        self.arm_profiles: dict[tuple[str, str], ArmProfile] = {}
        self.shell_caches: dict[str, ShellBodyCache] = {}
        # Local phase stamps per worker build (perf_counter seconds / ms; see asset_timing).
        self.timings: OrderedDict[tuple, tuple[str, dict[str, float]]] = OrderedDict()
        self.body_stamps: OrderedDict[str, dict[str, float]] = OrderedDict()
        # Per pending build: its priority (a mutable cell) and, once submitted, its job.
        self.priorities: dict[tuple, list[int]] = {}
        self.jobs: dict[tuple, Future] = {}
        self.waited: set[tuple] = set()  # pending builds a shopper already waits for

    def body_entry(self, body_id: str, body) -> tuple[DisplayBody, SdfData]:
        """Posed body and SDF grid; with workers the field itself is computed asynchronously."""
        with self.lock:
            if body_id in self.bodies:
                self.bodies.move_to_end(body_id)
                return self.bodies[body_id]
            posing = perf_counter()
            posed = display_body(self.garments.fitter.engine, body)
            body_stamps = self.body_stamps[body_id] = {"pose_ms": (perf_counter() - posing) * 1000}
            while len(self.body_stamps) > config.CACHE_SIZE:
                self.body_stamps.popitem(last=False)
            origin, dims, _ = sdf_grid(posed.mesh.vertices)
            spacing = config.SDF_SPACING_M
            sdf_id = hashlib.sha256(
                f"{body_id}:{config.DISPLAY_POSE_VERSION}:{spacing}:{config.SDF_VERSION}".encode()
            ).hexdigest()
            sdf = SdfData(
                sdf_id=sdf_id,
                origin=origin.tolist(),
                dimensions=list(dims),
                spacing=spacing,
                byte_length=int(np.prod(dims)) * 4,
            )
            self.bodies[body_id] = (posed, sdf)
            vertices = np.asarray(posed.mesh.vertices)
            faces = np.asarray(posed.mesh.faces)
            pool = asset_pool()
            if pool is None:
                self.sdf_bytes[sdf_id] = _sdf_job(vertices, faces)
            else:
                body_stamps["body_submitted"] = perf_counter()
                # Slow body-only shell inputs first (every jacket waits for them: armpit
                # search, both arm sections), then the collision field (the client fetches
                # it after a jacket arrives); all in parallel when workers are free.
                spare = pool.idle()
                submit = partial(pool.submit, priority=PRIORITY_BODY, owner=body_id)
                armpit = submit(_armpit_job, posed)
                arms = [submit(_arm_job, posed, side) for side in ("L", "R")]
                self.preps[body_id] = _gather([armpit, *arms])
                self.preps[body_id].add_done_callback(
                    lambda _, stamps=body_stamps: stamps.setdefault("prep_done", perf_counter())
                )
                field_job = partial(
                    pool.submit, _sdf_job, vertices, faces, priority=PRIORITY_FIELD, owner=body_id
                )
                if spare >= 4:  # armpit, both arms and the field all start at once
                    future = field_job()
                else:
                    # Workers are short (e.g. a reset just replaced some): the field (fetched
                    # only once a jacket has arrived) must not take the worker a shown jacket
                    # needs when the prep ends. Queue it behind them instead.
                    future = Future()
                    self.preps[body_id].add_done_callback(
                        lambda _, out=future: _relay(field_job, out)
                    )
                self.sdf_futures[sdf_id] = future

                def store(done: Future, body_id=body_id, sdf_id=sdf_id) -> None:
                    body_stamps["sdf_done"] = perf_counter()
                    with self.lock:
                        self.sdf_futures.pop(sdf_id, None)
                        # A body forgotten meanwhile (kiosk reset) keeps nothing.
                        if body_id in self.bodies and not done.cancelled():
                            if done.exception() is None:
                                self.sdf_bytes[sdf_id] = done.result()

                future.add_done_callback(store)
            while len(self.bodies) > config.CACHE_SIZE:
                old_body, (_, old_sdf) = self.bodies.popitem(last=False)
                self.sdf_bytes.pop(old_sdf.sdf_id, None)
                self.sdf_futures.pop(old_sdf.sdf_id, None)
                self.shell_caches.pop(old_body, None)
                self.preps.pop(old_body, None)
                for side in ("L", "R"):
                    self.arm_profiles.pop((old_body, side), None)
                for asset_key in list(self.assets):
                    if self.assets[asset_key].sdf.sdf_id == old_sdf.sdf_id:
                        self.assets.pop(asset_key)
            return self.bodies[body_id]

    def prepare(self, body_id: str) -> None:
        """Start the body-only work (pose, SDF, sections) before a jacket is requested.

        With workers this returns at once; the kiosk calls it when the body is fitted."""
        with self.garments.lock:
            body = self.garments.fitter.get(body_id)
            self.body_entry(body_id, body)

    def sdf(self, sdf_id: str, timeout: float | None = None) -> bytes | None:
        """The SDF bytes, waiting for an in-flight build; None if unknown or forgotten."""
        with self.lock:
            if sdf_id in self.sdf_bytes:
                return self.sdf_bytes[sdf_id]
            future = self.sdf_futures.get(sdf_id)
        if future is None:
            return None
        try:
            future.result(timeout)
        except (CancelledError, AssetSessionReset):  # forgotten by a kiosk reset
            return None
        except BrokenProcessPool:
            with self.lock:
                if sdf_id not in self.sdf_futures:
                    return None  # reset removed this field while the caller was waiting
            raise  # an unexpected worker crash remains an error
        with self.lock:
            return self.sdf_bytes.get(sdf_id)

    def get(
        self, fit_id: str, size: str, priority: int = PRIORITY_SHOWN, waited: bool = False
    ) -> ClothAsset:
        """``waited``: a shopper waits for this asset now (see ``wait_for``)."""
        future = self.request(fit_id, size, priority=priority)
        if waited:
            self.wait_for(fit_id, size)
        return future.result()

    def wait_for(self, fit_id: str, size: str) -> None:
        """A shopper is waiting for this build now (the kiosk's recommended jacket after the
        scan): run it at WAITED_PRIORITY_CLASS from now on (only these worker processes)."""
        key = (fit_id, size)
        with self.lock:
            if key not in self.pending:
                return
            self.waited.add(key)
            job = self.jobs.get(key)
        pool = asset_pool()
        if job is not None and pool is not None:
            pool.boost(job, WAITED_PRIORITY_CLASS)

    def shown_pending(self) -> bool:
        """Whether a build the kiosk shows at once (recommended / requested) is in flight."""
        with self.lock:
            return any(
                cell[0] <= PRIORITY_SHOWN
                for key, cell in self.priorities.items()
                if key in self.pending
            )

    def request(self, fit_id: str, size: str, fit=None, priority: int = PRIORITY_SHOWN) -> Future:
        """Cached asset, the in-flight build of the same key, or a new build.

        ``fit`` (a GarmentFitResponse) may be passed for a speculative build whose garment
        fit is not kept in the garment cache (see ``app.speculate_cloth``). ``priority``
        (workers.PRIORITY_*): joining a queued build with a higher priority promotes it."""
        key = (fit_id, size)
        with self.garments.lock, self.lock:
            if key in self.assets:
                self.assets.move_to_end(key)
                return _done(self.assets[key])
            if key in self.pending:
                cell = self.priorities.get(key)
                if cell is not None and priority < cell[0]:
                    cell[0] = priority
                    job, pool = self.jobs.get(key), asset_pool()
                    if job is not None and pool is not None:
                        pool.promote(job, priority)
                return self.pending[key]
            if fit is None:
                fit = self.garments.get(fit_id).response
            product = self.garments.products[fit.product_id]
            if size not in product.sizes:
                raise KeyError(size)
            body = self.garments.fitter.get(fit.body_id)
            posed, sdf = self.body_entry(fit.body_id, body)
            if config.GARMENT_CONSTRUCTION != "shell":
                result = self.pattern_asset(fit_id, fit, product, size, body, posed, sdf)
                self.store(key, fit.body_id, result)
                return _done(result)
            pool = asset_pool()
            if pool is None:
                cache = self.shell_caches.get(fit.body_id)
                if cache is None:
                    cache = self.shell_caches[fit.body_id] = ShellBodyCache(posed)
                result = build_shell_asset(
                    fit_id, fit, product, size, body, posed, sdf, cache, self.arm_profiles
                )
                self.store(key, fit.body_id, result)
                return _done(result)
            # The worker needs geometry only; the body GLB stays in this process.
            lite = dataclasses.replace(body, glb=b"")
            prep = self.preps[fit.body_id]
            outer: Future = Future()
            self.pending[key] = outer
            self.pending_bodies[key] = fit.body_id
            cell = self.priorities[key] = [priority]
            started = perf_counter()
            stamps = {"requested": started}
            self.timings[key] = (fit.body_id, stamps)
            while len(self.timings) > config.CACHE_SIZE * 2:
                self.timings.popitem(last=False)
        body_id = fit.body_id

        def failure(done: Future) -> BaseException | None:
            # A kiosk reset recycles the worker pool, which cancels in-flight futures;
            # waiters must get an error instead of hanging.
            if done.cancelled():
                return AssetSessionReset("Cloth build cancelled (session reset)")
            return done.exception()

        def inline(error: BaseException) -> None:
            """A worker failed (not a reset): build in this process instead of failing the
            request. Same pure function and inputs as the worker job (the ASSET_WORKERS=0
            path), so the asset is identical; only slower and on the API's own CPU."""
            logging.warning("Asset worker build failed (%s); building in-process", error)
            fallback_at = perf_counter()
            try:
                asset = build_shell_asset(
                    fit_id, fit, product, size, body, posed, sdf, ShellBodyCache(posed), {}
                )
            except Exception as again:  # noqa: BLE001 - a genuine geometry failure
                failed: Future = Future()
                failed.set_exception(again)
                finish(failed, fallback=False)
                return
            built: Future = Future()
            built.set_result((asset, {"inline_ms": (perf_counter() - fallback_at) * 1000}))
            finish(built, fallback=False)

        def finish(done: Future, fallback: bool = True) -> None:
            error = failure(done)
            if fallback and error is not None and not isinstance(error, AssetSessionReset):
                with self.lock:
                    known = body_id in self.bodies
                if known:
                    threading.Thread(target=inline, args=(error,), daemon=True).start()
                    return
            asset = None
            with self.lock:
                if self.pending.get(key) is outer:
                    self.pending.pop(key, None)
                    self.pending_bodies.pop(key, None)
                self.priorities.pop(key, None)
                self.jobs.pop(key, None)
                self.waited.discard(key)
                if error is not None and body_id not in self.bodies:
                    # Any failure of a body forgotten meanwhile is that reset, not a fault.
                    error = AssetSessionReset("Cloth build cancelled (session reset)")
                if error is None:
                    asset, worker = done.result()
                    stamps.update(worker)
                    stamps["received"] = perf_counter()
                    stamps.setdefault("worker_end", stamps["received"])
                    asset.build_ms = (stamps["received"] - started) * 1000
                    self.store(key, body_id, asset)
            if outer.done():
                return
            if error is None:
                outer.set_result(asset)
            else:
                outer.set_exception(error)

        def launch(ready: Future) -> None:
            if failure(ready) is not None:
                finish(ready)
                return
            stamps["submitted"] = perf_counter()
            submitted = cell[0]
            try:
                job = pool.submit(
                    _shell_job,
                    *(fit_id, fit, product, size, lite, posed, sdf, ready.result()),
                    priority=submitted,
                    owner=body_id,
                )
            except RuntimeError as error:  # pool shut down (service exit)
                job = Future()
                job.set_exception(error)
            else:
                with self.lock:
                    if key in self.pending:
                        self.jobs[key] = job
                    if cell[0] < submitted:  # promoted while it was being submitted
                        pool.promote(job, cell[0])
                    waited = key in self.waited
                if waited:
                    pool.boost(job, WAITED_PRIORITY_CLASS)
            job.add_done_callback(finish)

        prep.add_done_callback(launch)
        return outer

    def cancel_pending(self, body_ids: set[str]) -> int:
        """Kiosk reset: fail these bodies' in-flight builds now (their waiters get
        ``AssetSessionReset``). Other bodies' builds keep running: one client's reset must
        not 410 another client's cloth request on the same service. Returns the count."""
        cancelled = 0
        with self.lock:
            for key in [k for k, b in self.pending_bodies.items() if b in body_ids]:
                self.pending_bodies.pop(key, None)
                future = self.pending.pop(key, None)
                if future is not None and not future.done():
                    future.set_exception(AssetSessionReset("Cloth build cancelled (session reset)"))
                    cancelled += 1
        return cancelled

    def forget_timings(self, body_ids: set[str]) -> None:
        """Kiosk reset: drop these bodies' timing stamps (numbers only, keyed by their ids)."""
        with self.lock:
            for body_id in body_ids:
                self.body_stamps.pop(body_id, None)
            for key in [k for k, (b, _) in self.timings.items() if b in body_ids]:
                self.timings.pop(key, None)

    def asset_timing(self, fit_id: str, size: str, since: float) -> dict[str, float]:
        """Phases (ms) of the worker build behind this asset, for opt-in Server-Timing only.

        ``since`` is the request's own start (perf_counter). On Windows perf_counter is
        QueryPerformanceCounter, one system-wide clock, so worker stamps are comparable.
        ``ahead`` > 0: the build had started that long before this request (speculation)."""
        with self.lock:
            body_id, stamps = self.timings.get((fit_id, size), ("", {}))
            stamps, body = dict(stamps), dict(self.body_stamps.get(body_id, {}))
        if "received" not in stamps:
            return {}  # served from the cache after its stamps were evicted, or inline

        spans = {
            "prep_wait": ("requested", "submitted"),
            "pool_wait": ("submitted", "worker_start"),
            "return": ("worker_end", "received"),
            "build": ("requested", "received"),
        }
        phases = {"ahead": (since - stamps["requested"]) * 1000}
        for name, (start, end) in spans.items():
            if start in stamps and end in stamps:  # an in-process fallback has fewer stamps
                phases[name] = (stamps[end] - stamps[start]) * 1000
        for name in ("cache", "shell", "assemble", "inline"):
            if f"{name}_ms" in stamps:
                phases[name] = stamps[f"{name}_ms"]
        if "pose_ms" in body:
            phases["pose"] = body["pose_ms"]
        for name in ("sdf_done", "prep_done"):
            if name in body and "body_submitted" in body:
                phases[name.replace("_done", "_build")] = (
                    body[name] - body["body_submitted"]
                ) * 1000
        return phases

    def store(self, key: tuple, body_id: str, asset: ClothAsset) -> None:
        with self.lock:
            if body_id not in self.bodies:
                return  # forgotten (kiosk reset) while building
            self.assets[key] = asset
            while len(self.assets) > config.CACHE_SIZE * 2:
                self.assets.popitem(last=False)

    def pattern_asset(self, fit_id, fit, product, size, body, posed, sdf) -> ClothAsset:
        started = perf_counter()
        pkey = (product.product_id, size)
        if pkey not in self.patterns:
            self.patterns[pkey] = build_pattern(product, size, quilted=False)
        pattern = self.patterns[pkey]
        rest = pattern.mesh.vertices.copy()
        mechanical = config.CLOTH_CONFIG.copy()
        mechanical["maxSeconds"] = config.CLOTH_WRAP_RELAX_SECONDS
        mechanical["selfRadius"] = config.CLOTH_FABRIC_SELF_RADIUS_M
        mechanical["stretchMax"] = product.fabric.stretch_max or mechanical["stretchMax"]
        # Hierarchical arc bounds accelerate tension propagation through actual
        # material paths. Both endpoints move; no body/world target is prescribed.
        support_pairs, bounds = fabric_supports(pattern)
        if not np.isfinite(bounds).all():
            raise ValueError("Every garment particle must connect to the sewn support graph")
        colliders = {}
        for side in ("L", "R"):
            profile_key = (fit.body_id, side)
            if profile_key not in self.arm_profiles:
                self.arm_profiles[profile_key] = arm_profile(posed.mesh, posed.hand_routes[side])
            key_name = (
                f"cuff_inner_{side}" if f"cuff_inner_{side}" in pattern.tapes else f"cuff_{side}"
            )
            opening = pattern.measurements(rest)[key_name] / 100
            colliders[side] = cuff_collider(
                self.arm_profiles[profile_key],
                opening,
                fit.layer_cm / 100,
                mechanical["stretchMax"],
            )
        cuff_distances = {
            side: float(np.linalg.norm(posed.arm_centres[side][1] - posed.arm_centres[side][0]))
            + (
                collider.stop_distance_m
                if collider.stop_distance_m is not None
                else collider.distances_m[-1]
            )
            for side, collider in colliders.items()
        }
        wrapped = wrap_cloth(
            pattern,
            body,
            posed,
            fit.sizes[size],
            fit.layer_cm / 100 + mechanical["collisionMargin"],
            cuff_distances,
        )
        initial = wrapped.positions
        physical = (pattern.panels <= 7) | (pattern.panels == 13)
        used = np.flatnonzero(physical)
        remap = np.full(len(rest), -1, dtype=int)
        remap[used] = np.arange(len(used))
        cloth_edges = pattern.mesh.edges_unique
        cloth_edges = cloth_edges[physical[cloth_edges].all(1)]
        limits = np.where(
            pattern.elastic[cloth_edges].any(1),
            mechanical["stretchMax"] - config.WRAP_INITIAL_STRETCH_RESERVE,
            config.WRAP_INITIAL_STRETCH,
        )
        closest, _, face_ids = SurfaceQuery(posed.mesh).closest(initial[used])
        bary = trimesh.triangles.points_to_barycentric(posed.mesh.triangles[face_ids], closest)
        normal = np.einsum(
            "nij,ni->nj", posed.mesh.vertex_normals[posed.mesh.faces[face_ids]], bary
        )
        normal /= np.linalg.norm(normal, axis=1)[:, None]
        bound = (
            np.einsum("ij,ij->i", normal, closest)
            + fit.layer_cm / 100
            + mechanical["collisionMargin"]
        )
        upward = np.isfinite(wrapped.upward_contact[used])
        normal[upward] = [0.0, 1.0, 0.0]
        bound[upward] = wrapped.upward_contact[used[upward]]
        anchor = np.full(len(used), config.WRAP_INITIAL_TARGET_WEIGHT)
        collar_ids = np.r_[
            pattern.torso_grid[0], np.flatnonzero(pattern.panels == 6), pattern.tapes["hem"][:-1]
        ]
        anchor[remap[collar_ids]] = config.WRAP_PIN_WEIGHT
        initial[used] = BoundedWrap(rest[used], remap[cloth_edges], limits, anchor).project(
            initial[used], config.WRAP_INITIAL_ITERATIONS, (normal, bound)
        )
        initial = attach_accessories(pattern, initial)
        rendering = fabric_render_data(pattern, product)
        result = ClothAsset(
            key=f"{fit_id}:{size}:{config.GARMENT_ASSET_VERSION}:{config.DISPLAY_POSE_VERSION}",
            rest=rest.ravel().tolist(),
            initial=initial.ravel().tolist(),
            triangles=pattern.mesh.faces.ravel().tolist(),
            panels=pattern.panels.tolist(),
            elastic=pattern.elastic.tolist(),
            stitch=pattern.stitch.tolist(),
            loft=pattern.loft.tolist(),
            welds=pattern.welds.ravel().tolist(),
            fabric_surface="neutral",
            render_offsets=pattern.render_offsets.ravel().tolist(),
            attachments=pattern.attachments.ravel().tolist(),
            attachment_offsets=pattern.attachment_offsets.ravel().tolist(),
            body_arm_faces={
                side: faces.ravel().tolist() for side, faces in posed.arm_faces.items()
            },
            body_arm_routes={side: route.tolist() for side, route in posed.arm_centres.items()},
            render_uv=rendering.uv.ravel().tolist(),
            quilt=rendering.quilt.ravel().tolist(),
            stitch_distance_m=rendering.stitch_distance.tolist(),
            puff_frames=rendering.frames.ravel().tolist(),
            puff_components=rendering.puff_components.ravel().tolist(),
            maximum_loft_m=product.loft_cm / 100,
            neck_collider=neck_collider(
                posed.mesh,
                posed.landmarks,
                pattern.measurements(rest)["neckline"] / 100,
                fit.layer_cm / 100 + mechanical["collisionMargin"],
                mechanical["stretchMax"],
            ),
            tethers=support_pairs.ravel().tolist(),
            tether_lengths=bounds.tolist(),
            cuff_colliders=colliders,
            paths=pattern.tapes,
            landmarks=pattern.landmarks,
            body_landmarks={k: p.tolist() for k, p in posed.landmarks.items()},
            body_positions=posed.mesh.vertices.ravel().tolist(),
            body_triangles=posed.mesh.faces.ravel().tolist(),
            sdf=sdf,
            config=mechanical,
            rest_measurements_cm=pattern.measurements(),
            colour=product.visual.colour_hex.value,
            finish=product.visual.finish.value,
            layer_m=fit.layer_cm / 100,
            stretch_max_source="retailer"
            if product.fabric.stretch_max
            else "uncalibrated assumption",
            build_ms=(perf_counter() - started) * 1000,
            warnings=[
                "Material stiffness, hood dimensions and cuff girth are uncalibrated assumptions.",
                f"Assumed garment mass {mechanical['particleMass'] * physical.sum():.3f} kg; "
                "awaiting kitchen-scale weight.",
                "Derived sizes carry model uncertainty; rest tapes are preserved.",
            ],
        )
        return result


def build_shell_asset(
    fit_id: str,
    fit,
    product,
    size: str,
    body,
    posed: DisplayBody,
    sdf: SdfData,
    cache: ShellBodyCache,
    arm_profiles: dict[tuple[str, str], ArmProfile],
    stamps: dict[str, float] | None = None,
) -> ClothAsset:
    """03c fallback construction: tape-true posed shell, then an optional short relax.

    Pure function of its arguments (runs in an asset worker process or inline). ``stamps``,
    if given, receives local timings only (``shell_ms``, ``assemble_ms``); never the asset."""
    started = perf_counter()
    mechanical = {**config.CLOTH_CONFIG, **config.SHELL_CLOTH_CONFIG}
    mechanical["maxSeconds"] = config.SHELL_RELAX_SECONDS
    mechanical["selfRadius"] = config.CLOTH_FABRIC_SELF_RADIUS_M
    mechanical["stretchMax"] = product.fabric.stretch_max or mechanical["stretchMax"]
    layer = fit.layer_cm / 100
    colliders = {}
    stops = {}
    for side in ("L", "R"):
        profile_key = (fit.body_id, side)
        if profile_key not in arm_profiles:
            arm_profiles[profile_key] = arm_profile(posed.mesh, posed.hand_routes[side])
        colliders[side] = cuff_collider(
            arm_profiles[profile_key],
            config.CLOTH_CUFF_INNER_M,
            layer,
            mechanical["stretchMax"],
        )
        collider = colliders[side]
        stops[side] = float(
            np.linalg.norm(posed.arm_centres[side][1] - posed.arm_centres[side][0])
        ) + (
            collider.stop_distance_m
            if collider.stop_distance_m is not None
            else collider.distances_m[-1]
        )
    shell_started = perf_counter()
    shell = build_shell(product, size, fit.sizes[size], body, posed, layer, stops, cache)
    shell_done = perf_counter()
    rendering = shell_render_data(shell, product)
    tether_pairs, tether_lengths = shell_tethers(shell)
    loft = product.loft_cm / 100
    measured = shell_measurements(shell, product)
    neckline = shell.initial[shell.paths["neckline"][:-1]]
    asset = ClothAsset(
        key=f"{fit_id}:{size}:{config.GARMENT_ASSET_VERSION}:{config.DISPLAY_POSE_VERSION}",
        rest=shell.rest.ravel().tolist(),
        initial=shell.initial.ravel().tolist(),
        triangles=shell.faces.ravel().tolist(),
        panels=shell.panels.tolist(),
        elastic=shell.elastic.tolist(),
        stitch=shell.stitch.tolist(),
        loft=np.full(len(shell.initial), loft).tolist(),
        welds=[],
        tethers=tether_pairs.ravel().tolist(),
        tether_lengths=tether_lengths.tolist(),
        fabric_surface="neutral",
        render_offsets=[0.0] * (3 * len(shell.initial)),
        attachments=[],
        attachment_offsets=[],
        render_uv=shell.uv.ravel().tolist(),
        quilt=shell.quilt.ravel().tolist(),
        stitch_distance_m=rendering["stitch_distance"].tolist(),
        puff_frames=rendering["frames"].ravel().tolist(),
        puff_components=rendering["components"].ravel().tolist(),
        maximum_loft_m=loft,
        render_details=shell_render_details(shell, product),
        render_material_v=shell.material_v.tolist(),
        neck_collider=neck_collider(
            posed.mesh,
            posed.landmarks,
            float(np.linalg.norm(neckline - np.roll(neckline, 1, axis=0), axis=1).sum()),
            layer + mechanical["collisionMargin"],
            mechanical["stretchMax"],
        ),
        body_arm_faces={side: faces.ravel().tolist() for side, faces in posed.arm_faces.items()},
        body_arm_routes={side: route.tolist() for side, route in posed.arm_centres.items()},
        cuff_colliders=colliders,
        paths=shell.paths,
        landmarks=shell.landmarks,
        body_landmarks={k: p.tolist() for k, p in posed.landmarks.items()},
        body_positions=posed.mesh.vertices.ravel().tolist(),
        body_triangles=posed.mesh.faces.ravel().tolist(),
        sdf=sdf,
        config=mechanical,
        rest_measurements_cm=measured,
        colour=product.visual.colour_hex.value,
        finish=product.visual.finish.value,
        layer_m=layer,
        stretch_max_source="retailer" if product.fabric.stretch_max else "uncalibrated assumption",
        build_ms=(perf_counter() - started) * 1000,
        warnings=[
            "Tape-true posed shell (03c fallback construction); rest girths/lengths from tape.",
            "Material stiffness, hood dimensions and cuff opening are uncalibrated assumptions.",
            f"Assumed garment mass {mechanical['particleMass'] * len(shell.initial):.3f} kg; "
            "awaiting kitchen-scale weight.",
            "Derived sizes carry model uncertainty; rest tapes are preserved.",
            *shell.warnings,
        ],
    )
    if stamps is not None:
        stamps["shell_ms"] = (shell_done - shell_started) * 1000
        stamps["assemble_ms"] = (perf_counter() - shell_done) * 1000
    return asset
