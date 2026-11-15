import type { components } from '@satisfy/api-types';
import { attachAccessories } from './frames.ts';
import { compressionField } from './compression.ts';
import { GridSdfCollider, type BodyCollider } from './collider.ts';
import {
  applyArmholeStop,
  applyArmholeTethers,
  rebaseArmholeStop,
  type ArmholeStop,
  type ArmholeTethers,
} from './armholeStop.ts';
import type { KernelFactory, LayerPairs, SharedArrays, SolverKernels } from './wasm/kernels.ts';

function norm3(x: number, y: number, z: number) {
  return Math.sqrt(x * x + y * y + z * z);
}

export type ClothAsset = components['schemas']['ClothAsset'];
export type ClothSnapshot = {
  assetKey: string;
  positions: Float32Array;
  strain: Float32Array;
  gap: Float32Array;
  energy: number;
  simulatedSeconds: number;
  gapValid: boolean;
  strainValid: boolean;
  compression: Float32Array;
};
export type FrameBuffers = {
  positions: Float32Array;
  strain: Float32Array;
  gap: Float32Array;
  compression?: Float32Array;
};
export type SnapshotOptions = { gap?: boolean; strain?: boolean };
/** Local high-rate region (M4 hand pull): what runs while the rest of the garment is kinematic. */
export type ClothRegion = {
  /** Particles that move (inverse mass > 0), sorted. */
  particles: Int32Array;
  /** Per region particle (same order): per-substep pull to `anchor`, 0 = free, 1 = kinematic. */
  pull: Float64Array;
  anchor: Float64Array;
  edges: Int32Array;
  hinges: Int32Array;
  tethers: Int32Array;
  pairs: Int32Array;
};
/** Edge strain measured over the region (or the whole mesh). Ratio = length / rest. */
export type RegionStrain = {
  maxRatio: number;
  /** Largest length / rest - per-edge limit (stretchMax, or elasticStretchMax on elastic). */
  maxExcess: number;
  /** Largest ratio over non-elastic (woven shell) edges. */
  maxShellRatio: number;
};
export type { BodyCollider } from './collider.ts';

// No Three.js, DOM, React or worker dependencies: the same solver runs in the
// interactive worker and in Node for reproducible exported evidence.
export class ClothSolver {
  readonly asset: ClothAsset;
  readonly positions: Float64Array;
  readonly previous: Float64Array;
  readonly velocity: Float64Array;
  readonly inverseMass: Float64Array;
  readonly edges: Uint32Array;
  readonly restLengths: Float64Array;
  readonly edgeStrain: Float32Array;
  readonly bends: Uint32Array;
  readonly restAngles: Float64Array;
  readonly sdf: Float32Array;
  readonly elastic: Float64Array;
  readonly stitch: Float64Array;
  readonly loft: Float64Array;
  readonly panels: Int32Array;
  private tethers: Uint32Array;
  private tetherLengths: Float64Array;
  private supports: Uint32Array;
  private supportLengths: Float64Array;
  private rings: Uint32Array[];
  private ringLengths: Float64Array;
  private ringLambda: Float64Array;
  private ringGradient: Float64Array;
  private ringParticles: Uint32Array;
  private cuffGuides: {
    ids: Uint32Array;
    path: Float64Array;
    distances: Float64Array;
    radii: Float64Array;
    stop: number | null;
  }[];
  private edgeCompliance: Float64Array;
  /** Per-edge maximum length (m): rest × stretchMax, or × elasticStretchMax on elastic bands. */
  private edgeLimit: Float64Array;
  private bendCompliance: Float64Array;
  private bendLimit: Float64Array;
  /** Body collision; swap per frame for a moving (articulated) body, see collider.ts. */
  collider: BodyCollider;
  // Small-steps path (config.smallSteps = 1): XPBD with many substeps and one iteration
  // (Macklin et al. 2019, "Small Steps in Physics Simulation"), one-way long-range attachments
  // (Kim et al. 2012, LRA), hinge (cross-edge) bending and velocity-level Coulomb friction.
  private readonly smallSteps: boolean;
  private readonly oneWayTethers: boolean;
  /** 1 = legacy dressing guides (radial + stop), 2 = hand stop only, 0 = off. */
  private readonly guideMode: number;
  private hinges: Uint32Array;
  private hingeLengths: Float64Array;
  private hingeLambda: Float64Array;
  private contactDepth: Float64Array;
  private contactSlack: Float64Array;
  /** Extra per-particle contact thickness (m) for layers that lie on other cloth (hood). */
  private layerOffset: Float64Array;
  /** Layer contact pairs: source point, triangle (3 ids), remembered side (±1), target gap (m). */
  private layerPairA = new Int32Array(0);
  /** Second source vertex for edge-midpoint pairs, −1 for vertex pairs. */
  private layerPairB = new Int32Array(0);
  private layerPairTriangle = new Int32Array(0);
  private layerPairSide = new Float64Array(0);
  private layerPairGap = new Float64Array(0);
  /** Edges above stretchMax at the end of the previous frame (strain-limit hot list). */
  private hotEdges = new Int32Array(0);
  private contactAnchor: Float64Array;
  /**
   * Per-particle tangent plane of the body distance (contactPlaneRadius > 0): exact query point,
   * distance, gradient and skin velocity, valid for one collider pose (planeStamp == poseStamp).
   */
  private planeData = new Float64Array(0);
  private planeStamp = new Int32Array(0);
  private planeVelocity = new Float64Array(0);
  private allocatePlanes() {
    const n = this.inverseMass.length;
    if (this.planeStamp.length === n) return;
    this.planeData = new Float64Array(n * 8);
    this.planeStamp = new Int32Array(n);
    this.planeVelocity = new Float64Array(n * 3);
  }
  private poseStamp = 1;
  private grabTargets: Float64Array;
  private grabIds: Int32Array = new Int32Array(0);
  private baseInverseMass: Float64Array;
  private surfaceVelocity = new Float64Array(3);
  private tetherInitial: Float64Array;
  /** Tether roots (neck / shoulder-ridge particles) and their body anchor points (m). */
  readonly rootIds: Uint32Array;
  rootAnchors: Float64Array;
  private edgeLambda: Float64Array;
  private bendLambda: Float64Array;
  private excludedOffsets: Int32Array;
  private excludedIds: Int32Array;
  private cellCounts = new Int32Array(65536);
  private cellStart = new Int32Array(65537);
  private cellCursor = new Int32Array(65536);
  private cellEntries: Int32Array;
  private cellKeys: Int32Array;
  private cellX: Int32Array;
  private cellY: Int32Array;
  private cellZ: Int32Array;
  // Only relevant inter-panel pairs: sleeves↔torso/collar, hood↔back/yoke/collar.
  private collisionMasks = new Int32Array([48, 48, 176, 176, 79, 79, 176, 76]);
  private grabbed = new Map<number, number[]>();
  private region?: ClothRegion;
  /** Hand-pull clamp: per-edge length floor (m) frozen at grab start, see freezeStrainFloor. */
  private strainFloor?: Float64Array;
  /** Edges the hand-pull clamp covers (patch border), see freezeStrainFloor. */
  private clampEdges?: Int32Array;
  private gradient = new Float64Array(3);
  private contactNormals: Float64Array;
  private bendGradient = new Float64Array(12);
  elapsed = 0;
  frameIndex = 0;
  energy = Infinity;
  /** Motion bakes only (attachKernels): WebAssembly kernels for the full-mesh substep. */
  private kernels?: SolverKernels;

  constructor(asset: ClothAsset, sdf: Float32Array) {
    this.asset = asset;
    this.elastic = new Float64Array(asset.elastic);
    this.stitch = new Float64Array(asset.stitch);
    this.loft = new Float64Array(asset.loft);
    this.panels = new Int32Array(asset.panels);
    this.tethers = new Uint32Array(asset.tethers ?? []);
    this.tetherLengths = new Float64Array(asset.tether_lengths ?? []);
    this.rootIds = Uint32Array.from(
      new Set(Array.from({ length: this.tethers.length / 2 }, (_, e) => this.tethers[e * 2])),
    ).sort();
    this.rootAnchors = Float64Array.from(
      Array.from(this.rootIds).flatMap((id) => asset.initial.slice(id * 3, id * 3 + 3)),
    );
    this.tetherInitial = Float64Array.from(this.tetherLengths, (_, e) => {
      const a = this.tethers[e * 2] * 3,
        b = this.tethers[e * 2 + 1] * 3,
        q = asset.initial;
      return norm3(q[a] - q[b], q[a + 1] - q[b + 1], q[a + 2] - q[b + 2]);
    });
    // Neutral cloth can ovalise/fold without stretching its intrinsic edges.
    // Canonical circle chords are not material distances and must not pin shape.
    const neck = asset.paths.neckline?.slice(0, -1) ?? [],
      supportPairs: number[] = [],
      bounds: number[] = [];
    for (let i = 0; i < neck.length; i++)
      for (const fraction of [2, 4]) {
        const a = neck[i],
          b = neck[(i + Math.floor(neck.length / fraction)) % neck.length];
        supportPairs.push(a, b);
        let bound = norm3(
          asset.rest[a * 3] - asset.rest[b * 3],
          asset.rest[a * 3 + 1] - asset.rest[b * 3 + 1],
          asset.rest[a * 3 + 2] - asset.rest[b * 3 + 2],
        );
        if (asset.fabric_surface === 'neutral') {
          bound = 0;
          for (let j = 0; j < Math.floor(neck.length / fraction); j++) {
            const c = neck[(i + j) % neck.length] * 3,
              d = neck[(i + j + 1) % neck.length] * 3;
            bound += norm3(
              asset.rest[c] - asset.rest[d],
              asset.rest[c + 1] - asset.rest[d + 1],
              asset.rest[c + 2] - asset.rest[d + 2],
            );
          }
        }
        bounds.push(bound);
      }
    this.supports = new Uint32Array(supportPairs);
    this.supportLengths = new Float64Array(bounds);
    this.rings = [
      'neckline',
      'cuff_L',
      'cuff_R',
      'cuff_inner_L',
      'cuff_inner_R',
      'hem',
      'chest',
      'bicep_L',
      'bicep_R',
    ]
      .filter((key) => asset.paths[key]?.length > 2)
      .map((key) => new Uint32Array(asset.paths[key].slice(0, -1)));
    this.ringLengths = Float64Array.from(this.rings, (ring) => {
      let length = 0;
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j] * 3,
          b = ring[(j + 1) % ring.length] * 3;
        length += norm3(
          asset.rest[a] - asset.rest[b],
          asset.rest[a + 1] - asset.rest[b + 1],
          asset.rest[a + 2] - asset.rest[b + 2],
        );
      }
      return length;
    });
    this.ringLambda = new Float64Array(this.rings.length);
    this.ringParticles = new Uint32Array(
      Array.from(new Set(this.rings.flatMap((r) => Array.from(r)))).sort((a, b) => a - b),
    );
    this.ringGradient = new Float64Array(Math.max(1, ...this.rings.map((r) => r.length)) * 3);
    this.cuffGuides = Object.entries(asset.cuff_colliders ?? {}).map(([side, collider]) => ({
      ids: new Uint32Array(
        (asset.paths[`cuff_inner_${side}`] ?? asset.paths[`cuff_${side}`]).slice(0, -1),
      ),
      path: new Float64Array(collider.path.flat()),
      distances: new Float64Array(collider.distances_m),
      radii: new Float64Array(collider.guide_radii_m),
      stop: collider.stop_distance_m,
    }));
    this.guideMode = Math.round(asset.config.guides ?? 1);
    if (asset.neck_collider && this.guideMode !== 2) {
      const collider = asset.neck_collider;
      this.cuffGuides.push({
        ids: new Uint32Array(asset.paths.neckline.slice(0, -1)),
        path: new Float64Array(collider.path.flat()),
        distances: new Float64Array(collider.distances_m),
        radii: new Float64Array(collider.guide_radii_m),
        stop: collider.stop_distance_m,
      });
    }
    const flags = asset.config;
    this.smallSteps = (flags.smallSteps ?? 0) > 0;
    this.oneWayTethers = (flags.oneWayTethers ?? 0) > 0;
    this.positions = new Float64Array(asset.initial);
    this.previous = this.positions.slice();
    this.velocity = new Float64Array(this.positions.length);
    this.contactNormals = new Float64Array(this.positions.length);
    this.inverseMass = new Float64Array(this.positions.length / 3).fill(
      1 / asset.config.particleMass,
    );
    for (let i = 0; i < (asset.attachments?.length ?? 0); i += 4)
      this.inverseMass[asset.attachments![i]] = 0;
    this.baseInverseMass = this.inverseMass.slice();
    this.contactDepth = new Float64Array(this.inverseMass.length);
    this.contactSlack = new Float64Array(this.inverseMass.length);
    this.layerOffset = new Float64Array(this.inverseMass.length);
    this.contactAnchor = new Float64Array(this.inverseMass.length * 3);
    this.grabTargets = new Float64Array(0);
    let neighbours = Array.from(this.inverseMass, () => new Set<number>());
    const count = this.inverseMass.length;
    this.cellEntries = new Int32Array(count);
    this.cellKeys = new Int32Array(count);
    this.cellX = new Int32Array(count);
    this.cellY = new Int32Array(count);
    this.cellZ = new Int32Array(count);
    const edges = new Map<string, { a: number; b: number; opposite: number[] }>();
    for (let t = 0; t < asset.triangles.length; t += 3) {
      const tri = asset.triangles.slice(t, t + 3);
      if (asset.fabric_surface === 'neutral' && tri.some((i) => !this.inverseMass[i])) continue;
      for (let c = 0; c < 3; c++) {
        const a = Math.min(tri[c], tri[(c + 1) % 3]),
          b = Math.max(tri[c], tri[(c + 1) % 3]);
        const key = `${a}:${b}`;
        if (!edges.has(key)) edges.set(key, { a, b, opposite: [] });
        edges.get(key)!.opposite.push(tri[(c + 2) % 3]);
        neighbours[a].add(b);
        neighbours[b].add(a);
      }
    }
    const pairs: number[] = [],
      bends: number[] = [];
    for (const { a, b, opposite } of edges.values()) {
      pairs.push(a, b);
      if (opposite.length === 2) bends.push(a, b, opposite[0], opposite[1]);
    }
    for (let w = 0; w < asset.welds.length; w += 2) {
      const a = asset.welds[w],
        b = asset.welds[w + 1];
      pairs.push(a, b);
      neighbours[a].add(b);
      neighbours[b].add(a);
    }
    this.edges = new Uint32Array(pairs);
    this.restLengths = Float64Array.from({ length: pairs.length / 2 }, (_, e) => {
      const a = pairs[e * 2] * 3,
        b = pairs[e * 2 + 1] * 3;
      return norm3(
        asset.rest[a] - asset.rest[b],
        asset.rest[a + 1] - asset.rest[b + 1],
        asset.rest[a + 2] - asset.rest[b + 2],
      );
    });
    this.bends = new Uint32Array(bends);
    const restTyped = new Float64Array(asset.rest);
    this.restAngles = Float64Array.from({ length: bends.length / 4 }, (_, b) =>
      this.angle(restTyped, b),
    );
    this.edgeLambda = new Float64Array(this.restLengths.length);
    this.bendLambda = new Float64Array(this.restAngles.length);
    this.edgeStrain = new Float32Array(this.restLengths.length);
    this.edgeCompliance = Float64Array.from(this.restLengths, (_, e) =>
      this.elastic[this.edges[e * 2]] > 0.5 && this.elastic[this.edges[e * 2 + 1]] > 0.5
        ? asset.config.elasticCompliance
        : asset.config.stretchCompliance,
    );
    // Elastic rib bands have their own configured limit (uncalibrated); woven shell fabric uses
    // stretchMax. Without elasticStretchMax both use stretchMax (legacy behaviour).
    this.edgeLimit = Float64Array.from(this.restLengths, (rest, e) =>
      this.elastic[this.edges[e * 2]] > 0.5 && this.elastic[this.edges[e * 2 + 1]] > 0.5
        ? rest * (asset.config.elasticStretchMax ?? asset.config.stretchMax)
        : rest * asset.config.stretchMax,
    );
    this.bendCompliance = Float64Array.from(this.restAngles, (_, b) =>
      Math.min(this.stitch[this.bends[b * 4]], this.stitch[this.bends[b * 4 + 1]]) > 0.7
        ? asset.config.seamBendCompliance
        : asset.config.bendCompliance,
    );
    this.bendLimit = Float64Array.from(this.restAngles, (_, b) => {
      const ids = this.bends.slice(b * 4, b * 4 + 4);
      let shortest = Infinity;
      for (const [a, c] of [
        [0, 1],
        [0, 2],
        [1, 2],
        [0, 3],
        [1, 3],
      ]) {
        const i = ids[a] * 3,
          j = ids[c] * 3;
        shortest = Math.min(
          shortest,
          norm3(
            restTyped[i] - restTyped[j],
            restTyped[i + 1] - restTyped[j + 1],
            restTyped[i + 2] - restTyped[j + 2],
          ),
        );
      }
      return Math.min(asset.config.bendMaxCorrection, shortest * asset.config.bendRestEdgeFraction);
    });
    this.sdf = sdf;
    this.collider = new GridSdfCollider(sdf, asset.sdf);
    // Hinge bending: a compliant two-sided distance between the two vertices opposite each
    // interior edge. Rest = the constructed (initial) shape, so the wrapped garment keeps its
    // designed curvature, folded hood and stacked sleeves instead of springing back to flat
    // panels. Quadratic and well conditioned at any compliance, unlike the dihedral angle
    // constraint (bend()), which gained energy from 0.1 mm noise at every compliance tested.
    const hingeCompliance = flags.hingeCompliance ?? 0,
      hingePairs: number[] = [];
    if (hingeCompliance > 0)
      for (let b = 0; b < bends.length; b += 4) {
        // Optional: elastic rib bands (cuffs, hem) gather and roll freely, no shape memory.
        if (
          (flags.hingeSkipElastic ?? 0) > 0 &&
          [0, 1, 2, 3].some((k) => asset.elastic[bends[b + k]] > 0.5)
        )
          continue;
        hingePairs.push(bends[b + 2], bends[b + 3]);
      }
    this.hinges = new Uint32Array(hingePairs);
    this.hingeLengths = Float64Array.from({ length: hingePairs.length / 2 }, (_, e) => {
      const a = hingePairs[e * 2] * 3,
        b = hingePairs[e * 2 + 1] * 3,
        q = asset.initial;
      return norm3(q[a] - q[b], q[a + 1] - q[b + 1], q[a + 2] - q[b + 2]);
    });
    this.hingeLambda = new Float64Array(this.hingeLengths.length);
    // Extend the exclusion to two-hop neighbours so sewn panels do not repel
    // themselves. Nonadjacent sleeve/torso and hood/back remain collision pairs.
    neighbours = neighbours.map((direct, i) => {
      const set = new Set(direct);
      for (const j of direct) for (const k of neighbours[j]) set.add(k);
      set.add(i);
      return set;
    });
    this.excludedOffsets = new Int32Array(count + 1);
    const exclusions: number[] = [];
    for (let i = 0; i < count; i++) {
      for (const neighbour of Array.from(neighbours[i]).sort((a, b) => a - b))
        exclusions.push(neighbour);
      this.excludedOffsets[i + 1] = exclusions.length;
    }
    this.excludedIds = new Int32Array(exclusions);
    this.cuffStopStart = this.cuffGuides.map((guide) => this.guideDistance(guide).distance);
    // Hand stop moves the whole elastic cuff band of that sleeve (the ring and the elastic row
    // above it), not only the opening ring.
    if (this.guideMode === 2)
      this.cuffStopIds = this.cuffGuides.map((guide) => {
        const panel = this.panels[guide.ids[0]],
          band = new Set(guide.ids);
        for (let i = 0; i < this.panels.length; i++)
          if (this.panels[i] === panel && this.elastic[i] > 0.5) band.add(i);
        return Uint32Array.from(band);
      });
    this.layerOffsets(flags.hoodLayerGap ?? 0);
    if ((flags.layerPairRadius ?? 0) > 0) this.rebuildLayerPairs();
    // The small-steps path starts from the exact mesh-space wrap; contacts engage only where
    // the cloth actually approaches the body during the relax.
    if (!this.smallSteps) this.projectBody();
    attachAccessories(this.positions, asset.attachments ?? [], asset.attachment_offsets ?? []);
    this.previous.set(this.positions);
  }

  /**
   * Layered contact for the folded hood (panel 7): it lies on the back/yoke/collar shell, not
   * on the body. Particle-particle self contact (1 mm radius, ~1.2 cm edges) cannot stop a
   * sheet passing through another, so each hood particle instead keeps the body clearance of
   * the shell beneath it (nearest back/yoke/collar particle in the constructed state) plus
   * `gap`. Contact still uses the body's own distance and normal, so it moves with the body.
   */
  private layerOffsets(gap: number) {
    const flags = this.asset.config,
      q = this.asset.initial,
      panels = this.panels,
      base = this.asset.layer_m + this.asset.config.collisionMargin,
      under: number[] = [];
    // Where the wrap was built closer to the body than layer + margin (cuffs on the wrist:
    // the 7 mm grid reads ~1.5 mm less than the exact mesh clearance the builder checked),
    // contact starts at the constructed clearance instead of pushing the ring open on frame 1.
    // Never below the collision margin.
    if ((flags.contactFromInitial ?? 0) > 0)
      for (let i = 0; i < panels.length; i++) {
        const own = this.collider.distance(q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
        this.layerOffset[i] = Math.max(flags.collisionMargin - base, Math.min(0, own - base));
      }
    if (!(gap > 0)) return;
    for (let i = 0; i < panels.length; i++)
      if (panels[i] === 2 || panels[i] === 3 || panels[i] === 6) under.push(i);
    for (let i = 0; i < panels.length; i++) {
      if (panels[i] !== 7) continue;
      let best = Infinity,
        nearest = -1;
      for (const j of under) {
        const d =
          (q[i * 3] - q[j * 3]) ** 2 +
          (q[i * 3 + 1] - q[j * 3 + 1]) ** 2 +
          (q[i * 3 + 2] - q[j * 3 + 2]) ** 2;
        if (d < best) {
          best = d;
          nearest = j;
        }
      }
      if (nearest < 0) continue;
      const shell = this.collider.distance(q[nearest * 3], q[nearest * 3 + 1], q[nearest * 3 + 2]),
        own = this.collider.distance(q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
      // Never above the constructed hood position (no initial push), never below the body layer.
      this.layerOffset[i] = Math.max(0, Math.min(own, shell + gap) - base);
    }
    // Taper to zero at the hood root: the first rows are sewn to the neckline itself, so a
    // full layer offset there would push them off their own seam.
    for (let e = 0; e < this.tetherInitial.length; e++) {
      const id = this.tethers[e * 2 + 1];
      if (panels[id] === 7)
        this.layerOffset[id] *= Math.min(1, this.tetherInitial[e] / (flags.hoodLayerTaper ?? 0.03));
    }
  }

  /** Body signed distance through the active collider (kept for callers and tests). */
  sampleSdf(
    x: number,
    y: number,
    z: number,
    gradient?: Float64Array,
    threshold = Infinity,
  ): number {
    return this.collider.distance(x, y, z, gradient, threshold);
  }
  /** Move the root anchors with the body (rootIds order, metres); used by moving colliders. */
  setRootAnchors(points: ArrayLike<number>) {
    if (points.length !== this.rootAnchors.length) throw new Error('Root anchor count mismatch');
    this.rootAnchors = Float64Array.from(points);
  }
  /** Names of the hand-stop arm paths, in the order setCuffPaths expects (cuff_colliders keys). */
  get cuffPathNames() {
    return Object.keys(this.asset.cuff_colliders ?? {});
  }
  /**
   * Move the hand-stop arm paths with the body (motion bakes): one polyline per cuffPathNames
   * entry, same point count as the asset's path (metres). Arc distances are re-measured along
   * the new polyline from the path's first distance; the stop keeps its arc distance, so the
   * cuff band still cannot pass the hand wherever the forearm is. `rebase` (first call) also
   * re-measures where the wrap placed the cuff along the new path.
   */
  setCuffPaths(paths: readonly ArrayLike<number>[], rebase = false) {
    const names = this.cuffPathNames;
    if (paths.length !== names.length) throw new Error('Cuff path count mismatch');
    paths.forEach((points, g) => {
      const guide = this.cuffGuides[g];
      if (points.length !== guide.path.length || !Array.from(points).every(Number.isFinite))
        throw new Error('Invalid cuff path');
      guide.path.set(points);
      const d = guide.distances,
        q = guide.path;
      for (let j = 1; j < d.length; j++)
        d[j] =
          d[j - 1] +
          norm3(q[j * 3] - q[j * 3 - 3], q[j * 3 + 1] - q[j * 3 - 2], q[j * 3 + 2] - q[j * 3 - 1]);
      // rebase: the wrap's cuff position is re-measured on the new path (the motion body's
      // neutral differs from the display body by ~1 cm), so the stop never pulls the cuff back.
      if (rebase) this.cuffStopStart[g] = this.guideDistance(guide).distance;
    });
  }
  /** Replace the body collider (e.g. the articulated body SDF of the current motion frame). */
  setCollider(collider: BodyCollider) {
    const bound = collider === this.collider ? collider.motionBound : undefined;
    this.collider = collider;
    if (bound === undefined || !(bound >= 0)) {
      this.contactSlack.fill(0);
      this.poseStamp++;
      return;
    }
    // Same moving collider re-posed: the body moved at most `bound`, so a particle that had
    // `slack` clearance still has at least slack − bound. Planes stay valid only if nothing moved.
    const slack = this.contactSlack;
    for (let i = 0; i < slack.length; i++) slack[i] = slack[i] > bound ? slack[i] - bound : 0;
    if (bound > 0) this.poseStamp++;
  }
  private projectBody(onlyRings = false, hardOnly = false) {
    const p = this.positions,
      c = this.asset.config;
    if (!onlyRings) this.contactNormals.fill(0);
    const count = onlyRings ? this.ringParticles.length : this.inverseMass.length;
    for (let slot = 0; slot < count; slot++) {
      const i = onlyRings ? this.ringParticles[slot] : slot;
      if (!this.inverseMass[i]) continue;
      const k = i * 3;
      const loft = this.asset.fabric_surface === 'neutral' ? 0 : this.loft[i];
      const thickness = loft + this.asset.layer_m + c.collisionMargin;
      const minimum = loft * c.loftMinimumRatio + this.asset.layer_m + c.collisionMargin;
      const target = hardOnly ? minimum : thickness;
      const g = this.gradient;
      const distance = this.sampleSdf(p[k], p[k + 1], p[k + 2], g, target);
      if (distance < target) {
        const gradientLength = norm3(g[0], g[1], g[2]) || 1;
        g[0] /= gradientLength;
        g[1] /= gradientLength;
        g[2] /= gradientLength;
        this.contactNormals[k] = g[0];
        this.contactNormals[k + 1] = g[1];
        this.contactNormals[k + 2] = g[2];
        const h = c.dt / c.substeps,
          w = this.inverseMass[i];
        const compliance = loft > 0 ? c.loftCompliance : 0;
        const soft = hardOnly ? 0 : ((thickness - distance) * w) / (w + compliance / (h * h));
        const correction = Math.max(soft, minimum - distance);
        for (let a = 0; a < 3; a++) p[k + a] += g[a] * correction;
        // Coulomb-like positional friction: preserve tangential contact history.
        const dx = p[k] - this.previous[k],
          dy = p[k + 1] - this.previous[k + 1],
          dz = p[k + 2] - this.previous[k + 2];
        const normal = dx * g[0] + dy * g[1] + dz * g[2];
        const length = norm3(dx - normal * g[0], dy - normal * g[1], dz - normal * g[2]);
        const friction = Math.min(1, (c.friction * correction) / (length + 1e-12));
        p[k] -= (dx - normal * g[0]) * friction;
        p[k + 1] -= (dy - normal * g[1]) * friction;
        p[k + 2] -= (dz - normal * g[2]) * friction;
      }
      p[k + 1] = Math.max(c.collisionMargin, p[k + 1]);
    }
  }

  private stretch(h: number, reverse = false, list?: Int32Array) {
    // Hot loop: every per-edge lookup hoisted into locals (the small-steps path runs this
    // 10+ times per frame over ~28k edges). `list` restricts it to the local region (M4).
    const p = this.positions,
      edges = this.edges,
      restLengths = this.restLengths,
      lambdas = this.edgeLambda,
      compliances = this.edgeCompliance,
      inverseMass = this.inverseMass,
      neutral = this.asset.fabric_surface === 'neutral',
      limits = this.edgeLimit,
      inverseH2 = 1 / (h * h),
      count = list ? list.length : restLengths.length;
    for (let slot = 0; slot < count; slot++) {
      const o = reverse ? count - 1 - slot : slot,
        e = list ? list[o] : o,
        ai = edges[e * 2],
        bi = edges[e * 2 + 1],
        a = ai * 3,
        b = bi * 3;
      const dx = p[a] - p[b],
        dy = p[a + 1] - p[b + 1],
        dz = p[a + 2] - p[b + 2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 1e-12) continue;
      const rest = restLengths[e];
      // Tension-field cloth: unresolved compression buckles into the render
      // wrinkle field instead of forcing a shortened sleeve axially straight.
      if (neutral && length <= rest) {
        lambdas[e] = 0;
        continue;
      }
      const alpha = length > limits[e] ? 0 : compliances[e] * inverseH2;
      const wa = inverseMass[ai],
        wb = inverseMass[bi],
        den = wa + wb + alpha;
      if (!den) continue;
      const lambda = (rest - length - alpha * lambdas[e]) / den;
      lambdas[e] += lambda;
      const scale = lambda / length;
      p[a] += wa * scale * dx;
      p[a + 1] += wa * scale * dy;
      p[a + 2] += wa * scale * dz;
      p[b] -= wb * scale * dx;
      p[b + 1] -= wb * scale * dy;
      p[b + 2] -= wb * scale * dz;
    }
  }

  private angle(p: ArrayLike<number>, bend: number, gradients = false) {
    const base = bend * 4,
      a = this.bends[base] * 3,
      b = this.bends[base + 1] * 3,
      c = this.bends[base + 2] * 3,
      d = this.bends[base + 3] * 3;
    const ex = p[b] - p[a],
      ey = p[b + 1] - p[a + 1],
      ez = p[b + 2] - p[a + 2];
    const ux = p[c] - p[a],
      uy = p[c + 1] - p[a + 1],
      uz = p[c + 2] - p[a + 2];
    const vx = p[d] - p[a],
      vy = p[d + 1] - p[a + 1],
      vz = p[d + 2] - p[a + 2];
    const n1x = ey * uz - ez * uy,
      n1y = ez * ux - ex * uz,
      n1z = ex * uy - ey * ux;
    const n2x = vy * ez - vz * ey,
      n2y = vz * ex - vx * ez,
      n2z = vx * ey - vy * ex;
    const n1 = n1x * n1x + n1y * n1y + n1z * n1z,
      n2 = n2x * n2x + n2y * n2y + n2z * n2z;
    const el = norm3(ex, ey, ez);
    if (n1 < 1e-18 || n2 < 1e-18 || el < 1e-9) {
      if (gradients) this.bendGradient.fill(0);
      return 0;
    }
    const cosine = Math.max(
      -1,
      Math.min(1, (n1x * n2x + n1y * n2y + n1z * n2z) / Math.sqrt(n1 * n2)),
    );
    const sign =
      ex * (n1y * n2z - n1z * n2y) + ey * (n1z * n2x - n1x * n2z) + ez * (n1x * n2y - n1y * n2x) < 0
        ? -1
        : 1;
    const angle = Math.acos(cosine) * sign;
    if (gradients) {
      const g = this.bendGradient;
      g[6] = (n1x * el) / n1;
      g[7] = (n1y * el) / n1;
      g[8] = (n1z * el) / n1;
      g[9] = (n2x * el) / n2;
      g[10] = (n2y * el) / n2;
      g[11] = (n2z * el) / n2;
      const t1 = (ux * ex + uy * ey + uz * ez) / (el * el),
        t2 = (vx * ex + vy * ey + vz * ez) / (el * el);
      for (let k = 0; k < 3; k++) {
        g[3 + k] = -t1 * g[6 + k] - t2 * g[9 + k];
        g[k] = -g[3 + k] - g[6 + k] - g[9 + k];
      }
      // Signed atan orientation above has the opposite derivative to unsigned
      // PBD q vectors. Verified against central finite differences in tests.
      for (let k = 0; k < 12; k++) g[k] *= -1;
    }
    return angle;
  }

  private bend(h: number) {
    const p = this.positions;
    for (let b = 0; b < this.restAngles.length; b++) {
      let error = this.angle(p, b, true) - this.restAngles[b];
      if (error > Math.PI) error -= 2 * Math.PI;
      if (error < -Math.PI) error += 2 * Math.PI;
      const alpha = this.bendCompliance[b] / (h * h);
      const ids = this.bends,
        g = this.bendGradient,
        k = b * 4;
      const i0 = ids[k],
        i1 = ids[k + 1],
        i2 = ids[k + 2],
        i3 = ids[k + 3];
      const w0 = this.inverseMass[i0],
        w1 = this.inverseMass[i1],
        w2 = this.inverseMass[i2],
        w3 = this.inverseMass[i3];
      const q0 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2],
        q1 = g[3] * g[3] + g[4] * g[4] + g[5] * g[5];
      const q2 = g[6] * g[6] + g[7] * g[7] + g[8] * g[8],
        q3 = g[9] * g[9] + g[10] * g[10] + g[11] * g[11];
      const den = alpha + w0 * q0 + w1 * q1 + w2 * q2 + w3 * q3;
      if (!den) continue;
      let lambda = (-error - alpha * this.bendLambda[b]) / den;
      const correction =
        Math.abs(lambda) *
        Math.sqrt(Math.max(w0 * w0 * q0, w1 * w1 * q1, w2 * w2 * q2, w3 * w3 * q3));
      if (correction > this.bendLimit[b]) lambda *= this.bendLimit[b] / correction;
      this.bendLambda[b] += lambda;
      const a0 = i0 * 3,
        a1 = i1 * 3,
        a2 = i2 * 3,
        a3 = i3 * 3;
      p[a0] += w0 * lambda * g[0];
      p[a0 + 1] += w0 * lambda * g[1];
      p[a0 + 2] += w0 * lambda * g[2];
      p[a1] += w1 * lambda * g[3];
      p[a1 + 1] += w1 * lambda * g[4];
      p[a1 + 2] += w1 * lambda * g[5];
      p[a2] += w2 * lambda * g[6];
      p[a2 + 1] += w2 * lambda * g[7];
      p[a2 + 2] += w2 * lambda * g[8];
      p[a3] += w3 * lambda * g[9];
      p[a3 + 1] += w3 * lambda * g[10];
      p[a3 + 2] += w3 * lambda * g[11];
    }
  }

  private selfCollide() {
    const p = this.positions,
      cell = this.asset.config.selfRadius * 2,
      invCell = 1 / cell;
    const cell2 = cell * cell,
      n = this.inverseMass.length;
    const counts = this.cellCounts,
      start = this.cellStart,
      cursor = this.cellCursor;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      if (!this.collisionMasks[this.panels[i]]) continue;
      const k = i * 3,
        x = Math.floor(p[k] * invCell),
        y = Math.floor(p[k + 1] * invCell),
        z = Math.floor(p[k + 2] * invCell);
      this.cellX[i] = x;
      this.cellY[i] = y;
      this.cellZ[i] = z;
      const hash = this.hashKey(x, y, z);
      this.cellKeys[i] = hash;
      counts[hash]++;
    }
    start[0] = 0;
    for (let i = 0; i < counts.length; i++) {
      start[i + 1] = start[i] + counts[i];
      cursor[i] = start[i];
    }
    for (let i = 0; i < n; i++)
      if (this.collisionMasks[this.panels[i]]) this.cellEntries[cursor[this.cellKeys[i]]++] = i;
    for (let i = 0; i < n; i++) {
      const mask = this.collisionMasks[this.panels[i]];
      if (!mask) continue;
      const k = i * 3,
        x = this.cellX[i],
        y = this.cellY[i],
        z = this.cellZ[i];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const cx = x + dx,
              cy = y + dy,
              cz = z + dz,
              key = this.hashKey(cx, cy, cz);
            for (let slot = start[key]; slot < start[key + 1]; slot++) {
              const j = this.cellEntries[slot];
              if (
                j <= i ||
                !(mask & (1 << this.panels[j])) ||
                this.cellX[j] !== cx ||
                this.cellY[j] !== cy ||
                this.cellZ[j] !== cz
              )
                continue;
              const b = j * 3,
                ux = p[k] - p[b],
                uy = p[k + 1] - p[b + 1],
                uz = p[k + 2] - p[b + 2];
              const d2 = ux * ux + uy * uy + uz * uz;
              if (d2 >= cell2 || d2 < 1e-18) continue;
              if (this.excluded(i, j)) continue;
              const wa = this.inverseMass[i],
                wb = this.inverseMass[j],
                den = wa + wb;
              if (!den) continue;
              const dist = Math.sqrt(d2),
                scale = (cell - dist) / (dist * den);
              p[k] += ux * scale * wa;
              p[k + 1] += uy * scale * wa;
              p[k + 2] += uz * scale * wa;
              p[b] -= ux * scale * wb;
              p[b + 1] -= uy * scale * wb;
              p[b + 2] -= uz * scale * wb;
            }
          }
    }
  }
  private hashKey(x: number, y: number, z: number) {
    // Collisions never drop entries: exact cell coordinates are checked above.
    return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 65535;
  }
  private limitTethers(h = 0, list?: Int32Array) {
    const p = this.positions,
      max = this.asset.config.stretchMax;
    // Coarse collar strain limits keep a closed neckline from numerically
    // expanding through the shoulders. Compression/folding remains free.
    for (let e = 0; e < this.supportLengths.length; e++) {
      const ai = this.supports[e * 2],
        bi = this.supports[e * 2 + 1],
        a = ai * 3,
        b = bi * 3;
      const dx = p[b] - p[a],
        dy = p[b + 1] - p[a + 1],
        dz = p[b + 2] - p[a + 2],
        length = norm3(dx, dy, dz);
      const high = this.supportLengths[e] * max;
      const low =
        this.asset.fabric_surface === 'neutral'
          ? 0
          : this.supportLengths[e] * this.asset.config.collarCompression;
      if (length < 1e-12) continue;
      const bound = Math.max(low, Math.min(high, length));
      if (length === bound) continue;
      const wa = this.inverseMass[ai],
        wb = this.inverseMass[bi],
        den = wa + wb;
      if (!den) continue;
      const scale = (length - bound) / (length * den);
      p[a] += dx * scale * wa;
      p[a + 1] += dy * scale * wa;
      p[a + 2] += dz * scale * wa;
      p[b] -= dx * scale * wb;
      p[b + 1] -= dy * scale * wb;
      p[b + 2] -= dz * scale * wb;
    }
    // Legacy (two-way): both cloth endpoints remain dynamic; only upper bounds, so loose
    // fabric can shorten and stack under gravity.
    // One-way LRA (small-steps path): the root rests on the shoulders/neck and is held by body
    // contact; the tether must not drag it down (each root carries ~200 tethers, and two-way
    // splitting pulled the roots off the shoulders). Only the child moves:
    //  - hard: never farther than rest geodesic × stretchMax (inextensible fabric bound);
    //  - soft (supportCompliance > 0): a one-sided compliant pull towards the constructed
    //    root distance. It carries each particle's own weight to the support directly, which
    //    the one-iteration stretch chain cannot do within the step budget (its sag grows with
    //    rows² · g · h²). Equilibrium extra sag ≈ particleMass · g · supportCompliance.
    const soft = this.oneWayTethers && h > 0 ? (this.asset.config.supportCompliance ?? 0) : 0,
      alpha = soft > 0 ? soft / (h * h) : 0,
      anchor = this.oneWayTethers && h > 0 ? (this.asset.config.rootCompliance ?? 0) : 0;
    // Shoulder/neck static friction (rootCompliance > 0): each root is pulled towards its
    // anchor on the body (XPBD attachment). A worn jacket does not creep down the shoulders
    // while standing; the one-sweep chain loads the roots more than real friction would
    // resist. Moving bodies update the anchors with setRootAnchors().
    if (anchor > 0) {
      const beta = anchor / (h * h),
        // rootLiftFree: the shoulders support the jacket from below only; a root pulled above its
        // anchor (arms raised lift the yoke) is free, as on a real body.
        liftFree = (this.asset.config.rootLiftFree ?? 0) > 0;
      for (let r = 0; r < this.rootIds.length; r++) {
        const id = this.rootIds[r],
          w = this.inverseMass[id];
        if (!w) continue;
        if (liftFree && p[id * 3 + 1] > this.rootAnchors[r * 3 + 1]) continue;
        const f = w / (w + beta),
          k = id * 3,
          q = r * 3;
        p[k] += (this.rootAnchors[q] - p[k]) * f;
        p[k + 1] += (this.rootAnchors[q + 1] - p[k + 1]) * f;
        p[k + 2] += (this.rootAnchors[q + 2] - p[k + 2]) * f;
      }
    }
    const tetherCount = list ? list.length : this.tetherLengths.length;
    for (let slot = 0; slot < tetherCount; slot++) {
      const e = list ? list[slot] : slot,
        root = this.tethers[e * 2],
        a = root * 3,
        id = this.tethers[e * 2 + 1],
        b = id * 3,
        wb = this.inverseMass[id];
      if (!wb) continue;
      const dx = p[b] - p[a],
        dy = p[b + 1] - p[a + 1],
        dz = p[b + 2] - p[a + 2],
        length = norm3(dx, dy, dz);
      if (length < 1e-12) continue;
      let target = Math.min(length, this.tetherLengths[e] * max);
      if (alpha > 0 && target > this.tetherInitial[e])
        target -= ((target - this.tetherInitial[e]) * wb) / (wb + alpha);
      if (target >= length) continue;
      const wa = this.oneWayTethers ? 0 : this.inverseMass[root];
      const scale = (length - target) / (length * (wa + wb));
      p[b] -= dx * scale * wb;
      p[b + 1] -= dy * scale * wb;
      p[b + 2] -= dz * scale * wb;
      p[a] += dx * scale * wa;
      p[a + 1] += dy * scale * wa;
      p[a + 2] += dz * scale * wa;
    }
  }
  private constrainRings(h: number) {
    const p = this.positions,
      c = this.asset.config,
      g = this.ringGradient;
    for (let r = 0; r < this.rings.length; r++) {
      const ring = this.rings[r],
        n = ring.length;
      let length = 0,
        den = 0;
      for (let j = 0; j < n; j++) {
        const id = ring[j],
          a = id * 3,
          b = ring[(j + 1) % n] * 3,
          d = ring[(j + n - 1) % n] * 3;
        const ux = p[a] - p[b],
          uy = p[a + 1] - p[b + 1],
          uz = p[a + 2] - p[b + 2];
        const vx = p[a] - p[d],
          vy = p[a + 1] - p[d + 1],
          vz = p[a + 2] - p[d + 2];
        const u = norm3(ux, uy, uz),
          v = norm3(vx, vy, vz);
        length += u;
        const iu = u > 1e-12 ? 1 / u : 0,
          iv = v > 1e-12 ? 1 / v : 0,
          k = j * 3;
        g[k] = ux * iu + vx * iv;
        g[k + 1] = uy * iu + vy * iv;
        g[k + 2] = uz * iu + vz * iv;
        den += this.inverseMass[id] * (g[k] * g[k] + g[k + 1] * g[k + 1] + g[k + 2] * g[k + 2]);
      }
      const rest = this.ringLengths[r];
      if (this.asset.fabric_surface === 'neutral' && !ring.some((id) => !this.inverseMass[id])) {
        if (length > rest * c.stretchMax) {
          let x = 0,
            y = 0,
            z = 0;
          for (const id of ring) {
            x += p[id * 3] / n;
            y += p[id * 3 + 1] / n;
            z += p[id * 3 + 2] / n;
          }
          const scale = (rest * c.stretchMax) / length;
          for (const id of ring) {
            const k = id * 3;
            p[k] = x + (p[k] - x) * scale;
            p[k + 1] = y + (p[k + 1] - y) * scale;
            p[k + 2] = z + (p[k + 2] - z) * scale;
          }
        }
        continue;
      }
      if (this.asset.fabric_surface === 'neutral' && length <= rest) {
        this.ringLambda[r] = 0;
        continue;
      }
      const alpha = (length > rest * c.stretchMax ? 0 : c.elasticCompliance) / (h * h);
      den += alpha;
      if (!den) continue;
      let lambda = (-(length - rest) - alpha * this.ringLambda[r]) / den,
        maxCorrection = 0;
      for (let j = 0; j < n; j++) {
        const k = j * 3;
        maxCorrection = Math.max(
          maxCorrection,
          this.inverseMass[ring[j]] * Math.abs(lambda) * norm3(g[k], g[k + 1], g[k + 2]),
        );
      }
      if (maxCorrection > c.ringCorrectionLimit) lambda *= c.ringCorrectionLimit / maxCorrection;
      this.ringLambda[r] += lambda;
      for (let j = 0; j < n; j++) {
        const id = ring[j],
          a = id * 3,
          k = j * 3,
          w = this.inverseMass[id];
        p[a] += w * lambda * g[k];
        p[a + 1] += w * lambda * g[k + 1];
        p[a + 2] += w * lambda * g[k + 2];
      }
    }
  }
  /** Ring centroid's arc distance along a guide path (projection onto the polyline). */
  private guideDistance(guide: { ids: Uint32Array; path: Float64Array; distances: Float64Array }) {
    const p = this.positions,
      path = guide.path,
      distances = guide.distances;
    let x = 0,
      y = 0,
      z = 0;
    for (const id of guide.ids) {
      x += p[id * 3] / guide.ids.length;
      y += p[id * 3 + 1] / guide.ids.length;
      z += p[id * 3 + 2] / guide.ids.length;
    }
    let best = Infinity,
      distance = 0,
      tx = 0,
      ty = 0,
      tz = 0;
    for (let j = 0; j < distances.length - 1; j++) {
      const k = j * 3,
        dx = path[k + 3] - path[k],
        dy = path[k + 4] - path[k + 1],
        dz = path[k + 5] - path[k + 2],
        length2 = dx * dx + dy * dy + dz * dz;
      const f = Math.max(
        0,
        Math.min(
          1,
          ((x - path[k]) * dx + (y - path[k + 1]) * dy + (z - path[k + 2]) * dz) / length2,
        ),
      );
      const squared =
        (path[k] + f * dx - x) ** 2 +
        (path[k + 1] + f * dy - y) ** 2 +
        (path[k + 2] + f * dz - z) ** 2;
      if (squared < best) {
        best = squared;
        distance = distances[j] + f * (distances[j + 1] - distances[j]);
        const length = Math.sqrt(length2);
        tx = dx / length;
        ty = dy / length;
        tz = dz / length;
      }
    }
    return { distance, tx, ty, tz };
  }
  /**
   * Hand stop only (guides = 2): the cuff opening cannot pass the hand (aperture.py stop), so
   * a cuff ring whose centroid moves further down its arm path than where the wrap placed it
   * (or the collider's stop, whichever is further) is translated back along the path. No
   * radial guidance and no neck guide.
   */
  private cuffStops() {
    const p = this.positions;
    for (let g = 0; g < this.cuffGuides.length; g++) {
      const guide = this.cuffGuides[g];
      if (guide.stop == null) continue;
      const { distance, tx, ty, tz } = this.guideDistance(guide),
        limit = Math.max(guide.stop, this.cuffStopStart[g]);
      if (distance <= limit) continue;
      const back = distance - limit;
      for (const id of this.cuffStopIds[g] ?? guide.ids)
        if (this.inverseMass[id]) {
          p[id * 3] -= tx * back;
          p[id * 3 + 1] -= ty * back;
          p[id * 3 + 2] -= tz * back;
        }
    }
  }
  private cuffStopStart: number[] = [];
  /** Armhole stops (motion bakes only, armholeStop.ts); empty = off, the default. */
  private armholeStops: ArmholeStop[] = [];
  /**
   * Armhole stops for motion bakes (armholeStop.ts): per side, the underarm seam particle ids,
   * their anchors on the upper-arm skin (ids × 3) and the unit humerus axis, for the current
   * frame. `rebase` (first call) takes the current state as the rest offsets (a no-op there).
   * `null` turns them off. Applied after the hand stop in every substep, in JS on the shared
   * positions, so the JS and WebAssembly paths stay identical.
   */
  setArmholeStops(
    stops:
      | {
          ids: ArrayLike<number>;
          anchors: ArrayLike<number>;
          axis: ArrayLike<number>;
          stiffness?: number;
          direction?: 'axis' | 'anchor';
        }[]
      | null,
    rebase = false,
  ) {
    if (!stops) {
      this.armholeStops = [];
      return;
    }
    if (!rebase && stops.length !== this.armholeStops.length)
      throw new Error('Armhole stops must be rebased first');
    stops.forEach((s, i) => {
      if (s.anchors.length !== s.ids.length * 3 || s.axis.length !== 3)
        throw new Error('Invalid armhole stop');
      if (rebase) {
        this.armholeStops[i] = {
          ids: Uint32Array.from(s.ids),
          anchors: Float64Array.from(s.anchors),
          axis: Float64Array.from(s.axis),
          offsets: new Float64Array(s.ids.length),
          stiffness: s.stiffness ?? 1,
          direction: s.direction ?? 'axis',
        };
        rebaseArmholeStop(this.armholeStops[i], this.positions);
      } else {
        this.armholeStops[i].anchors.set(s.anchors);
        this.armholeStops[i].axis.set(s.axis);
      }
    });
    if (rebase) this.armholeStops.length = stops.length;
  }
  /** Long-range attachments from the armhole stop points (armholeStop.ts); null = off. */
  private armholeTethers: ArmholeTethers | null = null;
  setArmholeTethers(tethers: ArmholeTethers | null) {
    this.armholeTethers = tethers;
  }
  private applyArmholeStops() {
    for (const stop of this.armholeStops) applyArmholeStop(stop, this.positions, this.inverseMass);
    if (this.armholeTethers)
      applyArmholeTethers(this.armholeTethers, this.positions, this.inverseMass);
  }
  private cuffStopIds: Uint32Array[] = [];

  private cuffContact() {
    const p = this.positions;
    for (const guide of this.cuffGuides) {
      let x = 0,
        y = 0,
        z = 0;
      for (const id of guide.ids) {
        x += p[id * 3] / guide.ids.length;
        y += p[id * 3 + 1] / guide.ids.length;
        z += p[id * 3 + 2] / guide.ids.length;
      }
      let best = Infinity,
        segment = 0,
        fraction = 0;
      const path = guide.path,
        distances = guide.distances;
      for (let j = 0; j < distances.length - 1; j++) {
        const k = j * 3,
          dx = path[k + 3] - path[k],
          dy = path[k + 4] - path[k + 1],
          dz = path[k + 5] - path[k + 2];
        const f = Math.max(
          0,
          Math.min(
            1,
            ((x - path[k]) * dx + (y - path[k + 1]) * dy + (z - path[k + 2]) * dz) /
              (dx * dx + dy * dy + dz * dz),
          ),
        );
        const qx = path[k] + f * dx,
          qy = path[k + 1] + f * dy,
          qz = path[k + 2] + f * dz;
        const squared = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
        if (squared < best) {
          best = squared;
          segment = j;
          fraction = f;
        }
      }
      let distance = distances[segment] + fraction * (distances[segment + 1] - distances[segment]);
      if (guide.stop == null && segment === distances.length - 2 && fraction === 1) continue;
      if (guide.stop != null) distance = Math.min(distance, guide.stop);
      while (segment > 0 && distance < distances[segment]) segment--;
      fraction = Math.max(
        0,
        Math.min(
          1,
          (distance - distances[segment]) / (distances[segment + 1] - distances[segment]),
        ),
      );
      const k = segment * 3,
        dx = path[k + 3] - path[k],
        dy = path[k + 4] - path[k + 1],
        dz = path[k + 5] - path[k + 2];
      const length = norm3(dx, dy, dz),
        nx = dx / length,
        ny = dy / length,
        nz = dz / length;
      const qx = path[k] + fraction * dx,
        qy = path[k + 1] + fraction * dy,
        qz = path[k + 2] + fraction * dz;
      const axial = (x - qx) * nx + (y - qy) * ny + (z - qz) * nz;
      let rx = x - qx - axial * nx,
        ry = y - qy - axial * ny,
        rz = z - qz - axial * nz;
      const radial = norm3(rx, ry, rz),
        allowed = guide.radii[segment] * (1 - fraction) + guide.radii[segment + 1] * fraction;
      if (radial > allowed) {
        const f = allowed / radial;
        rx *= f;
        ry *= f;
        rz *= f;
      }
      const cx = qx + rx - x,
        cy = qy + ry - y,
        cz = qz + rz - z;
      for (const id of guide.ids)
        if (this.inverseMass[id]) {
          p[id * 3] += cx;
          p[id * 3 + 1] += cy;
          p[id * 3 + 2] += cz;
        }
    }
  }
  private excluded(i: number, j: number) {
    let lo = this.excludedOffsets[i],
      hi = this.excludedOffsets[i + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1,
        value = this.excludedIds[mid];
      if (value === j) return true;
      if (value < j) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
  grab(particleIds: number[], targetPositions: number[]) {
    if (targetPositions.length !== particleIds.length * 3)
      throw new Error('Grab target count mismatch');
    for (let i = 0; i < particleIds.length; i++) {
      const id = particleIds[i];
      if (!Number.isInteger(id) || id < 0 || id >= this.inverseMass.length)
        throw new Error('Invalid particle');
      const target = targetPositions.slice(i * 3, i * 3 + 3);
      if (!target.every(Number.isFinite)) throw new Error('Invalid grab target');
      this.grabbed.set(id, target);
      // Legacy path: kinematic pin. Small-steps path: the particle keeps its mass and is
      // projected onto its target before the cloth constraints, so stretch limits and
      // tethers win and an infeasible pull makes the patch lag ("slip") instead of tearing.
      if (!this.smallSteps) this.inverseMass[id] = 0;
    }
    this.grabIds = Int32Array.from(this.grabbed.keys());
    this.grabTargets = Float64Array.from(Array.from(this.grabbed.values()).flat());
  }
  move(particleIds: number[], targetPositions: number[]) {
    this.grab(particleIds, targetPositions);
  }
  release() {
    for (const id of this.grabbed.keys()) this.inverseMass[id] = this.baseInverseMass[id];
    this.grabbed.clear();
    this.grabIds = new Int32Array(0);
    this.grabTargets = new Float64Array(0);
  }
  /**
   * Local high-rate region (M4 hand pull). Particles within `radius` (Euclidean, metres, from the
   * nearest centre, current positions) run; everything else becomes kinematic (inverse mass 0)
   * until clearRegion(). Particles in the outer `blend` band are attached to their current
   * position with a pull ramping linearly from 0 at radius - blend to 1 at radius, so the moving
   * patch fades into the static remainder without a seam. Particles of `frozenPanels` stay
   * kinematic even inside the radius. Small-steps path only.
   */
  setRegion(
    centres: ArrayLike<number>,
    radius: number,
    blend: number,
    frozenPanels: readonly number[] = [],
  ) {
    if (!this.smallSteps) throw new Error('Local region needs the small-steps solver');
    if (!(radius > 0) || !(blend > 0) || blend > radius) throw new Error('Invalid region size');
    if (!centres.length || centres.length % 3 || !Array.from(centres).every(Number.isFinite))
      throw new Error('Invalid region centres');
    const p = this.positions,
      n = this.inverseMass.length,
      ids: number[] = [],
      pull: number[] = [];
    this.inverseMass.set(this.baseInverseMass);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let c = 0; c < centres.length; c += 3)
        best = Math.min(
          best,
          norm3(
            p[i * 3] - centres[c],
            p[i * 3 + 1] - centres[c + 1],
            p[i * 3 + 2] - centres[c + 2],
          ),
        );
      const free = Math.min(1, (radius - best) / blend);
      if (free > 0 && this.baseInverseMass[i] > 0 && !frozenPanels.includes(this.panels[i])) {
        ids.push(i);
        pull.push(1 - free);
      } else {
        this.inverseMass[i] = 0;
        this.velocity[i * 3] = this.velocity[i * 3 + 1] = this.velocity[i * 3 + 2] = 0;
      }
    }
    const m = this.inverseMass,
      edges: number[] = [],
      hinges: number[] = [],
      tethers: number[] = [],
      pairs: number[] = [];
    for (let e = 0; e < this.restLengths.length; e++)
      if (m[this.edges[e * 2]] || m[this.edges[e * 2 + 1]]) edges.push(e);
    for (let e = 0; e < this.hingeLengths.length; e++)
      if (m[this.hinges[e * 2]] || m[this.hinges[e * 2 + 1]]) hinges.push(e);
    for (let e = 0; e < this.tetherLengths.length; e++)
      if (m[this.tethers[e * 2 + 1]]) tethers.push(e);
    for (let k = 0; k < this.layerPairA.length; k++) {
      const b = this.layerPairB[k];
      if (
        m[this.layerPairA[k]] ||
        (b >= 0 && m[b]) ||
        m[this.layerPairTriangle[k * 3]] ||
        m[this.layerPairTriangle[k * 3 + 1]] ||
        m[this.layerPairTriangle[k * 3 + 2]]
      )
        pairs.push(k);
    }
    this.region = {
      particles: Int32Array.from(ids),
      pull: Float64Array.from(pull),
      anchor: Float64Array.from(ids.flatMap((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]])),
      edges: Int32Array.from(edges),
      hinges: Int32Array.from(hinges),
      tethers: Int32Array.from(tethers),
      pairs: Int32Array.from(pairs),
    };
    if ((this.asset.config.strainLimitPasses ?? 0) > 0) this.collectHotEdges(this.region.edges);
    return this.region;
  }
  /** Ends the local region: every particle is dynamic again (full-mesh steps). */
  clearRegion() {
    if (!this.region) return;
    this.region = undefined;
    this.strainFloor = undefined;
    this.clampEdges = undefined;
    this.inverseMass.set(this.baseInverseMass);
    if ((this.asset.config.strainLimitPasses ?? 0) > 0) this.collectHotEdges();
  }
  get activeRegion(): Readonly<ClothRegion> | undefined {
    return this.region;
  }
  /** Kinetic energy (J) of the region particles only (the whole mesh without a region). */
  regionEnergy() {
    const ids = this.region?.particles,
      v = this.velocity,
      count = ids ? ids.length : this.inverseMass.length;
    let sum = 0;
    for (let slot = 0; slot < count; slot++) {
      const k = (ids ? ids[slot] : slot) * 3;
      sum += v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2];
    }
    return sum * this.asset.config.particleMass * 0.5;
  }
  /** Edge strain over the region's edges (all edges without a region). */
  regionStrain(): RegionStrain {
    const list = this.region?.edges,
      p = this.positions,
      count = list ? list.length : this.restLengths.length,
      out: RegionStrain = { maxRatio: 0, maxExcess: -Infinity, maxShellRatio: 0 };
    for (let slot = 0; slot < count; slot++) {
      const e = list ? list[slot] : slot,
        rest = this.restLengths[e];
      if (!(rest > 1e-8)) continue;
      const a = this.edges[e * 2] * 3,
        b = this.edges[e * 2 + 1] * 3,
        ratio = norm3(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / rest;
      out.maxRatio = Math.max(out.maxRatio, ratio);
      out.maxExcess = Math.max(out.maxExcess, ratio - this.edgeLimit[e] / rest);
      if (!(this.elastic[this.edges[e * 2]] > 0.5 && this.elastic[this.edges[e * 2 + 1]] > 0.5))
        out.maxShellRatio = Math.max(out.maxShellRatio, ratio);
    }
    return out;
  }
  /**
   * Hard strain clamp for the hand pull (M4): up to `passes` Gauss-Seidel passes over the region
   * edges project every edge longer than rest x (its limit + margin) back to that length. The
   * grabbed patch keeps its mass, so it is pulled back towards the cloth (the grab slips)
   * instead of the cloth stretching further. Returns the passes that changed something.
   */
  clampStrain(margin: number, passes: number) {
    const list = this.clampEdges ?? this.region?.edges,
      p = this.positions,
      m = this.inverseMass,
      count = list ? list.length : this.restLengths.length;
    for (let pass = 0; pass < passes; pass++) {
      let changed = false;
      for (let slot = 0; slot < count; slot++) {
        const o = pass % 2 ? count - 1 - slot : slot,
          e = list ? list[o] : o,
          ai = this.edges[e * 2],
          bi = this.edges[e * 2 + 1],
          a = ai * 3,
          b = bi * 3,
          dx = p[a] - p[b],
          dy = p[a + 1] - p[b + 1],
          dz = p[a + 2] - p[b + 2],
          length = Math.sqrt(dx * dx + dy * dy + dz * dz),
          bound = Math.max(
            this.edgeLimit[e] + margin * this.restLengths[e],
            this.strainFloor ? this.strainFloor[e] : 0,
          );
        if (length <= bound) continue;
        const wa = m[ai],
          wb = m[bi];
        if (!(wa + wb)) continue;
        changed = true;
        const scale = (length - bound) / (length * (wa + wb));
        p[a] -= wa * scale * dx;
        p[a + 1] -= wa * scale * dy;
        p[a + 2] -= wa * scale * dz;
        p[b] += wb * scale * dx;
        p[b + 1] += wb * scale * dy;
        p[b + 2] += wb * scale * dz;
      }
      if (!changed) return pass;
    }
    return passes;
  }
  /**
   * Saves the moving state of the region (positions, previous, velocity of its particles, the
   * clock and the strain hot list) so a trial step can be undone (M4 strain clamp).
   */
  saveRegionState() {
    const region = this.region;
    if (!region) throw new Error('No local region');
    const ids = region.particles,
      data = new Float64Array(ids.length * 9);
    for (let slot = 0; slot < ids.length; slot++) {
      const k = ids[slot] * 3,
        o = slot * 9;
      for (let a = 0; a < 3; a++) {
        data[o + a] = this.positions[k + a];
        data[o + 3 + a] = this.previous[k + a];
        data[o + 6 + a] = this.velocity[k + a];
      }
    }
    return {
      region,
      data,
      hot: this.hotEdges.slice(),
      elapsed: this.elapsed,
      frameIndex: this.frameIndex,
      energy: this.energy,
    };
  }
  restoreRegionState(state: ReturnType<ClothSolver['saveRegionState']>) {
    if (state.region !== this.region) throw new Error('Region changed since the state was saved');
    const ids = state.region.particles,
      data = state.data;
    for (let slot = 0; slot < ids.length; slot++) {
      const k = ids[slot] * 3,
        o = slot * 9;
      for (let a = 0; a < 3; a++) {
        this.positions[k + a] = data[o + a];
        this.previous[k + a] = data[o + 3 + a];
        this.velocity[k + a] = data[o + 6 + a];
      }
    }
    this.hotEdges = state.hot.slice();
    this.elapsed = state.elapsed;
    this.frameIndex = state.frameIndex;
    this.energy = state.energy;
  }
  /**
   * Hand-pull clamp set-up (call after setRegion; cleared by clearRegion). The clamp covers the
   * region edges whose midpoint lies within `radius` of `centre` (the patch border, where the
   * hand's strain concentrates), or every region edge without a centre. Each covered edge gets a
   * floor = its length now: relax residue above limit + margin may stay but never grows.
   */
  freezeStrainFloor(centre?: ArrayLike<number>, radius = Infinity) {
    const list = this.region?.edges,
      p = this.positions,
      floor = (this.strainFloor ??= new Float64Array(this.restLengths.length)),
      covered: number[] = [];
    floor.fill(0);
    const count = list ? list.length : this.restLengths.length;
    for (let slot = 0; slot < count; slot++) {
      const e = list ? list[slot] : slot,
        a = this.edges[e * 2] * 3,
        b = this.edges[e * 2 + 1] * 3;
      if (
        centre &&
        norm3(
          (p[a] + p[b]) / 2 - centre[0],
          (p[a + 1] + p[b + 1]) / 2 - centre[1],
          (p[a + 2] + p[b + 2]) / 2 - centre[2],
        ) > radius
      )
        continue;
      covered.push(e);
      floor[e] = norm3(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    }
    this.clampEdges = Int32Array.from(covered);
  }
  /**
   * Largest (length − allowed) / rest over the region edges, allowed = max(limit + margin,
   * strain floor). ≤ 0 means the clamp holds for every edge.
   */
  overClamp(margin: number) {
    const list = this.clampEdges ?? this.region?.edges,
      p = this.positions,
      count = list ? list.length : this.restLengths.length;
    let worst = -Infinity;
    for (let slot = 0; slot < count; slot++) {
      const e = list ? list[slot] : slot,
        rest = this.restLengths[e];
      if (!(rest > 1e-8)) continue;
      const a = this.edges[e * 2] * 3,
        b = this.edges[e * 2 + 1] * 3,
        length = norm3(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]),
        allowed = Math.max(
          this.edgeLimit[e] + margin * rest,
          this.strainFloor ? this.strainFloor[e] : 0,
        );
      worst = Math.max(worst, (length - allowed) / rest);
    }
    return worst;
  }
  /** Weighted mean position (m) of particles, e.g. the grabbed patch. */
  centroid(ids: ArrayLike<number>, weights?: ArrayLike<number>) {
    let x = 0,
      y = 0,
      z = 0,
      total = 0;
    for (let j = 0; j < ids.length; j++) {
      const w = weights ? weights[j] : 1,
        k = ids[j] * 3;
      x += this.positions[k] * w;
      y += this.positions[k + 1] * w;
      z += this.positions[k + 2] * w;
      total += w;
    }
    return total > 0 ? [x / total, y / total, z / total] : [NaN, NaN, NaN];
  }
  /** Largest distance (m) between a grabbed particle and its target: > 0 means the fabric resists. */
  grabLag() {
    let lag = 0;
    const p = this.positions;
    for (let g = 0; g < this.grabIds.length; g++) {
      const k = this.grabIds[g] * 3,
        t = g * 3;
      lag = Math.max(
        lag,
        norm3(
          p[k] - this.grabTargets[t],
          p[k + 1] - this.grabTargets[t + 1],
          p[k + 2] - this.grabTargets[t + 2],
        ),
      );
    }
    return lag;
  }

  private hingeBend(h: number, list?: Int32Array) {
    // Per-hinge lookups hoisted into locals (runs every substep over ~25k hinges).
    const p = this.positions,
      hinges = this.hinges,
      rest = this.hingeLengths,
      lambdas = this.hingeLambda,
      inverseMass = this.inverseMass,
      alpha = (this.asset.config.hingeCompliance ?? 0) / (h * h),
      count = list ? list.length : rest.length;
    for (let slot = 0; slot < count; slot++) {
      const e = list ? list[slot] : slot,
        ai = hinges[e * 2],
        bi = hinges[e * 2 + 1],
        a = ai * 3,
        b = bi * 3;
      const dx = p[a] - p[b],
        dy = p[a + 1] - p[b + 1],
        dz = p[a + 2] - p[b + 2];
      const length = norm3(dx, dy, dz);
      if (length < 1e-12) continue;
      const wa = inverseMass[ai],
        wb = inverseMass[bi],
        den = wa + wb + alpha;
      if (!den) continue;
      const lambda = (-(length - rest[e]) - alpha * lambdas[e]) / den;
      lambdas[e] += lambda;
      const scale = lambda / length;
      p[a] += wa * scale * dx;
      p[a + 1] += wa * scale * dy;
      p[a + 2] += wa * scale * dz;
      p[b] -= wb * scale * dx;
      p[b + 1] -= wb * scale * dy;
      p[b + 2] -= wb * scale * dz;
    }
  }

  /**
   * Hard body contact for the small-steps path; records normal and push depth for friction.
   * A particle whose last exact query left slack (distance − thickness) is skipped while
   * √3 × its travel since that query is below the slack: trilinear interpolation of a distance
   * grid changes by at most 1 per unit length along each axis, i.e. |∇| ≤ √3, so it cannot
   * have reached the body. Moving colliders reset the cache (`setCollider`).
   */
  private contact(accumulate = false, list?: Int32Array) {
    const p = this.positions,
      c = this.asset.config,
      g = this.gradient,
      normals = this.contactNormals,
      depth = this.contactDepth,
      slack = this.contactSlack,
      anchor = this.contactAnchor,
      inverseMass = this.inverseMass,
      loft = this.loft,
      base = this.asset.layer_m + c.collisionMargin,
      neutral = this.asset.fabric_surface === 'neutral',
      collider = this.collider,
      layer = this.layerOffset,
      count = list ? list.length : inverseMass.length,
      planeRadius = c.contactPlaneRadius ?? 0,
      planeRadius2 = planeRadius * planeRadius,
      stamp = this.poseStamp,
      surface = this.collider.surfaceVelocity?.bind(this.collider),
      soft = (c.contactCompliance ?? 0) > 0,
      hardElastic = (c.contactHardElastic ?? 0) > 0,
      hardMin = c.contactHardMin ?? 0,
      h = c.dt / c.substeps,
      contactAlpha = (c.contactCompliance ?? 0) / (h * h);
    if (planeRadius > 0) this.allocatePlanes();
    const plane = this.planeData,
      planeStamp = this.planeStamp;
    for (let slot = 0; slot < count; slot++) {
      const i = list ? list[slot] : slot,
        k = i * 3;
      if (!accumulate) depth[i] = 0;
      if (!inverseMass[i]) continue;
      const x = p[k],
        y = p[k + 1],
        z = p[k + 2];
      if (slack[i] > 0) {
        const tx = x - anchor[k],
          ty = y - anchor[k + 1],
          tz = z - anchor[k + 2];
        if (3 * (tx * tx + ty * ty + tz * tz) < slack[i] * slack[i]) continue;
      }
      const thickness = (neutral ? 0 : loft[i]) + base + layer[i];
      let distance: number;
      // Tangent-plane reuse (contactPlaneRadius > 0): within `planeRadius` of this pose's exact
      // query the distance is d0 + ∇d0·Δ (error ≈ |Δ|²·curvature/2, < 0.5 mm for 5 mm on a 2.5 cm
      // radius). The moving-body collider is exact but costly; the body is fixed within a step.
      const o = i * 8;
      if (
        planeRadius > 0 &&
        planeStamp[i] === stamp &&
        (x - plane[o]) ** 2 + (y - plane[o + 1]) ** 2 + (z - plane[o + 2]) ** 2 < planeRadius2
      ) {
        g[0] = plane[o + 4];
        g[1] = plane[o + 5];
        g[2] = plane[o + 6];
        distance =
          plane[o + 3] +
          g[0] * (x - plane[o]) +
          g[1] * (y - plane[o + 1]) +
          g[2] * (z - plane[o + 2]);
      } else {
        distance = collider.distance(x, y, z, g, thickness + planeRadius);
        if (planeRadius > 0 && distance < thickness + planeRadius) {
          plane[o] = x;
          plane[o + 1] = y;
          plane[o + 2] = z;
          plane[o + 3] = distance;
          plane[o + 4] = g[0];
          plane[o + 5] = g[1];
          plane[o + 6] = g[2];
          planeStamp[i] = stamp;
          if (surface) {
            surface(x, y, z, this.surfaceVelocity);
            const v = this.planeVelocity;
            v[i * 3] = this.surfaceVelocity[0];
            v[i * 3 + 1] = this.surfaceVelocity[1];
            v[i * 3 + 2] = this.surfaceVelocity[2];
          }
        }
      }
      if (distance >= thickness) {
        slack[i] = distance - thickness;
        anchor[k] = x;
        anchor[k + 1] = y;
        anchor[k + 2] = z;
        continue;
      }
      slack[i] = 0;
      const length = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
      if (length < 1e-9) continue;
      // Compliant contact (contactCompliance > 0, m/N per particle, uncalibrated): above a hard
      // floor at contactHardMin (m from the skin) the push is an XPBD constraint, so where the
      // garment is too small for the posed body (raised arms in a tight jacket) the fabric limit
      // wins and the lining sinks a few mm into soft tissue/fill instead of stretching 2–10×.
      const push =
        soft && !(hardElastic && this.elastic[i] > 0.5)
          ? Math.max(
              ((thickness - distance) * inverseMass[i]) / (inverseMass[i] + contactAlpha),
              hardMin - distance,
            )
          : thickness - distance;
      if (push <= 0) continue;
      const nx = g[0] / length,
        ny = g[1] / length,
        nz = g[2] / length;
      p[k] = x + nx * push;
      p[k + 1] = y + ny * push;
      p[k + 2] = z + nz * push;
      normals[k] = nx;
      normals[k + 1] = ny;
      normals[k + 2] = nz;
      depth[i] += push;
    }
  }

  /**
   * Cloth-on-cloth layer contact (sleeve over torso, hood over back/yoke/collar). Particle
   * spheres cannot stop a 1.2 cm-edge sheet from passing through another, and near the
   * armhole seam the wrapped sleeve cap and torso are only millimetres apart. Every vertex and
   * every edge midpoint of one layer is paired with its closest few triangles of the other
   * layer within `layerPairRadius` (triangles incident to the source excluded), remembering
   * which side it is on; the solver then keeps it on that side by at least
   * min(layerGap, initial distance) (point–triangle constraint, Müller et al. 2007 §4.4, with
   * side memory). Call again (e.g. from P2 every few frames) once the cloth has moved far
   * from the state the pairs were built in; that state must be crossing-free.
   */
  rebuildLayerPairs() {
    if (this.kernels) return this.rebuildLayerPairsKernels(this.kernels);
    // Same pairs in the same order as the earlier Map + sort version (bit-identical; the hand
    // pull builds them once, P2 every few frames). The cell table and the per-source scratch are
    // typed arrays reused across calls: the Map version cost ~110 ms per call on the 8.8k shell.
    const c = this.asset.config,
      radius = c.layerPairRadius ?? 0,
      gapLimit = c.layerGap ?? 0.002,
      perSource = Math.max(1, Math.round(c.layerPairsPerVertex ?? 1)),
      p = this.positions,
      tri = this.asset.triangles,
      triangleCount = tri.length / 3,
      panels = this.panels,
      edges = this.edges,
      inverseMass = this.inverseMass;
    // sleeves(1) <-> fronts(4) and back/yoke/collar(2); hood(3) <-> back/yoke/collar(2)
    const groupOf = (panel: number) =>
      panel === 4 || panel === 5
        ? 1
        : panel === 7
          ? 3
          : panel === 2 || panel === 3 || panel === 6
            ? 2
            : panel <= 1
              ? 4
              : 0;
    const facing = (a: number, b: number) =>
      (a === 1 && (b === 2 || b === 4)) ||
      (b === 1 && (a === 2 || a === 4)) ||
      (a === 3 && b === 2) ||
      (a === 2 && b === 3);
    // Integer cell hash (a collision only adds candidates; each is tested exactly below).
    const hashCell = (i: number, j: number, k: number) =>
      ((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) | 0;
    let s = this.pairScratch;
    if (!s || s.triGroup.length !== triangleCount || s.bestTriangle.length !== perSource) {
      const triGroup = new Int32Array(triangleCount);
      for (let t = 0; t < triangleCount; t++) {
        const g0 = groupOf(panels[tri[t * 3]]);
        triGroup[t] =
          g0 && g0 === groupOf(panels[tri[t * 3 + 1]]) && g0 === groupOf(panels[tri[t * 3 + 2]])
            ? g0
            : 0;
      }
      let size = 1;
      while (size < triangleCount * 6) size *= 2;
      s = this.pairScratch = {
        triGroup,
        tableKeys: new Int32Array(size),
        tableUsed: new Int32Array(size),
        tableBucket: new Int32Array(size),
        bucketStart: new Int32Array(triangleCount * 3 + 1),
        cursor: new Int32Array(triangleCount * 3 + 1),
        bucketEntries: new Int32Array(triangleCount * 3),
        entryKeys: new Int32Array(triangleCount * 3),
        entryTriangles: new Int32Array(triangleCount * 3),
        stamp: new Int32Array(triangleCount),
        query: 0,
        epoch: 0,
        bestDistance: new Float64Array(perSource),
        bestTriangle: new Int32Array(perSource),
        bestSide: new Float64Array(perSource),
      };
    }
    const scratch = s,
      { triGroup, tableKeys, tableUsed, tableBucket, bucketStart, cursor, bucketEntries } = s,
      { entryKeys, entryTriangles, stamp, bestDistance, bestTriangle, bestSide } = s,
      mask = tableKeys.length - 1,
      epoch = ++s.epoch;
    // Register large triangles in every cell their vertices touch (once per cell).
    let entries = 0;
    for (let t = 0; t < triangleCount; t++) {
      if (!triGroup[t]) continue;
      const first = entries;
      for (let k = 0; k < 3; k++) {
        const id = tri[t * 3 + k] * 3,
          key = hashCell(
            Math.floor(p[id] / radius),
            Math.floor(p[id + 1] / radius),
            Math.floor(p[id + 2] / radius),
          );
        let seen = false;
        for (let q = first; q < entries; q++) if (entryKeys[q] === key) seen = true;
        if (seen) continue;
        entryKeys[entries] = key;
        entryTriangles[entries++] = t;
      }
    }
    // Open-addressed key -> bucket table (a slot is live when tableUsed = this epoch), then CSR.
    const slotOf = (key: number) => {
      let h = Math.imul(key, 0x9e3779b1) & mask;
      while (tableUsed[h] === epoch && tableKeys[h] !== key) h = (h + 1) & mask;
      return h;
    };
    let buckets = 0;
    for (let q = 0; q < entries; q++) {
      const h = slotOf(entryKeys[q]);
      if (tableUsed[h] !== epoch) {
        tableUsed[h] = epoch;
        tableKeys[h] = entryKeys[q];
        tableBucket[h] = buckets;
        bucketStart[++buckets] = 0;
      }
      bucketStart[tableBucket[h] + 1]++;
    }
    bucketStart[0] = 0;
    for (let b = 0; b < buckets; b++) {
      bucketStart[b + 1] += bucketStart[b];
      cursor[b] = bucketStart[b];
    }
    for (let q = 0; q < entries; q++)
      bucketEntries[cursor[tableBucket[slotOf(entryKeys[q])]]++] = entryTriangles[q];
    const sourceA: number[] = [],
      sourceB: number[] = [],
      triangles: number[] = [],
      sides: number[] = [],
      gaps: number[] = [],
      out = this.layerOut;
    const consider = (a: number, b: number) => {
      const group = groupOf(panels[a]);
      if (!group || (b >= 0 && groupOf(panels[b]) !== group)) return;
      if (!inverseMass[a] && (b < 0 || !inverseMass[b])) return;
      const x = b < 0 ? p[a * 3] : (p[a * 3] + p[b * 3]) / 2,
        y = b < 0 ? p[a * 3 + 1] : (p[a * 3 + 1] + p[b * 3 + 1]) / 2,
        z = b < 0 ? p[a * 3 + 2] : (p[a * 3 + 2] + p[b * 3 + 2]) / 2;
      const cx = Math.floor(x / radius),
        cy = Math.floor(y / radius),
        cz = Math.floor(z / radius),
        query = ++scratch.query;
      // Keep the perSource closest candidates in the total order (distance, triangle id), the
      // order the earlier version sorted all candidates by before keeping the first perSource.
      let kept = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const h = slotOf(hashCell(cx + dx, cy + dy, cz + dz));
            if (tableUsed[h] !== epoch) continue;
            const bucket = tableBucket[h];
            for (let e = bucketStart[bucket], end = bucketStart[bucket + 1]; e < end; e++) {
              const t = bucketEntries[e];
              if (stamp[t] === query) continue;
              stamp[t] = query;
              if (!facing(group, triGroup[t])) continue;
              const i = tri[t * 3],
                j = tri[t * 3 + 1],
                k = tri[t * 3 + 2];
              if (i === a || j === a || k === a || i === b || j === b || k === b) continue;
              if (!this.pointTriangle(x, y, z, i, j, k, out)) continue;
              const distance = Math.abs(out[0]);
              if (!(distance < radius)) continue;
              let slot = kept;
              while (
                slot > 0 &&
                (bestDistance[slot - 1] > distance ||
                  (bestDistance[slot - 1] === distance && bestTriangle[slot - 1] > t))
              )
                slot--;
              if (slot >= perSource) continue;
              for (let m = Math.min(kept, perSource - 1); m > slot; m--) {
                bestDistance[m] = bestDistance[m - 1];
                bestTriangle[m] = bestTriangle[m - 1];
                bestSide[m] = bestSide[m - 1];
              }
              bestDistance[slot] = distance;
              bestTriangle[slot] = t;
              bestSide[slot] = out[0] >= 0 ? 1 : -1;
              if (kept < perSource) kept++;
            }
          }
      for (let m = 0; m < kept; m++) {
        const t = bestTriangle[m];
        sourceA.push(a);
        sourceB.push(b);
        triangles.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]);
        sides.push(bestSide[m]);
        gaps.push(Math.min(gapLimit, bestDistance[m]));
      }
    };
    for (let v = 0; v < inverseMass.length; v++) consider(v, -1);
    for (let e = 0; e < this.restLengths.length; e++) consider(edges[e * 2], edges[e * 2 + 1]);
    this.layerPairA = Int32Array.from(sourceA);
    this.layerPairB = Int32Array.from(sourceB);
    this.layerPairTriangle = Int32Array.from(triangles);
    this.layerPairSide = Float64Array.from(sides);
    this.layerPairGap = Float64Array.from(gaps);
    return sourceA.length;
  }
  /** rebuildLayerPairs scratch, reused across calls (cell table, CSR buckets, query stamps). */
  private pairScratch?: {
    triGroup: Int32Array;
    tableKeys: Int32Array;
    tableUsed: Int32Array;
    tableBucket: Int32Array;
    bucketStart: Int32Array;
    cursor: Int32Array;
    bucketEntries: Int32Array;
    entryKeys: Int32Array;
    entryTriangles: Int32Array;
    stamp: Int32Array;
    query: number;
    epoch: number;
    bestDistance: Float64Array;
    bestTriangle: Int32Array;
    bestSide: Float64Array;
  };
  /**
   * Signed distance of point (x, y, z) to the plane of triangle (a, b, c) along its unit
   * normal, written to out[0], normal to out[1..3]; barycentrics of the projection stored in
   * this.bary. Returns false when the projection falls outside the (slightly grown) triangle.
   */
  private pointTriangle(
    x: number,
    y: number,
    z: number,
    a: number,
    b: number,
    c: number,
    out: Float64Array,
  ) {
    const p = this.positions,
      ax = p[a * 3],
      ay = p[a * 3 + 1],
      az = p[a * 3 + 2];
    const e1x = p[b * 3] - ax,
      e1y = p[b * 3 + 1] - ay,
      e1z = p[b * 3 + 2] - az,
      e2x = p[c * 3] - ax,
      e2y = p[c * 3 + 1] - ay,
      e2z = p[c * 3 + 2] - az;
    let nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (area < 1e-12) return false;
    nx /= area;
    ny /= area;
    nz /= area;
    const qx = x - ax,
      qy = y - ay,
      qz = z - az;
    const distance = qx * nx + qy * ny + qz * nz;
    const d00 = e1x * e1x + e1y * e1y + e1z * e1z,
      d01 = e1x * e2x + e1y * e2y + e1z * e2z,
      d11 = e2x * e2x + e2y * e2y + e2z * e2z,
      d20 = qx * e1x + qy * e1y + qz * e1z,
      d21 = qx * e2x + qy * e2y + qz * e2z,
      den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-18) return false;
    const u = (d11 * d20 - d01 * d21) / den,
      w = (d00 * d21 - d01 * d20) / den,
      t = 1 - u - w,
      grow = this.asset.config.layerGrow ?? 0.05;
    if (u < -grow || w < -grow || t < -grow) return false;
    this.bary[0] = t;
    this.bary[1] = u;
    this.bary[2] = w;
    out[0] = distance;
    out[1] = nx;
    out[2] = ny;
    out[3] = nz;
    return true;
  }
  private layerContact(list?: Int32Array) {
    const p = this.positions,
      out = this.layerOut,
      bary = this.bary,
      inverseMass = this.inverseMass,
      tri = this.layerPairTriangle,
      trust = this.asset.config.layerTrust ?? 0.003,
      count = list ? list.length : this.layerPairA.length;
    for (let slot = 0; slot < count; slot++) {
      const k = list ? list[slot] : slot,
        a = this.layerPairA[k],
        b = this.layerPairB[k],
        half = b >= 0 ? 0.5 : 1,
        x = b >= 0 ? (p[a * 3] + p[b * 3]) * 0.5 : p[a * 3],
        y = b >= 0 ? (p[a * 3 + 1] + p[b * 3 + 1]) * 0.5 : p[a * 3 + 1],
        z = b >= 0 ? (p[a * 3 + 2] + p[b * 3 + 2]) * 0.5 : p[a * 3 + 2],
        i = tri[k * 3],
        j = tri[k * 3 + 1],
        l = tri[k * 3 + 2];
      if (!this.pointTriangle(x, y, z, i, j, l, out)) continue;
      const side = this.layerPairSide[k],
        error = side * out[0] - this.layerPairGap[k];
      // Far on the wrong side = the source went around the triangle's border, not through it
      // (a stale pair); correcting it would snap the cloth by centimetres.
      if (error >= 0 || error < -trust) continue;
      const wa = inverseMass[a],
        wb = b >= 0 ? inverseMass[b] : 0,
        source = half * half * (wa + wb),
        den =
          source +
          inverseMass[i] * bary[0] * bary[0] +
          inverseMass[j] * bary[1] * bary[1] +
          inverseMass[l] * bary[2] * bary[2];
      if (!den) continue;
      const lambda = -error / den,
        nx = out[1] * side * lambda,
        ny = out[2] * side * lambda,
        nz = out[3] * side * lambda;
      p[a * 3] += wa * half * nx;
      p[a * 3 + 1] += wa * half * ny;
      p[a * 3 + 2] += wa * half * nz;
      if (b >= 0) {
        p[b * 3] += wb * half * nx;
        p[b * 3 + 1] += wb * half * ny;
        p[b * 3 + 2] += wb * half * nz;
      }
      for (let m = 0; m < 3; m++) {
        const id = tri[k * 3 + m],
          f = inverseMass[id] * bary[m];
        p[id * 3] -= f * nx;
        p[id * 3 + 1] -= f * ny;
        p[id * 3 + 2] -= f * nz;
      }
    }
  }
  private layerOut = new Float64Array(5);
  private bary = new Float64Array(3);

  /**
   * Strain limiting on the hot list only: hard-projects edges longer than rest × stretchMax.
   * Runs after contact, so the final positions of each substep respect the fabric limit
   * (one Gauss–Seidel sweep leaves a residual that matters on 2–4 mm edges).
   */
  private limitHotEdges() {
    const p = this.positions,
      edges = this.edges,
      inverseMass = this.inverseMass,
      hot = this.hotEdges;
    for (let slot = 0; slot < hot.length; slot++) {
      const e = hot[slot],
        ai = edges[e * 2],
        bi = edges[e * 2 + 1],
        a = ai * 3,
        b = bi * 3;
      const dx = p[a] - p[b],
        dy = p[a + 1] - p[b + 1],
        dz = p[a + 2] - p[b + 2],
        length = Math.sqrt(dx * dx + dy * dy + dz * dz),
        bound = this.edgeLimit[e];
      if (length <= bound) continue;
      const wa = inverseMass[ai],
        wb = inverseMass[bi];
      if (!(wa + wb)) continue;
      const scale = (length - bound) / (length * (wa + wb));
      p[a] -= wa * scale * dx;
      p[a + 1] -= wa * scale * dy;
      p[a + 2] -= wa * scale * dz;
      p[b] += wb * scale * dx;
      p[b + 1] += wb * scale * dy;
      p[b + 2] += wb * scale * dz;
    }
  }
  /**
   * Final strain limit, then credits its pull into the body to the contact depth: the fabric's
   * limit tension presses it onto the skin (capstan), so friction grips with that normal load.
   * Without this the limiter's tension was invisible to friction and tight sleeves slid freely.
   */
  private limitAfterContact(passes: number, ids?: Int32Array, edgeList?: Int32Array) {
    const p = this.positions,
      depth = this.contactDepth,
      normals = this.contactNormals,
      count = ids ? ids.length : this.inverseMass.length,
      before = (this.limitBefore ??= new Float64Array(p.length));
    for (let slot = 0; slot < count; slot++) {
      const k = (ids ? ids[slot] : slot) * 3;
      before[k] = p[k];
      before[k + 1] = p[k + 1];
      before[k + 2] = p[k + 2];
    }
    this.limitAllEdges(passes, edgeList);
    for (let slot = 0; slot < count; slot++) {
      const i = ids ? ids[slot] : slot,
        k = i * 3;
      if (!(depth[i] > 0)) continue;
      const inward = -(
        (p[k] - before[k]) * normals[k] +
        (p[k + 1] - before[k + 1]) * normals[k + 1] +
        (p[k + 2] - before[k + 2]) * normals[k + 2]
      );
      if (inward > 0) depth[i] += inward;
    }
  }
  private limitBefore?: Float64Array;
  /**
   * Final strain limit (finalStrainPasses > 0): up to `passes` Gauss–Seidel passes over every edge
   * (or the region's), hard-projecting edges longer than their limit; runs after body contact so
   * the fabric limit wins. Where a moving body demands more cloth than the garment has (arms
   * raised in a tight jacket), the cloth then stays at its limit and the body shows through by a
   * few mm, instead of the contact projection stretching the fabric 2–10× (measured, see STATUS).
   * Stops early once a pass changes nothing.
   */
  private limitAllEdges(passes: number, list?: Int32Array) {
    // Every 8th pass sweeps all edges and collects the ones it had to project; the passes in
    // between revisit only those (cheap), alternating direction. Stops once a full sweep is clean.
    // Hot loop of motion bakes (≈ 2 full sweeps per substep): array lookups hoisted into locals.
    const total = list ? list.length : this.restLengths.length,
      hot = (this.edgeQueue ??= new Int32Array(this.restLengths.length)),
      p = this.positions,
      edges = this.edges,
      limits = this.edgeLimit,
      inverseMass = this.inverseMass;
    /** Hard-projects edge e to its length limit; true when it moved something. */
    const project = (e: number) => {
      const ai = edges[e * 2],
        bi = edges[e * 2 + 1],
        a = ai * 3,
        b = bi * 3,
        dx = p[a] - p[b],
        dy = p[a + 1] - p[b + 1],
        dz = p[a + 2] - p[b + 2],
        squared = dx * dx + dy * dy + dz * dz,
        bound = limits[e];
      if (squared <= bound * bound) return false;
      const wa = inverseMass[ai],
        wb = inverseMass[bi];
      if (!(wa + wb)) return false;
      const length = Math.sqrt(squared),
        scale = (length - bound) / (length * (wa + wb));
      p[a] -= wa * scale * dx;
      p[a + 1] -= wa * scale * dy;
      p[a + 2] -= wa * scale * dz;
      p[b] += wb * scale * dx;
      p[b + 1] += wb * scale * dy;
      p[b + 2] += wb * scale * dz;
      return true;
    };
    let count = 0;
    for (let pass = 0; pass < passes; pass++) {
      if (pass % 8 === 0) {
        count = 0;
        if (list) {
          for (let slot = 0; slot < total; slot++)
            if (project(list[slot])) hot[count++] = list[slot];
        } else for (let e = 0; e < total; e++) if (project(e)) hot[count++] = e;
        if (!count) return pass;
      } else if (pass % 2) for (let slot = count - 1; slot >= 0; slot--) project(hot[slot]);
      else for (let slot = 0; slot < count; slot++) project(hot[slot]);
    }
    return passes;
  }
  private edgeQueue?: Int32Array;
  private collectHotEdges(list?: Int32Array) {
    const p = this.positions,
      edges = this.edges,
      hot: number[] = [],
      count = list ? list.length : this.restLengths.length;
    for (let slot = 0; slot < count; slot++) {
      const e = list ? list[slot] : slot,
        a = edges[e * 2] * 3,
        b = edges[e * 2 + 1] * 3,
        dx = p[a] - p[b],
        dy = p[a + 1] - p[b + 1],
        dz = p[a + 2] - p[b + 2],
        bound = this.edgeLimit[e];
      if (dx * dx + dy * dy + dz * dz > bound * bound) hot.push(e);
    }
    this.hotEdges = Int32Array.from(hot);
  }

  /**
   * One display frame of the small-steps solver: `substeps` × (predict, one Gauss–Seidel sweep
   * of every constraint, body contact, velocity update with Coulomb friction). Lagrange
   * multipliers reset every substep (one iteration per substep, Macklin et al. 2019).
   */
  private stepSmall() {
    if (this.kernels && this.kernelStepPossible()) return this.stepSmallKernels(this.kernels);
    // Local high-rate region (M4): only region particles/constraints run; the rest is
    // kinematic (inverse mass 0, see setRegion). Without a region every loop covers everything.
    const region = this.region,
      ids = region?.particles,
      edgeList = region?.edges,
      c = this.asset.config,
      n = c.substeps,
      h = c.dt / n,
      p = this.positions,
      v = this.velocity,
      prev = this.previous,
      count = ids ? ids.length : this.inverseMass.length,
      decay = Math.exp(-(c.dampingPerSecond ?? 0) * h),
      mu = c.friction,
      limit = c.velocityLimit,
      sv = this.surfaceVelocity,
      surface = this.collider.surfaceVelocity?.bind(this.collider),
      planeVelocity =
        (c.contactPlaneRadius ?? 0) > 0 && surface
          ? (this.allocatePlanes(), this.planeVelocity)
          : undefined;
    let energy = 0;
    for (let s = 0; s < n; s++) {
      if (ids)
        for (let slot = 0; slot < count; slot++) {
          const k = ids[slot] * 3;
          prev[k] = p[k];
          prev[k + 1] = p[k + 1];
          prev[k + 2] = p[k + 2];
        }
      else prev.set(p);
      for (let slot = 0; slot < count; slot++) {
        const i = ids ? ids[slot] : slot;
        if (!this.inverseMass[i]) continue;
        const k = i * 3;
        v[k + 1] += c.gravity * h;
        p[k] += v[k] * h;
        p[k + 1] += v[k + 1] * h;
        p[k + 2] += v[k + 2] * h;
      }
      // Grab = XPBD attachment to the hand target (grabCompliance m/N; 0 = hard). A compliant
      // hand lets the stretch limits and tethers win, so the patch slips instead of tearing.
      const grabAlpha = (c.grabCompliance ?? 0) / (h * h);
      for (let g = 0; g < this.grabIds.length; g++) {
        const id = this.grabIds[g],
          k = id * 3,
          t = g * 3,
          w = this.inverseMass[id],
          f = w + grabAlpha > 0 ? w / (w + grabAlpha) : 1;
        p[k] += (this.grabTargets[t] - p[k]) * f;
        p[k + 1] += (this.grabTargets[t + 1] - p[k + 1]) * f;
        p[k + 2] += (this.grabTargets[t + 2] - p[k + 2]) * f;
      }
      const order = c.contactOrder ?? 0;
      if (region) {
        // Boundary blend: band particles are attached to their state at region start with a
        // per-substep pull that ramps from 0 (inner radius) to 1 (outer radius = kinematic).
        const pull = region.pull,
          anchor = region.anchor;
        for (let slot = 0; slot < count; slot++) {
          const f = pull[slot];
          if (!f) continue;
          const k = ids![slot] * 3,
            q = slot * 3;
          p[k] += (anchor[q] - p[k]) * f;
          p[k + 1] += (anchor[q + 1] - p[k + 1]) * f;
          p[k + 2] += (anchor[q + 2] - p[k + 2]) * f;
        }
        for (let e = 0; e < edgeList!.length; e++) this.edgeLambda[edgeList![e]] = 0;
        for (let e = 0; e < region.hinges.length; e++) this.hingeLambda[region.hinges[e]] = 0;
        if (order > 0) this.contact(false, ids);
        for (let pass = 0; pass < c.iterations; pass++) this.stretch(h, pass % 2 === 1, edgeList);
        // hingePasses (default 1): extra Gauss-Seidel sweeps of the shape-memory hinges within
        // this substep (lambdas accumulate), for lofted jackets that hold their shape (ZB).
        for (let pass = 0; pass < (c.hingePasses ?? 1); pass++) this.hingeBend(h, region.hinges);
        this.limitTethers(h, region.tethers);
        // Rings, cuff stops and particle self-contact are global; they stay with the
        // kinematic remainder (documented gap). Layer pairs keep sleeve/torso apart locally.
        for (let pass = 0; pass < (c.strainLimitPasses ?? 0); pass++) this.limitHotEdges();
        if (region.pairs.length) this.layerContact(region.pairs);
        if (order !== 1) this.contact(order > 0, ids);
        if ((c.finalStrainPasses ?? 0) > 0)
          this.limitAfterContact(c.finalStrainPasses, ids, edgeList);
      } else {
        this.edgeLambda.fill(0);
        this.hingeLambda.fill(0);
        this.ringLambda.fill(0);
        if (order > 0) this.contact(false);
        // Extra passes run in reverse order. (Alternating the direction per substep, or
        // sub-cycling the hinges, was measured to inject energy: 2-cycles between substeps.)
        for (let pass = 0; pass < c.iterations; pass++) this.stretch(h, pass % 2 === 1);
        for (let pass = 0; pass < (c.hingePasses ?? 1); pass++) this.hingeBend(h);
        this.limitTethers(h);
        this.constrainRings(h);
        if (this.guideMode === 1) this.cuffContact();
        else if (this.guideMode === 2) this.cuffStops();
        if (this.armholeStops.length) this.applyArmholeStops();
        if (s === n - 1 && this.frameIndex % c.selfEvery === 0) this.selfCollide();
        for (let pass = 0; pass < (c.strainLimitPasses ?? 0); pass++) this.limitHotEdges();
        if (this.layerPairA.length) this.layerContact();
        if (order !== 1) this.contact(order > 0);
        if ((c.finalStrainPasses ?? 0) > 0) this.limitAfterContact(c.finalStrainPasses);
      }
      energy = 0;
      const inverseMass = this.inverseMass,
        contactDepth = this.contactDepth,
        contactNormals = this.contactNormals,
        planeStamp = this.planeStamp,
        poseStamp = this.poseStamp;
      for (let slot = 0; slot < count; slot++) {
        const i = ids ? ids[slot] : slot;
        if (!inverseMass[i]) continue;
        const k = i * 3;
        let vx = (p[k] - prev[k]) / h,
          vy = (p[k + 1] - prev[k + 1]) / h,
          vz = (p[k + 2] - prev[k + 2]) / h;
        const depth = contactDepth[i];
        if (depth > 0) {
          const nx = contactNormals[k],
            ny = contactNormals[k + 1],
            nz = contactNormals[k + 2];
          if (planeVelocity && planeStamp[i] === poseStamp) {
            sv[0] = planeVelocity[k];
            sv[1] = planeVelocity[k + 1];
            sv[2] = planeVelocity[k + 2];
          } else if (surface) surface(p[k], p[k + 1], p[k + 2], sv);
          // Relative to the skin. The normal part keeps only genuine separation: the
          // projection's own push (depth / h) must not launch the particle.
          let rx = vx - sv[0],
            ry = vy - sv[1],
            rz = vz - sv[2];
          const vn = rx * nx + ry * ny + rz * nz,
            kept = Math.max(0, vn - depth / h);
          rx -= vn * nx;
          ry -= vn * ny;
          rz -= vn * nz;
          // Velocity-level Coulomb friction: the tangential speed change is bounded by
          // mu × the normal speed change the contact applied (depth / h).
          const tangential = norm3(rx, ry, rz),
            scale = tangential > 1e-12 ? Math.max(0, 1 - (mu * depth) / h / tangential) : 0;
          vx = sv[0] + rx * scale + kept * nx;
          vy = sv[1] + ry * scale + kept * ny;
          vz = sv[2] + rz * scale + kept * nz;
        }
        const speed = norm3(vx, vy, vz),
          clamp = speed > limit ? (limit / speed) * decay : decay;
        vx *= clamp;
        vy *= clamp;
        vz *= clamp;
        v[k] = vx;
        v[k + 1] = vy;
        v[k + 2] = vz;
        energy += vx * vx + vy * vy + vz * vz;
      }
    }
    this.energy = energy * c.particleMass * 0.5;
    if ((c.strainLimitPasses ?? 0) > 0) this.collectHotEdges(edgeList);
    attachAccessories(p, this.asset.attachments ?? [], this.asset.attachment_offsets ?? []);
    this.elapsed = ++this.frameIndex * c.dt;
    return this.energy;
  }

  /**
   * Motion bakes (bake.ts): moves the hot arrays into WebAssembly memory and runs the full-mesh
   * substep loops there (wasm/kernels.ts), bit-identical to stepSmall. The solver keeps views
   * on that memory, so every other method still works unchanged. Steps the kernels do not
   * cover (a local region, grabs, a collider without surface velocity) run the JS path on the
   * same views. The hand pull never attaches kernels.
   */
  attachKernels(create: KernelFactory) {
    if (this.kernels) return;
    if (!this.smallSteps) throw new Error('WebAssembly kernels need the small-steps solver');
    this.allocatePlanes();
    const kernels = create({
      shared: {
        positions: this.positions,
        previous: this.previous,
        velocity: this.velocity,
        inverseMass: this.inverseMass,
        contactNormals: this.contactNormals,
        contactDepth: this.contactDepth,
        planeStamp: this.planeStamp,
        planeVelocity: this.planeVelocity,
        edgeLambda: this.edgeLambda,
        hingeLambda: this.hingeLambda,
        surfaceVelocity: this.surfaceVelocity,
        contactSlack: this.contactSlack,
        contactAnchor: this.contactAnchor,
        planeData: this.planeData,
        gradient: this.gradient,
      },
      panels: this.panels,
      edges: this.edges,
      restLengths: this.restLengths,
      edgeCompliance: this.edgeCompliance,
      edgeLimit: this.edgeLimit,
      hinges: this.hinges,
      hingeLengths: this.hingeLengths,
      supports: this.supports,
      supportLengths: this.supportLengths,
      tethers: this.tethers,
      tetherLengths: this.tetherLengths,
      tetherInitial: this.tetherInitial,
      rootIds: this.rootIds,
      collisionMasks: this.collisionMasks,
      excludedOffsets: this.excludedOffsets,
      excludedIds: this.excludedIds,
      layerOffset: this.layerOffset,
      loft: this.loft,
      elastic: this.elastic,
      triangles: Int32Array.from(this.asset.triangles),
      pairs: this.layerPairs(),
      perSource: Math.max(1, Math.round(this.asset.config.layerPairsPerVertex ?? 1)),
    });
    this.rehome(kernels.views);
    this.setLayerPairs(kernels.pairs);
    this.kernels = kernels;
  }
  private layerPairs(): LayerPairs {
    return {
      a: this.layerPairA,
      b: this.layerPairB,
      triangle: this.layerPairTriangle,
      side: this.layerPairSide,
      gap: this.layerPairGap,
    };
  }
  private setLayerPairs(pairs: LayerPairs) {
    this.layerPairA = pairs.a;
    this.layerPairB = pairs.b;
    this.layerPairTriangle = pairs.triangle;
    this.layerPairSide = pairs.side;
    this.layerPairGap = pairs.gap;
  }
  /** rebuildLayerPairs() in WebAssembly (same pairs, same order); the solver keeps views. */
  private rebuildLayerPairsKernels(k: SolverKernels) {
    const c = this.asset.config;
    this.setLayerPairs(
      k.rebuildPairs(
        this.inverseMass.length,
        this.restLengths.length,
        this.asset.triangles.length / 3,
        c.layerPairRadius ?? 0,
        c.layerGap ?? 0.002,
        Math.max(1, Math.round(c.layerPairsPerVertex ?? 1)),
        c.layerGrow ?? 0.05,
      ),
    );
    return this.layerPairA.length;
  }
  /** Back to plain JS arrays with the same contents (e.g. before cloneState). */
  detachKernels() {
    const kernels = this.kernels;
    if (!kernels) return;
    this.kernels = undefined;
    const own = {} as Record<string, Float64Array | Int32Array>;
    for (const [name, view] of Object.entries(kernels.views)) own[name] = view.slice();
    this.rehome(own as SharedArrays);
    this.hotEdges = this.hotEdges.slice();
    const pairs = this.layerPairs();
    this.setLayerPairs({
      a: pairs.a.slice(),
      b: pairs.b.slice(),
      triangle: pairs.triangle.slice(),
      side: pairs.side.slice(),
      gap: pairs.gap.slice(),
    });
    kernels.release();
  }
  /**
   * End of a bake: gives the kernels' instance back to the pool without copying the arrays out.
   * The solver must not be used afterwards (its arrays are views on the reused memory).
   */
  releaseKernels() {
    this.kernels?.release();
    this.kernels = undefined;
  }
  get kernelsAttached() {
    return this.kernels !== undefined;
  }
  private rehome(arrays: SharedArrays) {
    // The readonly fields are replaced only here, by arrays of the same type and contents.
    Object.assign(this as unknown as SharedArrays, arrays);
  }
  private kernelStepPossible() {
    return (
      !this.region &&
      !this.grabIds.length &&
      (this.asset.config.contactPlaneRadius ?? 0) > 0 &&
      this.collider.surfaceVelocity !== undefined
    );
  }
  /** stepSmall's full-mesh branch with the WebAssembly kernels, call for call in the same order. */
  private stepSmallKernels(k: SolverKernels) {
    const c = this.asset.config,
      n = c.substeps,
      h = c.dt / n,
      count = this.inverseMass.length,
      edgeCount = this.restLengths.length,
      hingeCount = this.hingeLengths.length,
      neutral = this.asset.fabric_surface === 'neutral',
      decay = Math.exp(-(c.dampingPerSecond ?? 0) * h),
      // stretch(): 1 / h², hingeBend(): compliance / h², limitTethers(h): see there.
      inverseH2 = 1 / (h * h),
      hingeAlpha = (c.hingeCompliance ?? 0) / (h * h),
      soft = this.oneWayTethers && h > 0 ? (c.supportCompliance ?? 0) : 0,
      tetherAlpha = soft > 0 ? soft / (h * h) : 0,
      anchor = this.oneWayTethers && h > 0 ? (c.rootCompliance ?? 0) : 0,
      beta = anchor > 0 ? anchor / (h * h) : 0,
      liftFree = (c.rootLiftFree ?? 0) > 0,
      // selfCollide()
      cell = c.selfRadius * 2,
      invCell = 1 / cell,
      cell2 = cell * cell,
      // contact(): see there.
      base = this.asset.layer_m + c.collisionMargin,
      planeRadius = c.contactPlaneRadius ?? 0,
      contactSoft = (c.contactCompliance ?? 0) > 0,
      hardElastic = (c.contactHardElastic ?? 0) > 0,
      hardMin = c.contactHardMin ?? 0,
      contactAlpha = (c.contactCompliance ?? 0) / (h * h),
      hasSurface = this.collider.surfaceVelocity !== undefined,
      contact = (accumulate: boolean) =>
        k.contact(
          count,
          accumulate,
          base,
          neutral,
          planeRadius,
          this.poseStamp,
          contactSoft,
          hardElastic,
          hardMin,
          contactAlpha,
          hasSurface,
        ),
      // layerContact()
      trust = c.layerTrust ?? 0.003,
      grow = c.layerGrow ?? 0.05;
    k.collider = this.collider;
    k.syncPairs(this.layerPairs());
    k.setRootAnchors(this.rootAnchors);
    k.syncHot(this.hotEdges);
    let energy = 0;
    for (let s = 0; s < n; s++) {
      k.integrate(count, c.gravity * h, h);
      const order = c.contactOrder ?? 0;
      k.resetLambdas(edgeCount, hingeCount);
      this.ringLambda.fill(0);
      if (order > 0) contact(false);
      for (let pass = 0; pass < c.iterations; pass++)
        k.stretch(edgeCount, inverseH2, pass % 2 === 1, neutral);
      k.hinge(hingeCount, hingeAlpha);
      k.tethers(
        this.supportLengths.length,
        this.rootIds.length,
        this.tetherLengths.length,
        c.stretchMax,
        neutral,
        c.collarCompression,
        anchor > 0,
        beta,
        liftFree,
        tetherAlpha,
        this.oneWayTethers,
      );
      this.constrainRings(h);
      if (this.guideMode === 1) this.cuffContact();
      else if (this.guideMode === 2) this.cuffStops();
      if (this.armholeStops.length) this.applyArmholeStops();
      if (s === n - 1 && this.frameIndex % c.selfEvery === 0)
        k.selfCollide(count, cell, invCell, cell2);
      for (let pass = 0; pass < (c.strainLimitPasses ?? 0); pass++) k.limitHot();
      if (this.layerPairA.length) k.layerContact(trust, grow);
      if (order !== 1) contact(order > 0);
      if ((c.finalStrainPasses ?? 0) > 0)
        k.limitAfterContact(count, edgeCount, c.finalStrainPasses);
      energy = k.velocity(count, h, c.friction, c.velocityLimit, decay, this.poseStamp);
    }
    this.energy = energy * c.particleMass * 0.5;
    if ((c.strainLimitPasses ?? 0) > 0) this.hotEdges = k.collectHot(edgeCount);
    attachAccessories(
      this.positions,
      this.asset.attachments ?? [],
      this.asset.attachment_offsets ?? [],
    );
    this.elapsed = ++this.frameIndex * c.dt;
    return this.energy;
  }

  step() {
    if (this.smallSteps) return this.stepSmall();
    const c = this.asset.config,
      h = c.dt / c.substeps,
      p = this.positions;
    for (let s = 0; s < c.substeps; s++) {
      this.previous.set(p);
      for (let i = 0; i < this.inverseMass.length; i++) {
        const k = i * 3;
        if (!this.inverseMass[i]) continue;
        this.velocity[k + 1] += c.gravity * h;
        for (let a = 0; a < 3; a++) p[k + a] += this.velocity[k + a] * h;
      }
      for (const [id, target] of this.grabbed)
        for (let k = 0; k < 3; k++) p[id * 3 + k] = target[k];
      this.edgeLambda.fill(0);
      this.bendLambda.fill(0);
      this.ringLambda.fill(0);
      for (let iteration = 0; iteration < c.iterations; iteration++) {
        this.stretch(h);
        this.bend(h);
        this.limitTethers();
        this.constrainRings(h);
        this.cuffContact();
      }
      if (s === c.substeps - 1 && this.frameIndex % c.selfEvery === 0) {
        this.selfCollide();
      }
      this.projectBody();
      for (let contact = 0; contact < c.hardRingContactIterations; contact++) {
        this.ringLambda.fill(0);
        this.constrainRings(h);
        this.cuffContact();
        this.projectBody(true);
      }
      let energy = 0;
      for (let i = 0; i < p.length; i += 3) {
        if (!this.inverseMass[i / 3]) continue;
        let vx = (p[i] - this.previous[i]) / h,
          vy = (p[i + 1] - this.previous[i + 1]) / h,
          vz = (p[i + 2] - this.previous[i + 2]) / h;
        const nx = this.contactNormals[i],
          ny = this.contactNormals[i + 1],
          nz = this.contactNormals[i + 2];
        // Inelastic contact: positional collision correction must not turn into
        // an artificial launch impulse at the next integration step.
        const vn = vx * nx + vy * ny + vz * nz;
        vx -= vn * nx;
        vy -= vn * ny;
        vz -= vn * nz;
        const speed = norm3(vx, vy, vz),
          scale = Math.min(1, c.velocityLimit / (speed + 1e-12)) * c.damping;
        this.velocity[i] = vx * scale;
        this.velocity[i + 1] = vy * scale;
        this.velocity[i + 2] = vz * scale;
        energy += (vx * vx + vy * vy + vz * vz) * scale * scale;
      }
      this.energy = energy * c.particleMass * 0.5;
      attachAccessories(p, this.asset.attachments ?? [], this.asset.attachment_offsets ?? []);
    }
    this.elapsed = ++this.frameIndex * c.dt;
    return this.energy;
  }

  polishContacts() {
    const p = this.positions,
      c = this.asset.config,
      g = this.gradient,
      tri = this.asset.triangles;
    const project = (ids: ArrayLike<number>, offset: number, count: number) => {
      let x = 0,
        y = 0,
        z = 0,
        loft = 0,
        mass = 0;
      for (let j = 0; j < count; j++) {
        const i = ids[offset + j],
          k = i * 3;
        x += p[k] / count;
        y += p[k + 1] / count;
        z += p[k + 2] / count;
        loft += (this.asset.fabric_surface === 'neutral' ? 0 : this.loft[i]) / count;
        mass += this.inverseMass[i];
      }
      if (!mass) return;
      const thickness = loft * c.loftMinimumRatio + this.asset.layer_m + c.collisionMargin;
      const distance = this.sampleSdf(x, y, z, g, thickness);
      if (distance >= thickness) return;
      const norm2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (norm2 < 1e-8) return;
      const correction = Math.min(
        c.surfaceCorrectionLimit,
        (thickness - distance) / Math.sqrt(norm2),
      );
      const scale = (correction * count) / (mass * Math.sqrt(norm2));
      for (let j = 0; j < count; j++) {
        const i = ids[offset + j],
          k = i * 3,
          w = this.inverseMass[i];
        p[k] += w * scale * g[0];
        p[k + 1] += w * scale * g[1];
        p[k + 2] += w * scale * g[2];
      }
    };
    for (let pass = 0; pass < c.strainPolishPasses; pass++) {
      this.edgeLambda.fill(0);
      this.stretch(c.dt / c.substeps);
      this.limitTethers();
      this.ringLambda.fill(0);
      this.constrainRings(c.dt / c.substeps);
      this.cuffContact();
      this.projectBody(false, true);
    }
    this.cuffContact();
    this.projectBody(true, true);
    for (let pass = 0; pass < c.surfaceContactPasses; pass++) {
      for (let e = 0; e < this.edges.length; e += 2) project(this.edges, e, 2);
      for (let t = 0; t < tri.length; t += 3) project(tri, t, 3);
      this.projectBody(false, true);
    }
    this.cuffContact();
    this.projectBody(true, true);
    attachAccessories(p, this.asset.attachments ?? [], this.asset.attachment_offsets ?? []);
  }

  snapshot(
    options: SnapshotOptions = { gap: true, strain: true },
    buffers?: FrameBuffers,
  ): ClothSnapshot {
    const p = this.positions,
      strain = buffers?.strain ?? new Float32Array(this.inverseMass.length),
      gap = buffers?.gap ?? new Float32Array(this.inverseMass.length),
      positions = buffers?.positions ?? new Float32Array(p.length);
    if (options.strain) strain.fill(0);
    if (options.strain)
      for (let e = 0; e < this.restLengths.length; e++) {
        const ai = this.edges[e * 2],
          bi = this.edges[e * 2 + 1],
          a = ai * 3,
          b = bi * 3;
        const rest = this.restLengths[e];
        const value =
          rest > 1e-8 ? norm3(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / rest - 1 : 0;
        this.edgeStrain[e] = value;
        strain[ai] = Math.max(strain[ai], value);
        strain[bi] = Math.max(strain[bi], value);
      }
    if (options.gap)
      for (let i = 0; i < gap.length; i++) {
        const outer =
          this.sampleSdf(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) + this.asset.sdf.distance_bias_m;
        const effective = Math.min(
          this.asset.fabric_surface === 'neutral' ? 0 : this.loft[i],
          Math.max(
            this.loft[i] * this.asset.config.loftMinimumRatio,
            outer - this.asset.layer_m - this.asset.config.collisionMargin,
          ),
        );
        gap[i] = (outer - effective - this.asset.layer_m) * 100;
      }
    positions.set(p);
    const compression = buffers?.compression ?? new Float32Array(this.inverseMass.length * 4);
    compressionField(p, this.edges, this.restLengths, compression);
    return {
      assetKey: this.asset.key,
      positions,
      strain,
      gap,
      energy: this.energy,
      simulatedSeconds: this.elapsed,
      gapValid: !!options.gap,
      strainValid: !!options.strain,
      compression,
    };
  }

  // ---- Interactive zip (agent Z). Called only on the zip's split solver (engine/interact),
  // never on the base solver: the measured shell, the relax and the hand pull do not reach it.

  /**
   * Soft tether supports (supportCompliance) off (or back on) for tethers whose particle is in
   * `particles`; the hard long-range bound stays. Off = their pull towards the constructed
   * distance from the root never acts.
   */
  setSoftSupports(particles: ArrayLike<number>, on: boolean) {
    const inside = new Uint8Array(this.inverseMass.length);
    for (let k = 0; k < particles.length; k++) inside[particles[k]] = 1;
    this.softSupportSaved ??= this.tetherInitial.slice();
    for (let e = 0; e < this.tetherLengths.length; e++)
      if (inside[this.tethers[e * 2 + 1]])
        this.tetherInitial[e] = on ? this.softSupportSaved[e] : Infinity;
  }
  private softSupportSaved?: Float64Array;
}
