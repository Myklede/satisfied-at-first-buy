import { describe, expect, it } from 'vitest';
import { ClothSolver, type BodyCollider, type ClothAsset } from './ClothSolver';
import { GridSdfCollider } from './collider';

// Synthetic cloth only (no body or garment data). Small-steps settings mirror
// services/body/body_service/config.py SHELL_CLOTH_CONFIG; material values are uncalibrated.
const SHELL = {
  smallSteps: 1,
  substeps: 10,
  iterations: 1,
  oneWayTethers: 1,
  supportCompliance: 0.3,
  hingeCompliance: 1e-3,
  dampingPerSecond: 3,
  guides: 0,
  selfEvery: 4,
};

type Grid = { asset: ClothAsset; index: (i: number, j: number) => number };

/** cols × rows sheet with spacing d; `place(i, j)` gives the initial (= rest) position. */
function sheet(
  cols: number,
  rows: number,
  place: (i: number, j: number) => [number, number, number],
  config: Record<string, number>,
  roots: (i: number, j: number) => boolean,
): Grid {
  const index = (i: number, j: number) => j * cols + i;
  const rest: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) rest.push(...place(i, j));
  const triangles: number[] = [];
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < cols - 1; i++) {
      const a = index(i, j),
        b = index(i + 1, j),
        c = index(i + 1, j + 1),
        d = index(i, j + 1);
      triangles.push(a, b, c, a, c, d);
    }
  // Rest geodesic to the nearest root (Dijkstra on mesh edges) = LRA tether lengths.
  const n = cols * rows,
    distance = new Float64Array(n).fill(Infinity),
    nearest = new Int32Array(n).fill(-1),
    done = new Uint8Array(n),
    neighbours: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k],
        b = triangles[t + ((k + 1) % 3)];
      neighbours[a].push(b);
      neighbours[b].push(a);
    }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      if (roots(i, j)) {
        distance[index(i, j)] = 0;
        nearest[index(i, j)] = index(i, j);
      }
  for (;;) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!done[v] && (u < 0 || distance[v] < distance[u])) u = v;
    if (u < 0 || !Number.isFinite(distance[u])) break;
    done[u] = 1;
    for (const v of neighbours[u]) {
      const length = Math.hypot(
        rest[u * 3] - rest[v * 3],
        rest[u * 3 + 1] - rest[v * 3 + 1],
        rest[u * 3 + 2] - rest[v * 3 + 2],
      );
      if (distance[u] + length < distance[v]) {
        distance[v] = distance[u] + length;
        nearest[v] = nearest[u];
      }
    }
  }
  const tethers: number[] = [],
    tetherLengths: number[] = [];
  for (let v = 0; v < n; v++)
    if (distance[v] > 0 && Number.isFinite(distance[v])) {
      tethers.push(nearest[v], v);
      tetherLengths.push(distance[v]);
    }
  const zeros = new Array<number>(n).fill(0);
  return {
    index,
    asset: {
      key: 'synthetic-sheet',
      pose: 'test',
      fabric_surface: 'neutral',
      maximum_loft_m: 0,
      rest,
      initial: rest.slice(),
      triangles,
      panels: zeros.slice(),
      elastic: zeros.slice(),
      stitch: zeros.slice(),
      loft: zeros.slice(),
      welds: [],
      tethers,
      tether_lengths: tetherLengths,
      paths: {},
      landmarks: {},
      body_landmarks: {},
      body_positions: [],
      body_triangles: [],
      sdf: {
        distance_bias_m: 0,
        origin: [-5, -5, -5],
        dimensions: [2, 2, 2],
        spacing: 10,
        sdf_id: '0'.repeat(64),
        byte_length: 32,
      },
      config: {
        dt: 1 / 60,
        substeps: 2,
        iterations: 1,
        gravity: -9.81,
        damping: 0.985,
        stretchCompliance: 1e-8,
        bendCompliance: 2e-4,
        seamBendCompliance: 2e-2,
        elasticCompliance: 2e-5,
        stretchMax: 1.03,
        friction: 0.35,
        collisionMargin: 0.002,
        selfRadius: 0.001,
        kineticEpsilon: 1e-5,
        maxSeconds: 1.5,
        particleMass: 0.0001,
        bendMaxCorrection: 0.003,
        bendRestEdgeFraction: 0.25,
        velocityLimit: 2,
        collarCompression: 0.9,
        selfEvery: 2,
        surfaceContactPasses: 6,
        surfaceCorrectionLimit: 0.02,
        strainPolishPasses: 24,
        loftMinimumRatio: 0.25,
        loftCompliance: 0.3,
        ringCorrectionLimit: 0.002,
        hardRingContactIterations: 3,
        ...config,
      },
      rest_measurements_cm: {},
      colour: '#ffffff',
      finish: 'satin_matte',
      layer_m: 0.003,
      stretch_max_source: 'synthetic test',
      build_ms: 0,
    },
  };
}

/** Far-away empty grid: the analytic collider set below replaces it. */
const emptyField = () => new Float32Array(8).fill(10);

/** Horizontal bar along X: a cylinder of radius r around the line y = cy, z = 0. */
function bar(r: number, cy: number): BodyCollider {
  return {
    distance(_x, y, z, gradient) {
      const dy = y - cy,
        length = Math.hypot(dy, z) || 1e-12;
      if (gradient) {
        gradient[0] = 0;
        gradient[1] = dy / length;
        gradient[2] = z / length;
      }
      return length - r;
    },
  };
}

/** Max edge length / rest; with `from`, only edges farther than `beyond` from that particle. */
function maxEdgeRatio(s: ClothSolver, at?: Float64Array, from = -1, beyond = 0) {
  let worst = 0;
  for (let e = 0; e < s.restLengths.length; e++) {
    const a = s.edges[e * 2] * 3,
      b = s.edges[e * 2 + 1] * 3,
      p = s.positions;
    if (
      at &&
      Math.hypot(at[a] - at[from * 3], at[a + 1] - at[from * 3 + 1], at[a + 2] - at[from * 3 + 2]) <
        beyond
    )
      continue;
    worst = Math.max(
      worst,
      Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / s.restLengths[e],
    );
  }
  return worst;
}

/** 0.9 m × 0.12 m strip (60 rows at 1.5 cm) hanging from its top row. */
function hangingStrip(config: Record<string, number>, tethers = true) {
  const grid = sheet(
    9,
    61,
    (i, j) => [i * 0.015, 1.5 - j * 0.015, 0],
    config,
    (_i, j) => j === 0,
  );
  if (!tethers) {
    grid.asset.tethers = [];
    grid.asset.tether_lengths = [];
  }
  const s = new ClothSolver(grid.asset, emptyField());
  const top = Array.from({ length: 9 }, (_, i) => grid.index(i, 0));
  s.grab(
    top,
    top.flatMap((id) => [s.positions[id * 3], s.positions[id * 3 + 1], s.positions[id * 3 + 2]]),
  );
  return s;
}

describe('small-steps XPBD cloth (shell relax)', () => {
  it('root cause: one sweep over 2 substeps lets a 60-row hanging chain stretch far past 10 %', () => {
    // Stretch edges only (no long-range support), as the shell's yoke/torso chain was.
    const legacy = hangingStrip({}, false);
    for (let f = 0; f < 60; f++) legacy.step();
    expect(maxEdgeRatio(legacy)).toBeGreaterThan(1.5);
  });

  it('holds the same strip within the 10 % gate and converges below the kinetic epsilon', () => {
    const s = hangingStrip(SHELL);
    for (let f = 0; f < 90; f++) s.step();
    expect(maxEdgeRatio(s)).toBeLessThanOrEqual(1.1);
    expect(s.energy).toBeLessThan(1e-5);
    expect(s.positions.every(Number.isFinite)).toBe(true);
  });

  it('drapes a sheet over a bar: supported by contact, no penetration, settles, deterministic', () => {
    const r = 0.05,
      run = () => {
        // 30 × 0.6 m sheet laid over the top of the bar along Z, rest = initial (zero strain).
        const grid = sheet(
          9,
          41,
          (i, j) => {
            const arc = (j - 20) * 0.015,
              theta = arc / (r + 0.006);
            if (Math.abs(theta) <= Math.PI / 2)
              return [i * 0.015, 1 + (r + 0.006) * Math.cos(theta), (r + 0.006) * Math.sin(theta)];
            const down = Math.abs(arc) - ((r + 0.006) * Math.PI) / 2;
            return [i * 0.015, 1 - down, Math.sign(arc) * (r + 0.006)];
          },
          SHELL,
          (_i, j) => j === 20,
        );
        const s = new ClothSolver(grid.asset, emptyField());
        s.setCollider(bar(r, 1));
        const start = s.positions.slice();
        for (let f = 0; f < 90; f++) s.step();
        return { s, start, grid };
      };
    const { s, start, grid } = run();
    const g = new Float64Array(3);
    let inside = 0,
      drop = 0;
    for (let i = 0; i < s.positions.length; i += 3) {
      if (s.collider.distance(s.positions[i], s.positions[i + 1], s.positions[i + 2], g) < 0)
        inside++;
      drop = Math.max(drop, start[i + 1] - s.positions[i + 1]);
    }
    expect(inside).toBe(0);
    expect(drop).toBeLessThan(0.02);
    expect(maxEdgeRatio(s)).toBeLessThanOrEqual(1.1);
    expect(s.energy).toBeLessThan(1e-5);
    const topId = grid.index(4, 20);
    expect(s.positions[topId * 3 + 1]).toBeGreaterThan(1 + r);
    expect(run().s.positions).toEqual(s.positions);
  });

  it('grab: a 2–3 cm patch pulled 10 cm stretches locally, never explodes, springs back', () => {
    const s = hangingStrip(SHELL);
    for (let f = 0; f < 90; f++) s.step();
    const rest = s.positions.slice();
    // Patch: particles within 2.5 cm of the middle of the strip.
    const centre = 4 + 30 * 9,
      ids: number[] = [];
    for (let i = 0; i < s.positions.length / 3; i++)
      if (
        Math.hypot(
          rest[i * 3] - rest[centre * 3],
          rest[i * 3 + 1] - rest[centre * 3 + 1],
          rest[i * 3 + 2] - rest[centre * 3 + 2],
        ) < 0.025
      )
        ids.push(i);
    const pinned = Array.from(s['grabIds'] as Int32Array);
    const pinTargets = pinned.flatMap((id) => [rest[id * 3], rest[id * 3 + 1], rest[id * 3 + 2]]);
    let worst = 0,
      far = 0;
    for (let f = 1; f <= 60; f++) {
      const t = Math.min(1, f / 30) * 0.1;
      s.move(
        [...pinned, ...ids],
        [
          ...pinTargets,
          ...ids.flatMap((id) => [rest[id * 3], rest[id * 3 + 1], rest[id * 3 + 2] + t]),
        ],
      );
      s.step();
      worst = Math.max(worst, maxEdgeRatio(s));
      far = Math.max(far, maxEdgeRatio(s, rest, centre, 0.15));
      expect(s.positions.every(Number.isFinite)).toBe(true);
    }
    const reached =
      ids.reduce((sum, id) => sum + s.positions[id * 3 + 2] - rest[id * 3 + 2], 0) / ids.length;
    expect(reached).toBeGreaterThan(0.08);
    // Measured: the edges at the patch border reach ~1.1 (shell: 1.33–1.47); M4 clamps the
    // target (prompts/05). Away from the hand the 10 % gate holds; nothing explodes.
    expect(worst).toBeLessThan(1.5);
    expect(far).toBeLessThanOrEqual(1.1);
    s.release();
    s.grab(pinned, pinTargets);
    for (let f = 0; f < 120; f++) s.step();
    const back = Math.max(...ids.map((id) => Math.abs(s.positions[id * 3 + 2] - rest[id * 3 + 2])));
    expect(back).toBeLessThan(0.01);
  });

  it('accepts any collider: the grid SDF and an equivalent analytic collider give the same contact', () => {
    // Plane y = 1 as a 4×4×4 grid (spacing 0.1) and analytically.
    const values = new Float32Array(64);
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++)
        for (let z = 0; z < 4; z++) values[(x * 4 + y) * 4 + z] = y * 0.1 - 0.15;
    const grid = new GridSdfCollider(values, {
      origin: [0, 0.85, 0],
      dimensions: [4, 4, 4],
      spacing: 0.1,
    });
    const plane: BodyCollider = {
      distance(_x, y, _z, gradient) {
        if (gradient) gradient.set([0, 1, 0]);
        return y - 1;
      },
    };
    const g = new Float64Array(3);
    expect(grid.distance(0.12, 1.03, 0.2, g)).toBeCloseTo(plane.distance(0.12, 1.03, 0.2), 6);
    expect(g[1]).toBeCloseTo(1, 6);
    const drop = (collider: BodyCollider) => {
      const sheetGrid = sheet(
        5,
        5,
        (i, j) => [0.05 + i * 0.015, 1.02, 0.05 + j * 0.015],
        SHELL,
        () => false,
      );
      const s = new ClothSolver(sheetGrid.asset, emptyField());
      s.setCollider(collider);
      for (let f = 0; f < 60; f++) s.step();
      return s.positions;
    };
    const a = drop(grid),
      b = drop(plane);
    for (let i = 1; i < a.length; i += 3) {
      expect(a[i]).toBeGreaterThanOrEqual(1 + 0.003 + 0.002 - 1e-6);
      expect(a[i]).toBeCloseTo(b[i], 5);
    }
  });
});
