import { BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import {
  chainLoops,
  cutMesh,
  cutMeshAt,
  cutTriangle,
  interpolate,
  loopPerimeter,
  side,
  signedDistance,
  type CutSegment,
  keyByWelds,
  weldRepresentatives,
} from './crossSection';

/** An open-ended prism (n-gon tube) from y=0 to y=1, radius r; optionally split along one seam. */
function tube(n: number, r: number, split = false) {
  const pos: number[] = [];
  // Ring vertices bottom (0..n-1) and top (n..2n-1); a split duplicates vertex 0 as vertex n*2 / n*2+1.
  for (const y of [0, 1])
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  if (split) pos.push(r, 0, 0, r, 1, 0);
  const tris: number[] = [];
  for (let i = 0; i < n; i++) {
    let j = (i + 1) % n,
      jt = j + n;
    if (split && j === 0) {
      j = 2 * n;
      jt = 2 * n + 1;
    }
    tris.push(i, j, i + n, j, jt, i + n);
  }
  return { pos, tris };
}

function segments(pos: number[], tris: number[], h: number): CutSegment[] {
  const out: CutSegment[] = [];
  for (let f = 0; f < tris.length; f += 3) {
    const c = cutTriangle(pos, tris[f], tris[f + 1], tris[f + 2], h);
    if (c) out.push({ p: c[0], q: c[1], zone: 0 });
  }
  return out;
}

describe('crossSection', () => {
  it('cuts a triangle crossing the plane at the right points', () => {
    const pos = [0, 0, 0, 2, 0, 0, 0, 2, 0];
    const c = cutTriangle(pos, 0, 1, 2, 1);
    expect(c).not.toBeNull();
    const xs = c!.map((p) => p.x).sort();
    expect(xs[0]).toBeCloseTo(0);
    expect(xs[1]).toBeCloseTo(1);
    expect(cutTriangle(pos, 0, 1, 2, 3)).toBeNull();
  });

  it('chains a tube into one closed loop with the right perimeter', () => {
    const { pos, tris } = tube(64, 0.15);
    const loops = chainLoops(segments(pos, tris, 0.5));
    expect(loops).toHaveLength(1);
    expect(loops[0].closed).toBe(true);
    expect(loops[0].points).toHaveLength(128); // two triangles per quad: the diagonal is cut too
    expect(loops[0].zones).toHaveLength(128);
    const polygon = 2 * 64 * 0.15 * Math.sin(Math.PI / 64);
    expect(loopPerimeter(loops[0])).toBeCloseTo(polygon, 6);
  });

  it('an opened seam gives an open "C"; a welded split (copies within 2 mm) closes', () => {
    const { pos, tris } = tube(32, 0.15, true);
    // The split copy sits exactly on the original: joined by distance -> closed.
    expect(chainLoops(segments(pos, tris, 0.5))[0].closed).toBe(true);
    // Open the seam by 3 cm: the cut stays one open loop.
    const opened = [...pos];
    opened[32 * 2 * 3 + 2] = 0.03;
    opened[(32 * 2 + 1) * 3 + 2] = 0.03;
    const loops = chainLoops(segments(opened, tris, 0.5));
    expect(loops).toHaveLength(1);
    expect(loops[0].closed).toBe(false);
    expect(loops[0].points).toHaveLength(65);
    expect(loops[0].zones).toHaveLength(64);
    // The same 3 cm opening held by solver welds (vertex 0 <-> 2n, n <-> 2n+1): chained closed.
    const welded = segments(opened, tris, 0.5);
    keyByWelds(welded, weldRepresentatives(opened.length / 3, [0, 64, 32, 65]));
    expect(chainLoops(welded)[0].closed).toBe(true);
  });

  it('interpolates a per-vertex value along the cut edge', () => {
    const pos = [0, 0, 0, 0, 1, 0, 1, 0, 0];
    const c = cutTriangle(pos, 0, 1, 2, 0.25)!;
    const onEdge01 = c.find((p) => p.a === 0 && p.b === 1)!;
    expect(onEdge01.t).toBeCloseTo(0.25);
    expect(interpolate([-2, 2, 0], onEdge01)).toBeCloseTo(-1);
  });

  it('signed distance is negative inside a closed loop; side() reads front/back/side', () => {
    const { pos, tris } = tube(64, 0.1);
    const loops = chainLoops(segments(pos, tris, 0.5));
    expect(signedDistance(0, 0, loops)).toBeCloseTo(-0.1, 2);
    expect(signedDistance(0.15, 0, loops)).toBeCloseTo(0.05, 2);
    expect(side(0, 1, 0, 0)).toBe('front');
    expect(side(0, -1, 0, 0)).toBe('back');
    expect(side(1, 0.2, 0, 0)).toBe('side');
  });

  it('cutMeshAt (one pass, many heights) matches cutMesh at each height', () => {
    const { pos, tris } = tube(48, 0.12);
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(tris);
    const mesh = new Mesh(g);
    mesh.position.set(0.1, 0.5, -0.2);
    const ys = [0.6, 0.9, 1.2, 2];
    const many = cutMeshAt(mesh, ys);
    ys.forEach((y, k) => {
      const one = cutMesh(mesh, y);
      expect(many[k]!.loops.length).toBe(one!.loops.length);
      if (one!.loops.length)
        expect(loopPerimeter(many[k]!.loops[0])).toBeCloseTo(loopPerimeter(one!.loops[0]), 9);
    });
    expect(many[3]!.loops).toHaveLength(0);
  });
});
