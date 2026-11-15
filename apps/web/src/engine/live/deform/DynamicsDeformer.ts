// 'dynamics' (agent V6): bounded real-time secondary motion of the live jacket, after the LBS
// skinning and V7's pose correctives. The model is "skinned cloth with max distance" (Unity
// Cloth, NVIDIA APEX): every particle follows its skinned target, may lag behind it by at most
// its max distance (maxDistance.ts: 0 where the body holds the jacket, 3–6 cm at a free hem,
// 1–2 cm at the cuffs), and collides with the posed body (collide.ts).
//
// Solver (XPBD, fixed 120 Hz substeps on a ~3.5 cm proxy net, proxy.ts):
//   - the skinned target is the cloth's equilibrium (it already is the drape the preview shows).
//     Gravity enters as the pendulum restoring acceleration g/L toward it, L = how far the cloth
//     hangs below where it is held (a hanging strip swings back like a pendulum of that length);
//     so a body that stops leaves the jacket exactly on the target, with no sag of its own;
//   - inertia: targets move with the body; free nodes lag, swing and settle;
//   - body turns: the avatar never yaws (the live pose has no root yaw), so the simulation runs
//     in a "world" frame turned by the measured heading (ctx.rootYawDeg) about the body's
//     vertical axis; a turn moves the targets in that frame and the hem lags with inertia;
//   - damping: the asset's dampingPerSecond, on the velocity relative to the target;
//   - edges: the proxy net is inextensible but free to buckle (one-sided, asset
//     stretchCompliance), rest lengths = this frame's target lengths (which carry LBS and the
//     correctives);
//   - max distance (hard), then body and arm collisions (hard, in the body frame);
//   - the target is interpolated across the substeps of a frame; a stall, a pose jump, a heading
//     flip or a reset restarts from the target (teleport).
// Every cloth particle then takes the interpolated proxy displacement, clamped to its own max
// distance and collided again. Held particles (max distance 0) are never written: they ARE the
// target, bit for bit.
import type { LiveDeformContext, LiveGarmentBinding, LiveJacketDeformer } from '../contract.ts';
import { DYNAMICS, physicalParameters } from './config.ts';
import {
  ANCHORS,
  armCapsules,
  bodyAnchors,
  CAPSULE_STRIDE,
  CAPSULES_ARMS,
  CAPSULES_NONE,
  CAPSULES_OWN_L,
  CAPSULES_OWN_R,
  collide,
  SkinGrid,
  sleeveRadii,
} from './collide.ts';
import { wrapDeg } from './heading.ts';
import {
  dynamicsMap,
  KIND_HOOD,
  KIND_SLEEVE_L,
  KIND_SLEEVE_R,
  KIND_TORSO,
  type DynamicsMap,
} from './maxDistance.ts';

/** The capsule rule of a particle kind (collide.ts). */
const capsuleMode = (kind: number) =>
  kind === KIND_SLEEVE_L
    ? CAPSULES_OWN_L
    : kind === KIND_SLEEVE_R
      ? CAPSULES_OWN_R
      : kind === KIND_TORSO || kind === KIND_HOOD
        ? CAPSULES_ARMS
        : CAPSULES_NONE;
import { buildProxy, type Proxy } from './proxy.ts';
import {
  BODY_ARM_L,
  BODY_ARM_R,
  BODY_TRUNK,
  type LiveDeformContextExt,
  type LiveGarmentBindingExt,
} from './types.ts';

type AssetLike = {
  panels: ArrayLike<number>;
  paths?: Record<string, ArrayLike<number>>;
  config?: Record<string, number>;
  layer_m?: number;
};

type Bound = {
  key: string;
  n: number;
  map: DynamicsMap;
  proxy: Proxy;
  /** (moving · ANCHORS) body anchors; null without a body (no body collisions). */
  anchors: Uint32Array | null;
  /** The arm and hand skin, hashed per frame for torso and hood particles near an arm. */
  armSkin: SkinGrid | null;
  /** The trunk skin, hashed per frame: the contact budget of the sleeves beside it. */
  trunkSkin: SkinGrid | null;
  /** Moving-particle index of each proxy node's seed, -1 for kinematic nodes. */
  nodeMoving: Int32Array;
  invMass: Float64Array;
  md: Float64Array;
  omega2: Float64Array;
  /** Per-substep velocity decay (relative to the target) of each node. */
  decay: Float64Array;
  inward: Float64Array;
  /** Capsule rule per node (collide.ts CAPSULES_*). */
  armCollide: Uint8Array;
  physics: ReturnType<typeof physicalParameters>;
  clearance: number;
  /** Sleeve radius + layer per arm segment; NaN until measured on a frame. */
  radii: Float64Array;
  // State. x, v and the t* arrays are in the world frame (body frame turned by the heading);
  // *B arrays are in the body (scene) frame.
  x: Float64Array;
  v: Float64Array;
  prev: Float64Array;
  tPrev: Float64Array;
  tCur: Float64Array;
  tPrevB: Float64Array;
  tCurB: Float64Array;
  tk: Float64Array;
  tkB: Float64Array;
  vT: Float64Array;
  /** Proxy displacement from the target in the body frame (what the fine pass applies). */
  disp: Float64Array;
  rest: Float64Array;
  lambda: Float64Array;
  /** Last frame's body-frame targets (rest detection). */
  tLast: Float64Array;
  p: Float64Array;
  bindMs: number;
};

export type DynamicsFrameStats = {
  substeps: number;
  teleported: boolean;
  /** Why it teleported ('' when it did not). */
  reason: string;
  /** Largest proxy displacement from its target after this frame, m. */
  maxDispM: number;
  /** Largest collision correction in the fine pass, m. */
  maxPushM: number;
  /** Heading used this frame, degrees. */
  yawDeg: number;
  /** Time in the proxy solve and in the per-particle pass, ms. */
  simMs: number;
  fineMs: number;
  /** Proxy nodes restarted on their target this frame (a local pose jump, e.g. an arm flip). */
  resetNodes: number;
  /** The targets are still and the jacket sits exactly on them (no solver ran). */
  atRest?: boolean;
};

export type DynamicsDeformerOptions = { enabled?: boolean };

const DEG = Math.PI / 180;

export class DynamicsDeformer implements LiveJacketDeformer {
  readonly name = 'dynamics' as const;
  private enabled: boolean;
  private b?: Bound;
  private ready = false;
  private lastTime = 0;
  private acc = 0;
  private lastMs = 0;
  private problem = '';
  private yawPrev = 0;
  private yaw = 0;
  private pivotX = 0;
  private pivotZ = 0;
  private capsules = new Float64Array(6 * CAPSULE_STRIDE);
  /** Collisions on (evaluation A/B only: without them nothing keeps the cloth out of the body). */
  collisions = true;
  /** The last frame's numbers (labs, evaluation). */
  lastFrame: DynamicsFrameStats = {
    substeps: 0,
    teleported: true,
    reason: 'start',
    maxDispM: 0,
    maxPushM: 0,
    yawDeg: 0,
    simMs: 0,
    fineMs: 0,
    resetNodes: 0,
  };
  private jumpScratch = new Uint8Array(0);
  /** How long the targets have been still (ms), and whether the jacket sits exactly on them. */
  private stillMs = 0;
  private atRest = false;
  private armSkinFrame: SkinGrid | null = null;
  private trunkSkinFrame: SkinGrid | null = null;

  constructor(options: DynamicsDeformerOptions = {}) {
    this.enabled = options.enabled ?? DYNAMICS.defaultOn;
  }

  get isEnabled() {
    return this.enabled;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.reset();
    if (on && !this.b && this.pending) this.build(this.pending);
  }

  /** The jacket binding; built only while enabled (a disabled deformer costs nothing). */
  private pending: LiveGarmentBinding | null = null;

  /** Bind-time data for tests and the evaluation (null without a jacket). */
  get binding() {
    const b = this.b;
    return b
      ? { map: b.map, proxy: b.proxy, bindMs: b.bindMs, radii: b.radii, hasBody: !!b.anchors }
      : null;
  }

  bind(binding: LiveGarmentBinding | null) {
    this.b = undefined;
    this.ready = false;
    this.problem = '';
    this.pending = binding;
    if (binding && this.enabled) this.build(binding);
  }

  private build(binding: LiveGarmentBinding) {
    const t0 = performance.now();
    const ext = binding as LiveGarmentBindingExt;
    const asset = (binding.asset ?? {}) as AssetLike;
    if (!asset.panels || asset.panels.length !== binding.count)
      throw new Error('Dynamics: the cloth asset has no panels for its particles');
    const map = dynamicsMap(binding.bound, binding.triangles, asset);
    const proxy = buildProxy(binding.bound, binding.triangles, asset.panels, map.maxDist);
    const anchors = ext.body
      ? bodyAnchors(binding.bound, proxy.moving, map.kind, map.maxDist, ext.body)
      : null;
    let armSkin: SkinGrid | null = null,
      trunkSkin: SkinGrid | null = null;
    if (ext.body) {
      const arm: number[] = [],
        trunk: number[] = [];
      ext.body.regions.forEach((flags, v) => {
        if (flags & (BODY_ARM_L | BODY_ARM_R)) arm.push(v);
        if (flags & BODY_TRUNK) trunk.push(v);
      });
      armSkin = new SkinGrid(Uint32Array.from(arm));
      trunkSkin = new SkinGrid(Uint32Array.from(trunk));
    }
    const n = binding.count,
      P = proxy.count,
      E = proxy.edges.length / 2;
    const physics = physicalParameters(asset.config);
    const movingIndex = new Int32Array(n).fill(-1);
    proxy.moving.forEach((i, m) => (movingIndex[i] = m));
    const nodeMoving = new Int32Array(P),
      invMass = new Float64Array(P),
      md = new Float64Array(P),
      omega2 = new Float64Array(P),
      decay = new Float64Array(P),
      inward = new Float64Array(P),
      armCollide = new Uint8Array(P);
    const h = 1 / DYNAMICS.substepHz;
    for (let j = 0; j < P; j++) {
      const i = proxy.particle[j];
      const free = proxy.free[j] === 1 && movingIndex[i] >= 0;
      nodeMoving[j] = free ? movingIndex[i] : -1;
      invMass[j] = free ? 1 / (Math.max(1, proxy.cellSize[j]) * physics.particleMass) : 0;
      md[j] = map.maxDist[i];
      omega2[j] = physics.gravity / map.pendulum[i];
      const damping = Math.max(
        physics.dampingPerSecond,
        2 * DYNAMICS.minDampingRatio * Math.sqrt(omega2[j]),
      );
      decay[j] = Math.exp(-damping * h);
      inward[j] = map.inward[i];
      armCollide[j] = capsuleMode(map.kind[i]);
    }
    const v3 = () => new Float64Array(P * 3);
    this.b = {
      key: binding.key,
      n,
      map,
      proxy,
      anchors,
      armSkin,
      trunkSkin,
      nodeMoving,
      invMass,
      md,
      omega2,
      decay,
      inward,
      armCollide,
      physics,
      clearance: (asset.layer_m ?? 0) + physics.collisionMargin,
      radii: new Float64Array(4).fill(NaN),
      x: v3(),
      v: v3(),
      prev: v3(),
      tPrev: v3(),
      tCur: v3(),
      tPrevB: v3(),
      tCurB: v3(),
      tk: v3(),
      tkB: v3(),
      vT: v3(),
      disp: v3(),
      rest: new Float64Array(E),
      lambda: new Float64Array(E),
      tLast: v3(),
      p: new Float64Array(3),
      bindMs: 0,
    };
    this.b.bindMs = performance.now() - t0;
    if (!anchors) this.problem = 'no body for collisions';
  }

  reset() {
    this.ready = false;
    this.acc = 0;
    this.stillMs = 0;
    this.atRest = false;
  }

  status() {
    const b = this.b;
    if (!this.enabled) return { active: false, note: 'off (?dyn=1 turns it on)', lastApplyMs: 0 };
    if (!b && this.pending) return { active: false, note: 'binding…', lastApplyMs: 0 };
    if (!b) return { active: false, note: 'no jacket', lastApplyMs: 0 };
    let free = 0;
    for (let j = 0; j < b.proxy.count; j++) if (b.nodeMoving[j] >= 0) free++;
    const f = this.lastFrame;
    return {
      active: true,
      note:
        `${free}/${b.proxy.count} nodes, ${b.proxy.moving.length}/${b.n} particles free, ` +
        `${f.substeps} substeps, max ${(f.maxDispM * 100).toFixed(1)} cm, yaw ${f.yawDeg.toFixed(0)}°` +
        (f.teleported ? ` (restart: ${f.reason})` : '') +
        (this.problem ? ` (${this.problem})` : ''),
      lastApplyMs: this.lastMs,
    };
  }

  dispose() {
    this.b = undefined;
    this.pending = null;
    this.ready = false;
  }

  /** Body frame → world frame (turned by `yaw` degrees about the pivot's vertical axis). */
  private toWorld(src: Float64Array, dst: Float64Array, yaw: number) {
    if (yaw === 0) {
      dst.set(src);
      return;
    }
    const c = Math.cos(yaw * DEG),
      s = Math.sin(yaw * DEG),
      px = this.pivotX,
      pz = this.pivotZ;
    for (let k = 0; k < src.length; k += 3) {
      const x = src[k] - px,
        z = src[k + 2] - pz;
      dst[k] = px + c * x + s * z;
      dst[k + 1] = src[k + 1];
      dst[k + 2] = pz - s * x + c * z;
    }
  }

  apply(positions: Float32Array, ctx: LiveDeformContext) {
    const b = this.b;
    if (!this.enabled || !b) return;
    const t0 = performance.now();
    if (positions.length !== b.n * 3) throw new Error('Dynamics: particle count changed');
    const ext = ctx as LiveDeformContextExt;
    const P = b.proxy.count;
    const particle = b.proxy.particle;
    for (let j = 0; j < P; j++) {
      const i = particle[j] * 3;
      b.tCurB[j * 3] = positions[i];
      b.tCurB[j * 3 + 1] = positions[i + 1];
      b.tCurB[j * 3 + 2] = positions[i + 2];
    }
    // Arm capsules for this frame (sleeve radius measured on the jacket, + the cloth layer).
    if (b.radii.some(Number.isNaN)) {
      const r = sleeveRadii(positions, b.map.kind, ctx.joints);
      for (let s = 0; s < 4; s++) b.radii[s] = r[s] + b.clearance;
    }
    const capsuleCount = b.radii.some(Number.isNaN)
      ? 0
      : armCapsules(ctx.joints, b.radii, this.capsules);
    const normals = this.collisions ? (ext.bodyNormals ?? null) : null;
    const anchors = normals ? b.anchors : null;
    const armSkin = normals && capsuleCount ? b.armSkin : null;
    armSkin?.update(ctx.bodyPositions);
    this.armSkinFrame = armSkin;
    const trunkSkin = normals ? b.trunkSkin : null;
    trunkSkin?.update(ctx.bodyPositions);
    this.trunkSkinFrame = trunkSkin;
    // Heading, unwrapped: +180 and −180 are the same orientation (never a fake 360° spin);
    // unknown = keep the last one (the body is not seen turning).
    const yawIn = ctx.rootYawDeg;
    const yawNow =
      typeof yawIn === 'number' && Number.isFinite(yawIn) ? this.yaw + wrapDeg(yawIn - this.yaw) : this.yaw;

    const stats: DynamicsFrameStats = {
      substeps: 0,
      teleported: false,
      reason: '',
      maxDispM: 0,
      maxPushM: 0,
      yawDeg: yawNow,
      simMs: 0,
      fineMs: 0,
      resetNodes: 0,
    };
    const dtMs = ctx.timeMs - this.lastTime;
    let reason = !this.ready
      ? 'start'
      : !(dtMs >= 0)
        ? 'time went back'
        : dtMs > DYNAMICS.stallMs
          ? `stall ${dtMs.toFixed(0)} ms`
          : Math.abs(yawNow - this.yaw) > DYNAMICS.yawJumpDeg
            ? 'heading jump'
            : '';
    // Pose jumps are local: an arm that flips restarts the nodes it carries, not the hem.
    let jumped = 0;
    const jump = this.jumpScratch.length === P ? this.jumpScratch : (this.jumpScratch = new Uint8Array(P));
    jump.fill(0);
    if (!reason) {
      for (let j = 0, k = 0; j < P; j++, k += 3)
        if (
          Math.hypot(
            b.tCurB[k] - b.tPrevB[k],
            b.tCurB[k + 1] - b.tPrevB[k + 1],
            b.tCurB[k + 2] - b.tPrevB[k + 2],
          ) > DYNAMICS.jumpM
        ) {
          jump[j] = 1;
          jumped++;
        }
      if (jumped > DYNAMICS.jumpGlobalShare * P) reason = `pose jump (${jumped}/${P} nodes)`;
    }
    // Rest: the targets have not moved (beyond float noise) since the last frame.
    // (A body turn moves the targets in the world frame: the heading must be still too.)
    let targetStill = this.ready && Math.abs(yawNow - this.yaw) < 0.01;
    for (let k = 0; targetStill && k < P * 3; k++)
      if (Math.abs(b.tCurB[k] - b.tLast[k]) > DYNAMICS.restTargetTolM) targetStill = false;
    b.tLast.set(b.tCurB);
    this.stillMs = targetStill && dtMs > 0 ? this.stillMs + dtMs : targetStill ? this.stillMs : 0;
    if (!targetStill) this.atRest = false;
    if (reason) {
      // Teleport: the jacket is exactly its target; the motion starts from rest.
      const hip = ctx.joints.midHip;
      this.pivotX = hip ? hip[0] : 0;
      this.pivotZ = hip ? hip[2] : 0;
      this.yaw = this.yawPrev = yawNow;
      b.tPrevB.set(b.tCurB);
      this.toWorld(b.tCurB, b.tCur, yawNow);
      b.tPrev.set(b.tCur);
      b.x.set(b.tCur);
      b.v.fill(0);
      b.disp.fill(0);
      this.acc = 0;
      this.ready = true;
      this.lastTime = ctx.timeMs;
      stats.teleported = true;
      stats.reason = reason;
      this.lastFrame = stats;
      this.lastMs = performance.now() - t0;
      return;
    }
    this.lastTime = ctx.timeMs;
    this.yaw = yawNow;
    let skipSim = false;
    if (this.stillMs >= DYNAMICS.restAfterMs && !jumped) {
      // At rest: decay what is left of the sway, then sit exactly on the target (no solver).
      skipSim = true;
      if (!this.atRest) {
        const keep = Math.exp(-Math.max(0, dtMs) / DYNAMICS.restTauMs);
        let max = 0;
        for (let k = 0; k < P * 3; k++) {
          b.disp[k] *= keep;
          max = Math.max(max, Math.abs(b.disp[k]));
        }
        if (max < DYNAMICS.restLockSnapM) {
          b.disp.fill(0);
          this.atRest = true;
        }
      }
      // Keep the solver state consistent with what is shown (it restarts from here).
      this.toWorld(b.tCurB, b.tCur, yawNow);
      const c = Math.cos(yawNow * DEG),
        sn = Math.sin(yawNow * DEG);
      for (let k = 0; k < P * 3; k += 3) {
        const dx = b.disp[k],
          dz = b.disp[k + 2];
        b.x[k] = b.tCur[k] + c * dx + sn * dz;
        b.x[k + 1] = b.tCur[k + 1] + b.disp[k + 1];
        b.x[k + 2] = b.tCur[k + 2] - sn * dx + c * dz;
      }
      b.v.fill(0);
      b.tPrev.set(b.tCur);
      b.tPrevB.set(b.tCurB);
      this.yawPrev = yawNow;
      this.acc = 0;
      stats.atRest = this.atRest;
      if (this.atRest) {
        this.lastFrame = stats;
        this.lastMs = performance.now() - t0;
        return;
      }
    } else if (jumped) {
      // These nodes restart on their new target (at the previous heading), at rest relative to it.
      const c = Math.cos(this.yawPrev * DEG),
        sn = Math.sin(this.yawPrev * DEG);
      for (let j = 0, k = 0; j < P; j++, k += 3) {
        if (!jump[j]) continue;
        const x = b.tCurB[k] - this.pivotX,
          z = b.tCurB[k + 2] - this.pivotZ;
        b.tPrevB[k] = b.tCurB[k];
        b.tPrevB[k + 1] = b.tCurB[k + 1];
        b.tPrevB[k + 2] = b.tCurB[k + 2];
        b.tPrev[k] = this.pivotX + c * x + sn * z;
        b.tPrev[k + 1] = b.tCurB[k + 1];
        b.tPrev[k + 2] = this.pivotZ - sn * x + c * z;
        b.x[k] = b.tPrev[k];
        b.x[k + 1] = b.tPrev[k + 1];
        b.x[k + 2] = b.tPrev[k + 2];
        b.v[k] = b.v[k + 1] = b.v[k + 2] = 0;
        b.disp[k] = b.disp[k + 1] = b.disp[k + 2] = 0;
      }
      stats.resetNodes = jumped;
    }
    const h = 1 / DYNAMICS.substepHz;
    this.acc += dtMs / 1000;
    let steps = Math.floor(this.acc / h);
    if (steps > DYNAMICS.maxSubstepsPerFrame) {
      steps = DYNAMICS.maxSubstepsPerFrame;
      this.acc = 0;
    } else this.acc -= steps * h;
    const tSim = performance.now();
    if (steps > 0 && !skipSim) {
      this.toWorld(b.tCurB, b.tCur, yawNow);
      this.simulate(b, steps, h, ctx, normals, anchors, capsuleCount);
      b.tPrev.set(b.tCur);
      b.tPrevB.set(b.tCurB);
      this.yawPrev = yawNow;
      // Displacement back into the body frame.
      const c = Math.cos(-yawNow * DEG),
        s = Math.sin(-yawNow * DEG);
      for (let k = 0; k < P * 3; k += 3) {
        const dx = b.x[k] - b.tCur[k],
          dy = b.x[k + 1] - b.tCur[k + 1],
          dz = b.x[k + 2] - b.tCur[k + 2];
        b.disp[k] = c * dx + s * dz;
        b.disp[k + 1] = dy;
        b.disp[k + 2] = -s * dx + c * dz;
      }
    }
    stats.substeps = steps;
    const tFine = performance.now();
    stats.simMs = tFine - tSim;
    for (let k = 0; k < P * 3; k += 3)
      stats.maxDispM = Math.max(stats.maxDispM, Math.hypot(b.disp[k], b.disp[k + 1], b.disp[k + 2]));

    // Fine pass: every moving particle takes the interpolated displacement.
    const { moving, weightStart, weightNode, weight } = b.proxy;
    const md = b.map.maxDist,
      inward = b.map.inward,
      kind = b.map.kind;
    const p = b.p;
    for (let m = 0; m < moving.length; m++) {
      const i = moving[m],
        o = i * 3;
      let dx = 0,
        dy = 0,
        dz = 0;
      for (let w = weightStart[m]; w < weightStart[m + 1]; w++) {
        const q = weightNode[w] * 3,
          a = weight[w];
        dx += a * b.disp[q];
        dy += a * b.disp[q + 1];
        dz += a * b.disp[q + 2];
      }
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // At rest the solver's round-off (~1e-17 m) is not motion: the particle IS its target.
      if (len < DYNAMICS.restSnapM) continue;
      const limit = md[i];
      if (len > limit) {
        const sc = limit / len;
        dx *= sc;
        dy *= sc;
        dz *= sc;
      }
      const tx = positions[o],
        ty = positions[o + 1],
        tz = positions[o + 2];
      p[0] = tx + dx;
      p[1] = ty + dy;
      p[2] = tz + dz;
      if (anchors && normals && Math.min(len, limit) >= DYNAMICS.collideSkipM) {
        const push = collide(
          p,
          0,
          tx,
          ty,
          tz,
          anchors,
          m * ANCHORS,
          ctx.bodyPositions,
          normals,
          b.clearance,
          inward[i],
          this.capsules,
          capsuleCount,
          capsuleMode(kind[i]),
          armSkin,
          trunkSkin,
        );
        if (push > stats.maxPushM) stats.maxPushM = push;
      }
      positions[o] = p[0];
      positions[o + 1] = p[1];
      positions[o + 2] = p[2];
    }
    this.lastFrame = stats;
    const end = performance.now();
    stats.fineMs = end - tFine;
    this.lastMs = end - t0;
  }

  private simulate(
    b: Bound,
    steps: number,
    h: number,
    ctx: LiveDeformContext,
    normals: Float32Array | null,
    anchors: Uint32Array | null,
    capsuleCount: number,
  ) {
    const P = b.proxy.count,
      edges = b.proxy.edges,
      E = edges.length / 2;
    const { x, v, prev, tPrev, tCur, tPrevB, tCurB, tk, tkB, vT, rest, lambda } = b;
    const { invMass, md, omega2, inward, decay } = b;
    const vmax = b.physics.velocityLimit;
    const alpha = b.physics.stretchCompliance / (h * h);
    const span = steps * h;
    for (let k = 0; k < P * 3; k++) vT[k] = (tCur[k] - tPrev[k]) / span;
    for (let e = 0; e < E; e++) {
      const a = edges[e * 2] * 3,
        c = edges[e * 2 + 1] * 3;
      rest[e] = Math.hypot(tCurB[c] - tCurB[a], tCurB[c + 1] - tCurB[a + 1], tCurB[c + 2] - tCurB[a + 2]);
    }
    const turning = this.yawPrev !== this.yaw || this.yaw !== 0;
    const px = this.pivotX,
      pz = this.pivotZ;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      for (let k = 0; k < P * 3; k++) {
        tk[k] = tPrev[k] + f * (tCur[k] - tPrev[k]);
        tkB[k] = tPrevB[k] + f * (tCurB[k] - tPrevB[k]);
      }
      const yawK = (this.yawPrev + f * (this.yaw - this.yawPrev)) * DEG;
      const cy = Math.cos(yawK),
        sy = Math.sin(yawK);
      // Predict: pendulum restoring toward the target, damping relative to it.
      for (let j = 0; j < P; j++) {
        const o = j * 3;
        prev[o] = x[o];
        prev[o + 1] = x[o + 1];
        prev[o + 2] = x[o + 2];
        if (invMass[j] === 0) {
          x[o] = tk[o];
          x[o + 1] = tk[o + 1];
          x[o + 2] = tk[o + 2];
          continue;
        }
        const w2 = omega2[j] * h,
          dec = decay[j];
        for (let a = 0; a < 3; a++) {
          let vel = v[o + a] - w2 * (x[o + a] - tk[o + a]);
          vel = vT[o + a] + (vel - vT[o + a]) * dec;
          v[o + a] = vel;
          x[o + a] += vel * h;
        }
      }
      // Edges (XPBD, λ reset per substep).
      lambda.fill(0);
      for (let it = 0; it < DYNAMICS.iterations; it++)
        for (let e = 0; e < E; e++) {
          const ja = edges[e * 2],
            jc = edges[e * 2 + 1];
          const wa = invMass[ja],
            wc = invMass[jc];
          const wsum = wa + wc;
          if (wsum === 0) continue;
          const a = ja * 3,
            c = jc * 3;
          const dx = x[c] - x[a],
            dy = x[c + 1] - x[a + 1],
            dz = x[c + 2] - x[a + 2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < 1e-9) continue;
          const C = len - rest[e];
          // One-sided: cloth resists stretch, not compression (it buckles). A two-sided edge
          // locked dimples in place (measured: 3-5 mm stuck 2 s after a shake).
          if (C <= 0 && lambda[e] === 0) continue;
          const dl = Math.min(-lambda[e], (-C - alpha * lambda[e]) / (wsum + alpha));
          lambda[e] += dl;
          const g = dl / len;
          x[a] -= wa * g * dx;
          x[a + 1] -= wa * g * dy;
          x[a + 2] -= wa * g * dz;
          x[c] += wc * g * dx;
          x[c + 1] += wc * g * dy;
          x[c + 2] += wc * g * dz;
        }
      // Max distance, collisions (body frame), velocities.
      for (let j = 0; j < P; j++) {
        if (invMass[j] === 0) continue;
        const o = j * 3;
        let dx = x[o] - tk[o],
          dy = x[o + 1] - tk[o + 1],
          dz = x[o + 2] - tk[o + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > md[j]) {
          const sc = md[j] / len;
          dx *= sc;
          dy *= sc;
          dz *= sc;
          x[o] = tk[o] + dx;
          x[o + 1] = tk[o + 1] + dy;
          x[o + 2] = tk[o + 2] + dz;
        }
        // Collisions every other substep and always on the last (the per-particle pass then
        // applies them exactly to everything shown).
        if (
          anchors &&
          normals &&
          (s === steps || s % 2 === 0) &&
          Math.min(len, md[j]) >= DYNAMICS.collideSkipM
        ) {
          if (turning) {
            // World → body: undo the heading about the pivot.
            const wx = x[o] - px,
              wz = x[o + 2] - pz;
            x[o] = px + cy * wx - sy * wz;
            x[o + 2] = pz + sy * wx + cy * wz;
          }
          collide(
            x,
            o,
            tkB[o],
            tkB[o + 1],
            tkB[o + 2],
            anchors,
            b.nodeMoving[j] * ANCHORS,
            ctx.bodyPositions,
            normals,
            b.clearance,
            inward[j],
            this.capsules,
            capsuleCount,
            b.armCollide[j],
            this.armSkinFrame,
            this.trunkSkinFrame,
          );
          if (turning) {
            const bx = x[o] - px,
              bz = x[o + 2] - pz;
            x[o] = px + cy * bx + sy * bz;
            x[o + 2] = pz - sy * bx + cy * bz;
          }
        }
        let rx = (x[o] - prev[o]) / h - vT[o],
          ry = (x[o + 1] - prev[o + 1]) / h - vT[o + 1],
          rz = (x[o + 2] - prev[o + 2]) / h - vT[o + 2];
        const speed = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (speed > vmax) {
          const sc = vmax / speed;
          rx *= sc;
          ry *= sc;
          rz *= sc;
        }
        v[o] = vT[o] + rx;
        v[o + 1] = vT[o + 1] + ry;
        v[o + 2] = vT[o + 2] + rz;
      }
    }
  }
}

export function createDynamics(options: DynamicsDeformerOptions = {}) {
  return new DynamicsDeformer(options);
}
