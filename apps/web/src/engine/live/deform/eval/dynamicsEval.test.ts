// V6 evaluation of the live dynamics (run on demand, never in the normal suite):
//   V6_EVAL=1 npx vitest run src/engine/live/deform/eval/dynamicsEval.test.ts
// Inputs: the public reference body and the two jackets' cloth assets (.cache/motion-fit, the P2
// fixture) and the user's recorded live sessions (data/reference-photos/live-diag/*.json: per-frame
// final poses, receive times and V2's drawn heading). Output: numbers only, .cache/v6/eval-*.json
// (gitignored). Nothing of the user's is written anywhere else.
import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../../../api';
import type { AnatomicalPose } from '../../../motion/rig';
import { parseRig } from '../../../motion/rig';
import { decodeSatb } from '../../../motion/satb';
import { fixtureAvailable, fixtureBuffer, fixtureJson } from '../../../motion/testFixture';
import { LiveAvatar } from '../../LiveAvatar';
import { createLiveRig } from '../../liveRig';
import type { DynamicsDeformer } from '../DynamicsDeformer';
import { DYNAMICS } from '../config';
import { plausibleHeading, YawFilter } from '../heading';
import { BodySdf, insideByParity } from './sdf';

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
const OUT = `${ROOT}.cache/v6/`;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const run = !!env.V6_EVAL;
/** V6_QUICK=1: the parka on one recorded session only (timing iterations). */
const quick = !!env.V6_QUICK;
/** V6_FAST=1: the parka on every session, no penetration checks, no timing repeats. */
const fast = !!env.V6_FAST;
/** V6_HEADING=1 feeds V2's recorded heading in the session replays (the engine's ?dynyaw=1);
 * default: as the engine (DYNAMICS.headingDefaultOn). Synthetic turns always feed theirs. */
const feedHeading = env.V6_HEADING === undefined ? DYNAMICS.headingDefaultOn : env.V6_HEADING === '1';

type DiagFrame = {
  receivedAt: number;
  landmarks2d: { x: number; y: number }[] | null;
  posed: { final: AnatomicalPose } | null;
  ar: { yawDrawnDeg?: number; tracked?: boolean; backView?: boolean } | null;
};

const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const r = (v: number, k = 2) => Math.round(v * 10 ** k) / 10 ** k;

describe.skipIf(!run || !fixtureAvailable('rig.bin', 'cloth-FB-M.json', 'cloth-DQ-M.json'))(
  'V6 dynamics evaluation',
  () => {
    const buffer = fixtureBuffer('rig.bin');
    const rig = parseRig(buffer);
    const header = decodeSatb(buffer, 'rig').header as unknown as { parents: number[] };
    const live = createLiveRig(rig, header.parents);
    const jackets: Record<string, string> = quick
      ? { parka: 'cloth-FB-M.json' }
      : { parka: 'cloth-FB-M.json', puffer: 'cloth-DQ-M.json' };

    const make = (file: string) => {
      const avatar = new LiveAvatar(live, { deformers: { dynamics: true, poseCorrectives: false } });
      avatar.setGarment(fixtureJson<ClothAsset>(file), { size: 'M' });
      const dyn = avatar.deformers.get<DynamicsDeformer>('dynamics')!;
      return { avatar, dyn, info: dyn.binding! };
    };

    /** Replays timed poses + headings; returns per-frame metrics. */
    function replay(
      file: string,
      frames: { t: number; pose: AnatomicalPose; yaw: number | null; spanRatio?: number | null }[],
      options: { penetrationEvery?: number; label: string },
    ) {
      const { avatar, dyn, info } = make(file);
      const md = info.map.maxDist;
      const moving = info.proxy.moving;
      const hem = (fixtureJson<ClothAsset>(file).paths.hem ?? []) as number[];
      const filter = new YawFilter();
      const ms: number[] = [],
        sim: number[] = [],
        fine: number[] = [],
        hemDisp: number[] = [],
        stillJitter: number[] = [],
        targetStillJitter: number[] = [];
      const cuffs = [...((fixtureJson<ClothAsset>(file).paths.cuff_L ?? []) as number[]), ...((fixtureJson<ClothAsset>(file).paths.cuff_R ?? []) as number[])];
      const cuffDisp: number[] = [];
      const msAll: number[] = [];
      let heldDev = 0,
        overshoot = 0,
        penNew = 0,
        penTarget = 0,
        insideDrift = 0,
        parityChecks = 0,
        teleports = 0,
        resetNodes = 0,
        nonFinite = 0;
      const reasons: Record<string, number> = {};
      let prevOffset: Float32Array | null = null;
      let prevPose: AnatomicalPose | null = null;
      let prevSkinned: Float32Array | null = null;
      frames.forEach((fr, k) => {
        // As the engine: ambiguous headings (size vs the image shoulder span) are null.
        avatar.rootYawDeg = filter.update(fr.t, plausibleHeading(fr.yaw, fr.spanRatio ?? null));
        avatar.applyPose(fr.pose, fr.t);
        const s = dyn.lastFrame;
        resetNodes += s.resetNodes;
        msAll.push(s.teleported ? NaN : dyn.status().lastApplyMs);
        if (s.teleported) {
          teleports++;
          const key = s.reason.replace(/[\d.]+ (ms|cm)/, '').trim();
          reasons[key] = (reasons[key] ?? 0) + 1;
        } else {
          ms.push(dyn.status().lastApplyMs);
          sim.push(s.simMs);
          fine.push(s.fineMs);
        }
        const disp = avatar.jacketPositions()!,
          skin = avatar.skinnedJacketPositions()!;
        for (let i = 0; i < disp.length; i++) if (!Number.isFinite(disp[i])) nonFinite++;
        for (let i = 0; i < md.length; i++) {
          const d = Math.hypot(
            disp[i * 3] - skin[i * 3],
            disp[i * 3 + 1] - skin[i * 3 + 1],
            disp[i * 3 + 2] - skin[i * 3 + 2],
          );
          if (md[i] === 0) heldDev = Math.max(heldDev, d);
          else overshoot = Math.max(overshoot, d - md[i]);
        }
        let h = 0;
        for (const i of hem)
          h += Math.hypot(
            disp[i * 3] - skin[i * 3],
            disp[i * 3 + 1] - skin[i * 3 + 1],
            disp[i * 3 + 2] - skin[i * 3 + 2],
          );
        hemDisp.push(hem.length ? h / hem.length : 0);
        let cu = 0;
        for (const i of cuffs)
          cu += Math.hypot(
            disp[i * 3] - skin[i * 3],
            disp[i * 3 + 1] - skin[i * 3 + 1],
            disp[i * 3 + 2] - skin[i * 3 + 2],
          );
        cuffDisp.push(cuffs.length ? cu / cuffs.length : 0);
        // Still frames: every DOF moved < 0.5 deg since the last frame (the person stands still).
        const offset = new Float32Array(moving.length * 3);
        moving.forEach((i, m) => {
          for (let a = 0; a < 3; a++) offset[m * 3 + a] = disp[i * 3 + a] - skin[i * 3 + a];
        });
        if (prevPose && prevOffset && prevSkinned) {
          let still = true;
          for (const key of Object.keys(fr.pose))
            if (Math.abs((fr.pose[key] ?? 0) - (prevPose[key] ?? 0)) > 0.5) still = false;
          if (still) {
            // Frame-to-frame motion of what is shown vs of the target: the dynamics must not add.
            let sum = 0,
              sumT = 0;
            moving.forEach((i, m) => {
              let dd = 0,
                dt = 0;
              for (let a = 0; a < 3; a++) {
                const prevDisplay = prevSkinned![i * 3 + a] + prevOffset![m * 3 + a];
                dd += (disp[i * 3 + a] - prevDisplay) ** 2;
                dt += (skin[i * 3 + a] - prevSkinned![i * 3 + a]) ** 2;
              }
              sum += dd;
              sumT += dt;
            });
            stillJitter.push(Math.sqrt(sum / moving.length));
            targetStillJitter.push(Math.sqrt(sumT / moving.length));
          }
        }
        prevOffset = offset;
        prevPose = fr.pose;
        prevSkinned = skin.slice();
        if (!fast && options.penetrationEvery && k % options.penetrationEvery === 0) {
          const body = avatar.bodyArrays();
          const sdf = new BodySdf(body.positions, body.normals, live.rig.faces);
          // Distance from the exact closest point; inside/outside from the pseudonormal, and
          // every "inside" re-checked by ray parity (the posed mesh self-intersects at bent
          // elbows, where the pseudonormal sign is wrong).
          const faces = live.rig.faces;
          for (const i of moving) {
            const dD = sdf.distance(disp[i * 3], disp[i * 3 + 1], disp[i * 3 + 2]);
            const dT = sdf.distance(skin[i * 3], skin[i * 3 + 1], skin[i * 3 + 2]);
            if (!(dD < 0 || dT < 0)) continue;
            parityChecks++;
            const inD = insideByParity(body.positions, faces, disp[i * 3], disp[i * 3 + 1], disp[i * 3 + 2]);
            const inT = insideByParity(body.positions, faces, skin[i * 3], skin[i * 3 + 1], skin[i * 3 + 2]);
            const depthD = inD && Number.isFinite(dD) ? Math.abs(dD) : 0,
              depthT = inT && Number.isFinite(dT) ? Math.abs(dT) : 0;
            penTarget = Math.max(penTarget, depthT);
            if (!inT) penNew = Math.max(penNew, depthD);
            else insideDrift = Math.max(insideDrift, depthD - depthT);
          }
        }
      });
      return {
        msSeries: msAll,
        label: options.label,
        frames: frames.length,
        seconds: r((frames[frames.length - 1].t - frames[0].t) / 1000, 1),
        msPerFrame: { mean: r(mean(ms), 3), p95: r(quantile(ms, 0.95), 3), max: r(Math.max(...ms), 3) },
        simMs: { mean: r(mean(sim), 3), p95: r(quantile(sim, 0.95), 3) },
        fineMs: { mean: r(mean(fine), 3), p95: r(quantile(fine, 0.95), 3) },
        heldDeviationMm: heldDev * 1000,
        maxDistanceOvershootMm: r(Math.max(0, overshoot) * 1000, 3),
        penetrationMm: {
          // The gate: a particle whose target is outside the body, shown inside it.
          newByDynamics: r(penNew * 1000),
          // LBS already sinks these targets (bent elbows): how much deeper the dynamics took them.
          insideTargetsDeeper: r(Math.max(0, insideDrift) * 1000),
          skinnedTargetMax: r(penTarget * 1000),
          parityChecks,
        },
        stillFrames: stillJitter.length,
        stillDisplayMotionMmRms: r(mean(stillJitter) * 1000, 3),
        stillTargetMotionMmRms: r(mean(targetStillJitter) * 1000, 3),
        cuffMeanDisplacementCm: {
          mean: r(mean(cuffDisp) * 100),
          p95: r(quantile(cuffDisp, 0.95) * 100),
          max: r(Math.max(...cuffDisp) * 100),
        },
        resetNodes,
        hemMeanDisplacementCm: {
          mean: r(mean(hemDisp) * 100),
          p95: r(quantile(hemDisp, 0.95) * 100),
          max: r(Math.max(...hemDisp) * 100),
        },
        teleports,
        teleportReasons: reasons,
        nonFinite,
        bind: {
          ms: r(info.bindMs, 0),
          nodes: info.proxy.count,
          moving: moving.length,
          hemMaxCm: r(info.map.summary.hemMaxM * 100),
        },
        hemSeries: hemDisp,
      };
    }

    const diagFrames = (name: string) => {
      const d = JSON.parse(fs.readFileSync(`${DIAG}${name}`, 'utf8')) as { frames: DiagFrame[] };
      // The engine's shoulder-span ratio (LiveTryOnEngine.outOfRange: decaying frontal maximum).
      let frontal = 0;
      const out: { t: number; pose: AnatomicalPose; yaw: number | null; spanRatio: number | null }[] = [];
      for (const f of d.frames) {
        const l = f.landmarks2d;
        let spanRatio: number | null = null;
        if (l && l.length >= 17) {
          const span = Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y);
          frontal = Math.max(span, frontal * 0.9977);
          spanRatio = frontal > 0 ? span / frontal : null;
        }
        if (!f.posed) continue;
        out.push({
          t: f.receivedAt,
          pose: f.posed.final,
          yaw:
            feedHeading && f.ar?.tracked && Number.isFinite(f.ar.yawDrawnDeg) ? f.ar.yawDrawnDeg! : null,
          spanRatio,
        });
      }
      return out;
    };

    /** Settle time after `from` (s) of a series sampled at `fps`: last time above `limit`. */
    const settle = (series: number[], fps: number, from: number, limit: number) => {
      let last = from - 1;
      for (let k = from; k < series.length; k++) if (series[k] >= limit) last = k;
      return r((last + 1 - from) / fps, 2);
    };

    it('replays the recorded live sessions and synthetic moves', () => {
      const results: Record<string, unknown> = {};
      const all = fs.existsSync(DIAG) ? fs.readdirSync(DIAG).filter((f) => f.endsWith('.json')) : [];
      const files = quick ? all.slice(1, 2) : all;
      if (fast) for (const k of Object.keys(jackets)) if (k !== 'parka') delete jackets[k];
      for (const [jacket, file] of Object.entries(jackets)) {
        for (const name of files) {
          const res = replay(file, diagFrames(name), { penetrationEvery: 5, label: `${jacket} ${name}` });
          const { hemSeries, msSeries, ...rest } = res;
          void hemSeries;
          // Contention-robust timing: the per-frame minimum over this run and two repeats (other
          // agents share this CPU; the kiosk will not).
          const repeats = [msSeries, ...(fast ? [] : [0, 1]).map(() => replay(file, diagFrames(name), { label: 'repeat' }).msSeries)];
          const minMs = msSeries.map((_, k) => Math.min(...repeats.map((r) => r[k]))).filter(Number.isFinite);
          results[`${jacket}:${name}`] = {
            ...rest,
            msPerFrameMinOf3: { mean: r(mean(minMs), 3), p95: r(quantile(minMs, 0.95), 3), max: r(Math.max(...minMs), 3) },
          };
          console.log(JSON.stringify(results[`${jacket}:${name}`]));
          // Control: the same session without the heading (body turns not fed).
          const noYaw = replay(file, diagFrames(name).map((f) => ({ ...f, yaw: null })), { label: `${jacket} ${name} no-heading` });
          results[`${jacket}:${name}:noHeading`] = { hemMeanDisplacementCm: noYaw.hemMeanDisplacementCm, cuffMeanDisplacementCm: noYaw.cuffMeanDisplacementCm };
        }
        if (quick || fast) continue;
        // Synthetic moves at 20 fps (the kiosk camera's 14-26 fps).
        const fps = 20;
        const neutral = { ...rig.neutralPose, shoulder_L_elevation: 8, shoulder_R_elevation: 8 };
        const seq = (n: number, f: (t: number) => { pose: AnatomicalPose; yaw: number | null }) =>
          Array.from({ length: n }, (_, k) => ({ t: (k * 1000) / fps, ...f(k / fps) }));
        const ease = (t: number, t0: number, t1: number) =>
          t <= t0 ? 0 : t >= t1 ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (t - t0)) / (t1 - t0));
        const synthetic = {
          // A body turn of 90 deg in 0.6 s (heading only: the avatar never yaws), then still.
          turn90: seq(80, (t) => ({ pose: neutral, yaw: 90 * ease(t, 0.5, 1.1) })),
          // A fast 45 deg turn in 0.3 s and back.
          turn45back: seq(100, (t) => ({ pose: neutral, yaw: 45 * (ease(t, 0.5, 0.8) - ease(t, 1.6, 1.9)) })),
          // Trunk twist 13 deg (the largest recorded) in 0.3 s.
          twist: seq(80, (t) => ({ pose: { ...neutral, trunk_twist: 13 * ease(t, 0.5, 0.8) }, yaw: 0 })),
          // Arm swing: both arms 8 -> 90 -> 8 deg over 0.8 s.
          armSwing: seq(80, (t) => {
            const e = 82 * (ease(t, 0.5, 0.9) - ease(t, 0.9, 1.3));
            return {
              pose: { ...neutral, shoulder_L_elevation: 8 + e, shoulder_R_elevation: 8 + e },
              yaw: 0,
            };
          }),
          // Standing still with tracking noise (0.7 deg on the arms, 0.4 deg on the trunk,
          // 2 deg on the heading; deterministic pseudo-random).
          restNoise: (() => {
            let seed = 7;
            const rnd = () => {
              seed = (seed * 16807) % 2147483647;
              return (seed / 2147483647) * 2 - 1;
            };
            return seq(200, () => ({
              pose: {
                ...neutral,
                shoulder_L_elevation: 8 + 0.7 * rnd(),
                shoulder_R_elevation: 8 + 0.7 * rnd(),
                elbow_L_flexion: 10 + 0.7 * rnd(),
                elbow_R_flexion: 10 + 0.7 * rnd(),
                trunk_flexion: 0.4 * rnd(),
                trunk_lateral: 0.4 * rnd(),
              },
              yaw: 2 * rnd(),
            }));
          })(),
        };
        for (const [name, frames] of Object.entries(synthetic)) {
          const res = replay(file, frames, { penetrationEvery: 4, label: `${jacket} ${name}` });
          const { hemSeries, msSeries, ...rest } = res;
          void msSeries;
          const peak = Math.max(...hemSeries);
          const stop = name === 'turn45back' ? Math.round(1.9 * fps) : name === 'armSwing' ? Math.round(1.3 * fps) : Math.round((name === 'restNoise' ? 0 : name === 'twist' ? 0.8 : 1.1) * fps);
          results[`${jacket}:${name}`] = {
            ...rest,
            hemPeakCm: r(peak * 100),
            settleS: {
              below2mm: settle(hemSeries, fps, stop, 0.002),
              below10pct: settle(hemSeries, fps, stop, 0.1 * peak),
              below1mm: settle(hemSeries, fps, stop, 0.001),
            },
          };
          console.log(name, JSON.stringify(results[`${jacket}:${name}`]));
        }
        // Soak: 5 minutes of the recorded sessions back to back (times continued).
        const sessions = files.map((f) => diagFrames(f));
        const soak: { t: number; pose: AnatomicalPose; yaw: number | null }[] = [];
        let offset = 0;
        while (soak.length === 0 || soak[soak.length - 1].t < 300_000) {
          for (const session of sessions) {
            const t0 = session[0].t;
            for (const f of session) soak.push({ ...f, t: offset + (f.t - t0) });
            offset = soak[soak.length - 1].t + 50;
          }
          if (soak.length > 20000) break;
        }
        const res = replay(file, soak, { penetrationEvery: 50, label: `${jacket} soak` });
        const { hemSeries, msSeries, ...rest } = res;
        void hemSeries;
        void msSeries;
        results[`${jacket}:soak5min`] = rest;
        console.log('soak', JSON.stringify(rest));
      }
      fs.mkdirSync(OUT, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      results.settings = { feedHeading, quick, fast };
      fs.writeFileSync(`${OUT}eval-${stamp}.json`, JSON.stringify(results, null, 1));
      console.log(`wrote ${OUT}eval-${stamp}.json`);
      expect(Object.keys(results).length).toBeGreaterThan(0);
    }, 1_800_000);
  },
);
