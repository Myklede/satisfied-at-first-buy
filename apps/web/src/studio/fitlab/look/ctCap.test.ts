import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Raycaster, Scene, Vector3 } from 'three';
import type { Loop } from './crossSection';
import type { CtSlice, CtTone } from './ctTypes';
import {
  createCtCap,
  easeInOut,
  fanY,
  layerProgress,
  liftHeight,
  loopArea,
  loopToShapePoints,
  nearestBodyPoint,
  ribbonTriangles,
  ringQuads,
  segmentCount,
  segmentTones,
  sliceSignature,
  torsoOnly,
} from './ctCap';

function circle(n: number, r: number, closed = true, zone = 0, drop = 0): Loop {
  const points = [];
  for (let i = 0; i < n - drop; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push({ x: r * Math.cos(a), z: r * Math.sin(a), a: i, b: i + 1, t: 0 });
  }
  const segs = closed ? points.length : points.length - 1;
  return { points, zones: Array.from({ length: segs }, (_, i) => (i < 2 ? zone : 9)), closed };
}

const toneOf = (z: number): CtTone => (z === 1 ? 'tight' : z === 2 ? 'snug' : null);

describe('ctCap helpers', () => {
  it('maps a loop to shape points (x, -z) and drops a duplicated closing point', () => {
    const loop = circle(8, 0.1);
    loop.points.push({ ...loop.points[0]! });
    const pts = loopToShapePoints(loop);
    expect(pts).toHaveLength(8);
    expect(pts[2]!.x).toBeCloseTo(loop.points[2]!.x);
    expect(pts[2]!.y).toBeCloseTo(-loop.points[2]!.z);
  });

  it('counts segments for closed and open loops', () => {
    expect(segmentCount(circle(8, 0.1))).toBe(8);
    expect(segmentCount(circle(8, 0.1, false))).toBe(7);
  });

  it('reads engine tones per segment, null for none / good / loose', () => {
    const tones = segmentTones(circle(6, 0.1, true, 1), toneOf);
    expect(tones.slice(0, 2)).toEqual(['tight', 'tight']);
    expect(tones.slice(2)).toEqual([null, null, null, null]);
  });

  it('finds the nearest body point across loops', () => {
    const body = [circle(16, 0.1)];
    const p = nearestBodyPoint(0.2, 0, body);
    expect(p!.x).toBeCloseTo(0.1);
    expect(nearestBodyPoint(0, 0, [])).toBeNull();
  });

  it('builds one ring quad per shell segment; an open C yields no closure', () => {
    const body = [circle(32, 0.1)];
    const closed = ringQuads([circle(32, 0.12, true, 2)], body, toneOf);
    expect(closed).toHaveLength(32);
    expect(closed[0]!.tone).toBe('snug');
    expect(closed[5]!.tone).toBeNull();
    // matched body points sit on the body circle, inside the shell
    expect(Math.hypot(closed[0]!.b0.x, closed[0]!.b0.z)).toBeCloseTo(0.1);
    const open = ringQuads([circle(32, 0.12, false, 0, 4)], body, toneOf);
    expect(open).toHaveLength(27);
  });

  it('ribbon quads have the requested width', () => {
    const loop: Loop = {
      points: [
        { x: 0, z: 0, a: 0, b: 1, t: 0 },
        { x: 1, z: 0, a: 1, b: 2, t: 0 },
      ],
      zones: [0],
      closed: false,
    };
    const { quads } = ribbonTriangles(loop, 0.004);
    expect(quads).toHaveLength(1);
    const q = quads[0]!;
    expect(Math.abs(q.a[1] - q.b[1])).toBeCloseTo(0.004);
  });

  it('signature changes with the slice geometry, not with nothing', () => {
    const base: CtSlice = {
      y: 1.3,
      centre: { x: 0, z: 0 },
      body: [circle(16, 0.1)],
      shell: [circle(16, 0.12)],
      ghosts: [{ size: 'L', loops: [circle(16, 0.13)] }],
      gapAt: () => null,
      toneOf,
      solver: true,
      selectedSize: 'M',
    };
    const s1 = sliceSignature(base);
    expect(sliceSignature({ ...base })).toBe(s1);
    expect(sliceSignature({ ...base, y: 1.25 })).not.toBe(s1);
    expect(sliceSignature({ ...base, shell: [circle(16, 0.12, false)] })).not.toBe(s1);
  });

  it('staggers layers bottom first and reaches 1 for every layer at phase 1', () => {
    const n = 7;
    expect(layerProgress(0, n, 0)).toBe(0);
    expect(layerProgress(0, n, 0.1)).toBeGreaterThan(0);
    expect(layerProgress(6, n, 0.1)).toBe(0);
    for (let i = 0; i < n; i++) expect(layerProgress(i, n, 1)).toBeCloseTo(1);
    expect(layerProgress(2, n, 0.5)).toBeGreaterThan(layerProgress(3, n, 0.5));
  });

  it('fans heights about the middle by the progress', () => {
    expect(fanY(1.2, 1.0, 0)).toBeCloseTo(1.2);
    expect(fanY(1.2, 1.0, 1)).toBeCloseTo(1.36);
    expect(fanY(1.0, 1.0, 1, 1.8, 1.3)).toBeCloseTo(1.3);
    expect(liftHeight([0.9, 1.1, 1.3], ['Hem', 'Chest', 'Collar'])).toBeCloseTo(1.1);
    expect(liftHeight([0.9, 1.3], ['', ''])).toBeCloseTo(1.1);
    expect(fanY(1.0, 1.0, 1)).toBeCloseTo(1.0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
  });

  it('keeps only the torso loop and the shell / ghost loops around it', () => {
    const shift = (l: Loop, dx: number): Loop => ({ ...l, points: l.points.map((p) => ({ ...p, x: p.x + dx })) });
    const torso = circle(32, 0.15);
    const arm = shift(circle(16, 0.04), 0.25);
    expect(loopArea(torso)).toBeGreaterThan(loopArea(arm));
    const slice: CtSlice = {
      y: 1.2,
      centre: { x: 0, z: 0 },
      body: [arm, torso],
      shell: [circle(32, 0.17, false, 0, 4), shift(circle(16, 0.06), 0.25)],
      ghosts: [{ size: 'L', loops: [circle(32, 0.18), shift(circle(16, 0.07), 0.25)] }],
      gapAt: () => null,
      toneOf,
      solver: true,
      selectedSize: 'M',
    };
    const t = torsoOnly(slice);
    expect(t.body).toEqual([torso]);
    expect(t.shell).toHaveLength(1);
    expect(t.shell[0]!.closed).toBe(false);
    expect(t.ghosts[0]!.loops).toHaveLength(1);
  });

  it('layerCentre and pick follow the drawn, slid-out disc', () => {
    const scene = new Scene();
    const cap = createCtCap(scene);
    const mk = (y: number): CtSlice => ({
      y,
      centre: { x: 0, z: 0 },
      body: [circle(32, 0.12)],
      shell: [circle(32, 0.14)],
      ghosts: [],
      gapAt: () => null,
      toneOf,
      solver: true,
      selectedSize: 'M',
    });
    const camera = new PerspectiveCamera(30, 1, 0.01, 50);
    camera.position.set(0, 1.2, 3);
    camera.lookAt(0, 1.2, 0);
    cap.update(1, { slices: [mk(1.0), mk(1.2), mk(1.4)], labels: ['', 'Chest', ''], verdicts: ['', '', ''] }, camera);
    const c = cap.layerCentre(1, new Vector3());
    expect(c).not.toBeNull();
    // Camera right is +X here: slid 0.40 m to +X, at the chest height.
    expect(c!.x).toBeCloseTo(0.4);
    expect(c!.y).toBeCloseTo(1.2);
    // The drawn body cap of that layer has the same world origin.
    const root = scene.getObjectByName('ct-cap')!;
    const disc = root.children[1]!;
    const drawn = disc.children.find((o) => o instanceof Mesh)!;
    const w = new Vector3();
    disc.getWorldPosition(w);
    expect(w.distanceTo(c!)).toBeLessThan(1e-9);
    expect(drawn.parent).toBe(disc);
    // A ray straight down through that centre picks layer 1.
    const rc = new Raycaster(new Vector3(c!.x, 1.29, c!.z), new Vector3(0, -1, 0));
    expect(cap.pick(rc)).toBe(1);
    cap.dispose();
  });
});
