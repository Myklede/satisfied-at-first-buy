"""Addressable cloth-asset worker processes (RAM only; nothing is written to disk).

Replaces a ``ProcessPoolExecutor`` for one reason: a kiosk reset must make the workers forget
one judge's body. An executor cannot address its workers, so the old reset replaced the whole
pool, and the next judge's jackets waited for four fresh processes to import torch/trimesh
(about 4-5 s; P2 measured Skip -> result 6.5 s with a 1.5 s reset gap vs 2.4 s with 10 s).

Here each worker has its own pipe, so a reset:
- cancels that body's queued jobs;
- terminates (and replaces) only the workers running that body's jobs, as before;
- makes every other worker run a forget call (drop that body's caches, collect garbage)
  before it takes another job.
Warm workers stay warm. Jobs are run highest priority first (lowest number), FIFO within a
priority, so the jackets the kiosk shows are never queued behind other sizes.
"""

from __future__ import annotations

import ctypes
import heapq
import io
import itertools
import multiprocessing
import os
import pickle
import threading
from collections.abc import Callable
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import trimesh

# Job priorities (lower runs first): body-only inputs every jacket waits for; the sizes the
# kiosk dresses at once; the collision field (fetched only once a jacket has arrived, so a
# shown jacket goes first when workers are short); then the other sizes.
PRIORITY_BODY = 0
PRIORITY_SHOWN = 1
PRIORITY_FIELD = 2
PRIORITY_LATER = 3

# Import priority of a replacement worker (after a reset stopped one mid-build). None = the
# OS default (NORMAL), as every fresh ProcessPoolExecutor worker imported before P2; its
# initializer then sets config.ASSET_WORKER_PRIORITY_CLASS. P2 tried IDLE and BELOW_NORMAL
# from the first instruction; under heavy machine load a lowered import can wait behind other
# programs while the pool is short-handed, so this keeps the previous behaviour.
# Windows classes: Microsoft processthreadsapi / SetPriorityClass.
REPLACEMENT_PRIORITY_CLASS: int | None = None
# A shown jacket a shopper is already waiting for (after the scan) builds at NORMAL instead of
# the workers' BELOW_NORMAL: in the browser soak the shell took ~4.5 s next to Chrome vs ~2.4 s
# in-process (P2 diagnostic soak). The scan dwell is over by then, which BELOW_NORMAL protects.
WAITED_PRIORITY_CLASS = 0x00000020
# A worker that has lived through this many kiosk resets is replaced at a reset where no other
# worker had to be stopped, if it is idle (one per reset). P2's 20-judge replay: a long-lived
# worker's private memory rose 1051 -> 1138 MB (+4.4 MB per judge) while freshly started ones
# stayed at ~760 MB, so long-lived workers are rotated instead of growing for the whole demo.
WORKER_MAX_SESSIONS = 8
_PROCESS_SET_INFORMATION = 0x0200


class AssetSessionReset(RuntimeError):
    """The owning kiosk session ended; this is not a geometry/worker failure."""


@dataclass(order=True)
class _Job:
    priority: int
    seq: int
    fn: Callable[..., Any] = field(compare=False)
    args: tuple = field(compare=False)
    owner: str | None = field(compare=False)
    future: Future = field(compare=False)
    boost: int | None = field(default=None, compare=False)  # priority class while it runs


@dataclass(eq=False)
class _Worker:
    process: Any  # multiprocessing.context.SpawnProcess
    conn: Any  # multiprocessing.connection.PipeConnection (parent end)
    ready: bool = False
    job: _Job | None = None
    calling: bool = False  # running a control call (forget)
    control: list[tuple[Callable[..., Any], tuple]] = field(default_factory=list)
    retired: bool = False
    boosted: bool = False  # running at a raised priority class (restored after the job)
    sessions: int = 0  # kiosk resets this process has lived through


def _portable(error: BaseException) -> BaseException:
    try:
        pickle.dumps(error)
        return error
    except Exception:  # noqa: BLE001 - any pickling failure: keep the message only
        return RuntimeError(f"{type(error).__name__}: {error}")


def _rebuild_mesh(vertices: np.ndarray, faces: np.ndarray) -> trimesh.Trimesh:
    return trimesh.Trimesh(vertices, faces, process=False)


class _JobPickler(pickle.Pickler):
    """Ships each trimesh mesh as its vertices and faces only (every body mesh is built as
    ``Trimesh(vertices, faces, process=False)``, see pose.py / fit.py / measure_body.py).

    A mesh's derived-data cache is not sent: it can hold an rtree index (trimesh's
    ``triangles_tree``, built in the API by proximity queries), and such an index
    intermittently failed to load in the worker ("Index_Create: InvalidPageException:
    Unknown page id 0", seen in P2 runs; cause not isolated). Workers recompute any cached
    value from the same arrays, so the results are unchanged (P2 identity diff)."""

    def reducer_override(self, obj):
        if type(obj) is trimesh.Trimesh:
            return _rebuild_mesh, (obj.vertices.view(np.ndarray), obj.faces.view(np.ndarray))
        return NotImplemented


def _dumps(message: tuple) -> bytes:
    buffer = io.BytesIO()
    _JobPickler(buffer, protocol=pickle.HIGHEST_PROTOCOL).dump(message)
    return buffer.getvalue()


def _worker_main(conn, initializer: Callable[[], None]) -> None:
    """Child process loop: ready, then jobs / control calls in the order the parent sends."""
    initializer()
    conn.send(("ready", os.getpid()))
    while True:
        try:
            message = pickle.loads(conn.recv_bytes())
        except (EOFError, OSError):
            return
        except Exception as error:  # noqa: BLE001 - a payload that does not load: its job fails
            conn.send(("error", _portable(error)))
            continue
        kind, fn, args = message
        if kind == "stop":
            return
        try:
            reply = ("ok" if kind == "job" else "done", fn(*args))
        except BaseException as error:  # noqa: BLE001 - every job error goes to its Future
            reply = ("error" if kind == "job" else "done", _portable(error))
        try:
            conn.send(reply)
        except Exception as error:  # noqa: BLE001 - e.g. an unpicklable result
            conn.send(("error", RuntimeError(f"Asset worker result not sendable: {error!r}")))


def _set_priority(pid: int, priority_class: int) -> bool:
    if os.name != "nt":
        return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    kernel.SetPriorityClass.restype = ctypes.c_int
    kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel.OpenProcess(_PROCESS_SET_INFORMATION, 0, pid)
    if not handle:
        return False  # already exited
    try:
        return bool(kernel.SetPriorityClass(handle, priority_class))
    finally:
        kernel.CloseHandle(handle)


class AssetWorkers:
    """A fixed number of spawned worker processes with a priority queue and per-worker control."""

    def __init__(
        self, count: int, initializer: Callable[[], None], base_priority: int | None = None
    ) -> None:
        """``base_priority``: the class the initializer gives each worker (restored after a
        boosted job)."""
        self._base_priority = base_priority
        self._context = multiprocessing.get_context("spawn")
        self._initializer = initializer
        self._lock = threading.Lock()
        self._queue: list[_Job] = []
        self._seq = itertools.count()
        self._closed = False
        self._ready = threading.Condition(self._lock)
        self._workers: list[_Worker] = []
        for _ in range(count):
            self._workers.append(self._spawn(None))

    # ---- public API -----------------------------------------------------------------------
    def submit(
        self,
        fn: Callable[..., Any],
        *args: Any,
        priority: int = PRIORITY_LATER,
        owner: str | None = None,
    ) -> Future:
        """Run ``fn(*args)`` in a worker. ``owner`` (a body id) lets ``forget`` cancel it."""
        future: Future = Future()
        with self._lock:
            if self._closed:
                raise RuntimeError("cannot schedule new futures after shutdown")
            heapq.heappush(self._queue, _Job(priority, next(self._seq), fn, args, owner, future))
        self._dispatch()
        return future

    def promote(self, future: Future, priority: int) -> bool:
        """Raise a queued job's priority (a shopper is now waiting for it). False if it is
        already running or done."""
        with self._lock:
            for job in self._queue:
                if job.future is future:
                    if priority < job.priority:
                        job.priority = priority
                        heapq.heapify(self._queue)
                    return True
        return False

    def boost(self, future: Future, priority_class: int) -> bool:
        """Run this job at ``priority_class`` (a shopper now waits for it): now if it is
        running, else from its dispatch. Only this pool's own processes are changed; the
        worker returns to its base class when the job ends. False if the job is unknown."""
        pid = None
        with self._lock:
            for worker in self._workers:
                if worker.job is not None and worker.job.future is future and not worker.retired:
                    worker.job.boost = priority_class
                    worker.boosted = True
                    pid = worker.process.pid
                    break
            else:
                for job in self._queue:
                    if job.future is future:
                        job.boost = priority_class
                        return True
                return False
        if pid is not None:
            _set_priority(pid, priority_class)
        return True

    def forget(self, owners: set[str], call: tuple[Callable[..., Any], tuple]) -> int:
        """Session reset for ``owners``: cancel their queued jobs, terminate (and replace) the
        workers running their jobs, and make every other worker run ``call`` before its next
        job. If no worker had to be stopped, one idle worker that has lived through
        WORKER_MAX_SESSIONS resets is replaced (bounded memory). Returns the number of workers
        terminated."""
        cancelled: list[_Job] = []
        stopped: list[_Worker] = []
        with self._lock:
            keep = []
            for job in self._queue:
                (cancelled if job.owner in owners else keep).append(job)
            heapq.heapify(keep)
            self._queue = keep
            for worker in self._workers:
                if worker.job is not None and worker.job.owner in owners:
                    worker.retired = True  # its reader thread ignores the coming EOF
                    stopped.append(worker)
                elif not worker.retired:
                    worker.control.append(call)
                    worker.sessions += 1
            if not stopped:
                old = [
                    w
                    for w in self._workers
                    if not w.retired
                    and w.ready
                    and w.job is None
                    and not w.calling
                    and w.sessions >= WORKER_MAX_SESSIONS
                ]
                if old:
                    worker = max(old, key=lambda w: w.sessions)
                    worker.retired = True
                    stopped.append(worker)
        for job in cancelled:
            job.future.cancel()
        for worker in stopped:
            worker.process.terminate()
            job, worker.job = worker.job, None
            if job is not None and not job.future.done():
                job.future.set_exception(AssetSessionReset("Cloth build cancelled (session reset)"))
            self._replace(worker)
        self._dispatch()
        return len(stopped)

    def wait_ready(self, timeout: float | None = None) -> bool:
        """Block until every worker has imported its modules (start-up warm-up)."""
        with self._ready:
            return self._ready.wait_for(
                lambda: self._closed or all(w.ready for w in self._workers), timeout
            )

    def idle(self) -> int:
        """Workers ready for a job now (imported, not running or forgetting anything)."""
        with self._lock:
            return sum(
                w.ready and not w.retired and not w.calling and w.job is None and not w.control
                for w in self._workers
            ) - len(self._queue)

    def pids(self) -> list[int]:
        with self._lock:
            return [w.process.pid for w in self._workers if not w.retired]

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            workers, self._workers = self._workers, []
            queued, self._queue = self._queue, []
            for worker in workers:
                worker.retired = True
            self._ready.notify_all()
        for job in queued:
            job.future.cancel()
        for worker in workers:
            worker.process.terminate()
            job, worker.job = worker.job, None
            if job is not None and not job.future.done():
                job.future.set_exception(AssetSessionReset("Asset workers shut down"))
        for worker in workers:
            worker.process.join(timeout=5)
            worker.conn.close()

    # ---- internals ------------------------------------------------------------------------
    def _spawn(self, import_priority: int | None) -> _Worker:
        parent, child = self._context.Pipe()
        process = self._context.Process(
            target=_worker_main, args=(child, self._initializer), daemon=True
        )
        process.start()
        if import_priority is not None and process.pid is not None:
            _set_priority(process.pid, import_priority)
        child.close()
        worker = _Worker(process, parent)
        threading.Thread(target=self._read, args=(worker,), daemon=True).start()
        return worker

    def _replace(self, old: _Worker) -> None:
        threading.Thread(target=old.process.join, daemon=True).start()
        with self._lock:
            if self._closed or old not in self._workers:
                return
        new = self._spawn(REPLACEMENT_PRIORITY_CLASS)
        with self._lock:
            if self._closed or old not in self._workers:
                closed = True
            else:
                self._workers[self._workers.index(old)] = new
                closed = False
        if closed:
            new.retired = True
            new.process.terminate()

    def _read(self, worker: _Worker) -> None:
        while True:
            try:
                kind, value = worker.conn.recv()
            except (EOFError, OSError):
                self._lost(worker)
                return
            except Exception as error:  # noqa: BLE001 - a result that failed to unpickle
                kind, value = "error", error
            future = None
            restore = False
            with self._lock:
                if worker.retired:
                    return
                if kind == "ready":
                    worker.ready = True
                    self._ready.notify_all()
                elif kind == "done":
                    worker.calling = False
                else:
                    job, worker.job = worker.job, None
                    future = job.future if job is not None else None
                    if job is None:
                        worker.calling = False  # a control call whose payload did not load
                    restore = worker.boosted and self._base_priority is not None
                    worker.boosted = False
            if restore:
                _set_priority(worker.process.pid, self._base_priority)
            if future is not None and not future.done():
                if kind == "ok":
                    future.set_result(value)
                else:
                    future.set_exception(value)
            self._dispatch()

    def _lost(self, worker: _Worker) -> None:
        with self._lock:
            if worker.retired:
                return
            worker.retired = True
            job, worker.job = worker.job, None
        if job is not None and not job.future.done():
            job.future.set_exception(BrokenProcessPool("An asset worker exited unexpectedly"))
        self._replace(worker)
        self._dispatch()

    def _dispatch(self) -> None:
        sends: list[tuple[_Worker, tuple]] = []
        with self._lock:
            for worker in self._workers:
                if not worker.ready or worker.retired or worker.calling or worker.job:
                    continue
                if worker.control:
                    fn, args = worker.control.pop(0)
                    worker.calling = True
                    sends.append((worker, ("call", fn, args)))
                    continue
                while self._queue:
                    job = heapq.heappop(self._queue)
                    if job.future.set_running_or_notify_cancel():
                        worker.job = job
                        sends.append((worker, ("job", job.fn, job.args)))
                        break
        for worker, message in sends:
            job = worker.job if message[0] == "job" else None
            if job is not None and job.boost is not None:
                worker.boosted = True
                _set_priority(worker.process.pid, job.boost)
            try:
                worker.conn.send_bytes(_dumps(message))
            except (pickle.PicklingError, TypeError, AttributeError) as error:
                self._unsent(worker, error)
            except (OSError, ValueError):
                pass  # the worker died; its reader thread reports it (EOF)

    def _unsent(self, worker: _Worker, error: BaseException) -> None:
        with self._lock:
            job, worker.job = worker.job, None
            worker.calling = False
        if job is not None and not job.future.done():
            job.future.set_exception(error)
        self._dispatch()
