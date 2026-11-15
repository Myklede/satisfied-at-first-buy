import { afterEach, expect, it, vi } from 'vitest';
import { api, type ClothAsset } from '../api';
import { ClothClient, type SettledCloth } from '../engine/cloth/ClothClient';

class TransportWorker {
  static latest: TransportWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{ kind: string; asset: ClothAsset }> = [];
  constructor() {
    TransportWorker.latest = this;
  }
  postMessage(message: unknown) {
    this.messages.push(message as { kind: string; asset: ClothAsset });
  }
  terminate() {}
  settled(key: string) {
    const result: SettledCloth = {
      assetKey: key,
      positions: new Float32Array(3),
      gap: new Float32Array(1),
      strain: new Float32Array(1),
      compression: new Float32Array(4),
      energy: 0,
      simulatedSeconds: 0,
      gapValid: false,
      strainValid: false,
      elapsedMs: 1,
      cached: false,
      meanStepMs: null,
      stopReason: 'static',
    };
    this.onmessage?.(new MessageEvent('message', { data: { kind: 'settled', ...result } }));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('skips superseded queued sizes and ready waits for the latest shown size', async () => {
  vi.stubGlobal('Worker', TransportWorker);
  const sdf = vi.spyOn(api, 'sdf').mockResolvedValue(new ArrayBuffer(4));
  // Transport-only fixtures: the fake worker does not construct or simulate a mesh.
  const asset = (key: string) => ({ key, sdf: { sdf_id: 'shared-body' } }) as unknown as ClothAsset;
  const client = new ClothClient();
  const first = client.settle(asset('first'));
  await vi.waitFor(() => expect(TransportWorker.latest.messages).toHaveLength(1));
  const skipped = client.settle(asset('skipped')).catch((error: unknown) => error);
  const last = client.settle(asset('last'));
  let ready = false;
  const waiting = client.ready().then(() => {
    ready = true;
  });
  TransportWorker.latest.settled('first');
  await first;
  expect(await skipped).toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(TransportWorker.latest.messages).toHaveLength(2));
  expect(TransportWorker.latest.messages.map((m) => m.asset.key)).toEqual(['first', 'last']);
  expect(ready).toBe(false);
  TransportWorker.latest.settled('last');
  await last;
  await waiting;
  expect(ready).toBe(true);
  expect(sdf).toHaveBeenCalledTimes(1);
  client.dispose();
});
