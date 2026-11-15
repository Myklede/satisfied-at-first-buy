// MotionClient.bakeCustom (recorded moves, agent V3) with a fake worker: same queue and worker as
// the presets, urgent, not cached, cancellable; the preset path is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BakedMotion } from './bake.ts';
import { MotionClient } from './MotionClient.ts';
import type { MotionWorkerRequest, MotionWorkerResponse } from './motion.worker.ts';

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: MotionWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<MotionWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: MotionWorkerRequest) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: MotionWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<MotionWorkerResponse>);
  }
  bakes() {
    return this.posted.filter(
      (m): m is Extract<MotionWorkerRequest, { kind: 'bake' }> => m.kind === 'bake',
    );
  }
}

const ID = 'c'.repeat(64);
const fakeBake = (motionId: string) => ({ motionId, size: 'S' }) as unknown as BakedMotion;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function readyClient() {
  const client = new MotionClient(ID, ID, ['S']);
  // Loaded state without the network (initWorker posts copies of these on a respawn).
  const init = {
    rigBuffer: new ArrayBuffer(8),
    sdfBuffer: new ArrayBuffer(8),
    anchors: {},
    assets: [{}],
    grids: [new ArrayBuffer(8)],
  };
  Object.assign(client, { init, ready: true });
  return client;
}

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe('MotionClient custom (recorded) bakes', () => {
  it('bakes the given frames on the size worker, reports progress, caches nothing', async () => {
    const client = readyClient();
    const frames = new Uint8Array([1, 2, 3, 4]).buffer;
    const progress: number[] = [];
    const pending = client.bakeCustom('S', frames, { onProgress: (p) => progress.push(p.done) });
    await flush();
    const worker = FakeWorker.all[0];
    const [request] = worker.bakes();
    expect(request.motionId).toMatch(/^custom:\d+$/);
    expect(new Uint8Array(request.frames)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(request.frames).not.toBe(frames); // a copy is transferred, the caller keeps its own
    expect(client.urgentPending).toBe(1);
    worker.reply({ kind: 'progress', id: request.id, phase: 'motion', done: 3, total: 9 });
    worker.reply({ kind: 'baked', id: request.id, bake: fakeBake('custom') });
    await expect(pending).resolves.toMatchObject({ motionId: 'custom' });
    expect(progress).toEqual([3]);
    expect(client.urgentPending).toBe(0);
    expect(client.cached('S', 'custom')).toBeUndefined();
    expect(client.cached('S', request.motionId)).toBeUndefined();
    expect(client.cachedBytes()).toBe(0);
    // The registered frames are gone: the key cannot be fetched again.
    expect(() => client.framesBuffer(request.motionId)).toThrow(/Invalid motion ID/);
  });

  it('passes solver overrides of a custom bake only; preset messages are unchanged', async () => {
    const client = readyClient();
    vi.spyOn(client, 'framesBuffer').mockImplementation(() => Promise.resolve(new ArrayBuffer(2)));
    void client.bake('S', 'sit', true);
    await flush();
    const worker = FakeWorker.all[0];
    expect(Object.keys(worker.bakes()[0]).sort()).toEqual(['frames', 'id', 'kind', 'motionId']);
    worker.reply({ kind: 'baked', id: worker.bakes()[0].id, bake: fakeBake('sit') });
    const custom = client.bakeCustom('S', new ArrayBuffer(4), {
      config: { dt: 1 / 120 },
      maxFrames: 42,
    });
    await flush();
    expect(worker.bakes()[1].config).toEqual({ dt: 1 / 120 });
    expect(worker.bakes()[1].maxFrames).toBe(42);
    worker.reply({ kind: 'baked', id: worker.bakes()[1].id, bake: fakeBake('custom') });
    await custom;
  });

  it('jumps ahead of queued background preset bakes', async () => {
    const client = readyClient();
    vi.spyOn(client, 'framesBuffer').mockImplementation((id: string) =>
      id.startsWith('custom:')
        ? Promise.resolve(new ArrayBuffer(4))
        : Promise.resolve(new ArrayBuffer(2)),
    );
    void client.bake('S', 'sit', false).catch(() => undefined);
    void client.bake('S', 'cross_arms', false).catch(() => undefined);
    const custom = client.bakeCustom('S', new ArrayBuffer(4));
    await flush();
    const worker = FakeWorker.all[0];
    expect(worker.bakes().map((b) => b.motionId)).toEqual(['sit']);
    worker.reply({ kind: 'baked', id: worker.bakes()[0].id, bake: fakeBake('sit') });
    await flush();
    expect(worker.bakes()[1].motionId).toMatch(/^custom:/);
    worker.reply({ kind: 'baked', id: worker.bakes()[1].id, bake: fakeBake('custom') });
    await custom;
    await flush();
    expect(worker.bakes()[2].motionId).toBe('cross_arms');
  });

  it('cancels while queued (the running preset continues) and while running (worker replaced)', async () => {
    const client = readyClient();
    vi.spyOn(client, 'framesBuffer').mockImplementation(() => Promise.resolve(new ArrayBuffer(2)));
    const sit = client.bake('S', 'sit', true);
    const queued = new AbortController();
    const first = client.bakeCustom('S', new ArrayBuffer(4), { signal: queued.signal });
    await flush();
    queued.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    const worker = FakeWorker.all[0];
    expect(worker.terminated).toBe(false);
    worker.reply({ kind: 'baked', id: worker.bakes()[0].id, bake: fakeBake('sit') });
    await expect(sit).resolves.toMatchObject({ motionId: 'sit' });

    const running = new AbortController();
    const second = client.bakeCustom('S', new ArrayBuffer(4), { signal: running.signal });
    await flush();
    expect(worker.bakes()[1].motionId).toMatch(/^custom:/);
    running.abort();
    await expect(second).rejects.toThrow(/cancelled/);
    expect(worker.terminated).toBe(true);
    const fresh = FakeWorker.all[1];
    expect(fresh.posted.map((m) => m.kind)).toEqual(['body', 'garment']);
    expect(client.urgentPending).toBe(0);
    await expect(
      client.bakeCustom('S', new ArrayBuffer(4), { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/cancelled/);
    await expect(client.bakeCustom('M', new ArrayBuffer(4))).rejects.toThrow(/not loaded/);
  });
});
