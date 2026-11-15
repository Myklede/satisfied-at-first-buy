import { describe, expect, it } from 'vitest';
import { installWorkerNetworkGuard, workerUrlAllowed } from './workerNetworkGuard';

const base = 'http://127.0.0.1:5761/assets/pose.worker.js';

describe('worker network guard', () => {
  it('allows only same-origin, loopback and in-memory URLs', () => {
    expect(workerUrlAllowed('https://odml.pa.googleapis.com/v1/log', base)).toBe(false);
    expect(workerUrlAllowed('//example.com/a.js', base)).toBe(false);
    expect(workerUrlAllowed('/vision/models/pose_landmarker_full.task', base)).toBe(true);
    expect(workerUrlAllowed('http://localhost:5710/x', base)).toBe(true);
    expect(workerUrlAllowed('blob:http://127.0.0.1:5761/abc', base)).toBe(true);
    expect(workerUrlAllowed('data:,', base)).toBe(true);
  });

  it('refuses a remote fetch and a remote importScripts before any request', async () => {
    const calls: string[] = [];
    const scope = {
      location: { href: base },
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('ok');
      }) as typeof fetch,
      importScripts: (...urls: string[]) => void calls.push(...urls),
    };
    const state = installWorkerNetworkGuard(scope);
    await expect(scope.fetch('https://odml.pa.googleapis.com/v1/log')).rejects.toThrow('privacy');
    expect(() => scope.importScripts('https://cdn.example/x.js')).toThrow('privacy');
    await scope.fetch('/vision/models/x.task');
    scope.importScripts('/vision/mediapipe/wasm/vision_wasm_internal.js');
    expect(calls).toEqual([
      '/vision/models/x.task',
      '/vision/mediapipe/wasm/vision_wasm_internal.js',
    ]);
    expect(state.blocked).toBe(2);
    expect(installWorkerNetworkGuard(scope)).toBe(state);
  });
});
