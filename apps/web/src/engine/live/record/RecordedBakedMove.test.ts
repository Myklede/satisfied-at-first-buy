import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../cloth/ClothSolver.ts';
import { parseArticulatedSdf } from '../../motion/articulatedCollider.ts';
import { bakeMotion } from '../../motion/bake.ts';
import { MOTION_FIT } from '../../motion/config.ts';
import { summarise } from '../../motion/metrics.ts';
import { anchorFrame, parseFrames, parseRig, type MotionAnchors } from '../../motion/rig.ts';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../../motion/testFixture.ts';
import { Group } from 'three';
import type { LivePosedScene } from '../contract.ts';
import { isDrivable, RecordedBakedMove, worldFromDrivers } from './RecordedBakedMove.ts';

const NEEDED = [
  'rig.bin',
  'sdf.bin',
  'anchors.json',
  'frames-reach_up_both.bin',
  'cloth-FB-S.json',
];

/** A LivePosedScene that records what playback set (V1's LiveAvatar has the same two methods). */
class FakeScene implements LivePosedScene {
  root = new Group();
  jacket = new Group();
  body = new Group();
  joints = {};
  drivers?: Float64Array;
  world?: Float64Array;
  jacketPositions?: Float32Array;
  setDrivers(drivers: ArrayLike<number>, world?: Float64Array) {
    this.drivers = Float64Array.from(drivers);
    this.world = world && Float64Array.from(world);
  }
  setJacketPositions(positions: ArrayLike<number>) {
    this.jacketPositions = Float32Array.from(positions);
  }
}

describe.skipIf(!fixtureAvailable(...NEEDED))('recorded baked move (reference body)', () => {
  const rig = parseRig(fixtureBuffer('rig.bin'));
  const sdf = parseArticulatedSdf(fixtureBuffer('sdf.bin'), rig);
  const anchors = fixtureJson<MotionAnchors>('anchors.json');
  const full = parseFrames(fixtureBuffer('frames-reach_up_both.bin'), rig.drivers.length);

  it('rebuilds the bone world poses from the drivers (joint centres = the service anchors)', () => {
    const drivers = new Float64Array(rig.drivers.length * 12),
      world = new Float64Array(rig.bones.length * 16);
    const bones = ['wrist.L', 'wrist.R', 'lowerarm01.L', 'lowerarm01.R'].map((b) =>
      rig.bones.indexOf(b),
    );
    let worst = 0;
    for (const f of [0, 40, 60, full.count - 1]) {
      for (let k = 0; k < drivers.length; k++) drivers[k] = full.matrices[f * drivers.length + k];
      worldFromDrivers(rig, drivers, world);
      const joints = anchorFrame(full, 'joints', f);
      bones.forEach((b, j) => {
        for (let c = 0; c < 3; c++)
          worst = Math.max(worst, Math.abs(world[b * 16 + c * 4 + 3] - joints[j * 3 + c]));
      });
    }
    expect(worst).toBeLessThan(2e-6); // float32 round-off, metres
  });

  it('plays back the bake and reads it out with the existing metrics, basis physics', () => {
    const asset = fixtureJson<ClothAsset>('cloth-FB-S.json');
    const grid = new Float32Array(fixtureBuffer(`sdf-${asset.sdf.sdf_id}.bin`));
    const F = 12;
    const bake = bakeMotion(
      { asset, grid, rig, sdf, frames: full, anchors, size: 'S' },
      undefined,
      {
        maxFrames: F,
      },
    );
    // The first F frames, as a move of F frames.
    const frames = {
      ...full,
      count: F,
      matrices: full.matrices.subarray(0, F * rig.drivers.length * 12),
    };
    const move = new RecordedBakedMove({ bake, frames, rig, anchors, asset });
    expect(move.frameCount).toBe(F);
    expect(move.fps).toBe(30);

    const scene = new FakeScene();
    expect(isDrivable(scene)).toBe(true);
    move.applyFrame(F - 1, scene);
    const n = bake.particles * 3;
    expect(scene.jacketPositions).toEqual(bake.positions.slice((F - 1) * n, F * n));
    expect(scene.drivers![0]).toBe(full.matrices[(F - 1) * rig.drivers.length * 12]);
    expect(scene.world).toHaveLength(rig.bones.length * 16);
    expect(() => move.applyFrame(0, new Group() as unknown as LivePosedScene)).toThrow(
      /setDrivers/,
    );

    const r = move.readouts(F - 1),
      m = bake.metrics[F - 1];
    const floor = (x: number) => (Number.isFinite(x) && x > MOTION_FIT.exposureFloorCm ? x : 0);
    expect(r.exposureCm).toEqual({
      front: floor(m.hemAboveCm.mid[0]),
      back: floor(m.hemAboveCm.mid[16]),
      sides: Math.max(floor(m.hemAboveCm.mid[8]), floor(m.hemAboveCm.mid[24])),
    });
    const wrist = summarise('S', [bake.metrics[0], m]).wrist;
    expect(r.sleeveRideUpCm).toEqual({ left: wrist.L.rideUp, right: wrist.R.rideUp });
    expect(r.zones.length).toBe(6);
    for (const z of r.zones) expect(z.basis).toBe('physics');
    // No static fit given: values unknown (never invented).
    for (const z of r.zones) expect(z.valueCm).toBeNull();
    expect(move.readouts(0).sleeveRideUpCm).toEqual({ left: 0, right: 0 });

    // With the static fit, a zone's value is its ease minus the simulated tape stretch.
    const withStatic = new RecordedBakedMove({
      bake,
      frames,
      rig,
      anchors,
      asset,
      staticZones: { chest: { value_cm: 10, status: 'fit' }, hem: { value_cm: 5, status: 'fit' } },
    });
    const chest = withStatic.readouts(F - 1).zones.find((z) => z.zone === 'chest')!;
    expect(chest.valueCm).not.toBeNull();
    expect(chest.valueCm!).toBeLessThanOrEqual(10);
    expect(withStatic.readouts(0).zones.find((z) => z.zone === 'chest')!.valueCm).toBe(10);
    const hem = move.hem(F - 1);
    expect(hem.riseCm.front).toBeCloseTo(m.hemAboveCm.mid[0] - bake.metrics[0].hemAboveCm.mid[0]);
    move.dispose();
    expect(() => move.readouts(1)).toThrow(/disposed/);
  }, 120_000); // a real (short) cloth bake: relax + 12 frames, ~3-6 s
});
