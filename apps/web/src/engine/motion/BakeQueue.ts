// Fit-in-motion background precompute (kiosk, agent E2). The kiosk shows "Try moves" per jacket;
// a motion bake takes 11-17 s in a worker, so the judge would wait on every click. After the
// result is on screen, MotionBakeQueue bakes the remaining (jacket, motion) pairs in the
// background, ONE pair at a time (both sizes of the pair in parallel, one worker per size),
// with the same bakeMotion code path as a click (MotionClient.bake). Nothing is simulated twice
// and nothing is faked: a pair is "ready" only when its bakes exist.
//
// Priority rules (the host supplies canRun):
//  - a judge's click (MotionClient.bake with urgent = true) jumps the worker queue, and the
//    background queue starts nothing new while a click is still waiting (urgentPending);
//  - canRun() is false during a hand pull, a size switch or a jacket build: the queue starts
//    nothing then. A bake that is already running cannot be interrupted (the solver loop is
//    synchronous inside the worker); it finishes, at most one bake per size is in flight;
//  - dispose() drops everything not started (the kiosk disposes the clients themselves).
//
// BakeStore caps the memory of the cached bakes (the typed arrays dominate): least recently used
// bakes are evicted when the cap is exceeded, and the queue stops starting bakes when the next
// one would not fit.
import type { BakedMotion } from './bake.ts';

/** Bytes held by one bake's typed arrays (cloth positions, strain, exposure mask). */
export function bakeBytes(bake: BakedMotion) {
  return bake.positions.byteLength + bake.strain.byteLength + bake.exposed.byteLength;
}

/** What BakeStore needs from a client (MotionClient implements it). */
export interface StoreClient {
  readonly fitId: string;
  evict(key: string): void;
}

export class BakeStore {
  private entries = new Map<string, { client: StoreClient; key: string; bytes: number }>();
  /** Largest bake seen: the estimate for the next one. */
  private largest = 0;
  total = 0;
  evictions = 0;
  constructor(readonly capBytes: number) {}

  private id(client: StoreClient, key: string) {
    return `${client.fitId}|${key}`;
  }
  add(client: StoreClient, key: string, bytes: number) {
    const id = this.id(client, key);
    this.total -= this.entries.get(id)?.bytes ?? 0;
    this.entries.delete(id);
    this.entries.set(id, { client, key, bytes });
    this.total += bytes;
    this.largest = Math.max(this.largest, bytes);
    // Oldest first; the bake just added is never the victim.
    for (const [victimId, victim] of this.entries) {
      if (this.total <= this.capBytes || this.entries.size <= 1) break;
      if (victimId === id) continue;
      this.entries.delete(victimId);
      this.total -= victim.bytes;
      this.evictions++;
      victim.client.evict(victim.key);
    }
  }
  /** A cache hit makes the bake the most recently used. */
  touch(client: StoreClient, key: string) {
    const id = this.id(client, key);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }
  forget(client: StoreClient) {
    for (const [id, entry] of this.entries)
      if (entry.client === client) {
        this.entries.delete(id);
        this.total -= entry.bytes;
      }
  }
  /** Whether one more bake of the largest size seen so far fits under the cap. */
  hasRoom(extraBakes = 1) {
    return this.total + this.largest * extraBakes <= this.capBytes;
  }
  get count() {
    return this.entries.size;
  }
}

/** What the queue needs from a client (MotionClient implements it). */
export interface QueueClient {
  readonly sizes: string[];
  readonly urgentPending: number;
  managed: boolean;
  load(): Promise<unknown>;
  bake(size: string, motionId: string, urgent?: boolean): Promise<unknown>;
  cached(size: string, motionId: string): unknown;
}

type Task = { client: QueueClient; motionId: string };

export type QueueOptions = {
  /** False while the queue must not start a bake (hand pull, size switch, jacket build). */
  canRun: () => boolean;
  store: BakeStore;
  /** How often a blocked queue looks again (ms). */
  pollMs?: number;
};

export class MotionBakeQueue {
  private tasks: Task[] = [];
  private current?: Task;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  /** Completed background pairs and the longest time a pair held the queue, for diagnostics. */
  completed = 0;
  failed = 0;
  constructor(private options: QueueOptions) {}

  /** Appends pairs in click-likelihood order; the queue works through them front to back. */
  enqueue(client: QueueClient, motionIds: readonly string[]) {
    client.managed = true;
    for (const motionId of motionIds)
      if (!this.tasks.some((t) => t.client === client && t.motionId === motionId))
        this.tasks.push({ client, motionId });
    this.schedule(0);
  }

  /**
   * The judge opened Try moves on this client: its pairs go first (stable order), so the
   * background CPU goes to the jacket being looked at, not the other one.
   */
  focus(client: QueueClient) {
    this.tasks = [
      ...this.tasks.filter((t) => t.client === client),
      ...this.tasks.filter((t) => t.client !== client),
    ];
  }

  /** The host calls this when its gate may have opened (e.g. the hand pull ended). */
  kick() {
    this.schedule(0);
  }

  get pending() {
    return this.tasks.length;
  }
  get running() {
    return this.current?.motionId ?? null;
  }

  private schedule(delay: number) {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
  }

  private done(task: Task) {
    return task.client.sizes.every((size) => task.client.cached(size, task.motionId));
  }

  private pump() {
    if (this.disposed || this.current) return;
    // Pairs the judge already requested are done; drop them.
    this.tasks = this.tasks.filter((t) => !this.done(t));
    const next = this.tasks[0];
    if (!next) return;
    const pollMs = this.options.pollMs ?? 500;
    const clicking = this.tasks.some((t) => t.client.urgentPending > 0);
    if (clicking || !this.options.canRun() || !this.options.store.hasRoom(next.client.sizes.length))
      return this.schedule(pollMs);
    this.tasks.shift();
    this.current = next;
    void (async () => {
      await next.client.load();
      // Same code path as a click, not urgent: a click made meanwhile jumps ahead in the worker.
      await Promise.all(
        next.client.sizes.map((size) => next.client.bake(size, next.motionId, false)),
      );
      this.completed++;
    })()
      .catch(() => {
        this.failed++; // the Try moves view reports its own errors when the judge opens it
      })
      .finally(() => {
        this.current = undefined;
        this.schedule(0);
      });
  }

  dispose() {
    this.disposed = true;
    this.tasks = [];
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
