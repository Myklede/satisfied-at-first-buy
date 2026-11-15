import { describe, expect, it } from 'vitest';
import type { ImageLandmark } from '../contract';
import { runEnd, silhouetteOffsets, type Mask } from './silhouette';

const W = 400,
  H = 600;

/** A synthetic jacket: torso box + two sleeve boxes hanging straight down (arms at the sides). */
function jacket(o: { top?: number; hem?: number; sleeveOut?: number; cuff?: number } = {}): Mask {
  const top = o.top ?? 150,
    hem = o.hem ?? 420,
    out = o.sleeveOut ?? 0,
    cuff = o.cuff ?? 380;
  const data = new Uint8Array(W * H);
  const fill = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[y * W + x] = 255;
  };
  fill(140, 260, top, hem); // torso
  fill(110 - out, 139, top + 10, cuff); // image-left sleeve (subject's right)
  fill(261, 290 + out, top + 10, cuff); // image-right sleeve (subject's left)
  return { data, width: W, height: H };
}

function landmarks(): ImageLandmark[] {
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const set = (i: number, x: number, y: number) => (l[i] = { x, y, visibility: 0.95 });
  set(11, 275, 170); // left shoulder (image right)
  set(12, 125, 170);
  set(13, 278, 270); // elbows
  set(14, 122, 270);
  set(15, 280, 360); // wrists
  set(16, 120, 360);
  set(23, 230, 360); // hips
  set(24, 170, 360);
  return l;
}

describe('silhouette offsets', () => {
  it('finds the end of a masked run along a ray', () => {
    const m = jacket();
    expect(runEnd(m, [200, 300], [0, 1], 0, 300)).toBe(120); // torso ends at y 420
    expect(runEnd(m, [200, 100], [0, 1], 0, 400)).toBe(320); // enters at 150, ends at 420
    expect(runEnd(m, [200, 100], [0, 1], 0, 300)).toBe(300); // clipped at the search end
    expect(runEnd(m, [10, 10], [1, 0], 0, 50)).toBeNull();
  });

  it('reads zero on identical masks', () => {
    const m = jacket();
    const o = silhouetteOffsets(m, m, landmarks());
    expect(o.shoulderL).toBe(0);
    expect(o.shoulderR).toBe(0);
    expect(o.sleeveL).toBe(0);
    expect(o.sleeveR).toBe(0);
    expect(o.cuffL).toBe(0);
    expect(o.cuffR).toBe(0);
    expect(o.hem).toBe(0);
  });

  it('signs: lower shoulder +, wider sleeve +, longer sleeve +, longer hem +', () => {
    const real = jacket();
    const ours = jacket({ top: 158, hem: 445, sleeveOut: 6, cuff: 392 });
    const o = silhouetteOffsets(ours, real, landmarks());
    expect(o.shoulderL).toBe(8);
    expect(o.shoulderR).toBe(8);
    expect(o.sleeveL).toBe(6);
    expect(o.sleeveR).toBe(6);
    expect(o.cuffL).toBe(12);
    expect(o.cuffR).toBe(12);
    expect(o.hem).toBe(25);
  });

  it('reports null, never a guess, where an edge is missing', () => {
    const real = jacket();
    const empty: Mask = { data: new Uint8Array(W * H), width: W, height: H };
    const o = silhouetteOffsets(empty, real, landmarks());
    expect(Object.values(o).every((v) => v === null)).toBe(true);
    const side = landmarks();
    side[12] = { x: 273, y: 171, visibility: 0.9 }; // side view: shoulders overlap
    expect(silhouetteOffsets(real, real, side).shoulderL).toBeNull();
  });
});
