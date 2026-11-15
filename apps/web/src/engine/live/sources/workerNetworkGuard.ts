// Privacy guard for the opt-in pose worker (?poseWorker=1). @mediapipe/tasks-vision 1.2.2 ships a
// usage logger that POSTs to odml.pa.googleapis.com (see packages/vision/src/networkGuard.ts, which
// guards the main thread and the vision package's own workers). A worker has its own globals, and
// that guard is not part of @satisfy/vision's public API, so this worker installs the same
// allowlist itself BEFORE MediaPipe loads: only same-origin, loopback, blob: and data: URLs.
// AGENTS.md §3: no telemetry; body data and camera frames never leave the machine.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when the URL is same-origin, loopback, or a non-network scheme (blob:, data:). */
export function workerUrlAllowed(input: string, base: string): boolean {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return false;
  }
  if (url.protocol === 'blob:' || url.protocol === 'data:') return true;
  if (url.origin === new URL(base).origin) return true;
  return LOOPBACK_HOSTS.has(url.hostname);
}

type GuardScope = {
  location?: { href: string };
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  importScripts?: (...urls: string[]) => void;
};

/** Patches fetch, XMLHttpRequest and importScripts of `scope` (the worker global). Idempotent. */
export function installWorkerNetworkGuard(scope: GuardScope = globalThis as GuardScope) {
  const marked = scope as GuardScope & { __satisfyGuard?: { blocked: number } };
  if (marked.__satisfyGuard) return marked.__satisfyGuard;
  const state = { blocked: 0 };
  marked.__satisfyGuard = state;
  const base = scope.location?.href ?? 'http://127.0.0.1/';
  const urlOf = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const fetchOriginal = scope.fetch?.bind(scope);
  if (fetchOriginal)
    scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (!workerUrlAllowed(urlOf(input), base)) {
        state.blocked++;
        return Promise.reject(new TypeError('Blocked by privacy guard: non-local request'));
      }
      return fetchOriginal(input, init);
    };
  const xhr = scope.XMLHttpRequest?.prototype;
  if (xhr) {
    const open = xhr.open;
    xhr.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      if (!workerUrlAllowed(String(args[1]), base)) {
        state.blocked++;
        throw new TypeError('Blocked by privacy guard: non-local request');
      }
      return (open as (...a: unknown[]) => void).apply(this, args);
    } as typeof xhr.open;
  }
  const importScripts = scope.importScripts?.bind(scope);
  if (importScripts)
    scope.importScripts = (...urls: string[]) => {
      if (!urls.every((u) => workerUrlAllowed(u, base))) {
        state.blocked++;
        throw new TypeError('Blocked by privacy guard: non-local script');
      }
      importScripts(...urls);
    };
  return state;
}

// Installed on import inside a worker, so an importing worker module is guarded before any later
// import (module evaluation follows import order): pose.worker.ts imports this module first.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined')
  installWorkerNetworkGuard();
