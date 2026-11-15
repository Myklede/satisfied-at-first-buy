/// <reference types="vite/client" />
import type {
  ArRenderer,
  MoveBaker,
  LivePhase,
  LiveSource,
  LiveTryOn,
  LiveTryOnOptions,
} from '../../engine/live/contract';
import type { GarmentFitResponse } from '../../api';
import { mockEnabled } from './presentation';
import { controlledBaker, PlaybackClock } from './playback';
export interface PlaybackControl {
  setPaused(paused: boolean): void;
  seek(fraction: number): void;
}
export type ScreenEngine = LiveTryOn &
  Partial<PlaybackControl> & {
    simulatePhase?: (phase: LivePhase) => void;
    simulateMessage?: (message: string) => void;
  };
interface EngineModule {
  createLiveTryOn?: (deps?: {
    arRenderer?: ArRenderer;
    moveBaker?: MoveBaker;
    loadFit: (options: LiveTryOnOptions, signal: AbortSignal) => Promise<GarmentFitResponse | null>;
  }) => LiveTryOn;
}
interface SourceModule {
  createCameraSource: () => LiveSource;
}
export async function createScreenSession(
  search: string,
  fits: GarmentFitResponse[] = [],
): Promise<{ engine: ScreenEngine; source: LiveSource; mock: boolean }> {
  if (mockEnabled(search)) {
    const { createMockSession } = await import('./mockLiveTryOn');
    return createMockSession();
  }
  // Optional during concurrent engine development; absence is a visible error, never a mock fallback.
  const factories = import.meta.glob<EngineModule>(
    '../../engine/live/{index,LiveTryOn,liveTryOn,LiveTryOnEngine}.ts',
  );
  for (const load of Object.values(factories)) {
    const module = await load();
    if (typeof module.createLiveTryOn !== 'function') continue;
    const sources = import.meta.glob<SourceModule>('../../engine/live/sources/cameraSource.ts');
    const sourceLoader = Object.values(sources)[0];
    if (!sourceLoader)
      throw Error('Live camera source is not available yet. Return to sizes and try again.');
    const clock = new PlaybackClock();
    const arModules = import.meta.glob<{ ArCompositor: new () => ArRenderer }>(
      '../../engine/live/ar/ArCompositor.ts',
    );
    const bakerModules = import.meta.glob<{
      createMoveBaker: (deps?: {
        staticZones: (
          options: LiveTryOnOptions,
        ) => GarmentFitResponse['sizes'][string]['zones'] | undefined;
      }) => MoveBaker & { dispose?: () => void };
    }>('../../engine/live/record/RecordMoveBaker.ts');
    const arLoad = Object.values(arModules)[0],
      bakerLoad = Object.values(bakerModules)[0];
    const renderer = arLoad ? new (await arLoad()).ArCompositor() : undefined;
    const baker = bakerLoad
      ? (await bakerLoad()).createMoveBaker({
          staticZones: (options) =>
            fits.find((f) => f.fit_id === options.fitId)?.sizes[options.size]?.zones,
        })
      : undefined;
    const engine: ScreenEngine = module.createLiveTryOn({
      arRenderer: renderer,
      moveBaker: baker ? controlledBaker(baker, clock) : undefined,
      loadFit: async (options) => fits.find((f) => f.fit_id === options.fitId) ?? null,
    });
    if (baker) {
      engine.setPaused = (paused) => clock.setPaused(paused);
      engine.seek = (fraction) => clock.seek(fraction);
      const replay = engine.replayLast.bind(engine);
      engine.replayLast = () => {
        clock.reset();
        replay();
      };
    }
    const dispose = engine.dispose.bind(engine);
    engine.dispose = () => {
      dispose();
      baker?.dispose?.();
    };
    return { engine, source: (await sourceLoader()).createCameraSource(), mock: false };
  }
  throw Error('Live try-on engine is still being prepared. Return to sizes and try again.');
}
