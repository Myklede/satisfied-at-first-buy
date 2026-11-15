// Decart view for the Studio's big slot. Follows the StudioBus: jacket + zipStage() + hood (+ our
// engine's fit label for the selected size) -> one reference image + a prompt -> set(), throttled
// to >= 400 ms apart, with set-to-visible latency measured. Sessions auto-stop at the token
// server's Studio limit (200 s) and on tab hide/unload; the seconds are reported to the server.
//
// Video leaves the machine only while a session is live (docs/USER-RULES.md 2026-11-15).
import { createDecartClient, models, type RealTimeClient } from '@decartai/sdk';
import { SessionClock } from '../decart/session-timer';
import { SwapProbe, loadReference, type SwapResult } from '../decart/swapProbe';
import { TokenServerError, tokenServer, type TokenStatus } from '../decart/tokenServer';
import { zipStage, type StudioBus, type ZipStage } from './contract';
import type { SharedCameraHandle } from './camera';
import {
  SetThrottle,
  buildPrompt,
  chooseReference,
  type FitLabel,
  type RefChoice,
} from './decartViewMap';

const REF_URL = '/local-textures/decart/';
const MODEL = models.realtime('lucy-vton-latest');
export const SET_MIN_GAP_MS = 400;

export type DecartViewStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'live'; remainingS: number; shown: RefChoice | null; connection: string }
  /** NO-GO for now (no key, cap reached, server offline, connection error): show the fallback. */
  | { kind: 'unavailable'; reason: string; code: string | null };

export interface DecartViewDeps {
  bus: StudioBus;
  camera: SharedCameraHandle;
  /** Our engine's verdict label for the current jacket + size (FitLabPanel.verdict); null = none. */
  fitLabel?: () => FitLabel | null;
  onStatus: (s: DecartViewStatus) => void;
  onBudget?: (s: TokenStatus) => void;
  onSwap?: (r: SwapResult) => void;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

interface Attempt {
  cancelled: boolean;
}

interface Live {
  sessionId: string;
  clock: SessionClock;
  input: MediaStream;
  rt: RealTimeClient | null;
  ticker: number;
  stopped: boolean;
}

export class DecartView {
  readonly output: HTMLVideoElement;
  private readonly probe: SwapProbe;
  private readonly throttle = new SetThrottle(SET_MIN_GAP_MS);
  private refs: string[] = [];
  private readonly blobs = new Map<string, Promise<Blob>>();
  private stage: ZipStage = 'closed';
  private live: Live | null = null;
  private attempt: Attempt | null = null;
  private timer = 0;
  private shown: RefChoice | null = null;
  private connection = 'connecting';
  private readonly unsubscribe: () => void;
  private readonly onHide = () => {
    if (document.visibilityState === 'hidden') void this.stop('tab hidden');
  };
  private readonly onUnload = () => void this.stop('page unload', true);

  constructor(private readonly deps: DecartViewDeps) {
    this.output = document.createElement('video');
    this.output.muted = true;
    this.output.playsInline = true;
    this.output.autoplay = true;
    this.probe = new SwapProbe(this.output);
    this.stage = zipStage(deps.bus.get().zip, 'closed');
    this.unsubscribe = deps.bus.subscribe(() => this.onState());
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onUnload);
  }

  get isLive(): boolean {
    return this.live !== null && !this.live.stopped;
  }

  /** Loads the reference list and the budget; reports 'unavailable' when Decart cannot run. */
  async init(): Promise<void> {
    try {
      this.refs = await tokenServer.refs();
      const status = await tokenServer.status();
      this.deps.onBudget?.(status);
      if (!status.keyPresent) {
        this.deps.onStatus({
          kind: 'unavailable',
          reason: 'No Decart key yet: put DECART_API_KEY=... in .env',
          code: 'NO_KEY',
        });
        return;
      }
      this.deps.onStatus({ kind: 'idle' });
    } catch (err) {
      this.fail(err);
    }
  }

  /** True from the Start click until the session is live or the start failed/was cancelled. */
  get isStarting(): boolean {
    return this.attempt !== null;
  }

  /**
   * Review H4: one start at a time. The attempt is registered synchronously, before any await;
   * Stop, tab hide and unload cancel it; after every await the attempt is re-checked, so a
   * cancelled start never clones the camera, never asks for a token and never connects.
   */
  async start(): Promise<void> {
    if (this.attempt || this.live) return;
    const attempt: Attempt = { cancelled: false };
    this.attempt = attempt;
    const alive = () => !attempt.cancelled && document.visibilityState === 'visible';
    let current: Live | null = null;
    try {
      if (!alive()) return;
      this.deps.onStatus({ kind: 'connecting' });
      const state = this.deps.bus.get();
      this.stage = zipStage(state.zip, this.stage);
      const target = this.target();
      if (!target) {
        this.deps.onStatus({
          kind: 'unavailable',
          reason: `No reference image for ${state.jacket} in local-textures/decart/`,
          code: 'NO_REF',
        });
        return;
      }
      const image = await this.blob(target.choice.file);
      if (!alive()) return this.cancelled();
      const session = await tokenServer.openSession('studio');
      this.deps.onBudget?.(session);
      if (!alive()) {
        // No token was minted for it: the report releases the reservation on the server.
        void tokenServer.report(session.sessionId, 0).catch(() => {});
        return this.cancelled();
      }
      const clock = new SessionClock(session.sessionLimitS);
      clock.start();
      const live: Live = {
        sessionId: session.sessionId,
        clock,
        input: this.deps.camera.cloneStream(),
        rt: null,
        ticker: 0,
        stopped: false,
      };
      current = live;
      live.ticker = window.setInterval(() => this.tick(live), 250);
      this.live = live;
      this.throttle.reset();
      const client = createDecartClient({
        telemetry: false,
        // No token once this session was stopped (the server also allows exactly one).
        apiKeyProvider: () =>
          live.stopped
            ? Promise.reject(new Error('session stopped'))
            : tokenServer.token(live.sessionId),
      });
      const rt = await client.realtime.connect(live.input, {
        model: MODEL,
        mirror: false,
        onRemoteStream: (stream) => {
          if (live.stopped) return;
          this.output.srcObject = stream;
          this.probe.start();
        },
        initialState: { prompt: { text: target.prompt, enhance: false }, image },
      });
      if (live.stopped || !alive()) {
        rt.disconnect();
        await this.end(live, 'cancelled while connecting');
        return;
      }
      live.rt = rt;
      this.shown = target.choice;
      // The initial state is applied: mark it so the throttle does not resend it.
      this.throttle.request(target.key, performance.now());
      this.throttle.take(performance.now());
      rt.on('connectionChange', (c) => {
        if (live.stopped) return;
        this.connection = c;
        if (c === 'disconnected') void this.end(live, 'disconnected');
      });
      rt.on('error', (e) => void this.end(live, `error: ${e.message}`, false, true));
      rt.on(
        'sessionEnded',
        (e) => void this.end(live, `server ended the session: ${String(e.reason)}`),
      );
      this.connection = rt.getConnectionState();
      this.log(`Decart live (${session.sessionLimitS} s max): ${target.choice.file}`);
      if (target.choice.hoodOn && !this.deps.bus.get().hoodOn)
        this.log('(hood removed by prompt; reference shows hood)', 'warn');
      this.onState(); // the state may have moved while connecting
    } catch (err) {
      if (current) await this.end(current, 'start failed', false, true);
      this.fail(err);
    } finally {
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  private cancelled(): void {
    this.log('Decart start cancelled');
    this.deps.onStatus({ kind: 'idle' });
  }

  /** Stop button / tab hide / unload: cancels a pending start and ends the live session. */
  async stop(reason: string, unloading = false): Promise<void> {
    if (this.attempt) this.attempt.cancelled = true;
    const current = this.live;
    if (current) await this.end(current, reason, unloading);
  }

  /** Idempotent per session: disconnect, stop the cloned track (never the shared camera), report
   *  the seconds (diagnostic: the server keeps the reservation once a token was minted). */
  private async end(
    current: Live,
    reason: string,
    unloading = false,
    asError = false,
  ): Promise<void> {
    if (current.stopped) return;
    current.stopped = true;
    window.clearInterval(current.ticker);
    window.clearTimeout(this.timer);
    try {
      current.rt?.disconnect();
    } catch {
      /* already closed */
    }
    current.input.getTracks().forEach((t) => t.stop());
    if (this.live === current) {
      this.probe.stop();
      this.output.srcObject = null;
      this.live = null;
      this.shown = null;
    }
    const seconds = current.clock.stop() ?? current.clock.elapsedS();
    this.log(`Decart stopped (${reason}) after ${seconds.toFixed(1)} s`);
    this.deps.onStatus(asError ? { kind: 'unavailable', reason, code: 'ERROR' } : { kind: 'idle' });
    try {
      const status = await tokenServer.report(current.sessionId, seconds, unloading);
      if (status) this.deps.onBudget?.(status);
    } catch (err) {
      this.log(
        `usage report failed (${errText(err)}); the server keeps the full reservation`,
        'error',
      );
    }
  }

  dispose(): void {
    void this.stop('disposed');
    this.unsubscribe();
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onUnload);
  }

  private target(): { choice: RefChoice; prompt: string; key: string } | null {
    const s = this.deps.bus.get();
    const choice = chooseReference(this.refs, s.jacket, this.stage, s.hoodOn);
    if (!choice) return null;
    const fit = this.deps.fitLabel?.() ?? null;
    // The zip stage in the prompt is what the chosen image shows. The hood follows the REQUEST
    // (lead decision 2026-11-15): with no no-hood image, the prompt asks Decart to remove the hood
    // and the log says so (see flush), so what was sent stays visible.
    const prompt = buildPrompt(s.jacket, choice.stage, s.hoodOn, s.size, fit);
    return { choice, prompt, key: `${choice.file}|${prompt}` };
  }

  private onState(): void {
    this.stage = zipStage(this.deps.bus.get().zip, this.stage);
    if (!this.live?.rt) return;
    const t = this.target();
    if (!t) return;
    const wait = this.throttle.request(t.key, performance.now());
    if (wait === null) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), wait);
  }

  private async flush(): Promise<void> {
    const rt = this.live?.rt;
    const t = this.target();
    if (!rt || !t) return;
    // Re-request with the freshest target, then take it (the timer may be stale by now).
    if (this.throttle.request(t.key, performance.now()) === null) return;
    if (this.throttle.take(performance.now()) === null) return;
    try {
      const image = await this.blob(t.choice.file);
      const probe = this.probe.begin(`${t.choice.stage}${t.choice.hoodOn ? '' : ' no-hood'}`);
      await rt.set({ prompt: t.prompt, image, enhance: false });
      probe?.ack();
      this.shown = t.choice;
      if (!t.choice.exact) this.log(`no exact reference; showing ${t.choice.file}`, 'warn');
      if (t.choice.hoodOn && !this.deps.bus.get().hoodOn)
        this.log('(hood removed by prompt; reference shows hood)', 'warn');
      void probe?.result.then((r) => {
        this.deps.onSwap?.(r);
        this.log(
          `swap ${r.label}: set() ${r.ackMs ?? '?'} ms, visible ${r.visibleMs ?? 'none in 10 s'} ms`,
        );
      });
    } catch (err) {
      this.log(`set failed: ${errText(err)}`, 'error');
    }
  }

  private tick(l: Live): void {
    if (l.stopped) return;
    if (l.clock.expired()) {
      void this.end(l, `auto-stop at ${l.clock.limitS} s`);
      return;
    }
    // Still connecting: the countdown runs, but the panel shows 'connecting' until live.
    if (!l.rt) return;
    this.deps.onStatus({
      kind: 'live',
      remainingS: l.clock.remainingS(),
      shown: this.shown,
      connection: this.connection,
    });
  }

  private blob(file: string): Promise<Blob> {
    let p = this.blobs.get(file);
    if (!p) {
      p = loadReference(REF_URL + encodeURIComponent(file));
      p.catch(() => this.blobs.delete(file));
      this.blobs.set(file, p);
    }
    return p;
  }

  private fail(err: unknown): void {
    const code = err instanceof TokenServerError ? err.code : null;
    this.deps.onStatus({ kind: 'unavailable', reason: errText(err), code });
    this.log(errText(err), 'error');
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.deps.log?.(message, level);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
