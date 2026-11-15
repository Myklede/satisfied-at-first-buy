// Synthetic state driver for explicit ?tryonmock only. Never a normal-kiosk fallback.
import { openCamera, type CameraHandle } from '@satisfy/vision';
import type {
  LivePhase,
  LiveSource,
  LiveTryOnOptions,
  LiveTryOnState,
} from '../../engine/live/contract';
import type { ScreenEngine } from './session';
import { EMPTY_STATE } from './presentation';

export function createMockSession(): { engine: ScreenEngine; source: LiveSource; mock: true } {
  let camera: CameraHandle | undefined;
  let closed = false;
  const source: LiveSource = {
    kind: 'camera',
    get video() {
      return camera?.video ?? null;
    },
    async start() {
      closed = false;
      const opened = await openCamera({ width: 640, height: 480 });
      if (closed) opened.close();
      else camera = opened;
    },
    stop() {
      closed = true;
      camera?.close();
      camera = undefined;
    },
    onFrame: () => () => undefined,
  };
  return { engine: new MockLiveTryOn(), source, mock: true };
}
class MockLiveTryOn implements ScreenEngine {
  private state = { ...EMPTY_STATE };
  private listeners = new Set<(s: LiveTryOnState) => void>();
  private source?: LiveSource;
  private containers: HTMLElement[] = [];
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private disposed = false;
  private options?: LiveTryOnOptions;
  private emit(change: Partial<LiveTryOnState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.listeners.forEach((cb) => cb(this.state));
  }
  private wait(ms: number) {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.set(timer, resolve);
    });
  }
  private zones(physics = false): LiveTryOnState['zones'] {
    // Deliberately synthetic UI fixtures. No accuracy or fit claim, always behind MOCK DATA.
    return (['shoulder', 'chest', 'bicep', 'sleeve', 'hem', 'collar'] as const).map((zone, i) => ({
      zone,
      valueCm: i === 5 ? null : i - 1.5,
      status: i === 5 ? 'unknown' : i === 0 ? 'tight' : 'fit',
      basis: physics ? 'physics' : 'static-fit',
    }));
  }
  async start(source: LiveSource, options: LiveTryOnOptions) {
    this.source = source;
    this.options = options;
    this.emit({ phase: 'starting' });
    await source.start();
    if (this.disposed) {
      source.stop();
      return;
    }
    const video = source.video;
    if (video && this.containers[0]) {
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;transform:scaleX(-1)';
      this.containers[0].replaceChildren(video);
    }
    this.emit({ phase: 'calibrating', progress: 0.3, trackingQuality: 0.8 });
    await this.wait(1400);
    this.emit({ phase: 'tracking', progress: null, zones: this.zones(), arAlignment: 0.92 });
  }
  stop() {
    this.source?.stop();
  }
  async setSize(size: string) {
    if (this.options) this.options.size = size;
    this.emit({ zones: this.zones() });
  }
  async setProduct(productId: string, fitId: string) {
    if (this.options) Object.assign(this.options, { productId, fitId });
    this.emit({ zones: this.zones() });
  }
  attachArView(container: HTMLElement) {
    this.containers[0] = container;
    container.textContent = 'Synthetic AR view';
  }
  attachMirrorView(container: HTMLElement) {
    this.containers[1] = container;
    container.innerHTML =
      '<svg viewBox="0 0 300 400" width="100%" height="100%" aria-label="Synthetic fitted body illustration"><circle cx="150" cy="64" r="27" fill="#a9b6b4"/><path d="M122 103 L87 129 52 236 75 245 113 164 115 260 111 376 139 376 150 280 161 376 189 376 185 260 187 164 225 245 248 236 213 129 178 103Z" fill="#a4e3c8"/><path d="M150 105V258M116 146H184M115 177H185M115 209H185M115 241H185" stroke="#344e49" fill="none" stroke-width="2"/></svg>';
  }
  async recordMove(seconds: number) {
    this.emit({ phase: 'recording', progress: 0 });
    for (let i = 1; i <= seconds; i++) {
      await this.wait(1000);
      this.emit({ progress: i / seconds });
    }
    this.emit({ phase: 'baking', progress: 0 });
    await this.wait(1000);
    this.emit({ progress: 0.6 });
    await this.wait(1000);
    this.replayLast();
  }
  simulatePhase(phase: LivePhase) {
    this.emit({
      phase,
      message: phase === 'error' ? 'Synthetic camera failure. Retry is safe.' : '',
      trackingQuality: phase === 'lost' ? 0 : 0.8,
      progress: phase === 'calibrating' ? 0.4 : null,
    });
  }
  simulateMessage(message: string) {
    this.emit({ message });
  }
  replayLast() {
    this.emit({
      phase: 'playback',
      progress: null,
      zones: this.zones(true),
      exposureCm: { front: 3.2, back: 1.4, sides: 2.1 },
      sleeveRideUpCm: { left: 2.3, right: 2.7 },
    });
  }
  backToLive() {
    this.emit({ phase: 'tracking', zones: this.zones(), exposureCm: null, sleeveRideUpCm: null });
  }
  setPaused(paused: boolean) {
    this.containers[1]?.setAttribute('data-paused', String(paused));
  }
  seek(fraction: number) {
    this.containers[1]?.setAttribute('data-position', String(fraction));
  }
  onState(cb: (s: LiveTryOnState) => void) {
    this.listeners.add(cb);
    cb(this.state);
    return () => {
      this.listeners.delete(cb);
    };
  }
  dispose() {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
    for (const [timer, resolve] of this.timers) {
      clearTimeout(timer);
      resolve();
    }
    this.timers.clear();
    this.containers.forEach((c) => c.replaceChildren());
  }
}
