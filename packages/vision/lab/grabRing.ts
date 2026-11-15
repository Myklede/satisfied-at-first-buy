// Grab-progress ring drawn at the hand cursor (live lab and replay viewer). The same visual is what
// the app is expected to show: it fills as a grab is being confirmed (fast for a clear grip, over
// the dwell for an ambiguous one) and is full while grabbing.
import type { GripConfidence } from '../src/grip';

export const RING_COLOUR: Record<GripConfidence, string> = { clear: '#3f3', ambiguous: '#fb3' };

export function drawGrabRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  progress: number,
  confidence: GripConfidence,
  grabbing: boolean,
  radius = 16,
): void {
  const colour = RING_COLOUR[confidence];
  ctx.save();
  // Track.
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke();
  // Progress arc, clockwise from 12 o'clock.
  const p = Math.max(0, Math.min(1, progress));
  if (p > 0.005) {
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.lineWidth = grabbing ? 6 : 4;
    ctx.strokeStyle = colour;
    ctx.stroke();
  }
  if (grabbing) {
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.restore();
}

/** Short status text for the ring. */
export function ringCaption(
  progress: number,
  confidence: GripConfidence,
  grabbing: boolean,
): string {
  if (grabbing) return `GRAB (${confidence})`;
  if (progress > 0.02 && confidence === 'ambiguous') return 'ambiguous · hold still';
  return confidence;
}
