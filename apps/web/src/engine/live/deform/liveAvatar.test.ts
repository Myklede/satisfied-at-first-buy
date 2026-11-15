import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../../api';
import { parseRig, skinVertices } from '../../motion/rig';
import { decodeSatb } from '../../motion/satb';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../../motion/testFixture';
import { LiveAvatar } from '../LiveAvatar';
import { createLiveRig } from '../liveRig';
import { liveNeutral, PoseSmoother } from '../livePose';
import type { DynamicsDeformer } from './DynamicsDeformer';

const ok = fixtureAvailable('rig.bin', 'cloth-FB-M.json');

describe.skipIf(!ok)('LiveAvatar deformer hook (fixture: public body, parka M)', () => {
  const make = (dynamics: boolean) => {
    const buffer = fixtureBuffer('rig.bin');
    const rig = parseRig(buffer);
    const header = decodeSatb(buffer, 'rig').header as unknown as { parents: number[] };
    const avatar = new LiveAvatar(createLiveRig(rig, header.parents), {
      deformers: { dynamics, poseCorrectives: false },
    });
    avatar.setGarment(fixtureJson<ClothAsset>('cloth-FB-M.json'), { size: 'M' });
    return avatar;
  };
  // A move: trunk lean and twist with both arms swinging, 20 fps.
  const pose = (t: number) => ({
    trunk_flexion: 12 * Math.sin(2 * Math.PI * 0.7 * t),
    trunk_lateral: 8 * Math.sin(2 * Math.PI * 0.5 * t),
    trunk_twist: 15 * Math.sin(2 * Math.PI * 0.6 * t),
    shoulder_L_elevation: 60 + 50 * Math.sin(2 * Math.PI * 0.8 * t),
    shoulder_R_elevation: 60 - 50 * Math.sin(2 * Math.PI * 0.8 * t),
    elbow_L_flexion: 30,
    elbow_R_flexion: 30,
  });

  it('fit readouts come from the skinned jacket only: identical with the dynamics on or off', () => {
    const on = make(true),
      off = make(false);
    let moved = 0;
    for (let f = 0; f < 60; f++) {
      const t = f / 20;
      on.rootYawDeg = off.rootYawDeg = 25 * Math.sin(2 * Math.PI * 0.4 * t);
      on.applyPose(pose(t), t * 1000);
      off.applyPose(pose(t), t * 1000);
      expect(on.previewStretch()).toEqual(off.previewStretch());
      expect(Array.from(on.skinnedJacketPositions()!)).toEqual(
        Array.from(off.skinnedJacketPositions()!),
      );
      const a = on.jacketPositions()!,
        s = on.skinnedJacketPositions()!;
      for (let k = 0; k < a.length; k += 3)
        moved = Math.max(moved, Math.hypot(a[k] - s[k], a[k + 1] - s[k + 1], a[k + 2] - s[k + 2]));
      // Off: the display IS the skinned jacket.
      expect(Array.from(off.jacketPositions()!)).toEqual(Array.from(off.skinnedJacketPositions()!));
    }
    expect(moved).toBeGreaterThan(0.005);
    const dyn = on.deformers.get<DynamicsDeformer>('dynamics')!;
    const info = dyn.binding!;
    console.log(
      `parka M: ${info.proxy.count} proxy nodes, ${info.proxy.moving.length} moving particles, ` +
        `bind ${info.bindMs.toFixed(0)} ms, hem max ${(info.map.summary.hemMaxM * 100).toFixed(1)} cm, ` +
        `largest display offset ${(moved * 100).toFixed(1)} cm; ${JSON.stringify(on.deformStatus())}`,
    );
  }, 30000);

  it('a baked physics frame bypasses the chain and is shown as given', () => {
    const avatar = make(true);
    avatar.applyPose(pose(0), 0);
    avatar.setDeformBypass(true);
    avatar.applyPose(pose(0.1), 100);
    expect(Array.from(avatar.jacketPositions()!)).toEqual(
      Array.from(avatar.skinnedJacketPositions()!),
    );
    const frame = avatar.skinnedJacketPositions()!.map((v) => v + 0.01);
    avatar.setJacketPositions(frame);
    expect(Array.from(avatar.jacketPositions()!)).toEqual(Array.from(frame));
    avatar.setDeformBypass(false);
    avatar.applyPose(pose(0.15), 150);
    // Back to live: the chain restarts from the target.
    expect(Array.from(avatar.jacketPositions()!)).toEqual(
      Array.from(avatar.skinnedJacketPositions()!),
    );
  }, 30000);

  it('reuses identical poses and driver values without geometry uploads or fit changes', () => {
    const avatar = make(false);
    const input = pose(0.3);
    avatar.applyPose(input, 0);
    const result = avatar.last;
    const version = avatar.version;
    const body = avatar.bodyArrays().positions.slice();
    const jacket = avatar.jacketPositions()!.slice();
    const stretch = avatar.previewStretch();
    for (let i = 1; i <= 10; i++) avatar.applyPose({ ...input }, i * 33);
    expect(avatar.last).toBe(result);
    expect(avatar.version).toBe(version);
    expect(avatar.bodyArrays().positions).toEqual(body);
    expect(avatar.jacketPositions()).toEqual(jacket);
    expect(avatar.previewStretch()).toEqual(stretch);
    avatar.setDrivers(result.drivers.slice(), result.world);
    expect(avatar.version).toBe(version);
    avatar.applyPose(pose(0.4), 400);
    expect(avatar.version).toBeGreaterThan(version);
    avatar.dispose();
  });

  it('restores the live target after physics even when drivers did not change', () => {
    const avatar = make(false);
    avatar.applyPose(pose(0), 0);
    const target = avatar.skinnedJacketPositions()!.slice();
    const frame = target.map((value) => value + 0.01);
    avatar.setDeformBypass(true);
    avatar.setJacketPositions(frame);
    avatar.setDeformBypass(false);
    avatar.applyPose(pose(0), 33);
    expect(avatar.jacketPositions()).toEqual(target);
    avatar.dispose();
  });

  it('holds and returns to a standing body when tracking disappears with unseen legs', () => {
    const avatar = make(false);
    const neutral = liveNeutral(avatar.live.rig.neutralPose);
    const smoother = new PoseSmoother();
    // Kiosk confidence excludes unseen hip/knee DOFs even when the tracker guesses a crouch.
    const raw = {
      ...neutral,
      shoulder_L_elevation: 60,
      hip_L_flexion: 100,
      hip_R_flexion: 100,
      knee_L_flexion: 120,
      knee_R_flexion: 120,
    };
    const confidence = Object.fromEntries(
      Object.keys(neutral)
        .filter((key) => !/^(hip|knee)_/.test(key))
        .map((key) => [key, 1]),
    );
    avatar.applyPose(smoother.update(0, raw, confidence, neutral).pose, 0);
    for (let t = 100; t <= 2000; t += 100) {
      avatar.applyPose(smoother.update(t, null, {}, neutral).pose, t);
      for (const key of ['hip_L_flexion', 'hip_R_flexion', 'knee_L_flexion', 'knee_R_flexion'])
        expect(avatar.last.pose[key]).toBe(neutral[key]);
      const expected = skinVertices(
        avatar.live.rig,
        avatar.last.drivers,
        new Float32Array(avatar.bodyArrays().positions.length),
      );
      expect(avatar.bodyArrays().positions).toEqual(expected);
    }
    avatar.dispose();
  });
});
