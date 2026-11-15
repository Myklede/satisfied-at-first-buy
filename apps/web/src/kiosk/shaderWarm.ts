// Operator readiness cue (agent S): every garment shader program of both views (product looks
// and X-ray passes; engine/programWarmup.ts) is linked, so the next judge meets no background
// compile. Shown as a tiny dot on attract; scripts wait on <html data-kiosk-warm="1">.
import type { Finish } from '../engine/garmentLook';

/** The garment finishes the engine has shader variants for (asset.finish / product visual). */
export function isGarmentFinish(value: unknown): value is Finish {
  return value === 'glossy_ripstop' || value === 'satin_matte';
}

/** What markShadersWarm writes to: the document element's dataset (or a stand-in in tests). */
export interface WarmTarget {
  dataset: Record<string, string | undefined>;
}

/**
 * Records the kiosk's shaders as warm: `data-kiosk-warm="1"` and `data-kiosk-warm-ms` (ms since
 * page load) for scripts, and one console line for the operator. Returns the rounded ms.
 */
export function markShadersWarm(
  root: WarmTarget,
  sincePageLoadMs: number,
  log: (message: string) => void = console.info,
) {
  const ms = Math.round(sincePageLoadMs);
  root.dataset.kioskWarm = '1';
  root.dataset.kioskWarmMs = String(ms);
  log(`[kiosk] shaders warm: every garment program linked ${ms} ms after page load`);
  return ms;
}
