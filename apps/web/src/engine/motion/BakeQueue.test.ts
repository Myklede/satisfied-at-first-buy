import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BakeStore, MotionBakeQueue, type QueueClient, type StoreClient } from './BakeQueue';

class FakeClient implements QueueClient, StoreClient {
  managed = false;
  urgentPending = 0;
  baked = new Set<string>();
  started: string[] = [];
  private waiting = new Map<string, () => void>();
  constructor(
    readonly fitId: string,
    readonly sizes: string[] = ['S', 'M'],
  ) {}
  async load() {}
  cached(size: string, motionId: string) {
    return this.baked.has(`${size}:${motionId}`) ? {} : undefined;
  }
  bake(size: string, motionId: string) {
    this.started.push(`${size}:${motionId}`);
    return new Promise<void>((resolve) =>
      this.waiting.set(`${size}:${motionId}`, () => {
        this.baked.add(`${size}:${motionId}`);
        resolve();
      }),
    );
  }
  finish(motionId: string) {
    for (const size of this.sizes) this.waiting.get(`${size}:${motionId}`)?.();
  }
  evict(key: string) {
    this.baked.delete(key);
  }
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(1);
};

describe('BakeStore', () => {
  it('evicts the least recently used bake when the cap is exceeded, never the new one', () => {
    const client = new FakeClient('a');
    ['x', 'y', 'z'].forEach((k) => client.baked.add(k));
    const store = new BakeStore(250);
    store.add(client, 'x', 100);
    store.add(client, 'y', 100);
    store.touch(client, 'x'); // y is now the oldest
    store.add(client, 'z', 100);
    expect(client.baked.has('y')).toBe(false);
    expect(client.baked.has('x') && client.baked.has('z')).toBe(true);
    expect(store.total).toBe(200);
    expect(store.evictions).toBe(1);
  });

  it('reports room for one more bake of the largest size seen', () => {
    const store = new BakeStore(250);
    const client = new FakeClient('a');
    store.add(client, 'x', 100);
    store.add(client, 'y', 100);
    expect(store.hasRoom()).toBe(false);
    store.forget(client);
    expect(store.total).toBe(0);
    expect(store.hasRoom()).toBe(true);
  });
});

describe('MotionBakeQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bakes one pair at a time, in the order given, both sizes of a pair together', async () => {
    const a = new FakeClient('a'),
      b = new FakeClient('b');
    const queue = new MotionBakeQueue({ canRun: () => true, store: new BakeStore(1e9) });
    queue.enqueue(b, ['m0']);
    queue.enqueue(a, ['m1', 'm2']);
    expect(a.managed).toBe(true);
    await settle();
    expect(b.started).toEqual(['S:m0', 'M:m0']);
    expect(a.started).toEqual([]);
    b.finish('m0');
    await settle();
    expect(a.started).toEqual(['S:m1', 'M:m1']);
    a.finish('m1');
    await settle();
    expect(a.started).toEqual(['S:m1', 'M:m1', 'S:m2', 'M:m2']);
    a.finish('m2');
    await settle();
    expect(queue.completed).toBe(3);
    expect(queue.pending).toBe(0);
  });

  it('focus puts the opened jacket first and keeps the order inside each jacket', async () => {
    const a = new FakeClient('a'),
      b = new FakeClient('b');
    let open = false;
    const queue = new MotionBakeQueue({ canRun: () => open, store: new BakeStore(1e9) });
    queue.enqueue(b, ['m0']);
    queue.enqueue(a, ['m1']);
    queue.enqueue(b, ['m1']);
    queue.enqueue(a, ['m2']);
    queue.focus(a);
    open = true;
    queue.kick();
    await settle();
    expect(a.started).toEqual(['S:m1', 'M:m1']);
    a.finish('m1');
    await settle();
    a.finish('m2');
    await settle();
    expect(a.started).toEqual(['S:m1', 'M:m1', 'S:m2', 'M:m2']);
    expect(b.started).toEqual(['S:m0', 'M:m0']); // the other jacket only after a's pairs
  });

  it('starts nothing while canRun is false and resumes when it opens', async () => {
    const a = new FakeClient('a');
    let open = false;
    const queue = new MotionBakeQueue({
      canRun: () => open,
      store: new BakeStore(1e9),
      pollMs: 100,
    });
    queue.enqueue(a, ['m1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.started).toEqual([]);
    open = true;
    queue.kick();
    await vi.advanceTimersByTimeAsync(200);
    expect(a.started).toEqual(['S:m1', 'M:m1']);
  });

  it('waits for a judge click and skips pairs the click already baked', async () => {
    const a = new FakeClient('a');
    const queue = new MotionBakeQueue({
      canRun: () => true,
      store: new BakeStore(1e9),
      pollMs: 100,
    });
    a.urgentPending = 1;
    queue.enqueue(a, ['m1', 'm2']);
    await vi.advanceTimersByTimeAsync(500);
    expect(a.started).toEqual([]);
    a.baked.add('S:m1');
    a.baked.add('M:m1'); // the judge's click finished m1
    a.urgentPending = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(a.started).toEqual(['S:m2', 'M:m2']);
  });

  it('stops starting bakes when the memory cap has no room, and on dispose', async () => {
    const a = new FakeClient('a');
    const store = new BakeStore(150);
    store.add(a, 'old1', 100); // largest 100, total 100: no room for two more (sizes S, M)
    const queue = new MotionBakeQueue({ canRun: () => true, store, pollMs: 100 });
    queue.enqueue(a, ['m1']);
    await vi.advanceTimersByTimeAsync(500);
    expect(a.started).toEqual([]);
    queue.dispose();
    store.forget(a);
    await vi.advanceTimersByTimeAsync(500);
    expect(a.started).toEqual([]);
    expect(queue.pending).toBe(0);
  });
});
