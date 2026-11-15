// Per-jacket Fit Lab hood shaping (lead, 06:40). Hood kind = GarmentLayer's render_details.hood_kind
// (engine/hood/hoodConfig.ts: 1 = parka.glb, 2 = puffer.glb). HP owns hoodPuffer.ts, HK owns
// hoodParka.ts; this dispatcher and productLook.ts stay as they are.
import { drapeHood } from '../../../engine/live/ar/hoodDrape';
import { shapeParkaHood } from './hoodParka';
import { shapePufferHood } from './hoodPuffer';

export const HOOD_KIND = { parka: 1, puffer: 2 } as const;

export function shapeHood(
  kind: number | undefined,
  positions: Float32Array,
  sigma: ArrayLike<number>,
  attach: ArrayLike<number>,
): void {
  if (kind === HOOD_KIND.puffer) shapePufferHood(positions, sigma, attach);
  else if (kind === HOOD_KIND.parka) shapeParkaHood(positions, sigma, attach);
  else drapeHood(positions, sigma, attach);
}
