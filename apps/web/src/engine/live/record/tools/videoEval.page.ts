// V3 evaluation page (driven by videoEval.mjs): "Record a move" on a local reference video.
//   1. Track the video with the live pipeline (V1's video-file source: MediaPipe pose → PosePipeline
//      with its One Euro filter → LiveFrame), after the neutral calibration on a chosen frame.
//   2. Cut each move's window, turn it into poses (recordedPoses), bake it on the fitted body with
//      the real MoveBaker (body service custom frames → MotionClient worker → bake.ts, WebAssembly).
//   3. Parity: a preset baked as a preset and as a custom request built from its keyframes.
// The video is read in memory by MediaPipe and never drawn or stored; only numbers are returned.
import { api } from '../../../../api.ts';
import type { BakedMotion } from '../../../motion/bake.ts';
import { MotionClient } from '../../../motion/MotionClient.ts';
import type { LiveFrame, LiveTryOnOptions } from '../../contract.ts';
import type { StaticZone } from '../../readouts.ts';
import { createVideoFileSource } from '../../sources/videoFileSource.ts';
import { fetchCustomFrames } from '../customRequest.ts';
import type { RecordedBakedMove } from '../RecordedBakedMove.ts';
import { PhysicsInvalidError, RecordMoveBaker } from '../RecordMoveBaker.ts';
import {
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { BodyMotionLayer } from '../../../motion/BodyMotionLayer.ts';
import { MotionGarmentLayer } from '../../../motion/MotionGarmentLayer.ts';
import type { MotionData } from '../../../motion/MotionClient.ts';
import { anchorFrame } from '../../../motion/rig.ts';
import { cuffToWristCm } from '../RecordedBakedMove.ts';
import { recordedPoses, RecordingError } from '../recordedPoses.ts';

type Move = { id: string; label: string; from: number; to: number; renders?: boolean };
export type EvalConfig = {
  video: string;
  person: { height_cm: number; weight_kg: number; sex: 'male' | 'female' };
  productStyle: string;
  size: string;
  layer: string;
  calibrateAt: number;
  moves: Move[];
  parityPreset: string | null;
  delegate: 'GPU' | 'CPU';
};

declare global {
  interface Window {
    v3Eval?: (config: EvalConfig) => Promise<unknown>;
    v3Status?: string;
  }
}

const log = (message: string) => {
  window.v3Status = message;
  console.log(`[v3] ${message}`);
};

async function sha(parts: (ArrayBufferView | string)[]) {
  const chunks = parts.map((p) =>
    typeof p === 'string'
      ? new TextEncoder().encode(p)
      : new Uint8Array(p.buffer, p.byteOffset, p.byteLength),
  );
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Everything a bake returns except its motion id and timings (bakeCheck.mjs digest). */
const bakeDigest = (b: BakedMotion) =>
  sha([
    b.positions,
    b.strain,
    b.exposed,
    b.exposureVertices,
    JSON.stringify([b.metrics, b.summary, b.checks, b.frameCount]),
  ]);

const round = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

function moveNumbers(move: RecordedBakedMove) {
  const { start, end } = move.recorded;
  const series = [] as {
    frame: number;
    hemAboveHipCm: { front: number | null; back: number | null; sides: number | null };
    hemAboveMidCm: { front: number | null; back: number | null; sides: number | null };
    riseCm: { front: number | null; back: number | null; sides: number | null };
    exposureCm: { front: number; back: number; sides: number };
    rideUpCm: { left: number; right: number };
  }[];
  for (let f = 0; f < move.frameCount; f++) {
    const low = move.hem(f, 'low'),
      mid = move.hem(f, 'mid'),
      m = move.bakedMotion.metrics[f],
      m0 = move.bakedMotion.metrics[0];
    // The readouts' formulas, from the raw metrics (also for a bake that failed its gate).
    const floor = (cm: number) => (Number.isFinite(cm) && cm > 0.3 ? cm : 0);
    const hemMid = m.hemAboveCm.mid;
    const r3 = (v: { front: number; back: number; sides: number }) => ({
      front: round(v.front),
      back: round(v.back),
      sides: round(v.sides),
    });
    series.push({
      frame: f,
      hemAboveHipCm: r3(low.aboveCm),
      hemAboveMidCm: r3(mid.aboveCm),
      riseCm: r3(mid.riseCm),
      exposureCm: {
        front: floor(hemMid[0]),
        back: floor(hemMid[16]),
        sides: Math.max(floor(hemMid[8]), floor(hemMid[24])),
      },
      rideUpCm: {
        left: Math.max(0, m0.cuffBeyondWristCm.L - m.cuffBeyondWristCm.L),
        right: Math.max(0, m0.cuffBeyondWristCm.R - m.cuffBeyondWristCm.R),
      },
    });
  }
  const inside = series.slice(start, end + 1);
  const peak = (key: (s: (typeof series)[number]) => number | null) => {
    let best = -Infinity,
      frame = -1;
    for (const s of inside) {
      const v = key(s);
      if (v !== null && v > best) {
        best = v;
        frame = s.frame;
      }
    }
    return { value: round(best), frame, t_s: round(frame / move.fps, 3) };
  };
  const neutral = series[0];
  return {
    frames: move.frameCount,
    fps: move.fps,
    recordedFrames: { start, end },
    neutral: {
      hemAboveHipCm: neutral.hemAboveHipCm,
      hemAboveMidWaistbandCm: neutral.hemAboveMidCm,
    },
    peak: {
      hemRiseFrontCm: peak((s) => s.riseCm.front),
      hemRiseBackCm: peak((s) => s.riseCm.back),
      hemRiseSidesCm: peak((s) => s.riseCm.sides),
      hemAboveHipFrontCm: peak((s) => s.hemAboveHipCm.front),
      hemAboveHipBackCm: peak((s) => s.hemAboveHipCm.back),
      exposureFrontCm: peak((s) => s.exposureCm.front),
      exposureBackCm: peak((s) => s.exposureCm.back),
      exposureSidesCm: peak((s) => s.exposureCm.sides),
      rideUpLeftCm: peak((s) => s.rideUpCm.left),
      rideUpRightCm: peak((s) => s.rideUpCm.right),
    },
    restriction: move.summary.restriction.map((r) => ({
      zone: r.zone,
      peakStrain: round(r.peakStrain, 4),
      neutralShare: round(r.neutralShare, 4),
      peakShare: round(r.peakShare, 4),
    })),
    zonesAtPeakRise: move.readouts(peak((s) => s.riseCm.front).frame).zones,
    checks: {
      finite: move.checks.finite,
      maxPenetrationCm: round(move.checks.maxPenetrationCm),
      penetratingShare: round(move.checks.penetratingShare, 4),
      maxStrain: round(move.checks.maxStrain, 4),
    },
    series,
  };
}

/** Per-frame diagnostics of a bake: arm angles, wrist speed, cuff vs wrist. */
function diagnostics(move: RecordedBakedMove, data: MotionData, size: string) {
  const frames = move.motionFrames,
    bake = move.bakedMotion,
    asset = data.assets[size];
  const ring = (k: string) => {
    const path = asset.paths[k];
    return path[0] === path[path.length - 1] ? path.slice(0, -1) : path;
  };
  const cuffs = { L: ring('cuff_L'), R: ring('cuff_R') };
  const out = [];
  for (let f = 0; f < move.frameCount; f++) {
    const pose = frames.poses[f];
    const j = anchorFrame(frames, 'joints', f),
      jp = anchorFrame(frames, 'joints', Math.max(0, f - 1));
    const speed = (w: number) =>
      Math.hypot(j[w * 3] - jp[w * 3], j[w * 3 + 1] - jp[w * 3 + 1], j[w * 3 + 2] - jp[w * 3 + 2]) *
      move.fps;
    const away = cuffToWristCm(bake, frames, cuffs, f);
    const cuff = bake.metrics[f].cuffBeyondWristCm;
    out.push({
      f,
      elevL: round(pose.shoulder_L_elevation, 1),
      planeL: round(pose.shoulder_L_plane, 1),
      axialL: round(pose.shoulder_L_axial, 1),
      elbowL: round(pose.elbow_L_flexion, 1),
      elevR: round(pose.shoulder_R_elevation, 1),
      planeR: round(pose.shoulder_R_plane, 1),
      axialR: round(pose.shoulder_R_axial, 1),
      elbowR: round(pose.elbow_R_flexion, 1),
      wristSpeedMs: { L: round(speed(0)), R: round(speed(1)) },
      cuffBeyondWristCm: { L: round(cuff.L, 1), R: round(cuff.R, 1) },
      cuffToWristCm: { L: round(away.L, 1), R: round(away.R, 1) },
    });
  }
  return out;
}

/** Front and side renders of the baked avatar (no camera image; avatar + simulated cloth only). */
function renders(move: RecordedBakedMove, data: MotionData, size: string, picks: number[]) {
  const asset = data.assets[size];
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(360, 540, false);
  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 1.2));
  const key = new DirectionalLight(0xffffff, 2);
  key.position.set(-1, 3, 3);
  scene.add(key);
  const body = new BodyMotionLayer(data.rig);
  const cloth = new MotionGarmentLayer(
    asset.triangles,
    move.bakedMotion.particles,
    '#d8d6cf',
    asset.config.stretchMax ?? 1.1,
  );
  scene.add(body as Object3D, cloth as Object3D);
  const camera = new PerspectiveCamera(30, 360 / 540, 0.05, 30);
  const out: Record<string, string> = {};
  for (const f of picks) {
    body.pose(move.motionFrames, f / move.fps);
    cloth.show(move.bakedMotion, f);
    for (const [view, x, z] of [
      ['front', 0, 4.2],
      ['side', 4.2, 0.6],
    ] as const) {
      camera.position.set(x, 1.15, z);
      camera.lookAt(0, 1.05, 0);
      renderer.render(scene, camera);
      out[`f${String(f).padStart(3, '0')}-${view}`] = renderer.domElement.toDataURL('image/png');
    }
  }
  body.dispose();
  cloth.dispose();
  renderer.dispose();
  return out;
}

window.v3Eval = async (config: EvalConfig) => {
  const t0 = performance.now();
  log('fitting the body and the garment');
  const [capabilities, options, products] = await Promise.all([
    api.capabilities(),
    api.garmentOptions(),
    api.products(),
  ]);
  const product = products.find((p) => p.style === config.productStyle);
  if (!product) throw new Error(`Product ${config.productStyle} not in the catalogue`);
  const layer = options.layer_presets_cm[config.layer];
  if (layer === undefined) throw new Error(`No under-layer preset ${config.layer}`);
  const body = await api.fit({
    ...config.person,
    shape_reference: 'neutral',
    density_kg_m3: capabilities.default_density_kg_m3,
    known_measurements: {},
  });
  const garment = await api.garmentFit({
    body_id: body.body_id,
    product_id: product.product_id,
    layer_cm: layer,
    preference: 'regular',
  });
  const zones = garment.sizes[config.size]?.zones as Record<string, StaticZone> | undefined;
  if (!zones) throw new Error(`Size ${config.size} missing from the garment fit`);
  const liveOptions: LiveTryOnOptions = {
    bodyId: body.body_id,
    fitId: garment.fit_id,
    productId: product.product_id,
    size: config.size,
  };
  const client = new MotionClient(body.body_id, garment.fit_id, [config.size]);
  const baker = new RecordMoveBaker({ clientFor: () => client, staticZones: () => zones });

  // 0. Warm-up, as the live engine does while the user is being tracked (motion data, relax).
  log('warming the baker');
  const warmStarted = performance.now();
  await baker.warm(liveOptions);
  const warmMs = performance.now() - warmStarted;

  // 1. Track the video (real time, as the kiosk camera would be).
  log('tracking the video');
  const source = createVideoFileSource(config.video, {
    startAt: config.calibrateAt,
    loop: false,
    rate: 1,
    model: 'full',
    delegate: config.delegate,
  });
  const frames: { media: number; frame: LiveFrame }[] = [];
  let video: HTMLVideoElement | null = null;
  source.onFrame((frame) => {
    if (video) frames.push({ media: video.currentTime, frame });
  });
  await source.start();
  video = source.video;
  if (!video) throw new Error('No video element');
  const calibration = await source.calibrate();
  log(`calibrated at ${video.currentTime.toFixed(2)} s`);
  // Play through each window in time order; seek ahead (2 s pre-roll for the filters) when the
  // next window is far away.
  for (const move of [...config.moves].sort((a, b) => a.from - b.from)) {
    if (video.currentTime < move.from - 4) {
      video.currentTime = move.from - 2;
      log(`seek to ${(move.from - 2).toFixed(1)} s`);
    }
    await new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const check = setInterval(() => {
        if (video!.currentTime >= move.to + 0.3 || video!.ended) {
          clearInterval(check);
          resolve();
        } else if (performance.now() - started > (move.to - video!.currentTime + 30) * 1000) {
          clearInterval(check);
          reject(new Error('The video stalled'));
        }
      }, 100);
    });
  }
  const stats = source.stats();
  source.stop();
  const tracking = {
    frames: frames.length,
    tracked: frames.filter((f) => f.frame.pose).length,
    meanFps: round(
      frames.length / Math.max(1e-3, frames[frames.length - 1].media - frames[0].media),
      1,
    ),
    calibratedVertical: calibration ? 'yes' : 'no',
    tracker: stats,
    warmMs: round(warmMs, 0),
  };

  // 2. Each move: window → poses → bake (the real MoveBaker).
  const moves = [];
  for (const move of config.moves) {
    const window = frames.filter((f) => f.media >= move.from && f.media <= move.to);
    log(`${move.id}: ${window.length} frames, baking`);
    let recorded;
    try {
      recorded = recordedPoses(window.map((f) => f.frame));
    } catch (error) {
      if (!(error instanceof RecordingError)) throw error;
      // Refused before baking (tracking lost, implausible jump): reported, nothing baked.
      log(`${move.id}: recording refused: ${error.message}`);
      moves.push({ ...move, refusedRecording: error.message, trace: error.trace });
      continue;
    }
    const { poses, trace } = recorded;
    const progress: number[] = [];
    const started = performance.now();
    let rejected: string | null = null;
    let baked: RecordedBakedMove;
    try {
      baked = (await baker.bake(
        poses,
        liveOptions,
        (p) => progress.push(p),
        new AbortController().signal,
      )) as RecordedBakedMove;
    } catch (error) {
      if (!(error instanceof PhysicsInvalidError)) throw error;
      rejected = error.message;
      baked = error.move;
    }
    const wallMs = performance.now() - started;
    const data = await client.load();
    const diag = diagnostics(baked, data, config.size);
    const { start, end } = baked.recorded;
    const fastest = diag.reduce((a, d) =>
      Math.max(d.wristSpeedMs.L ?? 0, d.wristSpeedMs.R ?? 0) >
      Math.max(a.wristSpeedMs.L ?? 0, a.wristSpeedMs.R ?? 0)
        ? d
        : a,
    );
    const picks = [
      start,
      Math.round((start + end) / 2),
      end,
      fastest.f,
      ...(baked.sleeves.frame !== null ? [baked.sleeves.frame] : []),
    ];
    const images = move.renders ? renders(baked, data, config.size, [...new Set(picks)]) : {};
    const peakPose = (dof: string) => Math.max(...poses.map((p) => p.pose[dof] ?? -Infinity));
    moves.push({
      ...move,
      poses: poses.length,
      trace,
      peakPose: Object.fromEntries(
        [
          'shoulder_L_elevation',
          'shoulder_R_elevation',
          'elbow_L_flexion',
          'elbow_R_flexion',
          'shoulder_L_plane',
          'shoulder_R_plane',
          'trunk_flexion',
          'trunk_lateral',
        ].map((d) => [d, round(peakPose(d), 1)]),
      ),
      bake: {
        wallMs: round(wallMs, 0),
        timings: baked.timings,
        progressSteps: progress.length,
        progressMonotonic: progress.every((p, i) => i === 0 || p >= progress[i - 1]),
        progressLast: progress[progress.length - 1],
      },
      assetKey: baked.bakedMotion.assetKey,
      sleeves: baked.sleeves,
      rejected,
      numbers: moveNumbers(baked),
      diagnostics: diag,
      images,
      recordedPoses: poses,
    });
    baked.dispose();
  }

  // 3. Parity on this body: preset vs a custom request built from its keyframes.
  if (!config.parityPreset) {
    client.dispose();
    baker.dispose();
    return { tracking, moves, parity: null, totalMs: round(performance.now() - t0, 0) };
  }
  log('parity: preset vs custom-from-keyframes');
  const data = await client.load();
  const preset = data.presets.find((p) => p.id === config.parityPreset)!;
  const presetBuffer = await client.framesBuffer(preset.id);
  const customBuffer = await fetchCustomFrames(body.body_id, {
    fps: 30,
    poses: preset.keyframes.map((k) => ({ t: k.t_s, pose: k.pose })),
  });
  const presetFrames = await client.frames(preset.id);
  const { parseFrames } = await import('../../../motion/rig.ts');
  const customFrames = parseFrames(customBuffer, data.rig.drivers.length);
  const blobsEqual =
    (await sha([
      presetFrames.matrices,
      ...[...presetFrames.anchors.values()].map((a) => a.data),
    ])) ===
    (await sha([customFrames.matrices, ...[...customFrames.anchors.values()].map((a) => a.data)]));
  const presetBake = await client.bake(config.size, preset.id);
  const customBake = await client.bakeCustom(config.size, customBuffer);
  const parity = {
    preset: preset.id,
    framesBytes: { preset: presetBuffer.byteLength, custom: customBuffer.byteLength },
    framesBlobsIdentical: blobsEqual,
    bakeDigest: { preset: await bakeDigest(presetBake), custom: await bakeDigest(customBake) },
    relaxCached: {
      preset: presetBake.timings.relaxCached,
      custom: customBake.timings.relaxCached,
    },
  };
  client.dispose();
  baker.dispose();
  log('done');
  return {
    staticFit: {
      hem: garment.sizes[config.size].zones.hem ?? null,
      layer: config.layer,
      layerCm: layer,
    },
    tracking,
    moves,
    parity,
    totalMs: round(performance.now() - t0, 0),
  };
};
log('ready');
