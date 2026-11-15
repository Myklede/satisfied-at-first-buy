import { describe, expect, it } from 'vitest';
import {
  ANATOMICAL_DOFS,
  AXIAL_MAX_CONFIDENCE,
  NeutralCalibrator,
  PL,
  POSE_LIMITS,
  TWIST_MAX_CONFIDENCE,
  UNCALIBRATED_CONFIDENCE,
  armAnglesFromLocal,
  estimateAnatomicalPose,
  forearmDirectionLocal,
  humerusDirectionLocal,
  neutralPose,
  wrapDeg,
  type AnatomicalDof,
  type AnatomicalPose,
  type NeutralCalibration,
  type PoseLandmarksInput,
  type Vec3,
} from './anatomicalPose';
import {
  DEFAULT_SEGMENTS,
  poseSkeleton,
  standingHipHeight,
  synthesizeLandmarks,
  type SynthOptions,
} from './poseSynth';

const pose = (p: Partial<AnatomicalPose>): AnatomicalPose => ({ ...neutralPose(), ...p });

/** Exact calibration for a synthetic camera setup (same as NeutralCalibrator on a still neutral). */
function calibrationFor(opts: SynthOptions = {}): NeutralCalibration {
  const cal = new NeutralCalibrator(1000);
  const input = synthesizeLandmarks(neutralPose(), opts);
  for (let t = 0; t <= 1000; t += 33) {
    const r = cal.update(t, input);
    if (r.done) return r.done;
  }
  const r = cal.update(1100, input);
  if (!r.done) throw new Error(`calibration did not finish: ${r.issues.join(',')}`);
  return r.done;
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uniform = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** Expected pelvis drop for synthetic legs, feet on the floor (lower ankle). */
function expectedDrop(p: AnatomicalPose): number {
  const sk = poseSkeleton(p);
  const h = Math.max(-sk.lAnkle[1], -sk.rAnkle[1]);
  return Math.min(0.6, Math.max(0, standingHipHeight(DEFAULT_SEGMENTS) - h));
}

function expectClose(
  actual: AnatomicalPose,
  expected: AnatomicalPose,
  dofs: AnatomicalDof[],
  tol = 0.5,
) {
  for (const d of dofs) {
    const t = d === 'pelvis_drop_m' ? 0.005 : tol;
    const diff = d === 'pelvis_drop_m' ? actual[d] - expected[d] : wrapDeg(actual[d] - expected[d]);
    expect(
      Math.abs(diff),
      `${d}: got ${actual[d].toFixed(2)}, want ${expected[d].toFixed(2)}`,
    ).toBeLessThan(t);
  }
}

describe('ISB humerus forward/inverse model', () => {
  it('plane 0 raises the arm sideways, plane 90 forward, elevation 180 overhead', () => {
    const side = humerusDirectionLocal(0, 90);
    expect(side[2]).toBeCloseTo(1); // lateral
    const fwd = humerusDirectionLocal(90, 90);
    expect(fwd[0]).toBeCloseTo(1); // forward
    expect(humerusDirectionLocal(37, 180)[1]).toBeCloseTo(1); // up
  });

  it('internal rotation swings a bent forearm medially', () => {
    const w = forearmDirectionLocal(0, 0, 60, 90);
    expect(w[2]).toBeLessThan(-0.8); // toward the midline (−z on the right arm)
  });

  it('inverts the forward model away from the gimbal', () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const plane = uniform(r, -80, 130);
      const elevation = uniform(r, 30, 150);
      const axial = uniform(r, -85, 85);
      const elbow = uniform(r, 50, 145);
      const a = armAnglesFromLocal(
        humerusDirectionLocal(plane, elevation),
        forearmDirectionLocal(plane, elevation, axial, elbow),
      );
      expect(a.plane).toBeCloseTo(plane, 6);
      expect(a.elevation).toBeCloseTo(elevation, 6);
      expect(a.axial).toBeCloseTo(axial, 6);
      expect(a.elbowFlexion).toBeCloseTo(elbow, 6);
    }
  });

  it('near elevation 0 the plane is held and axial absorbs the rotation (φ+ψ kept)', () => {
    // Arm hanging (elevation 1°), forearm bent 90° pointing 40° medial of forward.
    const d = humerusDirectionLocal(70, 1);
    const w = forearmDirectionLocal(0, 0, 40, 90);
    const a = armAnglesFromLocal(d, w, 10, 0);
    expect(a.planeDefined).toBe(0);
    expect(a.plane).toBeCloseTo(10, 6);
    // Composed orientation reproduces the forearm: Ry(φ+ψ) at θ≈0.
    expect(wrapDeg(a.plane + a.axial)).toBeCloseTo(40, 0);
  });
});

describe('estimateAnatomicalPose: each DOF in isolation (calibrated, facing the camera)', () => {
  const cal = calibrationFor();
  const cases: Array<[string, Partial<AnatomicalPose>, AnatomicalDof[]]> = [
    ['trunk flexion 40', { trunk_flexion: 40 }, ['trunk_flexion', 'trunk_lateral', 'trunk_twist']],
    ['trunk flexion 85', { trunk_flexion: 85 }, ['trunk_flexion', 'trunk_lateral']],
    ['trunk extension −15', { trunk_flexion: -15 }, ['trunk_flexion', 'trunk_lateral']],
    ['lean right 20', { trunk_lateral: 20 }, ['trunk_flexion', 'trunk_lateral', 'trunk_twist']],
    ['lean left −25', { trunk_lateral: -25 }, ['trunk_flexion', 'trunk_lateral']],
    ['twist left 30', { trunk_twist: 30 }, ['trunk_flexion', 'trunk_lateral', 'trunk_twist']],
    ['twist right −30', { trunk_twist: -30 }, ['trunk_twist']],
    [
      'R abduction 90',
      { shoulder_R_elevation: 90 },
      ['shoulder_R_plane', 'shoulder_R_elevation', 'elbow_R_flexion', 'shoulder_L_elevation'],
    ],
    [
      'L forward flexion 90',
      { shoulder_L_plane: 90, shoulder_L_elevation: 90 },
      ['shoulder_L_plane', 'shoulder_L_elevation', 'shoulder_R_elevation'],
    ],
    [
      'R overhead 170',
      { shoulder_R_plane: 30, shoulder_R_elevation: 170 },
      ['shoulder_R_elevation'],
    ],
    [
      'R arm across the chest (plane 130)',
      { shoulder_R_plane: 130, shoulder_R_elevation: 80 },
      ['shoulder_R_plane', 'shoulder_R_elevation'],
    ],
    [
      'L arm reaching back (plane −90)',
      { shoulder_L_plane: -90, shoulder_L_elevation: 40 },
      ['shoulder_L_plane', 'shoulder_L_elevation'],
    ],
    [
      'R elbow 100 with internal rotation 30',
      {
        shoulder_R_plane: 20,
        shoulder_R_elevation: 45,
        shoulder_R_axial: 30,
        elbow_R_flexion: 100,
      },
      ['shoulder_R_plane', 'shoulder_R_elevation', 'shoulder_R_axial', 'elbow_R_flexion'],
    ],
    [
      'L elbow 120 external rotation −50',
      {
        shoulder_L_plane: 60,
        shoulder_L_elevation: 60,
        shoulder_L_axial: -50,
        elbow_L_flexion: 120,
      },
      ['shoulder_L_plane', 'shoulder_L_elevation', 'shoulder_L_axial', 'elbow_L_flexion'],
    ],
    [
      'L hip flexion 60',
      { hip_L_flexion: 60 },
      ['hip_L_flexion', 'hip_R_flexion', 'knee_L_flexion'],
    ],
    ['R hip extension −20', { hip_R_flexion: -20 }, ['hip_R_flexion', 'knee_R_flexion']],
    ['R knee 70', { knee_R_flexion: 70 }, ['hip_R_flexion', 'knee_R_flexion', 'knee_L_flexion']],
  ];
  for (const [name, p, dofs] of cases)
    it(name, () => {
      const want = pose(p);
      const est = estimateAnatomicalPose(synthesizeLandmarks(want), { calibration: cal });
      expectClose(est.pose, want, dofs);
      expect(est.clamped).toEqual([]);
    });

  it('sitting: hips and knees 90 → pelvis drop = thigh length (feet on the floor)', () => {
    const want = pose({
      hip_L_flexion: 90,
      hip_R_flexion: 90,
      knee_L_flexion: 90,
      knee_R_flexion: 90,
    });
    want.pelvis_drop_m = expectedDrop(want);
    expect(want.pelvis_drop_m).toBeCloseTo(DEFAULT_SEGMENTS.thigh, 6);
    const est = estimateAnatomicalPose(synthesizeLandmarks(want), { calibration: cal });
    expectClose(est.pose, want, ['hip_L_flexion', 'knee_R_flexion', 'pelvis_drop_m']);
  });

  it('neutral stance reads all angles ≈ 0', () => {
    const est = estimateAnatomicalPose(synthesizeLandmarks(neutralPose()), { calibration: cal });
    expectClose(est.pose, neutralPose(), [...ANATOMICAL_DOFS]);
  });
});

describe('round trip on random poses (any heading, tilted camera, calibrated)', () => {
  it('recovers every DOF within 0.5° / 5 mm', () => {
    const r = rng(42);
    for (let i = 0; i < 200; i++) {
      const opts: SynthOptions = {
        yawDeg: uniform(r, -60, 60),
        cameraPitchDeg: uniform(r, -15, 15),
      };
      const cal = calibrationFor(opts);
      const want = pose({
        trunk_flexion: uniform(r, -20, 80),
        trunk_lateral: uniform(r, -30, 30),
        trunk_twist: uniform(r, -40, 40),
        shoulder_L_plane: uniform(r, -60, 130),
        shoulder_L_elevation: uniform(r, 30, 150),
        shoulder_L_axial: uniform(r, -80, 80),
        elbow_L_flexion: uniform(r, 50, 145),
        shoulder_R_plane: uniform(r, -60, 130),
        shoulder_R_elevation: uniform(r, 30, 150),
        shoulder_R_axial: uniform(r, -80, 80),
        elbow_R_flexion: uniform(r, 50, 145),
        hip_L_flexion: uniform(r, -20, 110),
        hip_R_flexion: uniform(r, -20, 110),
        knee_L_flexion: uniform(r, 0, 130),
        knee_R_flexion: uniform(r, 0, 130),
      });
      // Elevation ≤ 150 keeps the arms out of the gimbal band (plane blending) near 180.
      want.pelvis_drop_m = expectedDrop(want);
      const est = estimateAnatomicalPose(synthesizeLandmarks(want, opts), { calibration: cal });
      expectClose(est.pose, want, [...ANATOMICAL_DOFS]);
    }
  });

  it('is invariant to the person turning (yaw) for body-relative DOFs', () => {
    const want = pose({
      shoulder_R_plane: 45,
      shoulder_R_elevation: 100,
      elbow_L_flexion: 80,
      knee_L_flexion: 40,
    });
    for (const yawDeg of [-80, -30, 0, 30, 80]) {
      const est = estimateAnatomicalPose(synthesizeLandmarks(want, { yawDeg }), {
        calibration: calibrationFor({ yawDeg }),
      });
      expectClose(est.pose, want, [
        'shoulder_R_plane',
        'shoulder_R_elevation',
        'elbow_L_flexion',
        'knee_L_flexion',
      ]);
    }
  });
});

/** Mirror a MediaPipe frame: negate x, swap left/right landmark indices. */
function mirrorInput(input: PoseLandmarksInput): PoseLandmarksInput {
  const swap = (i: number) => {
    if (i === 0) return 0;
    if (i >= 1 && i <= 10) {
      // 1–3 left eye ↔ 4–6 right eye, 7 ↔ 8 ears, 9 ↔ 10 mouth
      if (i <= 6) return i <= 3 ? i + 3 : i - 3;
      return i % 2 ? i + 1 : i - 1;
    }
    return i % 2 ? i + 1 : i - 1; // 11+ : odd = left, even = right
  };
  const m = (arr: PoseLandmarksInput['world']) =>
    arr.map((_, i) => {
      const p = arr[swap(i)];
      return { ...p, x: -p.x };
    });
  return {
    world: m(input.world),
    image: input.image?.map((_, i) => {
      const p = input.image![swap(i)];
      return { ...p, x: 1 - p.x };
    }),
  };
}

describe('mirror symmetry', () => {
  it('mirrored landmarks swap L/R DOFs and negate lateral bend and twist', () => {
    const cal = calibrationFor();
    const p = pose({
      trunk_flexion: 20,
      trunk_lateral: 12,
      trunk_twist: 18,
      shoulder_L_plane: 30,
      shoulder_L_elevation: 110,
      shoulder_L_axial: 25,
      elbow_L_flexion: 70,
      shoulder_R_plane: 85,
      shoulder_R_elevation: 60,
      shoulder_R_axial: -40,
      elbow_R_flexion: 120,
      hip_L_flexion: 30,
      knee_L_flexion: 50,
      hip_R_flexion: 5,
      knee_R_flexion: 10,
    });
    const input = synthesizeLandmarks(p, { yawDeg: 20 });
    const a = estimateAnatomicalPose(input, { calibration: cal }).pose;
    const b = estimateAnatomicalPose(mirrorInput(input), {
      // The mirrored camera sees the same vertical (synthetic camera has no roll).
      calibration: cal,
    }).pose;
    const swapped = (d: AnatomicalDof): AnatomicalDof =>
      d.includes('_L_')
        ? (d.replace('_L_', '_R_') as AnatomicalDof)
        : (d.replace('_R_', '_L_') as AnatomicalDof);
    for (const d of ANATOMICAL_DOFS) {
      const sign = d === 'trunk_lateral' || d === 'trunk_twist' ? -1 : 1;
      expect(b[swapped(d)], d).toBeCloseTo(sign * a[d], 6);
    }
  });
});

describe('confidence', () => {
  const cal = calibrationFor();

  it('plane of elevation has ~0 confidence and holds its previous value at the gimbal', () => {
    const want = pose({ shoulder_R_plane: 70, shoulder_R_elevation: 2 });
    const prev = pose({ shoulder_R_plane: 25 });
    const est = estimateAnatomicalPose(synthesizeLandmarks(want), {
      calibration: cal,
      previous: prev,
    });
    expect(est.confidence.shoulder_R_plane).toBeLessThan(0.05);
    expect(est.pose.shoulder_R_plane).toBeCloseTo(25, 6);
    expect(est.confidence.shoulder_R_elevation).toBeGreaterThan(0.9);
  });

  it('axial rotation and twist are capped (single-camera ambiguity)', () => {
    const want = pose({ shoulder_R_elevation: 60, elbow_R_flexion: 90, trunk_twist: 20 });
    const est = estimateAnatomicalPose(synthesizeLandmarks(want, { yawDeg: 60 }), {
      calibration: calibrationFor({ yawDeg: 60 }),
    });
    expect(est.confidence.shoulder_R_axial).toBeLessThanOrEqual(AXIAL_MAX_CONFIDENCE);
    expect(est.confidence.trunk_twist).toBeLessThanOrEqual(TWIST_MAX_CONFIDENCE);
  });

  it('axial rotation has no confidence with a straight elbow', () => {
    const est = estimateAnatomicalPose(
      synthesizeLandmarks(pose({ shoulder_R_elevation: 60, shoulder_R_axial: 40 })),
      { calibration: cal },
    );
    expect(est.confidence.shoulder_R_axial).toBe(0);
    expect(est.held).toContain('shoulder_R_axial');
  });

  it('an arm pointing at the camera is less confident than one in the image plane', () => {
    const side = estimateAnatomicalPose(synthesizeLandmarks(pose({ shoulder_R_elevation: 90 })), {
      calibration: cal,
    });
    const fwd = estimateAnatomicalPose(
      synthesizeLandmarks(pose({ shoulder_R_plane: 90, shoulder_R_elevation: 90 })),
      { calibration: cal },
    );
    expect(side.confidence.shoulder_R_elevation).toBeGreaterThan(0.95);
    expect(fwd.confidence.shoulder_R_elevation).toBeLessThan(0.4);
  });

  it('trunk flexion facing the camera is penalised; lateral bend is not', () => {
    const est = estimateAnatomicalPose(synthesizeLandmarks(pose({ trunk_flexion: 30 })), {
      calibration: cal,
    });
    expect(est.confidence.trunk_flexion).toBeLessThan(0.6);
    expect(est.confidence.trunk_lateral).toBeGreaterThan(0.9);
    const sideOn = estimateAnatomicalPose(
      synthesizeLandmarks(pose({ trunk_flexion: 30 }), { yawDeg: 90 }),
      {
        calibration: calibrationFor({ yawDeg: 90 }),
      },
    );
    expect(sideOn.confidence.trunk_flexion).toBeGreaterThan(0.9);
  });

  it('plane of elevation of a sideways arm facing the camera rests on depth (penalised)', () => {
    const abd = pose({ shoulder_R_elevation: 60 });
    const facing = estimateAnatomicalPose(synthesizeLandmarks(abd), { calibration: cal });
    expect(facing.confidence.shoulder_R_plane).toBeLessThan(0.55);
    expect(facing.confidence.shoulder_R_elevation).toBeGreaterThan(0.95);
    const turned = estimateAnatomicalPose(synthesizeLandmarks(abd, { yawDeg: 45 }), {
      calibration: calibrationFor({ yawDeg: 45 }),
    });
    expect(turned.confidence.shoulder_R_plane).toBeGreaterThan(facing.confidence.shoulder_R_plane);
  });

  it('invisible wrist → elbow flexion confidence 0 and previous value held', () => {
    const input = synthesizeLandmarks(pose({ elbow_L_flexion: 90, shoulder_L_elevation: 40 }), {
      visibility: { [PL.lWrist]: 0.1 },
    });
    const est = estimateAnatomicalPose(input, {
      calibration: cal,
      previous: pose({ elbow_L_flexion: 33 }),
    });
    expect(est.confidence.elbow_L_flexion).toBe(0);
    expect(est.pose.elbow_L_flexion).toBe(33);
  });

  it('out-of-frame ankles → pelvis drop not estimated', () => {
    const synth = synthesizeLandmarks(pose({}));
    const input: PoseLandmarksInput = {
      world: synth.world,
      image: synth.image!.map((p, i) =>
        i === PL.lAnkle || i === PL.rAnkle ? { ...p, y: 1.2 } : p,
      ),
    };
    const est = estimateAnatomicalPose(input, { calibration: cal });
    expect(est.confidence.pelvis_drop_m).toBe(0);
    expect(est.held).toContain('pelvis_drop_m');
  });

  it('without calibration the gravity-referenced DOFs assume an upright camera (and say so)', () => {
    const input = synthesizeLandmarks(pose({}), { cameraPitchDeg: 12 });
    const est = estimateAnatomicalPose(input);
    // Camera pitch reads as trunk flexion before calibration: the documented assumption.
    expect(Math.abs(est.pose.trunk_flexion)).toBeCloseTo(12, 3);
    expect(est.confidence.trunk_lateral).toBeLessThanOrEqual(UNCALIBRATED_CONFIDENCE);
    const calibrated = estimateAnatomicalPose(input, {
      calibration: calibrationFor({ cameraPitchDeg: 12 }),
    });
    expect(Math.abs(calibrated.pose.trunk_flexion)).toBeLessThan(1e-6);
  });

  it('values beyond anatomical limits are clamped and reported', () => {
    const est = estimateAnatomicalPose(
      synthesizeLandmarks(pose({ elbow_R_flexion: 170, shoulder_R_elevation: 40 })),
      {
        calibration: cal,
      },
    );
    expect(est.pose.elbow_R_flexion).toBe(POSE_LIMITS.elbow_R_flexion[1]);
    expect(est.clamped).toContain('elbow_R_flexion');
  });

  it('all confidences stay in [0, 1]', () => {
    const est = estimateAnatomicalPose(
      synthesizeLandmarks(pose({ trunk_flexion: 60, hip_L_flexion: 90 })),
    );
    for (const d of ANATOMICAL_DOFS) {
      expect(est.confidence[d]).toBeGreaterThanOrEqual(0);
      expect(est.confidence[d]).toBeLessThanOrEqual(1);
    }
  });
});

describe('NeutralCalibrator', () => {
  it('needs 1 s of still, upright standing with arms down', () => {
    const c = new NeutralCalibrator(1000);
    const still = synthesizeLandmarks(neutralPose(), { cameraPitchDeg: 8 });
    let done: NeutralCalibration | undefined;
    let t = 0;
    for (; t <= 1100 && !done; t += 33) done = c.update(t, still).done;
    expect(done).toBeDefined();
    expect(t).toBeGreaterThanOrEqual(1000);
    expect(done!.standingHipHeightM).toBeCloseTo(standingHipHeight(), 6);
    // Up axis = the camera-pitched vertical.
    const upAngle = (Math.acos(done!.up[1]) * 180) / Math.PI;
    expect(upAngle).toBeCloseTo(8, 6);
  });

  it('completes despite 1 cm per-frame world-landmark jitter at 30 Hz (V1, real video)', () => {
    const c = new NeutralCalibrator(1000);
    const r = rng(11);
    const base = synthesizeLandmarks(neutralPose());
    let done: NeutralCalibration | undefined;
    for (let t = 0; t <= 2000 && !done; t += 33) {
      const noisy = {
        ...base,
        world: base.world.map((p) => ({
          ...p,
          x: p.x + (r() - 0.5) * 0.02,
          y: p.y + (r() - 0.5) * 0.02,
          z: p.z + (r() - 0.5) * 0.02,
        })),
      };
      done = c.update(t, noisy).done;
    }
    expect(done).toBeDefined();
  });

  it('resets when the person moves, raises an arm or disappears', () => {
    const c = new NeutralCalibrator(1000);
    const still = synthesizeLandmarks(neutralPose());
    expect(c.update(0, still).progress).toBe(0);
    expect(c.update(500, still).progress).toBeCloseTo(0.5);
    const moved = synthesizeLandmarks(pose({ shoulder_R_elevation: 20 }));
    expect(c.update(533, moved).issues).toContain('moving');
    expect(c.update(566, synthesizeLandmarks(pose({ shoulder_R_elevation: 60 }))).issues).toContain(
      'arms_not_down',
    );
    expect(c.update(600, undefined).issues).toEqual(['no_person']);
    expect(c.update(633, still).progress).toBe(0);
  });
});

describe('noise robustness (offline validation, 1 cm landmark noise)', () => {
  it('keeps well-observed DOFs within a few degrees', () => {
    const r = rng(3);
    const errs: Record<string, number[]> = {};
    const cal = calibrationFor();
    for (let i = 0; i < 200; i++) {
      const want = pose({
        trunk_flexion: uniform(r, -10, 60),
        trunk_lateral: uniform(r, -20, 20),
        shoulder_L_plane: uniform(r, 0, 60),
        shoulder_L_elevation: uniform(r, 40, 150),
        elbow_L_flexion: uniform(r, 30, 140),
        shoulder_R_plane: uniform(r, 0, 60),
        shoulder_R_elevation: uniform(r, 40, 150),
        elbow_R_flexion: uniform(r, 30, 140),
        hip_L_flexion: uniform(r, 0, 60),
        knee_L_flexion: uniform(r, 0, 90),
      });
      const noise = (): Vec3 => [0.01 * gauss(r), 0.01 * gauss(r), 0.01 * gauss(r)];
      const est = estimateAnatomicalPose(synthesizeLandmarks(want, { noise }), {
        calibration: cal,
      });
      for (const d of ANATOMICAL_DOFS) {
        if (d === 'pelvis_drop_m') continue;
        (errs[d] ??= []).push(Math.abs(wrapDeg(est.pose[d] - want[d])));
      }
    }
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const summary = Object.fromEntries(
      Object.entries(errs).map(([k, v]) => [k, Number(mean(v).toFixed(2))]),
    );
    console.info('[pose noise] mean |error| (deg) at σ = 1 cm per axis:', JSON.stringify(summary));
    for (const d of [
      'trunk_flexion',
      'trunk_lateral',
      'shoulder_L_elevation',
      'shoulder_R_elevation',
      'elbow_L_flexion',
      'elbow_R_flexion',
      'hip_L_flexion',
      'knee_L_flexion',
    ])
      expect(summary[d], d).toBeLessThan(5);
  });
});
