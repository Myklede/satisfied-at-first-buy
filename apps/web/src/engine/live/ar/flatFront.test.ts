import { describe, expect, it } from 'vitest';
import { PANEL } from '../../garmentSurface';
import {
  flattenAcross,
  flattenFront,
  FLAT_HEM_FLARE,
  FLAT_KEEP,
  FLATX,
  upperTorsoOccluderIndex,
} from './flatFront';

/** A torso: a chest ring at y 1.30 (front z 0.12), front vertices below it bulging to z 0.20. */
function torso() {
  const pos: number[] = [],
    panels: number[] = [];
  const chest: number[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * 2 * Math.PI;
    chest.push(pos.length / 3);
    pos.push(0.15 * Math.sin(a), 1.3, 0.12 * Math.cos(a));
    panels.push(PANEL.frontL);
  }
  const belly = pos.length / 3;
  pos.push(0, 1.05, 0.2); // belly, centre front
  panels.push(PANEL.frontR);
  const back = pos.length / 3;
  pos.push(0, 1.05, -0.2); // the back panel is never touched
  panels.push(PANEL.back);
  const above = pos.length / 3;
  pos.push(0, 1.4, 0.18); // above the chest: untouched
  panels.push(PANEL.frontL);
  return { positions: Float32Array.from(pos), panels, paths: { chest }, belly, back, above };
}

describe('flat front (F3, belly bulge)', () => {
  it('brings a belly in front of the chest profile back to it, keeps the rest', () => {
    const t = torso();
    const removed = flattenFront(t.positions, t.panels, t.paths);
    expect(removed).toBeCloseTo(0.08 * (1 - FLAT_KEEP), 6);
    expect(t.positions[t.belly * 3 + 2]).toBeCloseTo(0.12 + 0.08 * FLAT_KEEP, 6);
    expect(t.positions[t.back * 3 + 2]).toBeCloseTo(-0.2, 6);
    expect(t.positions[t.above * 3 + 2]).toBeCloseTo(0.18, 6);
  });

  it('straightens a waist bulging out of the chest-to-hem side line (frontal view)', () => {
    const t = torso();
    const pos = Array.from(t.positions),
      panels = [...t.panels];
    const hem: number[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      hem.push(pos.length / 3);
      pos.push(0.16 * Math.sin(a), 0.7, 0.12 * Math.cos(a));
      panels.push(PANEL.back);
    }
    const waist = pos.length / 3;
    pos.push(0.215, 1.0, 0); // side of the waist, 6 cm outside the line (x 0.155 at y 1.0)
    panels.push(PANEL.frontL);
    const sleeve = pos.length / 3;
    pos.push(0.3, 1.0, 0); // a sleeve beside it: never touched
    panels.push(PANEL.sleeveL);
    const positions = Float32Array.from(pos);
    flattenFront(positions, panels, { chest: t.paths.chest, hem });
    expect(positions[waist * 3]).toBeCloseTo(0.155 + 0.06 * FLAT_KEEP, 5);
    expect(positions[sleeve * 3]).toBeCloseTo(0.3, 6);
    // the hem itself is on its own line: unchanged
    expect(positions[hem[4] * 3]).toBeCloseTo(0.16, 6);
  });

  it('caps the hem flare at FLAT_HEM_FLARE of the chest width (a column, like the real coat)', () => {
    const t = torso();
    const pos = Array.from(t.positions),
      panels = [...t.panels];
    const hem: number[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      hem.push(pos.length / 3);
      pos.push(0.21 * Math.sin(a), 0.7, 0.12 * Math.cos(a)); // 40 % wider than the chest
      panels.push(PANEL.back);
    }
    const positions = Float32Array.from(pos);
    flattenFront(positions, panels, { chest: t.paths.chest, hem });
    const cap = 0.15 * (1 + FLAT_HEM_FLARE);
    expect(positions[hem[4] * 3]).toBeCloseTo(cap + (0.21 - cap) * FLAT_KEEP, 5);
  });

  it('f3flatx: the front across its width comes forward to the centre depth, seams stay', () => {
    // Front rings (half ellipses, x half-width 0.18, depth 0.16) at 1.0..1.2 m; a back vertex.
    const pos: number[] = [],
      panels: number[] = [];
    for (let k = 0; k <= 10; k++)
      for (let j = 0; j <= 20; j++) {
        const a = Math.PI * (j / 20); // 0..pi: right seam -> centre -> left seam
        pos.push(0.18 * Math.cos(a), 1.0 + 0.02 * k, 0.16 * Math.sin(a));
        panels.push(j < 10 ? PANEL.frontR : PANEL.frontL);
      }
    const back = pos.length / 3;
    pos.push(0, 1.1, -0.12);
    panels.push(PANEL.back);
    const p = Float32Array.from(pos);
    const raised = flattenAcross(p, panels, {});
    expect(raised).toBeGreaterThan(0.01);
    const at = (k: number, j: number) => (k * 21 + j) * 3;
    // centre (zip) and seams unchanged; never thicker than the centre
    expect(p[at(5, 10) + 2]).toBeCloseTo(0.16, 6);
    expect(p[at(5, 0) + 2]).toBeCloseTo(0, 6);
    expect(p[at(5, 20) + 2]).toBeCloseTo(0, 6);
    for (let i = 0; i < back; i++) expect(p[i * 3 + 2]).toBeLessThanOrEqual(0.16 + 1e-6);
    // a flank at 60 % of the half-width comes most of the way to the centre's depth
    const j = 3; // cos(3pi/20) = 0.89: inside the turn; j = 6: x = 0.106 (59 %)
    const before = 0.16 * Math.sin(Math.PI * (6 / 20));
    expect(p[at(5, 6) + 2]).toBeGreaterThan(before + (0.16 - before) * FLATX.strength * 0.99);
    expect(p[at(5, j) + 2]).toBeGreaterThanOrEqual(0.16 * Math.sin(Math.PI * (j / 20)) - 1e-6);
    // x and y never move; the back is untouched
    for (let i = 0; i < back; i++) expect(p[i * 3]).toBeCloseTo(pos[i * 3], 6);
    expect(p[back * 3 + 2]).toBeCloseTo(-0.12, 6);
  });

  it('does nothing without a chest ring', () => {
    const t = torso();
    expect(flattenFront(t.positions, t.panels, {})).toBe(0);
  });

  it('the torso occluder keeps the chest and head, drops abdomen, pelvis, arms, hands, legs', () => {
    const bones = [
      'spine01',
      'spine04',
      'pelvis',
      'head',
      'upperarm01.L',
      'wrist.L',
      'upperleg01.R',
    ];
    // One vertex per bone, fully weighted; one triangle per vertex triple (0,0,0 style).
    const rig = {
      bones,
      influences: 1,
      vertexCount: bones.length,
      skinIndices: Uint16Array.from(bones.map((_, i) => i)),
      skinWeights: Float32Array.from(bones.map(() => 1)),
      faces: Uint32Array.from(bones.flatMap((_, i) => [i, i, i])),
    };
    const idx = Array.from(upperTorsoOccluderIndex(rig as never));
    expect(new Set(idx)).toEqual(new Set([0, 3]));
  });
});
