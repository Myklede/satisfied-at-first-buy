import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../api';
import {
  ATLAS,
  INK,
  REGION,
  SWOOSH_ASPECT,
  THERMA_FIT,
  decalPlacements,
  decalUniformValues,
  letteringWidth,
  slotBox,
  slotContent,
  slotRect,
  sleeveDecalFrame,
  torsoLaterals,
  wrapArc,
  wordmarkLogoBox,
} from './garmentDecals';
import { detailEstimates } from './garmentLook';

const parka = { front_kind: 1, yoke_depth_m: 0.135, chamber_height_m: 0.15 };
const puffer = { front_kind: 2, yoke_depth_m: 0.07, chamber_height_m: 0.145 };

describe('decal shapes', () => {
  it('measures lettering and the wordmark box', () => {
    // 10 glyphs: advances + 9 trackings + one stroke width.
    expect(letteringWidth('TT')).toBeCloseTo(0.62 * 1.4 * 2 + 0.28 + 0.19, 6);
    expect(letteringWidth(THERMA_FIT)).toBeGreaterThan(9);
    expect(letteringWidth(THERMA_FIT)).toBeLessThan(13);
    expect(() => letteringWidth('Q')).toThrow();
    const box = wordmarkLogoBox();
    // The real logo is 2-3.3 times as wide as tall (Parka1/3/4: 2.1-3.1, swoosh tail faint).
    expect(box.width / box.height).toBeGreaterThan(2);
    expect(box.width / box.height).toBeLessThan(3.3);
  });
  it('keeps every atlas slot inside the texture', () => {
    for (const slot of ['swoosh', 'wordmark', 'lettering'] as const) {
      const [u0, v0, u1, v1] = slotRect(slot);
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(u1).toBeLessThanOrEqual(1);
      expect(v1).toBeLessThanOrEqual(1);
      expect(u1 - u0).toBeGreaterThan(0);
    }
    expect(ATLAS.width).toBe(2048);
    // Every decal box has its slot's aspect (no stretching between atlas and garment).
    for (const slot of ['swoosh', 'wordmark', 'lettering'] as const) {
      const [u0, v0, u1, v1] = slotRect(slot);
      const b = slotBox(slot, 0.1);
      expect(b.width / b.height).toBeCloseTo(
        ((u1 - u0) * ATLAS.width) / ((v1 - v0) * ATLAS.height),
        6,
      );
      expect(slotContent(slot)[0]).toBeLessThanOrEqual((u1 - u0) * ATLAS.width + 1e-6);
    }
  });
});

describe('decalPlacements', () => {
  it('places the parka logos from the yoke, chamber pitch and photo estimates', () => {
    const list = decalPlacements(parka);
    expect(list.map((d) => d.region)).toEqual([REGION.front, REGION.back, REGION.sleeveL]);
    const [chest, back, sleeve] = list;
    // Centred in the first chamber below the yoke: 13.5 + 7.5 cm.
    expect(chest.along).toBeCloseTo(0.21, 6);
    expect(back.along).toBeCloseTo(0.21, 6);
    expect(chest.lateral).toBe(detailEstimates.parkaLogos.chestLogoArcFromCfM);
    expect(back.lateral).toBe(0);
    expect(back.width).toBe(detailEstimates.parkaLogos.backSwooshWidthM);
    expect(back.height).toBeCloseTo(detailEstimates.parkaLogos.backSwooshWidthM / SWOOSH_ASPECT, 2);
    expect(back.height).toBeLessThan(parka.chamber_height_m); // fits its chamber
    expect(back.ink).toBe(INK.print);
    expect(chest.ink).toBe(INK.embroidery);
    // Lettering starts 8 cm above the cuff, behind the outer line.
    const length = detailEstimates.parkaLogos.sleeveLetteringCapM * letteringWidth(THERMA_FIT);
    expect(sleeve.along - length / 2).toBeCloseTo(0.08, 6);
    expect(length).toBeGreaterThan(0.09); // Parka5: about 11 cm
    expect(length).toBeLessThan(0.12);
    expect(sleeve.lateral).toBeLessThan(0);
  });
  it('gives the puffer one tonal chest swoosh and unknown garments none', () => {
    const list = decalPlacements(puffer);
    expect(list).toHaveLength(1);
    expect(list[0].ink).toBe(INK.tonal);
    expect(list[0].along).toBeCloseTo(0.07 + 0.44 * 0.145, 6);
    expect(decalPlacements({})).toEqual([]);
    const u = decalUniformValues({});
    expect(u.gDecalA.every((a) => a.x === 0)).toBe(true);
    expect(decalUniformValues(parka).gDecalA.filter((a) => a.x > 0)).toHaveLength(3);
  });
});

describe('decal lateral coordinates', () => {
  it('signs torso laterals from the server u and the CF/CB arcs', () => {
    // Row with half-circumference uCB = 0.5: u < 0 on the wearer's left front.
    const uCB = 0.5;
    const arcs = (u: number) => {
      const dCF = u <= uCB ? Math.abs(u) : 2 * uCB - u;
      return [dCF, uCB - dCF] as const;
    };
    const at = (u: number) => torsoLaterals(u, ...arcs(u));
    expect(at(-0.14).front).toBeCloseTo(0.14, 9); // wearer's left chest
    expect(at(0.14).front).toBeCloseTo(-0.14, 9);
    expect(at(0.4).back).toBeCloseTo(0.1, 9); // right back: + toward the wearer's right
    expect(at(0.6).back).toBeCloseTo(-0.1, 9); // left back
    // Linear across centre back: the midpoint of two vertices interpolates exactly.
    const a = at(0.45),
      b = at(0.55),
      [ax, ay] = arcs(0.45),
      [bx, by] = arcs(0.55);
    const mid = torsoLaterals(0.5, (ax + bx) / 2, (ay + by) / 2);
    expect(mid.back).toBeCloseTo((a.back + b.back) / 2, 9);
  });
  it('orients the left sleeve frame toward the front', () => {
    // Sleeve ring: centre (0.3, 1.2, 0), outer line at +X; u grows from +Z round past -Z.
    const m = 12,
      rs = 0.05,
      circ = 2 * Math.PI * rs;
    const panels: number[] = [],
      positions: number[] = [],
      uv: number[] = [];
    for (let j = 0; j < m; j++) {
      const t = (2 * Math.PI * j) / m; // t = 0 front (+Z), pi/2 outer line (+X)
      panels.push(4);
      positions.push(0.3 + rs * Math.sin(t), 1.2, rs * Math.cos(t));
      uv.push((j / m) * circ, 0.5);
    }
    const asset = { panels, render_uv: uv } as unknown as ClothAsset;
    const f = sleeveDecalFrame(asset, positions);
    expect(f.outer).toBeCloseTo((3 / m) * circ, 9);
    const lat = (j: number) => f.flip * wrapArc(uv[j * 2] - f.outer, circ);
    expect(lat(1)).toBeGreaterThan(0); // between the front and the outer line
    expect(lat(5)).toBeLessThan(0); // behind the outer line
    expect(Math.abs(lat(3))).toBeLessThan(1e-9);
    expect(sleeveDecalFrame({ panels: [0] } as unknown as ClothAsset, [0, 0, 0]).flip).toBe(0);
  });
});
