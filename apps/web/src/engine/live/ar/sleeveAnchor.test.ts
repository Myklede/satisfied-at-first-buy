import { describe, expect, it } from 'vitest';
import {
  HandHold,
  PinBlend,
  SLEEVE,
  buildChain,
  closeCuff,
  CUFF,
  cuffBand,
  facingTriangles,
  handShape,
  headRim,
  headTriangles,
  HEAD_TUCK,
  HEAD_LENGTH_M,
  facePoints,
  skinLike,
  skinLikelihood,
  cuffClip,
  itemBox,
  outsideWinding,
  restEdges,
  sampleIds,
  sleeveExtents,
  stickerMask,
  stickerSource,
  unifyWinding,
  unstretched,
  type ChainInput,
  type ChainJoints,
} from './sleeveAnchor';
import type { Pt } from './armOccluder';

const IDENTITY = [1, 0, 0, 1] as const;

/** Points of a tube of half-width r round the bones s→e→w, running `past` px beyond the wrist. */
function tube(j: ChainJoints, r: number, past: number): number[] {
  const out: number[] = [];
  const along = (a: Pt, b: Pt, from: number, to: number) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    for (let t = from; t <= len + to; t += 4)
      for (const s of [-r, -r / 2, 0, r / 2, r])
        out.push(a[0] + d[0] * t - d[1] * s, a[1] + d[1] * t + d[0] * s);
  };
  along(j.s, j.e, 0, 0);
  along(j.e, j.w, 0, past);
  return out;
}

/** A rendered arm hanging down: shoulder (300, 100), elbow 100 px below, wrist 90 px further. */
const hanging: ChainJoints = { s: [300, 100], e: [300, 200], w: [300, 290] };
const extents = { capR: 40, upperR: 30, foreR: 26, elbowR: 28, cuffPast: 12 };

const input = (over: Partial<ChainInput> = {}): ChainInput => ({
  source: hanging,
  shoulder: [310, 104],
  jacobian: IDENTITY,
  // The real arm folded across the chest: elbow down and out, wrist back over the torso.
  elbow: [330, 205],
  wrist: [240, 190],
  extents,
  handLen: 40,
  ...over,
});

const close = (a: Pt, b: Pt, eps = 1e-6) => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
};

describe('sleeve extents', () => {
  it('measures the bands and the cuff of a straight sleeve', () => {
    const e = sleeveExtents(tube(hanging, 30, 12), hanging)!;
    expect(e.upperR).toBeCloseTo(30, 0);
    expect(e.foreR).toBeCloseTo(30, 0);
    expect(e.cuffPast).toBeGreaterThan(8);
    expect(e.cuffPast).toBeLessThanOrEqual(12);
  });

  it('does not inflate a band when the arm is sharply bent', () => {
    // Forearm folded back up beside the upper arm (interior angle about 25°).
    const bent: ChainJoints = { s: [300, 100], e: [300, 200], w: [340, 115] };
    const e = sleeveExtents(tube(bent, 20, 0), bent)!;
    expect(e.upperR).toBeLessThanOrEqual(21);
    expect(e.foreR).toBeLessThanOrEqual(21);
  });

  it('reports a sleeve that ends short of the wrist', () => {
    const e = sleeveExtents(tube(hanging, 30, -30), hanging)!;
    expect(e.cuffPast).toBeLessThan(-20);
  });

  it('skips vertices without an image and needs enough of them', () => {
    expect(sleeveExtents([NaN, NaN, 300, 150], hanging)).toBeNull();
    expect(sleeveExtents([...tube(hanging, 30, 0), NaN, NaN], hanging)).not.toBeNull();
  });
});

describe('sleeve stickers', () => {
  it('lays the rendered joints exactly on the real ones', () => {
    const c = buildChain(input());
    close(c.target.s, [310, 104]);
    close(c.target.e, [330, 205]);
    close(c.target.w, [240, 190]);
    // Shoulder: cap and upper arm. Elbow: upper arm and forearm. Wrist: forearm.
    close(stickerSource(c, 'cap', c.target.s), hanging.s);
    close(stickerSource(c, 'upper', c.target.s), hanging.s);
    close(stickerSource(c, 'upper', c.target.e), hanging.e);
    close(stickerSource(c, 'fore', c.target.e), hanging.e);
    close(stickerSource(c, 'fore', c.target.w), hanging.w);
  });

  it('keeps the sleeve width and never folds along a bone', () => {
    const c = buildChain(input());
    // 10 px beside the real forearm is 10 px beside the rendered one.
    const mid: Pt = [(c.target.e[0] + c.target.w[0]) / 2, (c.target.e[1] + c.target.w[1]) / 2];
    const n: Pt = [-c.dirT[1][1], c.dirT[1][0]];
    const src = stickerSource(c, 'fore', [mid[0] + n[0] * 10, mid[1] + n[1] * 10]);
    expect(Math.abs(src[0] - hanging.e[0])).toBeCloseTo(10, 6);
    // Walking down the real forearm (and past both ends) walks down the rendered one, strictly.
    let last = -Infinity;
    for (let t = -40; t <= c.lenT[1] + 40; t += 2) {
      const p: Pt = [c.target.e[0] + c.dirT[1][0] * t, c.target.e[1] + c.dirT[1][1] * t];
      const y = stickerSource(c, 'fore', p)[1];
      expect(y).toBeGreaterThan(last);
      last = y;
    }
  });

  it('draws nothing away from the real arm', () => {
    const c = buildChain(input());
    const off = (origin: Pt, dir: Pt, t: number, s: number): Pt => [
      origin[0] + dir[0] * t - dir[1] * s,
      origin[1] + dir[1] * t + dir[0] * s,
    ];
    for (const t of [10, 40, 70]) {
      expect(stickerMask(c, 'fore', off(c.target.e, c.dirT[1], t, 0))).toBe(1);
      expect(stickerMask(c, 'fore', off(c.target.e, c.dirT[1], t, c.foreR + 1))).toBe(0);
      expect(stickerMask(c, 'upper', off(c.target.s, c.dirT[0], t, 0))).toBe(1);
      expect(stickerMask(c, 'upper', off(c.target.s, c.dirT[0], t, -c.upperR - 1))).toBe(0);
    }
    // The round ends: a ball at the elbow, nothing beyond it.
    expect(stickerMask(c, 'upper', off(c.target.e, c.dirT[0], c.elbowR * 0.5, 0))).toBe(1);
    expect(stickerMask(c, 'upper', off(c.target.e, c.dirT[0], c.elbowR + 1, 0))).toBe(0);
    expect(stickerMask(c, 'cap', [c.target.s[0], c.target.s[1] - c.capR - 1])).toBe(0);
    // The cap keeps the sleeve head, not the arm below the joint.
    expect(stickerMask(c, 'cap', [c.target.s[0], c.target.s[1] - 10])).toBe(1);
    expect(stickerMask(c, 'cap', [c.target.s[0], c.target.s[1] + c.capStub + 1])).toBe(0);
  });

  it('ends the sleeve at the wrist with the jacket overhang, never over the knuckles', () => {
    const past = (c: ReturnType<typeof buildChain>, d: number): Pt => [
      c.target.w[0] + c.dirT[1][0] * d,
      c.target.w[1] + c.dirT[1][1] * d,
    ];
    // Overhang 12 px (+ the pad), hand 40 px: the cuff ends 14 px past the wrist.
    const c = buildChain(input());
    expect(c.cuff).toBeCloseTo(12 + SLEEVE.bandPadPx, 6);
    expect(stickerMask(c, 'fore', past(c, c.cuff - 3))).toBe(1);
    expect(stickerMask(c, 'fore', past(c, c.cuff + 0.1))).toBe(0);
    // A sleeve far too long for the arm stops before the knuckles.
    const long = buildChain(input({ extents: { ...extents, cuffPast: 60 } }));
    expect(long.cuff).toBeCloseTo(SLEEVE.cuffOfHand * 40, 6);
    expect(stickerMask(long, 'fore', past(long, 40))).toBe(0);
    // Hand not seen: a share of the forearm instead.
    const blind = buildChain(input({ extents: { ...extents, cuffPast: 60 }, handLen: null }));
    expect(blind.cuff).toBeCloseTo(SLEEVE.cuffOfForearm * blind.lenT[1], 6);
    // A sleeve that ends short of the wrist stays short (scaled with the forearm).
    const short = buildChain(input({ extents: { ...extents, cuffPast: -18 } }));
    expect(short.cuff).toBeLessThan(0);
    expect(stickerMask(short, 'fore', past(short, -1))).toBe(0);
    expect(cuffClip(-18, 40, 90)).toBe(-18);
  });

  it('lets a joint without a landmark keep its rendered place on its parent', () => {
    // No wrist: the forearm turns with the upper arm (the rendered elbow angle is kept).
    const c = buildChain(input({ wrist: null }));
    const angle = (a: Pt, b: Pt) =>
      Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    expect(angle(c.dirT[0], c.dirT[1])).toBeCloseTo(angle(c.dirS[0], c.dirS[1]), 6);
    expect(c.lenT[1]).toBeCloseTo(c.lenS[1], 6);
    // No elbow either: the arm stays where the torso warp carries it.
    const k = buildChain(input({ elbow: null, wrist: null }));
    close(k.target.e, [310, 204]);
    close(k.target.w, [310, 294]);
    expect(k.pinned).toEqual({ elbow: 0, wrist: 0 });
  });

  it('blends a landmark in by its weight', () => {
    const c = buildChain(input({ wristWeight: 0.5 }));
    const free = buildChain(input({ wrist: null }));
    close(c.target.w, [(240 + free.target.w[0]) / 2, (190 + free.target.w[1]) / 2]);
  });

  it('follows the torso warp at the armhole and rejects a broken Jacobian', () => {
    // The torso warp turns 90° at the shoulder: the cap turns with it.
    const turned = buildChain(input({ jacobian: [0, -1, 1, 0] }));
    close(stickerSource(turned, 'cap', [turned.target.s[0], turned.target.s[1] + 10]), [310, 100]);
    const broken = buildChain(input({ jacobian: [0, 0, 0, 0] }));
    expect(broken.rootInv.map((v) => v + 0)).toEqual([1, 0, 0, 1]);
    expect(broken.across).toBe(1);
  });

  it('survives a degenerate arm (a bone shorter than a pixel)', () => {
    const c = buildChain(
      input({ source: { s: [300, 100], e: [300, 100.2], w: [300, 100.4] }, elbow: [310, 104] }),
    );
    for (const v of [...c.dirS, ...c.dirT].flat()) expect(Number.isFinite(v)).toBe(true);
    for (const part of ['cap', 'upper', 'fore'] as const)
      for (const v of stickerSource(c, part, [320, 150])) expect(Number.isFinite(v)).toBe(true);
  });

  it('bounds what a piece can touch', () => {
    const c = buildChain(input());
    const box = itemBox(c, 'fore', 2);
    expect(box.min[0]).toBeLessThan(c.target.w[0] - c.foreR);
    expect(box.max[0]).toBeGreaterThan(c.target.e[0] + c.foreR);
    const all = itemBox(c, 'all', 0);
    expect(all.min[1]).toBeLessThanOrEqual(c.target.s[1] - c.capR);
  });
});

describe('landmark pin', () => {
  it('follows a visible landmark at once on the first frame, then blends', () => {
    const p = new PinBlend();
    expect(p.update(0.9, true, 0)).toBe(1);
    // Dropped for one frame: the weight eases, it does not jump to 0.
    const w = p.update(0.05, true, 33);
    expect(w).toBeGreaterThan(0.7);
    expect(w).toBeLessThan(1);
    expect(p.update(0.9, true, 66)).toBe(1);
  });

  it('has hysteresis on the visibility and lets go outside the frame', () => {
    const p = new PinBlend();
    p.update(0.9, true, 0);
    // Between the thresholds: still pinned.
    for (let t = 33; t < 400; t += 33) expect(p.update(0.3, true, t)).toBe(1);
    for (let t = 400; t < 800; t += 33) p.update(0.9, false, t);
    expect(p.weight).toBe(0);
    // Between the thresholds from below: still free.
    for (let t = 800; t < 1200; t += 33) expect(p.update(0.3, true, t)).toBe(0);
  });
});

describe('vertex sampling', () => {
  it('takes distinct ids, evenly, up to the cap', () => {
    expect(Array.from(sampleIds([5, 1, 5, 3, 1, 9], 10))).toEqual([1, 3, 5, 9]);
    const many = sampleIds(
      Array.from({ length: 3000 }, (_, i) => i % 1000),
      100,
    );
    expect(many.length).toBe(100);
    expect(new Set(many).size).toBe(100);
    expect(many[99]).toBeGreaterThan(900);
  });
});

describe('sleeve outside', () => {
  // A tube round the y axis (the arm runs down it), 12 segments × 6 rings, wound either way.
  const tubeMesh = (flip: boolean) => {
    const positions: [number, number, number][] = [];
    const index: number[] = [];
    const N = 12,
      R = 6;
    for (let r = 0; r <= R; r++)
      for (let k = 0; k < N; k++) {
        const a = (k / N) * 2 * Math.PI;
        positions.push([0.08 * Math.cos(a), -0.1 * r, 0.08 * Math.sin(a)]);
      }
    for (let r = 0; r < R; r++)
      for (let k = 0; k < N; k++) {
        const a = r * N + k,
          b = r * N + ((k + 1) % N),
          c = a + N,
          d = b + N;
        if (flip) index.push(a, c, b, b, c, d);
        else index.push(a, b, c, b, d, c);
      }
    return { positions, index };
  };
  const bones: [[number, number, number], [number, number, number], [number, number, number]] = [
    [0, 0, 0],
    [0, -0.3, 0],
    [0, -0.6, 0],
  ];

  it('finds which winding faces out of the sleeve, either way round', () => {
    const one = tubeMesh(false),
      other = tubeMesh(true);
    const a = outsideWinding((i) => one.positions[i], one.index, bones),
      b = outsideWinding((i) => other.positions[i], other.index, bones);
    expect(Math.abs(a)).toBe(1);
    expect(b).toBe(-a);
    // The winding found is the one whose normal points away from the arm.
    const [i0, i1, i2] = one.index;
    const [p, q, r] = [one.positions[i0], one.positions[i1], one.positions[i2]];
    const n = [
      (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]),
      0,
      (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]),
    ];
    expect(Math.sign(n[0] * p[0] + n[2] * p[2])).toBe(a);
  });

  it('winds every triangle the same way round, a patch wound the other way included', () => {
    const mesh = tubeMesh(false);
    // Turn every third triangle the other way (a panel sewn in with the opposite winding).
    const mixed = [...mesh.index];
    let flipped = 0;
    for (let t = 0; t < mixed.length; t += 9) {
      [mixed[t + 1], mixed[t + 2]] = [mixed[t + 2], mixed[t + 1]];
      flipped++;
    }
    const sign = outsideWinding((i) => mesh.positions[i], mesh.index, bones);
    const u = unifyWinding((i) => mesh.positions[i], mixed, bones);
    // The clean mesh is all one way: either none or all of its triangles need turning; the
    // mixed one differs from it by exactly the patch.
    expect(unifyWinding((i) => mesh.positions[i], mesh.index, bones).turned).toBe(
      sign === 1 ? 0 : mesh.index.length / 3,
    );
    expect(u.turned).toBe(sign === 1 ? flipped : mesh.index.length / 3 - flipped);
    expect(outsideWinding((i) => mesh.positions[i], u.index, bones)).toBe(1);
    // Same triangles, only their order of vertices changed.
    for (let t = 0; t < mixed.length; t += 3)
      expect([...u.index.subarray(t, t + 3)].sort()).toEqual(mixed.slice(t, t + 3).sort());
  });

  it('does not guess from too few triangles', () => {
    expect(outsideWinding(() => [0, 0, 0], [0, 1, 2], bones)).toBe(0);
  });
});

describe('real hands past the cuff', () => {
  /** 33 landmarks with one left hand: wrist (240, 190), knuckles 20 px further along −x. */
  const withHand = (visibility = 0.95, thumb = 0.95) => {
    const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
    l[13] = { x: 330, y: 205, visibility: 0.95 };
    l[15] = { x: 240, y: 190, visibility };
    l[17] = { x: 220, y: 200, visibility };
    l[19] = { x: 220, y: 180, visibility };
    l[21] = { x: 232, y: 176, visibility: thumb };
    return l;
  };

  it('shapes the hand from the pose points and cuts it at the cuff of the pieces', () => {
    const c = buildChain(input());
    const h = handShape(withHand(), 'L', c)!;
    expect(h.a).toEqual([240, 190]);
    // Knuckles 20 px from the wrist, reach 2.1; spread 20 px, radius 0.75 of it.
    close(h.b, [240 - 42, 190]);
    expect(h.radius).toBeCloseTo(15, 6);
    close(h.thumb!, [240 - 8 * SLEEVE.thumbReach, 190 - 14 * SLEEVE.thumbReach]);
    expect(h.thumbRadius).toBeCloseTo(SLEEVE.thumbRadius * 15, 6);
    // The cuff line: the sleeve's end past the real wrist, across the real forearm.
    close(h.cuffAt, [c.target.w[0] + c.dirT[1][0] * c.cuff, c.target.w[1] + c.dirT[1][1] * c.cuff]);
    expect(h.cuffDir).toEqual(c.dirT[1]);
  });

  it('cuts at the wrist across the forearm without pieces, and needs a seen hand', () => {
    const h = handShape(withHand(0.95, 0.1), 'L', null)!;
    expect(h.thumb).toBeNull();
    expect(h.cuffAt).toEqual([240, 190]);
    // Elbow (330, 205) → wrist (240, 190).
    expect(h.cuffDir[0]).toBeCloseTo(-90 / Math.hypot(90, 15), 6);
    expect(handShape(withHand(0.3), 'L', null)).toBeNull();
    expect(handShape(withHand(), 'R', null)).toBeNull();
  });

  it('tells skin from cloth by chroma', () => {
    for (const skin of [
      [0.87, 0.67, 0.56],
      [0.7, 0.5, 0.38],
      [0.36, 0.24, 0.18],
      [0.98, 0.85, 0.75],
    ])
      expect(skinLikelihood(skin[0], skin[1], skin[2])).toBeGreaterThan(0.9);
    // White, grey and black cloth, blue denim. (Beige or tan cloth does read as skin: the test
    // only ever runs inside the hand's shape.)
    for (const cloth of [
      [0.95, 0.95, 0.97],
      [0.5, 0.5, 0.52],
      [0.08, 0.08, 0.1],
      [0.6, 0.75, 0.85],
    ])
      expect(skinLikelihood(cloth[0], cloth[1], cloth[2])).toBeLessThan(0.1);
  });

  it('matches skin to the face of the same frame, pale over-exposed skin included', () => {
    const face = [0.85, 0.68, 0.58];
    // The same skin, the venue's almost white forearm, skin in shadow.
    for (const skin of [face, [0.97, 0.93, 0.9], [0.45, 0.33, 0.27]])
      expect(skinLike(skin, face)).toBeGreaterThan(0.9);
    // Black hoodie, mid and light grey, blue denim, a saturated red.
    for (const cloth of [
      [0.08, 0.08, 0.1],
      [0.5, 0.5, 0.52],
      [0.75, 0.75, 0.77],
      [0.6, 0.75, 0.85],
      [0.9, 0.15, 0.1],
    ])
      expect(skinLike(cloth, face)).toBeLessThan(0.1);
    // The stated limit: anything blown out to white passes (over-exposed skin is).
    expect(skinLike([1, 1, 1], face)).toBeGreaterThan(0.9);
  });

  it('takes the cheeks and the nose of a seen face as the reference', () => {
    const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0.9 }));
    l[0] = { x: 100, y: 100, visibility: 0.9 };
    l[2] = { x: 110, y: 90, visibility: 0.9 };
    l[9] = { x: 108, y: 112, visibility: 0.9 };
    l[5] = { x: 90, y: 90, visibility: 0.9 };
    l[10] = { x: 92, y: 112, visibility: 0.9 };
    expect(facePoints(l)).toEqual([
      [100, 100],
      [109, 101],
      [91, 101],
    ]);
    l[5] = { ...l[5], visibility: 0.2 };
    expect(facePoints(l)).toBeNull();
  });

  it('holds a hand over a short dropout, fading, then lets go', () => {
    const hold = new HandHold();
    const h = handShape(withHand(), 'L', null)!;
    expect(hold.update(null, 0)).toBeNull();
    expect(hold.update(h, 33)).toEqual({ shape: h, alpha: 1 });
    const faded = hold.update(null, 33 + SLEEVE.handHoldMs / 2)!;
    expect(faded.shape).toBe(h);
    expect(faded.alpha).toBeCloseTo(0.5, 6);
    expect(hold.update(null, 33 + SLEEVE.handHoldMs)).toBeNull();
    expect(hold.update(null, 40 + SLEEVE.handHoldMs)).toBeNull();
  });
});

describe('the cuff closes round the wrist', () => {
  // A straight sleeve at rest: a tube of radius 8 cm round the −y axis, 0.6 m long, rings every
  // 2 cm, 12 vertices per ring; the cuff landmark on the last ring.
  const N = 12,
    RINGS = 31;
  const rest: number[] = [];
  const index: number[] = [];
  for (let r = 0; r < RINGS; r++)
    for (let k = 0; k < N; k++) {
      const a = (k / N) * 2 * Math.PI;
      rest.push(0.08 * Math.cos(a), -0.02 * r, 0.08 * Math.sin(a));
    }
  for (let r = 0; r < RINGS - 1; r++)
    for (let k = 0; k < N; k++) {
      const a = r * N + k,
        b = r * N + ((k + 1) % N);
      index.push(a, b, a + N, b, b + N, a + N);
    }
  const landmark = (RINGS - 1) * N + 3;
  const band = cuffBand(index, rest, landmark, CUFF.lengthM)!;
  const ringOf = (id: number) => Math.floor(id / N);

  it('finds the band at rest: the last 7 cm of the sleeve, weighted toward its end', () => {
    // Rings 27 to 30 lie within 7 cm of the end (ring 27 is 6 cm from it).
    const rings = [...new Set(Array.from(band.ids, ringOf))];
    expect(Math.min(...rings)).toBe(27);
    expect(Math.max(...rings)).toBe(30);
    const w = (ring: number) =>
      band.weight[Array.from(band.ids).findIndex((i) => ringOf(i) === ring)];
    expect(w(30)).toBeGreaterThan(0.9);
    expect(w(27)).toBeGreaterThan(0);
    expect(w(27)).toBeLessThan(w(29));
    expect(cuffBand(index, rest, 9999, CUFF.lengthM)).toBeNull();
  });

  it('gathers the sleeve end to the wrist radius and can put the cloth back', () => {
    const positions = Float32Array.from(rest);
    const saved = closeCuff(positions, band, [0, -0.3, 0], [0, -0.58, 0], CUFF.radiusM)!;
    const radius = (id: number) => Math.hypot(positions[id * 3], positions[id * 3 + 2]);
    // The end ring sits at the wrist radius; the band narrows toward it; the rest is untouched.
    // (to within half a millimetre: the rest axis is estimated).
    expect(radius(30 * N)).toBeCloseTo(CUFF.radiusM, 3);
    expect(radius(28 * N)).toBeLessThan(0.08);
    expect(radius(28 * N)).toBeGreaterThan(radius(29 * N));
    expect(radius(26 * N)).toBeCloseTo(0.08, 6);
    // Along the forearm nothing moved.
    expect(positions[30 * N * 3 + 1]).toBeCloseTo(-0.6, 6);
    band.ids.forEach((id, k) => positions.set(saved.subarray(k * 3, k * 3 + 3), id * 3));
    expect(Array.from(positions)).toEqual(Array.from(Float32Array.from(rest)));
  });

  it('finds the sleeve head at the other end, for the armhole plug', () => {
    const head = headTriangles(index, rest, landmark, HEAD_LENGTH_M)!;
    const rings = [...new Set(Array.from(head, ringOf))];
    // The first 12 cm from the armhole end: rings 0 to 5 (ring 6 lies exactly 12 cm in).
    expect(Math.min(...rings)).toBe(0);
    expect(Math.max(...rings)).toBeLessThanOrEqual(6);
    expect(Math.max(...rings)).toBeGreaterThanOrEqual(4);
    expect(head.length % 3).toBe(0);
    expect(headTriangles(index, rest, 9999, HEAD_LENGTH_M)).toBeNull();
  });

  it('tucks the head rim under the sleeve: its end narrows round the upper arm', () => {
    const rim = headRim(index, rest, landmark, HEAD_LENGTH_M, HEAD_TUCK.lengthM)!;
    // The rim: from 8 cm down the sleeve to just past the head's end (rings 4 to 7 or so).
    const rings = [...new Set(Array.from(rim.ids, ringOf))];
    expect(Math.min(...rings)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...rings)).toBeLessThanOrEqual(8);
    const positions = Float32Array.from(rest);
    // The posed upper arm runs down the tube's axis.
    const saved = closeCuff(positions, rim, [0, 0, 0], [0, -0.3, 0], HEAD_TUCK.radiusM)!;
    expect(saved).not.toBeNull();
    const radius = (id: number) => Math.hypot(positions[id * 3], positions[id * 3 + 2]);
    // Above the rim the head keeps its width; at the head's end it is well inside the sleeve.
    expect(radius(2 * N)).toBeCloseTo(0.08, 6);
    expect(radius(6 * N)).toBeLessThan(0.065);
    expect(radius(6 * N)).toBeGreaterThanOrEqual(HEAD_TUCK.radiusM - 1e-6);
  });

  it('keeps only the head triangles seen from outside', () => {
    const head = headTriangles(index, rest, landmark, HEAD_LENGTH_M)!;
    const out = new Uint32Array(head.length);
    // The tube is wound a, b, a+N: find which winding is its outside with one triangle…
    const [i0, i1, i2] = [head[0], head[1], head[2]];
    const p = (i: number) => [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]];
    const [a, b, c] = [p(i0), p(i1), p(i2)];
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const winding = nx * a[0] + nz * a[2] > 0 ? 1 : -1;
    // …then from an eye far out along +x about half the tube faces it, and none from inside.
    const n = facingTriangles(head, rest, [5, -0.05, 0], winding, out);
    expect(n).toBeGreaterThan(head.length * 0.3);
    expect(n).toBeLessThan(head.length * 0.7);
    for (let t = 0; t < n; t += 3) expect(rest[out[t] * 3]).toBeGreaterThan(-0.05);
    expect(facingTriangles(head, rest, [0, -0.05, 0], winding, out)).toBe(0);
  });

  it('never pushes cloth outward and survives a degenerate forearm', () => {
    const thin = Float32Array.from(rest, (v, i) => (i % 3 === 1 ? v : v * 0.25));
    expect(closeCuff(thin, band, [0, -0.3, 0], [0, -0.58, 0], CUFF.radiusM)).toBeNull();
    expect(closeCuff(Float32Array.from(rest), band, [0, 0, 0], [0, 0, 0], CUFF.radiusM)).toBeNull();
  });
});

describe('web triangles', () => {
  // Two triangles sharing an edge: vertices 0,1,2 and 1,3,2 (unit right triangles at rest).
  const index = [0, 1, 2, 1, 3, 2];
  const rest = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];

  it('keeps cloth that moved or stretched a little', () => {
    const restSq = restEdges(index, rest);
    expect(Array.from(restSq)).toEqual([1, 2, 1, 1, 1, 2]);
    const out = new Uint32Array(index.length);
    // Rigidly moved and stretched by 30 %.
    const moved = rest.map((v, i) => v * 1.3 + (i % 3 === 2 ? 5 : 0));
    expect(unstretched(index, restSq, moved, SLEEVE.webStretch, out)).toBe(6);
    expect(Array.from(out)).toEqual(index);
  });

  it('leaves out a triangle pulled into a web', () => {
    const restSq = restEdges(index, rest);
    const out = new Uint32Array(index.length);
    // Vertex 3 dragged 4 units away: the second triangle is a web, the first is untouched.
    const pulled = [...rest];
    pulled[9] = 5;
    expect(unstretched(index, restSq, pulled, SLEEVE.webStretch, out)).toBe(3);
    expect(Array.from(out.subarray(0, 3))).toEqual([0, 1, 2]);
  });

  it('keeps a triangle whose rest edge is degenerate', () => {
    const flat = [0, 0, 0, 0, 0, 0, 0, 1, 0];
    const out = new Uint32Array(3);
    expect(
      unstretched([0, 1, 2], restEdges([0, 1, 2], flat), [0, 0, 0, 0.5, 0, 0, 0, 1, 0], 1.8, out),
    ).toBe(3);
  });
});

describe('a bone that points at the lens', () => {
  // The real upper arm is half as long as the rendered one (elbow pushed toward the camera),
  // the real forearm 60 % of the rendered one.
  const c = buildChain(input({ elbow: [310, 154], wrist: [310, 208] }));

  it('keeps the far joint and the render scale, and hides the near part', () => {
    expect(c.lenT[0]).toBeCloseTo(50, 6);
    expect(c.lenT[1]).toBeCloseTo(54, 6);
    // Elbow of the upper arm and wrist of the forearm land on the rendered ones.
    close(stickerSource(c, 'upper', c.target.e), hanging.e);
    close(stickerSource(c, 'fore', c.target.w), hanging.w);
    // No squeeze of the forearm: 10 px up the real bone is 10 px up the rendered one, and the
    // elbow shows the middle of the rendered forearm (its start is hidden at the elbow).
    close(stickerSource(c, 'fore', [310, 198]), [300, 280]);
    close(stickerSource(c, 'fore', c.target.e), [300, 236]);
  });
});

describe('the upper arm bends from the armhole to the elbow', () => {
  it('keeps the armhole map at the shoulder and the bone at the elbow, monotonically', () => {
    // Real upper arm turned 90° from the rendered one (pointing along +x), same length.
    const c = buildChain(input({ elbow: [410, 104], wrist: [410, 194] }));
    // At and behind the shoulder: the cap's map (no turn).
    close(stickerSource(c, 'upper', c.target.s), hanging.s);
    close(stickerSource(c, 'upper', [305, 99]), stickerSource(c, 'cap', [305, 99]));
    // At the elbow and past it: the bone's map (fully turned).
    close(stickerSource(c, 'upper', c.target.e), hanging.e);
    close(stickerSource(c, 'upper', [420, 104]), [300, 210]);
    // Walking down the real bone walks down the rendered sleeve, without going back.
    let last = -Infinity;
    for (let t = 0; t <= 100; t += 5) {
      const src = stickerSource(c, 'upper', [310 + t, 104]);
      const down = src[1] - hanging.s[1];
      expect(down).toBeGreaterThanOrEqual(last);
      last = down;
    }
  });

  it('is drawn behind the shoulder joint too (the same cloth as the cap there)', () => {
    const c = buildChain(input());
    expect(stickerMask(c, 'upper', [c.target.s[0], c.target.s[1] - 0.5 * c.upperR])).toBe(1);
  });
});
