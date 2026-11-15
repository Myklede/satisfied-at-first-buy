import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  SphereGeometry,
  TorusKnotGeometry,
} from 'three';
import { fastBoundingSphere, fastVertexNormals, installFastGeometry } from './fastGeometry';

/** A seeded, deformed copy of an indexed mesh (a posed jacket stand-in). */
function deformed(seed: number) {
  const base = new TorusKnotGeometry(0.4, 0.12, 180, 24);
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const p = base.getAttribute('position').array as Float32Array;
  for (let i = 0; i < p.length; i++) p[i] += rand() * 0.01 + 0.3;
  return base;
}

const clone = (g: BufferGeometry) => {
  const c = new BufferGeometry();
  c.setIndex(new BufferAttribute((g.index!.array as Uint16Array | Uint32Array).slice(), 1));
  for (const name of ['position', 'normal'])
    c.setAttribute(
      name,
      new BufferAttribute((g.getAttribute(name).array as Float32Array).slice(), 3),
    );
  return c;
};

describe('fast geometry (bit-identical to three)', () => {
  it('bounding sphere: same centre and radius bits as three', () => {
    for (const seed of [1, 7, 42]) {
      const a = deformed(seed),
        b = clone(a);
      a.computeBoundingSphere();
      expect(fastBoundingSphere(b)).toBe(true);
      expect(b.boundingSphere!.center.toArray()).toEqual(a.boundingSphere!.center.toArray());
      expect(b.boundingSphere!.radius).toBe(a.boundingSphere!.radius);
    }
  });

  it('vertex normals: same float32 bits as three', () => {
    for (const seed of [3, 11]) {
      const a = deformed(seed),
        b = clone(a);
      a.computeVertexNormals();
      expect(fastVertexNormals(b)).toBe(true);
      expect(Array.from(b.getAttribute('normal').array)).toEqual(
        Array.from(a.getAttribute('normal').array),
      );
    }
    // Uint32 indices too.
    const s = new SphereGeometry(1, 64, 48);
    const t = clone(s);
    t.setIndex(new BufferAttribute(Uint32Array.from(s.index!.array), 1));
    s.computeVertexNormals();
    expect(fastVertexNormals(t)).toBe(true);
    expect(Array.from(t.getAttribute('normal').array)).toEqual(
      Array.from(s.getAttribute('normal').array),
    );
  });

  it('falls back for layouts it does not handle, and the patch is reversible', () => {
    const g = new BufferGeometry();
    const inter = new InterleavedBuffer(new Float32Array([0, 0, 0, 9, 1, 2, 3, 9]), 4);
    g.setAttribute('position', new InterleavedBufferAttribute(inter, 3, 0));
    expect(fastBoundingSphere(g)).toBe(false);
    expect(fastVertexNormals(new SphereGeometry(1, 8, 6).toNonIndexed())).toBe(false);
    const original = BufferGeometry.prototype.computeBoundingSphere;
    const uninstall = installFastGeometry();
    expect(BufferGeometry.prototype.computeBoundingSphere).not.toBe(original);
    g.computeBoundingSphere(); // interleaved: three's own path still runs
    expect(g.boundingSphere!.radius).toBeGreaterThan(0);
    const k = deformed(5),
      ref = clone(k);
    k.computeBoundingSphere();
    uninstall();
    expect(BufferGeometry.prototype.computeBoundingSphere).toBe(original);
    ref.computeBoundingSphere();
    expect(k.boundingSphere!.radius).toBe(ref.boundingSphere!.radius);
  });
});
