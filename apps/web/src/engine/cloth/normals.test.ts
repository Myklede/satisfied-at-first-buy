import { BufferGeometry, Float32BufferAttribute } from 'three';
import { expect, it } from 'vitest';
import { smoothNormals } from './normals';

it('matches Three smooth shading and keeps degenerate triangles finite', () => {
  const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    ids = new Uint16Array([0, 1, 2, 0, 3, 1, 0, 0, 0]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.setIndex(Array.from(ids));
  g.computeVertexNormals();
  const out = new Float32Array(p.length);
  smoothNormals(p, ids, out);
  const expected = g.getAttribute('normal').array;
  for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(expected[i], 6);
  expect(out.every(Number.isFinite)).toBe(true);
  g.dispose();
});
