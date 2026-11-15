// Fit Lab puffer hood shape (agent HP, 2026-11-15 06:40; user: "the hood is flat, it does not read
// as a hood; make it like the real jacket"). Edits the baked hood's rest positions ONCE per hood
// instance (HoodLayer base), before refresh(). Display only: fit numbers never read the hood.
import { drapeHood } from '../../../engine/live/ar/hoodDrape';

/** Current behaviour (the AR's lying-down drape); HP replaces this with the real puffer hood shape. */
export function shapePufferHood(
  positions: Float32Array,
  sigma: ArrayLike<number>,
  attach: ArrayLike<number>,
): void {
  drapeHood(positions, sigma, attach);
}
