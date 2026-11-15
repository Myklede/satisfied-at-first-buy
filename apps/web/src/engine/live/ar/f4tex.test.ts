import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../../api';
import {
  f4tAlbedo,
  f4tCharts,
  f4tPhotoRow,
  f4tRow,
  f4tRowMap,
  hexToLinear,
  parseF4tMeta,
  readF4tFlags,
} from './f4tex';

const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('f4tex flags', () => {
  it('is off unless asked for', () => {
    expect(readF4tFlags('')).toEqual({ tex: false, debug: false, faces: false, chroma: 0 });
    expect(readF4tFlags('?f4tex=0')).toEqual({ tex: false, debug: false, faces: false, chroma: 0 });
    expect(readF4tFlags('?f4tex=1&f4tdebug=1')).toEqual({
      tex: true,
      debug: true,
      faces: false,
      chroma: 0,
    });
    expect(readF4tFlags('?f4tex=1&f4tchroma=0.5').chroma).toBe(0.5);
    expect(readF4tFlags('?f4tchroma=7').chroma).toBe(1);
    expect(readF4tFlags('?f4tchroma=x').chroma).toBe(0);
  });
});

describe('f4tex rows', () => {
  it('counts rows from the yoke stitch, -1 at the shoulder point line', () => {
    expect(f4tRow(0, 0.05, 0.1)).toBeCloseTo(-1);
    expect(f4tRow(0.025, 0.05, 0.1)).toBeCloseTo(-0.5);
    expect(f4tRow(0.05, 0.05, 0.1)).toBeCloseTo(0);
    expect(f4tRow(0.35, 0.05, 0.1)).toBeCloseTo(3);
  });

  it('maps stitch on stitch when the counts agree, the last cell onto the last cell', () => {
    // Model: stitches 0..6, hem at 6.8. Photo: 7 stitches.
    const m = f4tRowMap(6.8, { rows: 7, tile: 3 });
    expect(m).toMatchObject({ extra: 0, last: 6 });
    for (let k = 0; k <= 6; k++) expect(f4tPhotoRow(k, m)).toBeCloseTo(k);
    expect(f4tPhotoRow(-0.5, m)).toBeCloseTo(-0.5);
    expect(f4tPhotoRow(2.25, m)).toBeCloseTo(2.25);
    expect(f4tPhotoRow(6.4, m)).toBeCloseTo(6.5); // half way down the model's last cell
    expect(f4tPhotoRow(6.8, m)).toBeCloseTo(7); // hem on hem
  });

  it('repeats the tile chamber when the model has more stitch rows', () => {
    // Model: stitches 0..7 (hem 7.5). Photo: 7 stitches, tile chamber 3.
    const m = f4tRowMap(7.5, { rows: 7, tile: 3 });
    expect(m).toMatchObject({ extra: 1, last: 7 });
    expect(f4tPhotoRow(2.5, m)).toBeCloseTo(2.5); // above the tile: one to one
    expect(f4tPhotoRow(3.5, m)).toBeCloseTo(3.5); // the tile chamber
    expect(f4tPhotoRow(4.5, m)).toBeCloseTo(3.5); // ... again
    expect(f4tPhotoRow(5.5, m)).toBeCloseTo(4.5); // below: one to one, shifted
    expect(f4tPhotoRow(6.5, m)).toBeCloseTo(5.5); // the photo's last full chamber
    expect(f4tPhotoRow(7.25, m)).toBeCloseTo(6.5); // last cell
    expect(f4tPhotoRow(7.5, m)).toBeCloseTo(7);
    // Every model stitch is a photo stitch (integer -> integer).
    for (let k = 0; k <= 7; k++) expect(Math.abs(f4tPhotoRow(k, m) % 1)).toBeCloseTo(0);
  });

  it('drops photo chambers when the model has fewer stitch rows', () => {
    // Model: stitches 0..3 (cuff 3.9). Photo: 6 stitches, tile chamber 1.
    const m = f4tRowMap(3.9, { rows: 6, tile: 1 });
    expect(m).toMatchObject({ extra: -2, last: 3 });
    expect(f4tPhotoRow(0.5, m)).toBeCloseTo(0.5);
    expect(f4tPhotoRow(1.5, m)).toBeCloseTo(3.5); // chambers 1 and 2 of the photo are skipped
    expect(f4tPhotoRow(2.5, m)).toBeCloseTo(4.5);
    expect(f4tPhotoRow(3.9, m)).toBeCloseTo(6);
  });

  it('does not count a sliver above the hem as a chamber', () => {
    // Hem 0.1 pitch below stitch 4: the last stitch is 3, and its cell runs to the hem.
    expect(f4tRowMap(4.1, { rows: 4, tile: 1 })).toMatchObject({ last: 3, extra: 0 });
    expect(f4tRowMap(4.3, { rows: 4, tile: 1 })).toMatchObject({ last: 4, extra: 1 });
  });
});

describe('f4tex meta', () => {
  const good = {
    version: 1,
    style: 'FB7675-100',
    chroma: [0.96, 0.91],
    front: { file: 'front.png', rows: 7, tile: 3, top: 0.9, half: 2.6 },
  };
  it('accepts a builder file', () => {
    expect(parseF4tMeta(good)).toEqual({
      version: 1,
      style: 'FB7675-100',
      chroma: [0.96, 0.91],
      front: { file: 'front.png', rows: 7, tile: 3, top: 0.9, half: 2.6 },
      back: undefined,
      sleeve: undefined,
    });
  });
  it('rejects anything else', () => {
    expect(parseF4tMeta(null)).toBeNull();
    expect(parseF4tMeta({ ...good, version: 2 })).toBeNull();
    expect(parseF4tMeta({ ...good, style: '../x' })).toBeNull();
    expect(parseF4tMeta({ ...good, chroma: [0.96, Number.NaN] })).toBeNull();
    expect(parseF4tMeta({ ...good, chroma: [3, 1] })).toBeNull();
    // A chart with a path in its file name is dropped, not followed.
    const withFront = (front: object) => parseF4tMeta({ ...good, front })?.front;
    expect(withFront({ file: '../../x.png', rows: 7, tile: 3, top: 0.9 })).toBeUndefined();
    expect(withFront({ file: 'front.png', rows: 1, tile: 0, top: 0.9 })).toBeUndefined();
    expect(withFront({ file: 'front.png', rows: 7, tile: 6, top: 0.9 })).toBeUndefined();
    expect(withFront({ file: 'front.png', rows: 7, tile: 3, top: 0 })).toBeUndefined();
    expect(withFront({ file: 'front.png', rows: 7, tile: 3, top: 0.9, half: 0 })).toBeUndefined();
  });
});

describe('f4tex albedo', () => {
  it('keeps the product luminance and takes the measured chroma', () => {
    const base = hexToLinear('#cdb89f');
    // By default the product colour itself (the calibrated look is not moved).
    expect(f4tAlbedo('#cdb89f', [1.209, 0.717], [1, 1, 1], 0)).toEqual(base);
    const a = f4tAlbedo('#cdb89f', [1.209, 0.717], [1, 1, 1], 1);
    expect(luminance(a)).toBeCloseTo(luminance(base), 4);
    expect(a[0] / a[1]).toBeCloseTo(1.209, 3);
    expect(a[2] / a[1]).toBeCloseTo(0.717, 3);
  });
  it('pre-divides the camera adaptation so the measured chroma stands after it', () => {
    const gain = [0.927, 1.009, 1.129];
    const a = f4tAlbedo('#cdb89f', [1.209, 0.717], gain, 1);
    const after = a.map((c, i) => c * gain[i]);
    expect(after[0] / after[1]).toBeCloseTo(1.209, 3);
    expect(after[2] / after[1]).toBeCloseTo(0.717, 3);
  });
  it('bounds a broken calibration to 35 % of the product colour', () => {
    const base = hexToLinear('#eeeff3');
    const a = f4tAlbedo('#eeeff3', [1.9, 0.55], [1, 1, 1], 1);
    a.forEach((c, i) => {
      expect(c).toBeLessThanOrEqual(1.35 * base[i] + 1e-9);
      expect(c).toBeGreaterThanOrEqual(0.65 * base[i] - 1e-9);
    });
  });
});

describe('f4tex charts', () => {
  // Two torso rows of two vertices each (front right, back) and a four-vertex sleeve.
  const asset = {
    panels: [1, 2, 1, 2, 4, 4, 4, 4],
    render_uv: [0.1, 0.0, 0.4, 0.0, 0.1, 0.8, 0.4, 0.8, 0, 0.0, 0.2, 0.0, 0, 0.6, 0.15, 0.6],
    quilt: [
      0, 0.1, 0.05, 1, 0, 0.1, 0.05, 1, 0, 0.1, 0.05, 1, 0, 0.1, 0.05, 1, 0, 0.105, 0.02, 1, 0,
      0.105, 0.02, 1, 0, 0.105, 0.02, 1, 0, 0.105, 0.02, 1,
    ],
    render_material_v: [0, 0, 0.8, 0.8, 0.13, 0.13, 0.65, 0.65],
  } as unknown as ClothAsset;
  const arc = Float32Array.from([
    0.1, 0.45, 0.27, 0.28, 0.4, 0.15, 0.27, 0.28, 0.1, 0.45, 0.3, 0.31, 0.4, 0.15, 0.3, 0.31, 0,
    0.13, 1, -1, 0.2, 0.13, 1, -1, 0, 0.65, 1, -1, 0.15, 0.65, 1, -1,
  ]);

  it('reads pitch, yoke, hem row and the upper chest half widths', () => {
    const c = f4tCharts(asset, arc);
    expect(c).not.toBeNull();
    expect(c!.pitchM).toBeCloseTo(0.1);
    expect(c!.yokeM).toBeCloseTo(0.05);
    expect(c!.hemM).toBeCloseTo(0.8);
    expect(c!.sHem).toBeCloseTo(7.5);
    // Only the rows within 1.5 pitches of the yoke stitch count (v = 0 here, not v = 0.8).
    expect(c!.halfFrontM).toBeCloseTo(0.27);
    expect(c!.halfBackM).toBeCloseTo(0.28);
  });

  it('reads the sleeve from its material arc', () => {
    const c = f4tCharts(asset, arc)!;
    expect(c.sleeveStartM).toBeCloseTo(0.13);
    expect(c.sleeveLenM).toBeCloseTo(0.65);
    expect(c.sleevePitchM).toBeCloseTo(0.105);
    // Drawn stitches at 0.02 + k x 0.105: the first one below the armhole (0.13) is 0.23.
    expect(c.sleeveYokeM).toBeCloseTo(0.23);
    expect(c.sSleeveEnd).toBeCloseTo((0.65 - 0.23) / 0.105);
    expect(c.sleeveHalf0M).toBeCloseTo(0.2);
    expect(c.sleeveHalf1M).toBeCloseTo(0.15);
  });

  it('gives no charts without quilting rows', () => {
    const plain = { ...asset, quilt: new Array(32).fill(0) } as unknown as ClothAsset;
    expect(f4tCharts(plain, arc)).toBeNull();
    expect(f4tCharts(asset, new Float32Array(4))).toBeNull();
  });
});
