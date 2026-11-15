import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../../api';
import { PANEL } from '../../garmentSurface';
import { SleeveLayers, sleeveCapRows } from './sleeveLayers';

/**
 * A toy jacket: 4 torso vertices (0–3), then per sleeve an armhole row taken from the torso and
 * 4 sleeve rows of 2 vertices (rows 1–2 = the cap, row 2 = the bicep ring, rows 3–4 below).
 */
function toy() {
  const panels = [0, 0, 0, 0];
  const index: number[] = [0, 1, 2];
  const paths: Record<string, number[]> = {};
  const landmarks: Record<string, number> = {};
  for (const [side, panel] of [
    ['L', PANEL.sleeveL],
    ['R', PANEL.sleeveR],
  ] as const) {
    const start = panels.length;
    for (let k = 0; k < 8; k++) panels.push(panel);
    const row = (r: number) => (r === 0 ? [0, 1] : [start + (r - 1) * 2, start + (r - 1) * 2 + 1]);
    for (let r = 0; r < 4; r++) {
      const [a, b] = row(r),
        [c, d] = row(r + 1);
      index.push(a, b, d, a, d, c);
    }
    paths[`sleeve_${side}`] = [0, 1, 2, 3, 4].map((r) => row(r)[0]);
    paths[`bicep_${side}`] = row(2);
    landmarks[`cuff_${side}`] = row(4)[0];
  }
  const asset = { panels, paths, landmarks } as unknown as ClothAsset;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(panels.length * 3), 3));
  geometry.setIndex(index);
  const layer = new Group();
  layer.add(new Mesh(geometry, new MeshBasicMaterial()));
  return { asset, layer, start: [4, 12] };
}

describe('sleeve layers: cap in the torso layer (F3, D8)', () => {
  it('finds the cap rows from the sleeve line and the bicep ring', () => {
    const { asset, start } = toy();
    expect(sleeveCapRows(asset.paths, 'L')).toEqual({
      firstRowStart: start[0],
      capEnd: start[0] + 4,
    });
    expect(sleeveCapRows({}, 'L')).toBeNull();
  });

  it('draws the cap triangles in both layers only when asked', () => {
    const { asset, layer } = toy();
    const count = (s: SleeveLayers, name: 'torso' | 'sleeveL') =>
      (s.proxies.get(name)!.geometry.getIndex()!.count / 3) | 0;
    const plain = new SleeveLayers();
    expect(plain.update(layer, asset)).toBe(true);
    const torsoPlain = count(plain, 'torso'),
      sleevePlain = count(plain, 'sleeveL');
    plain.dispose();
    const capped = new SleeveLayers();
    capped.capInTorso = true;
    expect(capped.update(layer, asset)).toBe(true);
    // Per sleeve: the cap is rows 1–2, i.e. the one all-sleeve quad between them (2 triangles).
    expect(count(capped, 'torso')).toBe(torsoPlain + 4);
    expect(count(capped, 'sleeveL')).toBe(sleevePlain);
  });
});

describe('sleeve layers: dropped cap with the sleeve (F3, f3shoulder)', () => {
  it('moves the dropped-cap triangles from the torso layer to their sleeve', () => {
    const { asset, layer, start } = toy();
    // The left sleeve's first row is a dropped cap carrying the body panel.
    const capIds = [start[0], start[0] + 1, start[0] + 2, start[0] + 3];
    for (const v of capIds) (asset.panels as number[])[v] = 0;
    (asset.paths as Record<string, number[]>).dropped_cap_L = capIds;
    const count = (s: SleeveLayers, name: 'torso' | 'sleeveL') =>
      (s.proxies.get(name)!.geometry.getIndex()!.count / 3) | 0;
    const plain = new SleeveLayers();
    plain.update(layer, asset);
    const torsoPlain = count(plain, 'torso'),
      sleevePlain = count(plain, 'sleeveL');
    plain.dispose();
    const moved = new SleeveLayers();
    moved.dropCapToSleeve = true;
    moved.update(layer, asset);
    // The cap quad (rows 1-2) and the cap-to-sleeve quad (rows 2-3): 4 triangles move.
    expect(count(moved, 'sleeveL')).toBe(sleevePlain + 4);
    expect(count(moved, 'torso')).toBe(torsoPlain - 4);
  });
});
