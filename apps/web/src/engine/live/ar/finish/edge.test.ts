import { describe, expect, it } from 'vitest';
import { EDGE_JBU } from './config';
import { jbuRefine } from './masks';

// A person whose true edge is at x = 100.3 (full-res), seen through a 4× coarser mask whose
// bilinear upsampling ramps over ≈ 8 px around x ≈ 98 (the 256-px model's blocky, offset edge).
const trueEdge = 100.3;
const guide = (x: number): [number, number, number] => (x < trueEdge ? [0.1, 0.1, 0.12] : [0.6, 0.45, 0.3]);
const lowRes = (x: number) => {
  const t = (x - 94) / 8; // the coarse mask's ramp: 0 at 94, 1 at 102
  return Math.min(1, Math.max(0, t));
};
const refine = (x: number) =>
  jbuRefine(
    (u) => lowRes(u),
    (u) => guide(u),
    x,
    0,
    4 * EDGE_JBU.tapOfTexel,
    EDGE_JBU.rangeSigma,
    EDGE_JBU.spatialSigma,
  );
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

describe('F4 joint-bilateral edge refinement', () => {
  it('leaves decided pixels unchanged', () => {
    expect(refine(80)).toBe(0);
    expect(refine(120)).toBe(1);
  });

  it('snaps the soft, offset low-res edge to the guide image edge (≤ 1 px transition)', () => {
    const band = EDGE_JBU.band;
    const after = (x: number) => smooth(band[0], band[1], refine(x));
    // The coarse mask is half-person 2 px before the true edge; refined: background left of the
    // true edge, person right of it, the transition within one pixel.
    expect(lowRes(98)).toBeCloseTo(0.5, 6);
    expect(after(99)).toBeLessThan(0.1);
    expect(after(99.8)).toBeLessThan(0.1);
    expect(after(100.8)).toBeGreaterThan(0.9);
    expect(after(102)).toBeGreaterThan(0.9);
  });
});

describe('F4 person mask packing', () => {
  it('centre sampling removes the half-block shift of the corner sample', async () => {
    const { packPerson } = await import('./masks');
    // A vertical person edge at source x = 10 (person to the right), 16 px wide, step 4.
    const W = 16,
      H = 4;
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = x >= 10 ? 1 : 0;
    const corner = packPerson({ data, width: W, height: H }, 4);
    const centre = packPerson({ data, width: W, height: H }, 4, undefined, true);
    // Texel 2 is centred on source x = 10 (block 8..11): the corner sample reads x = 8 (0), the
    // centre sample x = 10 (1), the value at the texel's own centre.
    expect(corner.data[2]).toBe(0);
    expect(centre.data[2]).toBe(255);
  });
});

describe('F4 capture-path class mask pairing', () => {
  it('uses the newest mask of a frame already drawn and not newer than the drawn one', async () => {
    const { pickCaptured } = await import('./segmenterClient');
    const recent = [{ tag: 100 }, { tag: null }, { tag: 133 }, { tag: 166 }];
    const drawn = new Set([100, 133]);
    // Drawing frame 133: its own mask (age 0 frames).
    expect(pickCaptured(recent, 133, drawn)?.tag).toBe(133);
    // Drawing frame 133 again while 166 (a newer frame, not drawn yet) has a mask: still 133.
    expect(pickCaptured(recent, 133.2, drawn)?.tag).toBe(133);
    // Nothing drawn yet: none.
    expect(pickCaptured(recent, 200, new Set<number>())).toBeNull();
    // Masks only from frames before the drawn one: the newest frame, whatever the arrival order.
    expect(pickCaptured([{ tag: 100 }, { tag: 66 }], 120, new Set([66, 100]))?.tag).toBe(100);
  });
});

describe('F4 mask hysteresis', () => {
  it('keeps an edge pixel on its side unless it clearly crosses', async () => {
    const { hysteresis } = await import('./masks');
    const prev = Uint8Array.from([200, 200, 50, 50, 140]);
    const cur = Uint8Array.from([110, 80, 150, 190, 100]);
    hysteresis(cur, prev, [96, 160]);
    // in → 110 (above 96): held at 128; in → 80: drops; out → 150 (below 160): held at 127;
    // out → 190: rises; in (140) → 100: held at 128.
    expect(Array.from(cur)).toEqual([128, 80, 127, 190, 128]);
    expect(Array.from(prev)).toEqual(Array.from(cur));
  });
});
