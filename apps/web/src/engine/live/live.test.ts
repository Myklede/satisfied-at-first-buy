import { describe, expect, it } from 'vitest';
import { parseRig, skinVertices } from '../motion/rig';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../motion/testFixture';
import { bindGarment, skinGarment, uniqueEdges } from './garmentSkin';
import { gatePose, PoseSmoother, trackingQuality } from './livePose';
import {
  capFit,
  FIT_ROTATION_CAP_DEG,
  FIT_SLEW_DEG_S,
  FitFilter,
  HangingArms,
} from './LiveTryOnEngine';
import { createLiveRig, poseDrivers } from './liveRig';
import { decodeSatb } from '../motion/satb';
import { pathLength, previewReadouts, staticReadouts, zoneStretchCm } from './readouts';

describe('gatePose', () => {
  const neutral = { shoulder_L_elevation: 12, hip_L_flexion: 8, pelvis_drop_m: 0.01 };
  it('keeps confident DOFs and takes the neutral value for the rest', () => {
    const { pose, estimated } = gatePose(
      { shoulder_L_elevation: 90, hip_L_flexion: 40, pelvis_drop_m: 0.2 },
      { shoulder_L_elevation: 0.8, hip_L_flexion: 0.01 },
      neutral,
    );
    expect(pose).toEqual({ shoulder_L_elevation: 90, hip_L_flexion: 8 });
    expect(estimated).toEqual(['shoulder_L_elevation']);
  });
  it('never passes a non-finite value', () => {
    const { pose } = gatePose({ shoulder_L_elevation: NaN }, { shoulder_L_elevation: 1 }, neutral);
    expect(pose.shoulder_L_elevation).toBe(12);
  });
  it('tracking quality is the mean upper-body confidence', () => {
    expect(trackingQuality({})).toBe(0);
    expect(
      trackingQuality({
        trunk_flexion: 1,
        trunk_lateral: 1,
        shoulder_L_elevation: 1,
        shoulder_R_elevation: 1,
        shoulder_L_plane: 1,
        shoulder_R_plane: 1,
        elbow_L_flexion: 1,
        elbow_R_flexion: 1,
      }),
    ).toBe(1);
  });
});

describe('PoseSmoother', () => {
  const neutral = { shoulder_R_elevation: 10, elbow_R_flexion: 5, pelvis_drop_m: 0 };
  it('holds a lost DOF, then eases it to neutral, never snapping', () => {
    const s = new PoseSmoother(400, 600, false);
    const conf = { shoulder_R_elevation: 0.9, elbow_R_flexion: 0.9 };
    expect(
      s.update(0, { shoulder_R_elevation: 120, elbow_R_flexion: 40 }, conf, neutral).pose,
    ).toEqual({
      shoulder_R_elevation: 120,
      elbow_R_flexion: 40,
    });
    // Elbow occluded: held at its last measured value for 400 ms.
    const held = s.update(
      300,
      { shoulder_R_elevation: 118, elbow_R_flexion: 0 },
      { shoulder_R_elevation: 0.9 },
      neutral,
    );
    expect(held.pose).toEqual({ shoulder_R_elevation: 118, elbow_R_flexion: 40 });
    expect(held.estimated).toEqual(['shoulder_R_elevation']);
    // Person gone: halfway through the release the value is between measured and neutral.
    const mid = s.update(1000, null, {}, neutral).pose;
    expect(mid.shoulder_R_elevation).toBeLessThan(118);
    expect(mid.shoulder_R_elevation).toBeGreaterThan(10);
    const end = s.update(2000, null, {}, neutral);
    expect(end.pose).toEqual({ shoulder_R_elevation: 10, elbow_R_flexion: 5 });
    expect(end.settled).toBe(true);
  });
});

describe('PoseSmoother stabilizer', () => {
  const neutral = {
    shoulder_R_plane: 20,
    shoulder_R_elevation: 10,
    shoulder_R_axial: 5,
    trunk_flexion: 0,
    pelvis_drop_m: 0,
  };
  const conf = {
    shoulder_R_plane: 0.2,
    shoulder_R_elevation: 0.9,
    shoulder_R_axial: 0.2,
    trunk_flexion: 0.9,
  };
  it('holds plane and axial at neutral when the arm hangs (gimbal)', () => {
    const s = new PoseSmoother();
    for (let i = 0; i <= 30; i++) {
      const out = s.update(
        i * 33,
        {
          shoulder_R_plane: i % 2 ? 80 : -60,
          shoulder_R_elevation: 6,
          shoulder_R_axial: i % 2 ? -50 : 40,
          trunk_flexion: 0,
        },
        conf,
        neutral,
      ).pose;
      expect(out.shoulder_R_plane).toBeCloseTo(20, 6);
      expect(out.shoulder_R_axial).toBeCloseTo(5, 6);
    }
  });
  it('keeps a DOF measured while its confidence hovers between leave and enter (hysteresis)', () => {
    const s = new PoseSmoother();
    s.update(0, { shoulder_R_elevation: 90 }, { shoulder_R_elevation: 0.9 }, neutral);
    const r = s.update(33, { shoulder_R_elevation: 91 }, { shoulder_R_elevation: 0.1 }, neutral);
    expect(r.estimated).toContain('shoulder_R_elevation');
  });
  it('limits a one-frame spike to the slew rate', () => {
    const s = new PoseSmoother();
    s.update(0, { trunk_flexion: 0 }, conf, neutral);
    const out = s.update(33, { trunk_flexion: 80 }, conf, neutral).pose;
    expect(out.trunk_flexion).toBeLessThanOrEqual(150 * 0.033 + 1e-9);
  });
});

describe('capFit', () => {
  it('keeps the screen fit within the cap on plane and axial only', () => {
    const out = capFit(
      {
        shoulder_L_plane: 200,
        shoulder_L_axial: -180,
        shoulder_L_elevation: 120,
        elbow_L_flexion: 70,
      },
      { shoulder_L_plane: 10, shoulder_L_axial: 0, shoulder_L_elevation: 60, elbow_L_flexion: 20 },
    );
    expect(out.shoulder_L_plane).toBe(10 + FIT_ROTATION_CAP_DEG);
    expect(out.shoulder_L_axial).toBe(-FIT_ROTATION_CAP_DEG);
    expect(out.shoulder_L_elevation).toBe(120);
    expect(out.elbow_L_flexion).toBe(70);
  });
});

describe('HangingArms', () => {
  const lm = (sx: number, sy: number, ex: number, ey: number) => {
    const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
    pts[11] = { x: sx, y: sy, visibility: 1 };
    pts[13] = { x: ex, y: ey, visibility: 1 };
    pts[12] = { x: sx - 200, y: sy, visibility: 1 };
    pts[14] = { x: sx - 260, y: sy + 40, visibility: 1 };
    return pts;
  };
  const frame = (l: ReturnType<typeof lm>) => ({
    t: 0,
    width: 960,
    height: 540,
    landmarks2d: l,
    world: null,
    pose: null,
    confidence: {},
    mask: null,
  });
  it('caps the elevation of an arm that hangs in the image (the 15:18 relaxed arms)', () => {
    const h = new HangingArms();
    // Shoulder (578,180) -> elbow (587,281): 5 deg from straight down, full length.
    const out = h.apply(frame(lm(578, 180, 587, 281)), { shoulder_L_elevation: 33 });
    expect(out.shoulder_L_elevation).toBeLessThanOrEqual(15);
  });
  it('f3arms: an arm whose world elbow is 8+ cm in front of the shoulder is not capped', () => {
    const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
    world[11] = { x: 0.2, y: -0.5, z: 0, visibility: 1 };
    world[13] = { x: 0.25, y: -0.25, z: -0.15, visibility: 1 }; // elbow 15 cm toward the camera
    const f = { ...frame(lm(578, 180, 587, 281)), world };
    expect(new HangingArms(true).apply(f, { shoulder_L_elevation: 38 }).shoulder_L_elevation).toBe(
      38,
    );
    // Without the flag (default) it is capped as before.
    expect(
      new HangingArms().apply(f, { shoulder_L_elevation: 38 }).shoulder_L_elevation,
    ).toBeLessThanOrEqual(15);
  });
  it('leaves a raised or foreshortened arm alone', () => {
    const h = new HangingArms();
    h.apply(frame(lm(578, 180, 587, 281)), { shoulder_L_elevation: 10 }); // learn the full length
    // Forward raise toward the camera: the image segment is short.
    const fwd = h.apply(frame(lm(578, 180, 580, 215)), { shoulder_L_elevation: 85 });
    expect(fwd.shoulder_L_elevation).toBe(85);
    // Sideways raise: far from vertical in the image.
    const side = h.apply(frame(lm(578, 180, 670, 200)), { shoulder_L_elevation: 80 });
    expect(side.shoulder_L_elevation).toBe(80);
  });
});

describe('readouts', () => {
  it('measures open and closed paths', () => {
    const p = [0, 0, 0, 1, 0, 0, 1, 1, 0];
    expect(pathLength(p, [0, 1, 2], false)).toBeCloseTo(2);
    expect(pathLength(p, [0, 1, 2], true)).toBeCloseTo(2 + Math.SQRT2);
  });
  it('preview = static minus stretch, labelled preview; static stays static-fit', () => {
    const neutral = [0, 0, 0, 0.1, 0, 0, 0.1, 0.1, 0, 0, 0.1, 0];
    const posed = [0, 0, 0, 0.12, 0, 0, 0.12, 0.1, 0, 0, 0.1, 0];
    const stretch = zoneStretchCm(
      { paths: { chest: [0, 1, 2, 3] }, seams: [0, 1] },
      neutral,
      posed,
    );
    expect(stretch.chest).toBeCloseTo(4, 5);
    expect(stretch.shoulder).toBeCloseTo(2, 5);
    const zones = {
      chest: { value_cm: 3, status: 'fit' as const },
      shoulder: { value_cm: 5, status: 'relaxed' as const },
      sleeve: { value_cm: 1, status: 'fit' as const },
    };
    expect(staticReadouts(zones).every((z) => z.basis === 'static-fit')).toBe(true);
    const preview = previewReadouts(zones, stretch);
    expect(preview.find((z) => z.zone === 'chest')).toEqual({
      zone: 'chest',
      valueCm: expect.closeTo(-1, 5) as number,
      status: 'tight',
      basis: 'preview',
    });
    expect(preview.find((z) => z.zone === 'shoulder')?.status).toBe('relaxed');
    // No tape for the sleeve here: unknown, never invented.
    expect(preview.find((z) => z.zone === 'sleeve')).toEqual({
      zone: 'sleeve',
      valueCm: null,
      status: 'unknown',
      basis: 'preview',
    });
  });
  it('unique edges of two triangles', () => {
    expect(uniqueEdges([0, 1, 2, 2, 1, 3]).length / 2).toBe(5);
  });
});

type Cloth = {
  initial: number[];
  panels: number[];
  triangles: number[];
  body_positions: number[];
  paths: Record<string, number[]>;
};

describe.skipIf(!fixtureAvailable('rig.bin', 'cloth-FB-M.json'))('garment preview skinning', () => {
  it('reproduces the bound jacket at the neutral pose and follows a raised arm', () => {
    const buffer = fixtureBuffer('rig.bin');
    const rig = parseRig(buffer);
    const header = decodeSatb(buffer, 'rig').header as unknown as { parents: number[] };
    const live = createLiveRig(rig, header.parents);
    const cloth = fixtureJson<Cloth>('cloth-FB-M.json');
    const neutral = poseDrivers(live, rig.neutralPose);
    const skin0 = skinVertices(rig, neutral.drivers, new Float32Array(rig.vertexCount * 3));
    const started = performance.now();
    const skin = bindGarment(
      rig,
      neutral.drivers,
      skin0,
      cloth.body_positions,
      cloth.initial,
      cloth.panels,
      cloth.triangles,
    );
    const bindMs = performance.now() - started;
    const out = new Float32Array(skin.count * 3);
    skinGarment(skin, neutral.drivers, out);
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i] - skin.bound[i]));
    expect(err).toBeLessThan(1e-5);
    // Asset body vs the rig's neutral skin: the binding shifts the cloth by this much at most.
    console.log(
      `garment bind: ${skin.count} particles in ${bindMs.toFixed(0)} ms, ` +
        `asset body vs rig neutral ≤ ${(skin.bodyMismatchM * 1000).toFixed(1)} mm`,
    );
    const t0 = performance.now();
    const raised = poseDrivers(live, { ...rig.neutralPose, shoulder_L_elevation: 150 });
    skinGarment(skin, raised.drivers, out);
    const skinMs = performance.now() - t0;
    // The left cuff (subject's left, +X) rises above the shoulder; the right cuff stays low.
    const cuffY = (name: string, p: ArrayLike<number>) => {
      const ids = cloth.paths[name];
      return ids.reduce((s, i) => s + p[i * 3 + 1], 0) / ids.length;
    };
    const shoulderY = live.rest[live.index.get('upperarm01.L')! * 16 + 7];
    expect(cuffY('cuff_L', out)).toBeGreaterThan(shoulderY);
    expect(Math.abs(cuffY('cuff_R', out) - cuffY('cuff_R', skin.bound))).toBeLessThan(0.02);
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true);
    console.log(`pose + jacket skin: ${skinMs.toFixed(2)} ms`);
  });
});

describe('FitFilter (screen-fit spike guard) and ?f1arm=1', () => {
  // A fast arm swing, 300 deg/s on plane and elevation, sampled at 24 fps.
  const ramp = (filter: FitFilter) => {
    const lag: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = (i * 1000) / 24;
      const v = 10 + (300 * t) / 1000;
      const out = filter.apply(t, { shoulder_L_plane: v, shoulder_L_elevation: v });
      if (i >= 3) lag.push(v - out.shoulder_L_plane, v - out.shoulder_L_elevation);
    }
    return lag;
  };
  it('default: the median and the 250 deg/s plane slew trail a fast swing', () => {
    const lag = ramp(new FitFilter());
    // The median alone keeps elevation one frame (12.5 deg) behind; plane falls further behind.
    expect(Math.max(...lag)).toBeGreaterThan(12);
  });
  it('f1arm: no median, 600 deg/s slew: a 300 deg/s swing passes without lag', () => {
    const lag = ramp(new FitFilter(false, {}));
    expect(Math.max(...lag.map(Math.abs))).toBeLessThan(1e-9);
  });
  it('f1arm still limits a one-frame flip to the tracker slew (600 deg/s)', () => {
    const f = new FitFilter(false, {});
    f.apply(0, { shoulder_L_plane: 0 });
    const out = f.apply(1000 / 24, { shoulder_L_plane: 120 });
    expect(out.shoulder_L_plane).toBeCloseTo(25, 6);
    expect(FIT_SLEW_DEG_S.shoulder_plane).toBe(250);
  });
});
