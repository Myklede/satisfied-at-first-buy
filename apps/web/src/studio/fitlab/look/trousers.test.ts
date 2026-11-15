import { describe, expect, it } from 'vitest';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import { smoothNormals } from '../../../engine/cloth/normals';
import { loadLiveRig } from '../../../engine/live/liveRig';
import { fixtureAvailable, fixtureBuffer } from '../../../engine/motion/testFixture';
import {
  ANKLE_OFFSET_M,
  HEM_ABOVE_ANKLE_M,
  THIGH_OFFSET_M,
  WAIST_RISE_M,
  buildTrousersData,
  createTrousers,
  createTrousersFromRest,
  openEdges,
  selectTrouserFaces,
  trouserOffset,
  trousersHeights,
} from './trousers';

/** A tube along Y: `rings` rings of `seg` vertices from y0 to y1, closed sides, open ends. */
function tube(
  cx: number,
  cz: number,
  y0: number,
  y1: number,
  r0: number,
  r1: number,
  rings = 20,
  seg = 12,
) {
  const positions: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const r = r0 + (r1 - r0) * t;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      positions.push(cx + r * Math.cos(a), y0 + (y1 - y0) * t, cz + r * Math.sin(a));
    }
  }
  for (let i = 0; i < rings - 1; i++)
    for (let s = 0; s < seg; s++) {
      const a = i * seg + s,
        b = i * seg + ((s + 1) % seg),
        c = (i + 1) * seg + s,
        d = (i + 1) * seg + ((s + 1) % seg);
      faces.push(a, c, b, b, c, d); // outward for a Y-up tube (verified by the offset test)
    }
  return { positions, faces };
}

/** Pelvis tube + two leg tubes (joined at y=0.8) and a separate arm tube hanging beside the hip. */
function fakeBody() {
  const parts = [
    tube(0, 0, 0.9, 1.4, 0.16, 0.14), // torso (joined below via shared rim: add legs separately)
    tube(-0.08, 0, 0.0, 0.85, 0.045, 0.085), // left leg, ankle to thigh
    tube(0.08, 0, 0.0, 0.85, 0.045, 0.085), // right leg
    tube(0.3, 0, 0.6, 1.2, 0.04, 0.05, 13, 3), // arm, far from the torso: a small separate component
  ];
  const positions: number[] = [];
  const faces: number[] = [];
  for (const p of parts) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    faces.push(...p.faces.map((f) => f + base));
  }
  return { positions: Float32Array.from(positions), faces: Uint32Array.from(faces) };
}

// Hip line at the top of the legs; ankles at 0.08 m (the legs' bottom rings sit below that).
const HIP_Y = 0.78;
const ANKLE_Y = 0.08;

describe('trouser ease', () => {
  it('is looser at the thigh than at the ankle and has 2.5-3 cm ease at the thigh and 1.5 cm at the waistband', () => {
    const thigh = trouserOffset(HIP_Y - 0.02, HIP_Y, ANKLE_Y);
    const knee = trouserOffset(0.45, HIP_Y, ANKLE_Y);
    const hem = trouserOffset(ANKLE_Y + HEM_ABOVE_ANKLE_M, HIP_Y, ANKLE_Y);
    expect(thigh).toBeGreaterThan(knee);
    expect(knee).toBeGreaterThan(hem);
    expect(thigh).toBeLessThanOrEqual(THIGH_OFFSET_M + 1e-9);
    expect(thigh).toBeGreaterThanOrEqual(0.025);
    expect(hem).toBeCloseTo(ANKLE_OFFSET_M, 6);
    for (let y = ANKLE_Y; y <= HIP_Y + WAIST_RISE_M; y += 0.01) {
      const o = trouserOffset(y, HIP_Y, ANKLE_Y);
      expect(o).toBeGreaterThanOrEqual(0.015 - 1e-9);
      expect(o).toBeLessThanOrEqual(0.03 + 1e-9);
    }
  });

  it('is monotone from the knee to the ankle', () => {
    let last = Infinity;
    for (let y = HIP_Y; y >= ANKLE_Y + HEM_ABOVE_ANKLE_M; y -= 0.02) {
      const o = trouserOffset(y, HIP_Y, ANKLE_Y);
      expect(o).toBeLessThanOrEqual(last + 1e-12);
      last = o;
    }
  });
});

describe('vertex selection', () => {
  const body = fakeBody();
  const bottom = ANKLE_Y + HEM_ABOVE_ANKLE_M,
    top = HIP_Y + WAIST_RISE_M;

  it('selects only faces that touch the band', () => {
    const kept = selectTrouserFaces(body.positions, body.faces, bottom, top);
    expect(kept.length).toBeGreaterThan(0);
    for (const f of kept) {
      const ys = [0, 1, 2].map((k) => body.positions[body.faces[f * 3 + k] * 3 + 1]);
      expect(Math.min(...ys)).toBeLessThanOrEqual(top);
      expect(Math.max(...ys)).toBeGreaterThanOrEqual(bottom);
    }
  });

  it('cuts the hems flat: every rim vertex lies exactly on the waist or the ankle plane', () => {
    const data = buildTrousersData(body.positions, body.faces, { hipY: HIP_Y, ankleY: ANKLE_Y });
    let low = 0,
      high = 0;
    for (let i = 0; i < data.rim.length; i++) {
      if (!data.rim[i]) continue;
      const y = data.restPositions[i * 3 + 1];
      if (Math.abs(y - bottom) < 1e-5) low++;
      else if (Math.abs(y - top) < 1e-5) high++;
      else throw new Error(`rim vertex ${i} at y=${y} is on neither hem plane`);
    }
    expect(low).toBeGreaterThan(10);
    expect(high).toBeGreaterThan(10);
  });

  it('drops the arm hanging beside the hip (a separate component)', () => {
    const data = buildTrousersData(body.positions, body.faces, { hipY: HIP_Y, ankleY: ANKLE_Y });
    for (const v of [...data.sourceIndex, ...data.sourceIndexB])
      expect(Math.abs(body.positions[v * 3] - 0.3)).toBeGreaterThan(0.1);
  });

  it('keeps both legs', () => {
    const data = buildTrousersData(body.positions, body.faces, { hipY: HIP_Y, ankleY: ANKLE_Y });
    const xs = [...data.restPositions].filter((_, i) => i % 3 === 0);
    expect(xs.some((x) => x < -0.03)).toBe(true);
    expect(xs.some((x) => x > 0.03)).toBe(true);
  });
});

describe('geometry', () => {
  const body = fakeBody();
  const data = buildTrousersData(body.positions, body.faces, { hipY: HIP_Y, ankleY: ANKLE_Y });

  it('eases the thigh by 2.5-3 cm and hangs the lower leg as a constant-radius tube', () => {
    const radii: Record<number, number[]> = { 0: [], 1: [] };
    for (let i = 0; i < data.sourceIndex.length; i++) {
      if (data.rim[i]) continue;
      const [va, vb, t] = [data.sourceIndex[i], data.sourceIndexB[i], data.blend[i]];
      const at = (a: number) =>
        body.positions[va * 3 + a] * (1 - t) + body.positions[vb * 3 + a] * t;
      const x = data.restPositions[i * 3],
        z = data.restPositions[i * 3 + 2];
      if (data.tubeWeight[i] >= 0.999 && data.ring[i] >= 0) {
        const cx = at(0) < 0 ? -0.08 : 0.08;
        radii[cx < 0 ? 0 : 1].push(Math.hypot(x - cx, z));
      } else if (data.tubeWeight[i] === 0) {
        expect(Math.hypot(x - at(0), z - at(2))).toBeLessThanOrEqual(0.0285);
      }
    }
    for (const side of [0, 1]) {
      expect(radii[side].length).toBeGreaterThan(20);
      expect(Math.max(...radii[side]) - Math.min(...radii[side])).toBeLessThan(0.006);
    }
  });

  it('closes the hems: the only open edges are on the skin-level rim', () => {
    const open = openEdges(data.indices);
    expect(open.length).toBeGreaterThan(0); // the rim lies on the body, it is not a hole
    for (const [a, b] of open) {
      expect(data.rim[a]).toBe(1);
      expect(data.rim[b]).toBe(1);
      expect(data.offset[a]).toBe(0);
    }
    // Every outer hem edge has a wall: no surface vertex ends an open edge.
    const surfaceOpen = open.filter(([a, b]) => !data.rim[a] || !data.rim[b]);
    expect(surfaceOpen).toEqual([]);
  });

  it('has consistent winding (no directed edge used twice) and no degenerate triangles', () => {
    const used = new Set<string>();
    for (let t = 0; t < data.indices.length; t += 3) {
      const tri = [data.indices[t], data.indices[t + 1], data.indices[t + 2]];
      expect(new Set(tri).size).toBe(3);
      for (let k = 0; k < 3; k++) {
        const id = `${tri[k]}>${tri[(k + 1) % 3]}`;
        expect(used.has(id)).toBe(false);
        used.add(id);
      }
    }
  });

  it('wall triangles face away from the trouser surface (hems point down at the ankle)', () => {
    // The lowest rim ring: wall triangle normals should have a negative Y component on average.
    let sum = 0,
      n = 0;
    for (let t = data.surfaceTriangles * 3; t < data.indices.length; t += 3) {
      const [a, b, c] = [data.indices[t], data.indices[t + 1], data.indices[t + 2]];
      const y = data.restPositions[a * 3 + 1];
      if (y > 0.2) continue;
      const u = [0, 1, 2].map((k) => data.restPositions[b * 3 + k] - data.restPositions[a * 3 + k]);
      const w = [0, 1, 2].map((k) => data.restPositions[c * 3 + k] - data.restPositions[a * 3 + k]);
      sum += u[2] * w[0] - u[0] * w[2]; // normal Y = uz*wx - ux*wz
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(sum).toBeLessThan(0);
  });

  it('rejects an impossible band', () => {
    expect(() =>
      buildTrousersData(body.positions, body.faces, { hipY: 0.1, ankleY: 0.5 }),
    ).toThrow();
  });
});

describe('Trousers mesh', () => {
  const body = fakeBody();
  it('follows a moved body: a translated body translates the trousers', () => {
    const trousers = createTrousersFromRest(body.positions, body.faces, {
      hipY: HIP_Y,
      ankleY: ANKLE_Y,
    });
    const moved = Float32Array.from(body.positions, (v, i) => (i % 3 === 0 ? v + 1 : v));
    const normals = new Float32Array(moved.length);
    smoothNormals(body.positions, body.faces, normals);
    trousers.sync(moved, normals);
    const p = trousers.geometry.getAttribute('position');
    const rest = trousers.data.restPositions;
    for (let i = 0; i < rest.length / 3; i += 5) {
      expect(p.getX(i)).toBeCloseTo(rest[i * 3] + 1, 4);
      expect(p.getY(i)).toBeCloseTo(rest[i * 3 + 1], 4);
      expect(p.getZ(i)).toBeCloseTo(rest[i * 3 + 2], 4);
    }
    trousers.dispose();
  });

  it('uses a matte, non-metallic fabric', () => {
    const trousers = createTrousersFromRest(body.positions, body.faces, {
      hipY: HIP_Y,
      ankleY: ANKLE_Y,
      colour: 0x1a2238,
    });
    expect(trousers.material.roughness).toBeGreaterThan(0.85);
    expect(trousers.material.metalness).toBe(0);
    expect(trousers.material.color.getHex()).toBe(0x1a2238);
    trousers.dispose();
  });
});

describe('createTrousers (SkinnedMesh body)', () => {
  it('copies the body skin attributes and binds the same skeleton', () => {
    const body = fakeBody();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(body.positions, 3));
    g.setIndex(Array.from(body.faces));
    const n = body.positions.length / 3;
    const si = new Uint16Array(n * 4),
      sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = i % 2;
      sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
    const bones = [new Bone(), new Bone()];
    const skeleton = new Skeleton(bones);
    const skinned = new SkinnedMesh(g);
    skinned.add(bones[0], bones[1]);
    skinned.bind(skeleton);
    const t = createTrousers(skinned, { hipY: HIP_Y, ankleY: ANKLE_Y });
    expect(t.skeleton).toBe(skeleton);
    const idx = t.geometry.getAttribute('skinIndex');
    const wgt = t.geometry.getAttribute('skinWeight');
    expect(idx.count).toBe(t.geometry.getAttribute('position').count);
    for (let i = 0; i < idx.count; i += 7) expect(wgt.getX(i)).toBe(1);
  });
});

describe('trousersHeights', () => {
  it('reads the hip and the lower ankle from the joints', () => {
    expect(
      trousersHeights({ midHip: [0, 0.95, 0], lAnkle: [0, 0.1, 0], rAnkle: [0, 0.09, 0] }),
    ).toEqual({
      hipY: 0.95,
      ankleY: 0.09,
    });
    expect(() => trousersHeights({})).toThrow();
  });
});

describe.skipIf(!fixtureAvailable('rig.bin'))('on the real Anny reference body', () => {
  const live = loadLiveRig(fixtureBuffer('rig.bin'));
  const rig = live.rig;
  // Joints at the rest pose: hip joint height and ankle joint height from the rig's own bones.
  const index = (name: string) => rig.bones.indexOf(name);
  const headY = (name: string) => rig.restWorld[index(name) * 16 + 7];
  const hipY = (headY('upperleg01.L') + headY('upperleg01.R')) / 2;
  const ankleY = Math.min(headY('foot.L'), headY('foot.R'));

  it('selects pelvis and both legs only, with closed hems', () => {
    const data = buildTrousersData(rig.restVertices, rig.faces, { hipY, ankleY });
    expect(data.surfaceTriangles).toBeGreaterThan(500);
    const rimYs = [...data.rim].flatMap((r, i) => (r ? [data.restPositions[i * 3 + 1]] : []));
    // the ankle hem is cut square to the (tilted) leg axis, so it may sit up to ~1.5 cm off the plane
    expect(Math.abs(Math.min(...rimYs) - (ankleY + HEM_ABOVE_ANKLE_M))).toBeLessThan(0.015);
    expect(Math.max(...rimYs)).toBeCloseTo(hipY + WAIST_RISE_M, 4);
    // no hands/arms: all trouser vertices stay within the legs' lateral reach (pelvis half-width)
    const xs = [...data.restPositions].filter((_, i) => i % 3 === 0).map(Math.abs);
    expect(Math.max(...xs)).toBeLessThan(0.3);
    for (const [a, b] of openEdges(data.indices)) {
      expect(data.rim[a]).toBe(1);
      expect(data.rim[b]).toBe(1);
    }
  });
});
