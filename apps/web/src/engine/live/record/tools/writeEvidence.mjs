// Turns a V3 evaluation (gitignored .cache/v3/eval-<label>.json from videoEval.mjs, and optional
// .cache/v3/<name>.json from bakeNode.mjs) into the committed evidence
// docs/validation/tryon-physics-eval.json: NUMBERS ONLY. No pose stream, no per-frame series, no
// images, no body figures or ids (the person's height/weight stay in the gitignored toi.txt).
//   node apps/web/src/engine/live/record/tools/writeEvidence.mjs --eval run1 [--node synth-held,...]
//        [--assess-reach_up_both "..."] [--assess-cross_arms "..."]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const safe = (s) => {
  if (!/^[a-z0-9-]{1,32}$/.test(s)) throw new Error(`bad name ${s}`);
  return s;
};
const read = (name) => JSON.parse(readFileSync(join(root, '.cache/v3', `${name}.json`), 'utf8'));
const evalRun = read(`eval-${safe(opt('--eval'))}`);
const nodeRuns = (opt('--node', '') || '')
  .split(',')
  .filter(Boolean)
  .map((n) => ({ name: safe(n), ...read(n) }));

const OBSERVATION = {
  reach_up_both:
    'Video index (docs/look/video-index.md), parka 47-50 s: "Hem rides up to about hip height at 48-49", sleeves taut, no bunching at the elbow.',
  reach_up_both_final:
    'Video index, parka 213-218 s (front view): "same behaviour as 47-50; hem rises to the hip at 215".',
  cross_arms:
    'Video index, parka 66-68 s: sleeves bunch into thick folds at the elbow crease and forearm, upper fronts bulge around the arms, zip line stays straight below (no hem observation).',
};

const r1 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(1)) : x);
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(2)) : x);
const map = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

const moves = evalRun.moves.map((m) => {
  if (m.refusedRecording)
    return {
      id: m.id,
      label: m.label,
      videoWindowS: [m.from, m.to],
      refusedBeforeBaking: m.refusedRecording,
      peakJointSpeed: m.trace?.peakJointSpeed
        ? { degS: Math.round(m.trace.peakJointSpeed.degS), joint: m.trace.peakJointSpeed.joint }
        : null,
      heldAtNeutral: (m.trace?.neutral ?? []).map((d) => ({
        dof: d.dof,
        estimatedShare: r2(d.share),
      })),
      observation: OBSERVATION[m.id] ?? null,
      assessment: opt(`--assess-${m.id}`, null),
    };
  const n = m.numbers;
  const t = m.bake.timings ?? {};
  return {
    id: m.id,
    label: m.label,
    videoWindowS: [m.from, m.to],
    tracking: {
      poses: m.poses,
      framesInWindow: m.trace.frames,
      trackedFrames: m.trace.tracked,
      keptDofs: m.trace.kept,
      heldAtNeutral: m.trace.neutral.map((d) => ({
        dof: d.dof,
        estimatedShare: r2(d.share),
        longestGapMs: Math.round(d.longestGapMs),
      })),
      recordedDurationMs: Math.round(m.trace.durationMs),
      longestGapMs: Math.round(m.trace.longestGapMs),
      clampedValues: m.trace.clamped,
    },
    measuredPeakAnglesDeg: m.peakPose,
    bake: {
      recordingToBakedMs: Math.round(t.totalMs ?? m.bake.wallMs),
      workerBakeMs: Math.round(t.bakeMs ?? 0),
      customFramesMs: Math.round(t.framesMs ?? 0),
      loadMs: Math.round(t.loadMs ?? 0),
      relaxCached: t.relaxCached,
      solverSteps: t.steps,
      subdivision: t.subdivision
        ? {
            factor: t.subdivision.factor,
            peakJointSpeedMs: r2(t.subdivision.peakSpeedMs),
            peakJoint: t.subdivision.peakJoint,
            stepTravelCm: r2(t.subdivision.stepTravelM * 100),
            capped: t.subdivision.capped,
          }
        : null,
      progressMonotonic: m.bake.progressMonotonic,
      frames: n.frames,
      recordedFrames: n.recordedFrames,
    },
    sleeveGate: {
      valid: m.sleeves.valid,
      reason: m.sleeves.reason,
      forearmCm: map(m.sleeves.forearmCm, r1),
      maxRideUpCm: map(m.sleeves.maxRideUpCm, r1),
      maxCuffToWristCm: map(m.sleeves.maxCuffToWristCm, r1),
    },
    physics: m.sleeves.valid
      ? {
          note: 'mid waistband (contract default); hem heights are the hem above the given body line along the local torso up, front/back centre; "rise" = change from the neutral frame',
          neutralHemAboveHipCm: n.neutral.hemAboveHipCm,
          neutralHemAboveMidWaistbandCm: n.neutral.hemAboveMidWaistbandCm,
          peak: map(n.peak, (p) => ({ value: p.value, atS: p.t_s })),
          restrictionPeakShareRise: n.restriction
            .map((r) => ({ zone: r.zone, rise: r2(r.peakShare - r.neutralShare) }))
            .filter((r) => r.rise > 0.005),
          checks: n.checks,
        }
      : { withheld: 'sleeve gate failed: no physical numbers are reported for this bake' },
    observation: OBSERVATION[m.id] ?? null,
    assessment: opt(`--assess-${m.id}`, null),
  };
});

const hemRuns = (opt('--hem', '') || '')
  .split(',')
  .filter(Boolean)
  .flatMap((n) => read(safe(n)).results.map((r) => ({ round: n, ...r })));
const hemLift = hemRuns.length
  ? {
      question: 'Why does the simulated hem rise only 5-10 cm on reach_up_both?',
      realObserved: {
        method:
          'By eye on the local, gitignored 1 fps frames (31 s neutral vs 48 s arms overhead), stable camera; the pixel scale comes from the person own figures, which stay local. Relative rises only, +-3 cm.',
        hemRiseCm: 23,
        collarRiseCm: 9,
      },
      simulated:
        'preset reach_up_both on the same fitted body, parka S, hoodie layer; mean over the hold',
      variants: hemRuns.map((r) => ({
        round: r.round,
        variant: r.variant,
        override: r.config,
        hemRiseCm: { front: r.hemRiseCm.front, back: r.hemRiseCm.back, sides: r.hemRiseCm.sides },
        yokeLiftCm: r.yokeLiftCm,
        collarRiseCm: r.collarRiseCm ?? null,
        restHemAboveHipFrontCm: r.hemAboveHipCm?.neutral ?? null,
        bakeS: r.bakeS,
        sleevesStayOn: r.sleeves.valid,
        maxRideUpCm: r.sleeves.maxRideUpCm,
        maxStrain: r.checks.maxStrain,
        peakStrainZone: r.zonePeakStrain
          ? Object.entries(r.zonePeakStrain).sort((a, b) => b[1] - a[1])[0][0]
          : null,
      })),
    }
  : null;

const evidence = {
  what: 'V3 "Record a move": true cloth physics baked on a recorded pose sequence from the user\'s own video, on the user\'s own fitted body (figures in the gitignored data/reference-photos/toi.txt; not committed)',
  generatedBy: 'apps/web/src/engine/live/record/tools/videoEval.mjs + writeEvidence.mjs',
  date: new Date().toISOString().slice(0, 10),
  garmentAssetVersion:
    evalRun.moves
      .find((m) => m.assetKey)
      ?.assetKey.split(':')
      .slice(2)
      .join(':') ?? null,
  garment: {
    style: 'FB7675-100 parka',
    size: 'size the user wears (toi.txt)',
    underLayer: 'hoodie preset (the video shows a grey hoodie)',
  },
  video:
    'data/reference-photos/FB7675-100-parka-trang/video/video-parka.mp4 (gitignored), tracked in Chrome by the live pipeline (MediaPipe pose → PosePipeline One Euro → LiveFrame), neutral calibration on a front stand frame',
  tracking: {
    frames: evalRun.tracking.frames,
    tracked: evalRun.tracking.tracked,
    trackerInferenceHz: evalRun.tracking.tracker?.inferenceHz ?? null,
    warmUpMs: evalRun.tracking.warmMs ?? null,
    freeRamAtLockGiB: evalRun.freeRamAtLockGiB ?? null,
  },
  moves,
  hemLift,
  parity: (opt('--parity-from') ? read(`eval-${safe(opt('--parity-from'))}`) : evalRun).parity,
  nodeExperiments: nodeRuns.map((r) => ({
    name: r.name,
    source: r.source,
    subdivision: {
      factor: r.subdivision.factor,
      peakJointSpeedMs: r2(r.subdivision.peakSpeedMs),
    },
    runs: r.runs.map((x) => ({
      factor: x.factor,
      sleevesStayOn: x.sleeves.valid,
      maxRideUpCm: map(x.sleeves.maxRideUpCm, r1),
      bakeS: r1(x.timings.totalMs / 1000),
      steps: x.timings.steps,
      ...(x.hem
        ? {
            hem: {
              neutralAboveHipCm: map(x.hem.neutralAboveHipCm, r1),
              peakAboveHipCm: map(x.hem.peakAboveHipCm, r1),
              riseCm: map(x.hem.riseCm, r1),
              peakS: r2(x.hem.peakS),
            },
            exposureMidCm: map(x.exposureMid, r1),
            assetKey: x.assetKey?.split(':').slice(1).join(':'),
          }
        : {}),
    })),
  })),
};
writeFileSync(
  join(root, 'docs/validation/tryon-physics-eval.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log('wrote docs/validation/tryon-physics-eval.json');
