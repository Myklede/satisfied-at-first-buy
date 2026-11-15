/** Opt-in, bounded local diagnostics. No paths, body IDs, measurements or network export. */
export interface LocalTiming {
  phase: 'request' | 'first-render';
  category: string;
  atMs: number;
  values: Record<string, number | string>;
}

declare global {
  interface Window {
    __SATISFY_TIMINGS__?: LocalTiming[];
  }
}

export function timingEnabled(): boolean {
  return (
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('timings')
  );
}

export function appendTiming(list: LocalTiming[], item: LocalTiming): void {
  list.push(item);
  if (list.length > 128) list.splice(0, list.length - 128);
}

export function recordTiming(item: LocalTiming): void {
  if (!timingEnabled()) return;
  appendTiming((window.__SATISFY_TIMINGS__ ??= []), item);
}

export async function measuredJson(response: Response): Promise<{
  data: unknown;
  readMs: number;
  decodeMs: number;
  parseMs: number;
  bytes: number;
}> {
  const started = performance.now();
  const buffer = await response.arrayBuffer();
  const read = performance.now();
  const text = new TextDecoder().decode(buffer);
  const decoded = performance.now();
  const data: unknown = JSON.parse(text);
  return {
    data,
    readMs: read - started,
    decodeMs: decoded - read,
    parseMs: performance.now() - decoded,
    bytes: buffer.byteLength,
  };
}
