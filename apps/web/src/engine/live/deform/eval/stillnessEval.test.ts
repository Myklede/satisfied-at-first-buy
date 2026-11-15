// V6: stillness at rest, before/after (run on demand: V6_EVAL=1). Replays the final poses of the
// user's recorded live sessions on the public fixture body (parka M) with the stillness lock off
// (as recorded) and on, dynamics off and on, and measures the shown jacket's per-frame vertex
// motion on still stretches and the motion-onset lag. Numbers only, to .cache/v6/stillness-*.json.
import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../../../api';
import type { AnatomicalPose } from '../../../motion/rig';
import { parseRig } from '../../../motion/rig';
import { decodeSatb } from '../../../motion/satb';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../../../motion/testFixture';
import { LiveAvatar } from '../../LiveAvatar';
import { StillnessLock } from '../../livePose';
import { createLiveRig } from '../../liveRig';

type Fs = {
  existsSync(p: string): boolean;
  readFileSync(p: string, e: 'utf8'): string;
  readdirSync(p: string): string[];
  mkdirSync(p: string, o: { recursive: boolean }): void;
  writeFileSync(p: string, s: string): void;
};
const fsName = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsName)) as Fs;
const ROOT = new URL('../../../../../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIAG = `${ROOT}data/reference-photos/live-diag/`;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DOFS = [
  'trunk_flexion',
  'trunk_lateral',
  'trunk_twist',
  'shoulder_L_plane',
  'shoulder_L_elevation',
  'shoulder_L_axial',
  'elbow_L_flexion',
  'shoulder_R_plane',
  'shoulder_R_elevation',
  'shoulder_R_axial',
  'elbow_R_flexion',
];
/** A still stretch: every DOF stays within this range (deg) over at least STILL_MS. */
const STILL_RANGE_DEG = 5;
const STILL_MS = 800;

describe.skipIf(!env.V6_EVAL || !fixtureAvailable('rig.bin', 'cloth-FB-M.json'))('V6 stillness', () => {
  it('measures the jacket at rest, lock off vs on, dynamics off vs on', () => {
    const buffer = fixtureBuffer('rig.bin');
    const rig = parseRig(buffer);
    const header = decodeSatb(buffer, 'rig').header as unknown as { parents: number[] };
    const live = createLiveRig(rig, header.parents);
    const asset = fixtureJson<ClothAsset>('cloth-FB-M.json');
    const results: Record<string, unknown> = {};
    for (const name of fs.readdirSync(DIAG).filter((f) => f.endsWith('.json'))) {
      const d = JSON.parse(fs.readFileSync(`${DIAG}${name}`, 'utf8')) as {
        frames: { receivedAt: number; phase: string; posed: { final: AnatomicalPose } | null }[];
      };
      const frames = d.frames.filter((f) => f.posed && f.phase === 'tracking');
      // Still stretches from the recorded (unlocked) final pose.
      // still[k] = ms since the still stretch containing frame k began (0 = not still).
      const still = new Float64Array(frames.length);
      for (let a = 0; a < frames.length; a++) {
        let b = a;
        const lo = new Map<string, number>(),
          hi = new Map<string, number>();
        for (; b < frames.length; b++) {
          let ok = true;
          for (const k of DOFS) {
            const v = frames[b].posed!.final[k] ?? 0;
            lo.set(k, Math.min(lo.get(k) ?? v, v));
            hi.set(k, Math.max(hi.get(k) ?? v, v));
            if (hi.get(k)! - lo.get(k)! > STILL_RANGE_DEG) ok = false;
          }
          if (!ok) break;
        }
        if (frames[b - 1].receivedAt - frames[a].receivedAt >= STILL_MS)
          for (let k = a + 1; k < b; k++)
            still[k] = Math.max(still[k], frames[k].receivedAt - frames[a].receivedAt);
      }
      const run = (lockOn: boolean, dynamics: boolean) => {
        const avatar = new LiveAvatar(live, { deformers: { dynamics, poseCorrectives: false } });
        avatar.setGarment(asset, { size: 'M' });
        const lock = new StillnessLock();
        let prev: Float32Array | null = null;
        let sum = 0,
          count = 0,
          maxFrame = 0;
        const settled = { s300: [0, 0], s800: [0, 0] };
        const motion: number[] = [];
        const outputs: AnatomicalPose[] = [];
        frames.forEach((f, k) => {
          const pose = lockOn ? lock.apply(f.receivedAt, f.posed!.final) : f.posed!.final;
          outputs.push(pose);
          avatar.applyPose(pose, f.receivedAt);
          const p = avatar.jacketPositions()!;
          if (prev && still[k]) {
            let s = 0;
            for (let i = 0; i < p.length; i += 3)
              s += (p[i] - prev[i]) ** 2 + (p[i + 1] - prev[i + 1]) ** 2 + (p[i + 2] - prev[i + 2]) ** 2;
            const rms = Math.sqrt(s / (p.length / 3));
            sum += rms * rms;
            count++;
            if (still[k] >= 300) {
              settled.s300[0] += rms * rms;
              settled.s300[1]++;
            }
            if (still[k] >= 800) {
              settled.s800[0] += rms * rms;
              settled.s800[1]++;
            }
            maxFrame = Math.max(maxFrame, rms);
            motion.push(rms);
          }
          prev = p.slice();
        });
        return {
          stillFrames: count,
          vertexMotionRmsMm: count ? Math.sqrt(sum / count) * 1000 : null,
          worstFrameRmsMm: maxFrame * 1000,
          settled300: settled.s300[1] ? Math.sqrt(settled.s300[0] / settled.s300[1]) * 1000 : null,
          settled800: settled.s800[1] ? Math.sqrt(settled.s800[0] / settled.s800[1]) * 1000 : null,
          settledFrames: [settled.s300[1], settled.s800[1]],
          motion,
          outputs,
        };
      };
      const before = run(false, false),
        after = run(true, false),
        afterDyn = run(true, true),
        beforeDyn = run(false, true);
      // Motion onset lag: frames where a DOF's input first moves > 3 deg from where it rested
      // (after >= 250 ms still), and when the locked output first moves > 1 deg.
      const lags: number[] = [];
      for (const k of DOFS) {
        let restStart = 0;
        for (let f = 1; f < frames.length; f++) {
          const v = frames[f].posed!.final[k] ?? 0,
            r = frames[restStart].posed!.final[k] ?? 0;
          if (Math.abs(v - r) <= 1) continue;
          if (Math.abs(v - r) > 3 && frames[f - 1].receivedAt - frames[restStart].receivedAt >= 250) {
            const base = after.outputs[f - 1][k] ?? 0;
            let g = f;
            while (g < frames.length && Math.abs((after.outputs[g][k] ?? 0) - base) <= 1) g++;
            if (g < frames.length) lags.push(g - f);
          }
          restStart = f;
        }
      }
      const pct = (q: number) => {
        const s = [...lags].sort((a, b) => a - b);
        return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
      };
      const r2 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
      results[name] = {
        stillFrames: before.stillFrames,
        vertexMotionAtRestMm: {
          lockOffDynOff: r2(before.vertexMotionRmsMm),
          lockOnDynOff: r2(after.vertexMotionRmsMm),
          lockOnDynOn: r2(afterDyn.vertexMotionRmsMm),
          lockOffDynOn: r2(beforeDyn.vertexMotionRmsMm),
          worstFrameLockOnDynOff: r2(after.worstFrameRmsMm),
          worstFrameLockOnDynOn: r2(afterDyn.worstFrameRmsMm),
        },
        // Frames at least 300 / 800 ms into a still stretch (the lock engages after 250 ms).
        settledAtRestMm: {
          frames: before.settledFrames,
          lockOffDynOff: [r2(before.settled300), r2(before.settled800)],
          lockOnDynOff: [r2(after.settled300), r2(after.settled800)],
          lockOnDynOn: [r2(afterDyn.settled300), r2(afterDyn.settled800)],
        },
        // dynamics on minus off at rest, per frame (must be within 0.1 mm)
        dynOnMinusOffMaxMm: r2(
          Math.max(0, ...afterDyn.motion.map((m, k) => Math.abs(m - (after.motion[k] ?? 0)))) * 1000,
        ),
        onsetLagFrames: { n: lags.length, p50: pct(0.5), p90: pct(0.9), max: lags.length ? Math.max(...lags) : null },
      };
      console.log(name, JSON.stringify(results[name]));
    }
    fs.mkdirSync(`${ROOT}.cache/v6`, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    fs.writeFileSync(`${ROOT}.cache/v6/stillness-${stamp}.json`, JSON.stringify(results, null, 1));
    expect(Object.keys(results).length).toBeGreaterThan(0);
  }, 900_000);
});
