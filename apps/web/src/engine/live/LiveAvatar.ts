// The posed avatar + jacket (LivePosedScene): the user's fitted Anny body, LBS-skinned on the CPU
// by the TS rig's 18 drivers (liveRig.ts, parity with P1 ≤ 0.001 mm), and the size's cloth asset
// skinned to the same drivers (garmentSkin.ts). The jacket is a skinned PREVIEW: no cloth solve.
// Plain Three.js; shared by the mirror view (V1) and the AR view (V2).
//
// Two jacket buffers (deformer hook, agent V6):
//   skinned: the LBS-skinned jacket, before any deformer. The fit readouts (previewStretch, the
//            zones) read ONLY this one, so a deformer can never change a reported fit number.
//   display: skinned + the live deformers (deform/chain.ts: V7's pose correctives, then V6's
//            dynamics). The rendered geometry and jacketPositions() (the AR glue reads it) use it.
//            A baked physics frame (setJacketPositions) overwrites it and bypasses the chain.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
} from 'three';
import type { ClothAsset } from '../../api.ts';
import { smoothNormals } from '../cloth/normals.ts';
import { skinVertices, type AnatomicalPose } from '../motion/rig.ts';
import { readF3Flags } from './ar/f3Flags.ts';
import type { LivePosedScene } from './contract.ts';
import { bodyRegions } from './deform/body.ts';
import {
  createLiveDeformers,
  type DeformerChain,
  type LiveDeformerOptions,
} from './deform/chain.ts';
import type { LiveDeformContextExt, LiveGarmentBindingExt } from './deform/types.ts';
import { ARM_FREE, bindGarment, skinGarment, type GarmentSkin } from './garmentSkin.ts';
import {
  jointPositions,
  poseDrivers,
  type LiveRig,
  type PoseResult,
  type TrunkSolverState,
} from './liveRig.ts';
import { zoneStretchCm, type PreviewTapes } from './readouts.ts';

/** The studio mannequin colour (BodyLayer.ts / BodyMotionLayer.ts). */
const SKIN = new Color('#c4bfb6');

export function liveBodyMaterial() {
  return new MeshStandardMaterial({ color: SKIN, roughness: 0.62, metalness: 0 });
}
export function liveJacketMaterial(colour = '#d8d6cf') {
  return new MeshPhysicalMaterial({
    color: new Color(colour),
    roughness: 0.55,
    metalness: 0,
    sheen: 0.45,
    sheenRoughness: 0.6,
    side: DoubleSide,
  });
}

type Jacket = {
  asset: ClothAsset;
  skin: GarmentSkin;
  geometry: BufferGeometry;
  /** LBS-skinned positions (N·3), before any deformer: the readouts' only source. */
  skinned: Float32Array;
  /** Displayed positions (N·3): skinned + deformers, or a baked physics frame. The geometry's. */
  display: Float32Array;
  normals: Float32Array;
  rendered: Float32Array;
  skinnedReady: boolean;
  renderedReady: boolean;
  material: MeshPhysicalMaterial;
  mesh: Mesh;
  tapes: PreviewTapes;
};

export class LiveAvatar implements LivePosedScene {
  readonly root = new Group();
  readonly body = new Group();
  readonly jacket = new Group();
  joints: Record<string, [number, number, number]> = {};
  /** The last pose result (clamped pose, drivers, warnings). */
  last: PoseResult;
  readonly neutral: PoseResult;
  private bodyGeometry = new BufferGeometry();
  private bodyPositions: Float32Array;
  private bodyNormals: Float32Array;
  private bodyMaterial = liveBodyMaterial();
  private garment?: Jacket;
  private solver: TrunkSolverState = {};
  /** The live jacket deformers (deform/chain.ts), run on the display copy after skinning. */
  readonly deformers: DeformerChain;
  /** True while a baked physics move plays: the chain does not run (V3's frames are shown). */
  private deformBypass = false;
  /** Pose and time of the frame being applied (deformer context). */
  private framePose: AnatomicalPose | null = null;
  private frameTime: number | null = null;
  /** Heading of the whole body for the deformers (contract rootYawDeg); null = unknown. */
  rootYawDeg: number | null = null;
  private bodyRegionFlags?: Uint8Array;
  private appliedDrivers: Float64Array | null = null;
  private appliedPose: AnatomicalPose | null = null;

  /**
   * F3 (?f3armfree=1): the jacket's body panels are bound without arm/clavicle skinning outside
   * a narrow armhole band (garmentSkin.ts ARM_FREE), so a swinging arm no longer bends them.
   */
  readonly armFree: boolean;
  private readonly armBandM = readF3Flags().armBandM;

  constructor(
    readonly live: LiveRig,
    options: { deformers?: LiveDeformerOptions; armFree?: boolean } = {},
  ) {
    this.armFree = options.armFree ?? readF3Flags().armFree;
    this.deformers = createLiveDeformers(options.deformers);
    const rig = live.rig;
    this.bodyPositions = new Float32Array(rig.vertexCount * 3);
    this.bodyNormals = new Float32Array(rig.vertexCount * 3);
    this.bodyGeometry.setAttribute('position', new BufferAttribute(this.bodyPositions, 3));
    this.bodyGeometry.setAttribute('normal', new BufferAttribute(this.bodyNormals, 3));
    this.bodyGeometry.setIndex(new BufferAttribute(rig.faces, 1));
    const mesh = new Mesh(this.bodyGeometry, this.bodyMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    this.body.add(mesh);
    this.root.add(this.body, this.jacket);
    this.neutral = poseDrivers(live, rig.neutralPose, {});
    this.last = this.neutral;
    this.setDrivers(this.neutral.drivers, this.neutral.world);
  }

  /** Bumped whenever the body or jacket geometry changes (views copy on change only). */
  version = 0;
  /** Body-only revision: jacket dynamics never require re-uploading the unchanged body. */
  bodyVersion = 0;

  /**
   * Fit Lab hook (agent FL, prompt 33; read-only): the driver matrices (18·12) of the pose on
   * screen, so other sizes' jackets can be skinned to the same pose. Live array: copy, never modify.
   */
  get currentDrivers(): Float64Array | null {
    return this.appliedDrivers;
  }

  /** The posed body's vertex positions and normals (V·3), live arrays: copy, never modify. */
  bodyArrays() {
    return {
      positions: this.bodyPositions,
      normals: this.bodyNormals,
      bounds: this.bodyGeometry.boundingSphere,
    };
  }

  /**
   * The DISPLAYED jacket's particle positions (N·3: skinned + deformers, or a physics frame), live
   * array, or null without a jacket. What the views and the AR glue draw.
   */
  jacketPositions(): Float32Array | null {
    return this.garment?.display ?? null;
  }

  /** The LBS-skinned jacket before any deformer (N·3), live array: readouts and diagnostics. */
  skinnedJacketPositions(): Float32Array | null {
    return this.garment?.skinned ?? null;
  }

  /** The deformers' status lines (labs HUD). */
  deformStatus() {
    return this.deformers.status();
  }

  /**
   * Physics playback shows V3's simulated frames: the chain must not run (or keep any state)
   * meanwhile. Either way the chain restarts from the target.
   */
  setDeformBypass(on: boolean) {
    this.deformBypass = on;
    this.deformers.reset();
  }

  /** Forget the deformers' motion (tracking loss, a pose jump, back to live). */
  resetDeformers() {
    this.deformers.reset();
  }

  get hasJacket() {
    return this.garment !== undefined;
  }
  get jacketAsset() {
    return this.garment?.asset;
  }
  get jacketSkin() {
    return this.garment?.skin;
  }

  /**
   * Binds a size's cloth asset to the body (null removes the jacket). `identity` (body, product,
   * size) keys the deformers' caches together with the asset's own key.
   */
  setGarment(
    asset: ClothAsset | null,
    identity: { bodyId?: string; productId?: string; size?: string } = {},
  ) {
    if (this.garment) {
      this.jacket.remove(this.garment.mesh);
      this.garment.geometry.dispose();
      this.garment.material.dispose();
      this.garment = undefined;
    }
    if (!asset) {
      this.deformers.bind(null);
      return;
    }
    const rig = this.live.rig;
    const neutralSkin = skinVertices(
      rig,
      this.neutral.drivers,
      new Float32Array(rig.vertexCount * 3),
    );
    const skin = bindGarment(
      rig,
      this.neutral.drivers,
      neutralSkin,
      asset.body_positions,
      asset.initial,
      asset.panels,
      asset.triangles,
      this.armFree
        ? {
            ...ARM_FREE,
            bandM: this.armBandM ?? ARM_FREE.bandM,
            // the arms hanging: the shape the freed body panels keep (garmentSkin.ts ARM_FREE)
            reference: poseDrivers(this.live, {
              ...rig.neutralPose,
              shoulder_L_elevation: ARM_FREE.referenceElevationDeg,
              shoulder_R_elevation: ARM_FREE.referenceElevationDeg,
            }).drivers,
          }
        : undefined,
    );
    const display = new Float32Array(skin.count * 3);
    const normals = new Float32Array(skin.count * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(display, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(Array.from(asset.triangles));
    const material = liveJacketMaterial(asset.colour);
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.jacket.add(mesh);
    const seamL = asset.landmarks.seam_L,
      seamR = asset.landmarks.seam_R;
    this.garment = {
      asset,
      skin,
      geometry,
      skinned: new Float32Array(skin.count * 3),
      display,
      normals,
      rendered: new Float32Array(display.length),
      skinnedReady: false,
      renderedReady: false,
      material,
      mesh,
      tapes: {
        paths: asset.paths,
        seams: seamL !== undefined && seamR !== undefined ? [seamL, seamR] : null,
      },
    };
    this.bodyRegionFlags ??= bodyRegions(rig);
    const binding: LiveGarmentBindingExt = {
      count: skin.count,
      bound: skin.bound,
      triangles: asset.triangles,
      skinDrivers: skin.drivers,
      skinWeights: skin.weights,
      asset,
      key: [
        identity.bodyId ?? 'body',
        identity.productId ?? 'product',
        identity.size ?? '',
        asset.key,
      ].join('|'),
      body: { neutral: neutralSkin as Float32Array, regions: this.bodyRegionFlags },
    };
    this.deformers.bind(binding);
    this.setDrivers(this.last.drivers, this.last.world);
  }

  /**
   * Poses body and jacket from an anatomical pose (missing DOFs = the body's neutral). `timeMs`
   * (performance.now() of the source frame) times the deformers' dynamics; default now.
   */
  applyPose(pose: AnatomicalPose, timeMs?: number) {
    // An identical input must not run the iterative trunk solver again: even its converging
    // warm start can move vertices at rest. Cache the computed result, never a rounded pose.
    if (!samePose(this.appliedPose, pose)) this.last = poseDrivers(this.live, pose, this.solver);
    this.framePose = this.last.pose;
    this.frameTime = timeMs ?? null;
    try {
      this.setDrivers(this.last.drivers, this.last.world);
    } finally {
      this.framePose = null;
      this.frameTime = null;
    }
    this.appliedPose = { ...pose };
    return this.last;
  }

  /**
   * Forward kinematics only (no skinning): the posed joints, keyed like `joints`, for a candidate
   * pose. For a screen-space IK (agent V2) that searches pose corrections; ~0.3–0.5 ms per call.
   */
  fkJoints(pose: AnatomicalPose): Record<string, [number, number, number]> {
    return jointPositions(this.live, poseDrivers(this.live, pose, this.fkState).world);
  }
  private fkState: TrunkSolverState = {};

  /** Back to the neutral (display) pose; resets the trunk solver's warm start. */
  resetPose() {
    this.solver = {};
    this.last = this.neutral;
    this.deformers.reset();
    this.setDrivers(this.neutral.drivers, this.neutral.world);
  }

  /**
   * Poses body and jacket from driver matrices directly (18·12). `world` (bone poses) updates the
   * joints when given. V3's baked playback may then overwrite the jacket with setJacketPositions.
   */
  setDrivers(drivers: ArrayLike<number>, world?: Float64Array) {
    this.appliedPose = null;
    const changed = !sameValues(this.appliedDrivers, drivers);
    if (changed) {
      skinVertices(this.live.rig, drivers, this.bodyPositions);
      smoothNormals(this.bodyPositions, this.live.rig.faces, this.bodyNormals);
      this.bodyGeometry.getAttribute('position').needsUpdate = true;
      this.bodyGeometry.getAttribute('normal').needsUpdate = true;
      this.bodyGeometry.computeBoundingSphere();
      this.appliedDrivers = Float64Array.from(drivers);
      this.bodyVersion++;
      this.version++;
    }
    if (world) this.joints = jointPositions(this.live, world);
    const g = this.garment;
    if (g) {
      if (changed || !g.skinnedReady) {
        skinGarment(g.skin, drivers, g.skinned);
        g.skinnedReady = true;
      }
      g.display.set(g.skinned);
      if (!this.deformBypass) {
        const ctx: LiveDeformContextExt = {
          timeMs: this.frameTime ?? performance.now(),
          pose: this.framePose,
          drivers,
          bodyPositions: this.bodyPositions,
          bodyNormals: this.bodyNormals,
          joints: this.joints,
          rootYawDeg: this.rootYawDeg,
        };
        this.deformers.apply(g.display, ctx);
      }
      this.refreshJacket();
    }
  }

  /**
   * Overwrites the DISPLAYED jacket particle positions (N·3), e.g. a baked physics frame. The
   * deformers do not touch it; the skinned (readout) copy keeps the last skinning.
   */
  setJacketPositions(positions: ArrayLike<number>) {
    const g = this.garment;
    if (!g) return;
    if (positions.length !== g.display.length) throw new Error('Jacket size mismatch');
    g.display.set(positions);
    this.refreshJacket();
  }

  private refreshJacket() {
    const g = this.garment!;
    if (g.renderedReady && sameValues(g.rendered, g.display)) return;
    g.rendered.set(g.display);
    g.renderedReady = true;
    this.version++;
    smoothNormals(g.display, g.geometry.index!.array, g.normals);
    g.geometry.getAttribute('position').needsUpdate = true;
    g.geometry.getAttribute('normal').needsUpdate = true;
    g.geometry.computeBoundingSphere();
  }

  /**
   * Preview stretch per zone (cm) of the SKINNED jacket (before any deformer) vs the neutral pose.
   */
  previewStretch() {
    const g = this.garment;
    if (!g) return {};
    return zoneStretchCm(g.tapes, g.skin.bound, g.skinned);
  }

  dispose() {
    this.setGarment(null);
    this.deformers.dispose();
    this.bodyGeometry.dispose();
    this.bodyMaterial.dispose();
  }
}

function sameValues(a: ArrayLike<number> | null, b: ArrayLike<number>) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function samePose(a: AnatomicalPose | null, b: AnatomicalPose) {
  if (!a) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}
