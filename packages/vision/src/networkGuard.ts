// Privacy guard: @mediapipe/tasks-vision 1.2.2 ships a usage logger that POSTs to
// https://odml.pa.googleapis.com/v1/log and has no opt-out (found by grepping vision_bundle.mjs,
// 2026-11-12). AGENTS.md §3 forbids telemetry: nothing may leave this machine. This guard makes
// fetch / XMLHttpRequest / sendBeacon refuse any URL that is not same-origin or loopback, before
// a request is made. It is installed by every tracker factory in this package. Pages should also
// set a `connect-src 'self'` Content-Security-Policy as defence in depth.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

let installed = false;
let blocked = 0;

/** Number of outbound requests refused since the guard was installed. */
export function blockedRequestCount(): number {
  return blocked;
}

/** True when the URL is same-origin, loopback, or a non-network scheme (blob:, data:). */
export function isAllowedUrl(input: string, base: string): boolean {
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

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Idempotent. Safe to call in browsers and workers; a no-op where the globals are absent. */
export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.location?.href ?? 'http://127.0.0.1/';

  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (originalFetch) {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isAllowedUrl(urlOf(input), base)) {
        blocked++;
        return Promise.reject(new TypeError('Blocked by privacy guard: non-local request'));
      }
      return originalFetch(input, init);
    };
  }

  const xhr = globalThis.XMLHttpRequest?.prototype;
  if (xhr) {
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    const refused = new WeakSet<XMLHttpRequest>();
    xhr.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = String(args[1]);
      if (!isAllowedUrl(url, base)) {
        blocked++;
        refused.add(this);
        // Open a harmless local target so later calls stay valid; send() is then suppressed.
        return originalOpen.call(this, 'GET', 'data:,', true);
      }
      refused.delete(this);
      return (originalOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof xhr.open;
    xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      if (refused.has(this)) {
        this.dispatchEvent(new ProgressEvent('error'));
        return;
      }
      return originalSend.call(this, body);
    };
  }

  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.sendBeacon) {
    const originalBeacon = nav.sendBeacon.bind(nav);
    nav.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      if (!isAllowedUrl(String(url), base)) {
        blocked++;
        return false;
      }
      return originalBeacon(url, data);
    };
  }
}
