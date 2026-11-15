// Pure maths for the interactive zip and hood (agent Z): slider ↔ teeth, progress mapping,
// rate limits and the hood state machine. No Three.js, no DOM; unit tested.
import { INTERACT } from './config.ts';

/**
 * Teeth state for a slider at `slider` metres of arc from the zip's start (the collar top):
 * a pair is open when it lies above the slider (arc < slider). slider ≤ 0: all closed;
 * slider > the last pair's arc: all open (a separating zip: the pin leaves the box at the hem).
 * Writes into `out` and returns the number of open pairs.
 */
export function teethForSlider(arc: ArrayLike<number>, slider: number, out: Uint8Array) {
  let open = 0;
  for (let k = 0; k < arc.length; k++) {
    const isOpen = arc[k] < slider;
    out[k] = isOpen ? 0 : 1;
    if (isOpen) open++;
  }
  return open;
}

/**
 * Teeth state for a line opened from its start to the fraction `progress` (0..1) of its length
 * (the hood's zip along the collar). Same convention as teethForSlider (out: 1 = closed).
 */
export function teethForProgress(
  arc: ArrayLike<number>,
  length: number,
  progress: number,
  out: Uint8Array,
) {
  return teethForSlider(arc, hoodFrontier(progress, length), out);
}

/**
 * Arc (m) of the hood zip's open/closed boundary at `progress`: agent H's padded hood frontier
 * (docs/requests/H-to-Z.md, hoodFit.liftedAt): front = progress (1 + w), the half-lifted point
 * sigma = front - w / 2 along the seam (0 at the wearer's right end, as hood_zip). Fully detached
 * (1) is past every pair.
 */
export function hoodFrontier(progress: number, length: number) {
  const w = INTERACT.hoodPeelWidth;
  return progress >= 1 ? Infinity : Math.max(0, progress * (1 + w) - w / 2) * length;
}

/** How much of the hand's rigid move the lifted hood takes (0 below, 1 at full detach). */
export function hoodFreeWeight(progress: number) {
  const t = Math.max(
    0,
    Math.min(1, (progress - (1 - INTERACT.hoodFreeBlend)) / INTERACT.hoodFreeBlend),
  );
  return t * t * (3 - 2 * t);
}

/** Moves `from` toward `to` by at most `step` (scalar rate limit). */
export function approach(from: number, to: number, step: number) {
  if (Math.abs(to - from) <= step) return to;
  return from + Math.sign(to - from) * step;
}

/** Clamps the slider to the zip: 0 (closed at the top) .. length + ε (open through the hem). */
export function clampSlider(slider: number, length: number) {
  return Math.max(0, Math.min(length + INTERACT.zipEndM, slider));
}

/** A slider let go within INTERACT.snapM of either stop goes to that stop. */
export function snapSlider(slider: number, length: number) {
  if (slider <= INTERACT.snapM) return 0;
  if (slider >= length - INTERACT.snapM) return length + INTERACT.zipEndM;
  return slider;
}

/** The zip is fully open (every pair, including the hem pair, is open). */
export function zipFullyOpen(slider: number, length: number) {
  return slider > length;
}

/**
 * Slider arc for a cursor, from the zip track projected on screen. `track`: screen points
 * (px) of the pairs, top first; `arc`: their arc (m). The cursor is projected on the polyline
 * segment nearest to it, but only within `window` metres of arc around the current slider, so a
 * drag never jumps across the jacket (continuity). Returns the arc of that projection.
 */
export function sliderFromCursor(
  track: ArrayLike<number>,
  arc: ArrayLike<number>,
  cursor: { x: number; y: number },
  current: number,
  window: number,
) {
  let best = Infinity,
    result = current;
  const count = arc.length;
  for (let k = 0; k + 1 < count; k++) {
    if (arc[k + 1] < current - window || arc[k] > current + window) continue;
    const ax = track[k * 2],
      ay = track[k * 2 + 1],
      bx = track[k * 2 + 2],
      by = track[k * 2 + 3],
      dx = bx - ax,
      dy = by - ay,
      len2 = dx * dx + dy * dy;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, ((cursor.x - ax) * dx + (cursor.y - ay) * dy) / len2)) : 0;
    const px = ax + dx * t - cursor.x,
      py = ay + dy * t - cursor.y,
      d = px * px + py * py;
    if (d < best) {
      best = d;
      result = arc[k] + (arc[k + 1] - arc[k]) * t;
    }
  }
  // Past the collar end of the zip (the hand went on up beyond the zip's highest point on
  // screen, along the hem → collar direction): closed. The funnel collar folds, so the screen's
  // highest track point is not always the first pair; nearest-segment search alone stopped a
  // closing drag at ~10 % open on the puffer.
  if (count >= 2) {
    let ax = track[0] - track[(count - 1) * 2],
      ay = track[1] - track[(count - 1) * 2 + 1];
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    let top = -Infinity;
    for (let k = 0; k < count; k++) top = Math.max(top, track[k * 2] * ax + track[k * 2 + 1] * ay);
    if (cursor.x * ax + cursor.y * ay > top + 2) return 0;
  }
  // Past the hem end of the track: the drag continues below the last pair = fully open.
  if (count >= 2) {
    const lx = track[(count - 1) * 2],
      ly = track[(count - 1) * 2 + 1],
      px = track[(count - 2) * 2],
      py = track[(count - 2) * 2 + 1];
    const along = (cursor.x - lx) * (lx - px) + (cursor.y - ly) * (ly - py);
    if (along > 0 && arc[count - 1] >= current - window && result >= arc[count - 1] - 1e-9)
      result = arc[count - 1] + INTERACT.zipEndM;
  }
  return result;
}

/**
 * Hood unzip progress from the hand: the hood comes off the collar as the hand takes it away.
 * `distance` (m): grabbed point's distance from where it rested when attached (pulling off), or
 * the hood's attachment edge's distance from the collar's zip track (bringing it back).
 * Progress 0 below `INTERACT.hoodSlackM`, 1 at slack + `INTERACT.hoodTravelM`.
 */
export function hoodProgressFromDistance(distance: number) {
  const t = (distance - INTERACT.hoodSlackM) / INTERACT.hoodTravelM;
  return Math.max(0, Math.min(1, t));
}

/** Hood interaction states. */
export type HoodState = 'attached' | 'detaching' | 'detached' | 'attaching';

/**
 * Hood state machine. `progress`: 0 attached .. 1 detached (fraction of the attachment zip
 * open); `held`: the hand holds the hood. Transitions:
 *  attached  --grab & pull (progress > 0)-->  detaching
 *  detaching --progress reaches 1-->          detached
 *  detaching --progress back to 0, released--> attached
 *  detached  --grab & bring back (progress < 1)--> attaching
 *  attaching --progress reaches 0-->          attached
 *  attaching --progress back to 1-->          detached
 */
export function nextHoodState(state: HoodState, progress: number, held: boolean): HoodState {
  switch (state) {
    case 'attached':
      return held && progress > 0 ? 'detaching' : 'attached';
    case 'detaching':
      if (progress >= 1) return 'detached';
      if (progress <= 0 && !held) return 'attached';
      return 'detaching';
    case 'detached':
      return held && progress < 1 ? 'attaching' : 'detached';
    case 'attaching':
      if (progress <= 0) return 'attached';
      if (progress >= 1) return 'detached';
      return 'attaching';
  }
}
