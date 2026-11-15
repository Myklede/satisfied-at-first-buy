import { describe, expect, it } from 'vitest';
import {
  blendFactor,
  blendInto,
  colourChange,
  deadband,
  edgeMotion,
  holdRect,
  motionOfSpan,
  RestHold,
  stillness,
} from './stability';

/** An RGBA image with a soft vertical edge at x = e (alpha in channel 0). */
function edge(w: number, h: number, e: number) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = Math.min(1, Math.max(0, (x - e) / 4 + 0.5));
      px[(y * w + x) * 4] = Math.round(a * 255);
    }
  return px;
}

describe('rest stability', () => {
  it('holds the drawn snapshot exactly and releases on the detector frame', () => {
    const hold = new RestHold<{ x: number }>();
    const a = { x: 20 };
    expect(hold.update(a, false)).toBe(a);
    for (let i = 0; i < 120; i++) expect(hold.update({ x: 20 + i / 100 }, true)).toBe(a);
    const moved = { x: 35 };
    expect(hold.update(moved, false)).toBe(moved);
    expect(hold.update({ x: 35.1 }, true)).toBe(moved);
  });

  it('clears on tracking loss or reset instead of retaining a previous session', () => {
    const hold = new RestHold<number>();
    expect(hold.update(10, true)).toBe(10);
    expect(hold.update(null, true)).toBeNull();
    expect(hold.update(20, true)).toBe(20);
    hold.reset();
    expect(hold.update(30, true)).toBe(30);
  });

  it('stillness from landmark motion relative to the span', () => {
    const a = { 11: [100, 100] as [number, number], 12: [200, 100] as [number, number] };
    const still = { 11: [100.5, 100] as [number, number], 12: [200, 100.5] as [number, number] };
    const moving = { 11: [110, 100] as [number, number], 12: [200, 100] as [number, number] };
    expect(motionOfSpan(a, still, 100)).toBeCloseTo(0.005, 6);
    expect(stillness(motionOfSpan(a, still, 100))).toBe(1);
    expect(stillness(motionOfSpan(a, moving, 100))).toBe(0);
    expect(stillness(null)).toBe(0);
  });

  it('blends masks only as much as the stillness allows', () => {
    const acc = new Float32Array([0, 100]);
    const out = new Uint8Array(2);
    blendInto(acc, Uint8Array.from([200, 100]), blendFactor(1, 0.25), out);
    expect(Array.from(out)).toEqual([50, 100]);
    blendInto(acc, Uint8Array.from([200, 0]), blendFactor(0, 0.25), out); // moving: copy
    expect(Array.from(out)).toEqual([200, 0]);
  });

  it('copies moving masks only within the shared extent, preserving accumulator tails', () => {
    const acc = new Float32Array([0, 0, 77]);
    const out = new Uint8Array([0, 0, 88, 99]);
    blendInto(acc, new Uint8Array([3, 255]), 1, out);
    expect(Array.from(acc)).toEqual([3, 255, 77]);
    expect(Array.from(out)).toEqual([3, 255, 88, 99]);
    blendInto(new Float32Array(1), new Uint8Array([4, 5, 6]), 1, out);
    expect(Array.from(out)).toEqual([4, 255, 88, 99]);
  });

  it('crop box and grade targets hold within their tolerance', () => {
    const r = { x: 100, y: 50, w: 300, h: 400 };
    expect(holdRect(r, { x: 103, y: 48, w: 300, h: 401 }, 5)).toBe(r);
    expect(holdRect(r, { x: 112, y: 50, w: 300, h: 400 }, 5).x).toBe(112);
    expect(deadband(0.75, 0.77, 0.03)).toBe(0.75);
    expect(deadband(0.75, 0.8, 0.03)).toBe(0.8);
    expect(deadband(NaN, 0.8, 0.03)).toBe(0.8);
  });

  it('edge motion recovers a known sub-pixel shift; colour change counts covered pixels only', () => {
    const w = 64,
      h = 16;
    expect(edgeMotion(edge(w, h, 30), edge(w, h, 30.5), w, h, 0)).toBeCloseTo(0.5, 1);
    expect(edgeMotion(edge(w, h, 30), edge(w, h, 32), w, h, 0, 2)).toBeCloseTo(4, 0);
    expect(edgeMotion(edge(w, h, 30), edge(w, h, 30), w, h, 0)).toBe(0);
    const a = edge(w, h, 30);
    const c0 = Uint8Array.from(a),
      c1 = Uint8Array.from(a);
    for (let i = 0; i < c1.length; i += 4) c1[i + 1] = 6; // +6 in G everywhere
    // Only fully covered pixels (alpha 255 in channel 0) count: mean |Δ| = 6 / 3 = 2.
    expect(colourChange(c0, c1, a, a, 0)).toBeCloseTo(2, 6);
  });
});
