// W3: the ArticulatedCollider's queries (distance with its linearised cache, exactDistance,
// surfaceVelocity) in WebAssembly (cloth/wasm/solver.as.ts, collider section), bit-identical
// to the JS. One instance and memory per collider. setFrame still runs in JS; its pose is
// copied in (pose()). The query state (cache, hints, last winner) lives in the module while
// attached and is copied back on detach, so a cloned or detached collider continues exactly.
import { acquireInstance, solverModule, type PooledInstance } from '../../cloth/wasm/kernels.ts';
import { MOTION_FIT } from '../config.ts';
import type { ArticulatedSdf } from '../articulatedCollider.ts';

/** Per-pose data written by ArticulatedCollider.setFrame. */
export type ColliderPose = {
  toLocal: Float64Array;
  toPrevious: Float64Array;
  zoneCurrent: Float64Array;
  zonePrevious: Float64Array;
  faceNormal: Float64Array;
  vertexNormal: Float64Array;
  triBounds: Float64Array;
  gridOrigin: Float64Array;
  gridDims: Int32Array;
  cellStart: Int32Array;
  cellEntries: Int32Array;
  dt: number;
  generation: number;
};
/** The collider's query state (fields of the same names). */
export type ColliderQueryState = {
  cache: Float64Array<ArrayBuffer>;
  cacheFrame: Int32Array<ArrayBuffer>;
  stamp: Int32Array<ArrayBuffer>;
  query: number;
  hintSegment: number;
  hintFace: number;
  winner: number;
  winnerSegment: number;
  winnerFace: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  bary: Float64Array;
  closest: Float64Array;
  local: Float64Array;
  bestLocal: Float64Array;
  queries: number;
  zoneQueries: number;
  cacheHits: number;
};
export type ColliderKernelFactory = (sdf: ArticulatedSdf, pose: ColliderPose) => ColliderKernels;

type Exports = {
  memory: WebAssembly.Memory;
  heapBase(): number;
  colliderDistance(x: number, y: number, z: number, gradient: number, threshold: number): number;
  colliderExact(x: number, y: number, z: number, threshold: number): number;
  colliderSurface(x: number, y: number, z: number): void;
} & Record<string, WebAssembly.Global>;

const CACHE_SIZE = 1 << 16,
  CACHE_STRIDE = 14;

export class ColliderKernels {
  private readonly x: Exports;
  private readonly out: Float64Array;
  private readonly view: Record<string, Float64Array<ArrayBuffer> | Int32Array<ArrayBuffer>> = {};
  private readonly cellCapacity: number;
  private readonly entryCapacity: number;
  private readonly pooled: PooledInstance;

  constructor(
    sdf: ArticulatedSdf,
    pose: ColliderPose,
    module: WebAssembly.Module = solverModule(),
  ) {
    // One reusable instance per thread (kernels.ts acquireInstance), not one per bake.
    this.pooled = acquireInstance('collider', module, () => {
      const imports: WebAssembly.Imports = {};
      for (const entry of WebAssembly.Module.imports(module)) {
        const table = (imports[entry.module] ??= {});
        table[entry.name] =
          entry.name === 'hypot'
            ? Math.hypot
            : () => {
                throw new Error('Collider kernels do not use ' + entry.name);
              };
      }
      return imports;
    });
    this.pooled.owner = this;
    const x = this.pooled.exports as unknown as Exports;
    this.x = x;
    const segments = sdf.segments,
      S = segments.length,
      faces = sdf.zoneFaces.length / 3,
      zv = sdf.zoneVertices.length,
      cells = pose.gridDims[0] * pose.gridDims[1] * pose.gridDims[2];
    // Room for poses with up to 4x the zone grid cells / 3x the entries of the attach pose; a
    // larger pose detaches the kernels (the collider continues in JS, see pose()).
    this.cellCapacity = Math.max(4 * cells, 1 << 16);
    this.entryCapacity = Math.max(3 * pose.cellStart[cells], 1 << 16);
    const plan: [string, 'f64' | 'i32' | 'f32', number][] = [
      ['ZSEG', 'f64', S * 12],
      ['ZSEGV', 'i32', S],
      ['ZTOLOCAL', 'f64', S * 12],
      ['ZTOPREV', 'f64', S * 12],
      ['ZFACES', 'i32', faces * 3],
      ['ZBV', 'i32', zv],
      ['ZBE', 'i32', faces * 3],
      ['ZNEI', 'i32', faces * 3],
      ['ZCUR', 'f64', zv * 3],
      ['ZPREV', 'f64', zv * 3],
      ['ZFN', 'f64', faces * 3],
      ['ZVN', 'f64', zv * 3],
      ['ZTB', 'f64', faces * 6],
      ['ZCSTART', 'i32', this.cellCapacity + 1],
      ['ZCENT', 'i32', this.entryCapacity],
      ['ZSTAMP', 'i32', faces],
      ['ZCACHE', 'f64', CACHE_SIZE * CACHE_STRIDE],
      ['ZCFRAME', 'i32', CACHE_SIZE],
      ['ZOUT', 'f64', 3],
      ...segments.map((s, i): [string, 'f32', number] => [`grid${i}`, 'f32', s.values.length]),
    ];
    const offsets = new Map<string, number>();
    let end = x.heapBase();
    for (const [name, type, count] of plan) {
      end = Math.ceil(end / 16) * 16;
      offsets.set(name, end);
      end += count * (type === 'f64' ? 8 : 4);
    }
    const pages = Math.ceil(end / 65536) - x.memory.buffer.byteLength / 65536;
    if (pages > 0) x.memory.grow(pages);
    const buffer = x.memory.buffer;
    for (const [name, type, count] of plan) {
      const at = offsets.get(name)!;
      if (type === 'f32') continue;
      x[name].value = at;
      this.view[name] =
        type === 'f64' ? new Float64Array(buffer, at, count) : new Int32Array(buffer, at, count);
    }
    segments.forEach((s, i) => {
      new Float32Array(buffer, offsets.get(`grid${i}`)!, s.values.length).set(s.values);
      this.view.ZSEGV[i] = offsets.get(`grid${i}`)!;
      this.view.ZSEG.set([...s.centre, s.radius, ...s.origin, s.spacing, ...s.dims, 0], i * 12);
    });
    this.view.ZFACES.set(sdf.zoneFaces);
    this.view.ZBV.set(sdf.borderVertex);
    this.view.ZBE.set(sdf.borderEdge);
    this.view.ZNEI.set(sdf.edgeNeighbour);
    this.out = this.view.ZOUT as Float64Array;
    x.zSegments.value = S;
    x.zCell.value = MOTION_FIT.zoneCellM;
    x.zCacheE.value = MOTION_FIT.cacheRadiusM;
    x.zSearchMax.value = MOTION_FIT.zoneSearchMaxM;
    x.zSearchMargin.value = MOTION_FIT.zoneSearchMarginM;
    if (!this.pose(pose)) throw new Error('Collider pose exceeds the kernel grid');
  }

  /** Gives the instance back to the thread's pool (after queryState()); unusable afterwards. */
  release() {
    if (this.pooled.owner !== this) return;
    this.pooled.owner = undefined;
    this.pooled.busy = false;
  }

  /** Copies setFrame's pose in; false when its zone grid does not fit (caller detaches). */
  pose(p: ColliderPose) {
    const x = this.x,
      v = this.view,
      cells = p.gridDims[0] * p.gridDims[1] * p.gridDims[2],
      entries = p.cellStart[cells];
    if (cells > this.cellCapacity || entries > this.entryCapacity) return false;
    v.ZTOLOCAL.set(p.toLocal);
    v.ZTOPREV.set(p.toPrevious);
    v.ZCUR.set(p.zoneCurrent);
    v.ZPREV.set(p.zonePrevious);
    v.ZFN.set(p.faceNormal);
    v.ZVN.set(p.vertexNormal);
    v.ZTB.set(p.triBounds);
    v.ZCSTART.set(p.cellStart.subarray(0, cells + 1));
    v.ZCENT.set(p.cellEntries.subarray(0, entries));
    x.zOx.value = p.gridOrigin[0];
    x.zOy.value = p.gridOrigin[1];
    x.zOz.value = p.gridOrigin[2];
    x.zNx.value = p.gridDims[0];
    x.zNy.value = p.gridDims[1];
    x.zNz.value = p.gridDims[2];
    x.zDt.value = p.dt;
    x.zGeneration.value = p.generation;
    x.zLastX.value = NaN; // setFrame resets lastX only
    return true;
  }

  setQueryState(s: ColliderQueryState) {
    const x = this.x,
      v = this.view;
    v.ZCACHE.set(s.cache);
    v.ZCFRAME.set(s.cacheFrame);
    v.ZSTAMP.set(s.stamp);
    x.zQuery.value = s.query;
    x.zHintSegment.value = s.hintSegment;
    x.zHintFace.value = s.hintFace;
    x.zWinner.value = s.winner;
    x.zWinnerSegment.value = s.winnerSegment;
    x.zWinnerFace.value = s.winnerFace;
    x.zLastX.value = s.lastX;
    x.zLastY.value = s.lastY;
    x.zLastZ.value = s.lastZ;
    [x.zBary0.value, x.zBary1.value, x.zBary2.value] = s.bary;
    [x.zClosestX.value, x.zClosestY.value, x.zClosestZ.value] = s.closest;
    [x.zLocalX.value, x.zLocalY.value, x.zLocalZ.value] = s.local;
    [x.zBestX.value, x.zBestY.value, x.zBestZ.value] = s.bestLocal;
    x.zQueries.value = s.queries;
    x.zZoneQueries.value = s.zoneQueries;
    x.zCacheHits.value = s.cacheHits;
  }

  /** The module's query state, as fresh arrays (detach). */
  queryState(): ColliderQueryState {
    const x = this.x,
      v = this.view,
      g = (name: string) => x[name].value as number;
    return {
      cache: (v.ZCACHE as Float64Array<ArrayBuffer>).slice(),
      cacheFrame: (v.ZCFRAME as Int32Array<ArrayBuffer>).slice(),
      stamp: (v.ZSTAMP as Int32Array<ArrayBuffer>).slice(),
      query: g('zQuery'),
      hintSegment: g('zHintSegment'),
      hintFace: g('zHintFace'),
      winner: g('zWinner'),
      winnerSegment: g('zWinnerSegment'),
      winnerFace: g('zWinnerFace'),
      lastX: g('zLastX'),
      lastY: g('zLastY'),
      lastZ: g('zLastZ'),
      bary: Float64Array.of(g('zBary0'), g('zBary1'), g('zBary2')),
      closest: Float64Array.of(g('zClosestX'), g('zClosestY'), g('zClosestZ')),
      local: Float64Array.of(g('zLocalX'), g('zLocalY'), g('zLocalZ')),
      bestLocal: Float64Array.of(g('zBestX'), g('zBestY'), g('zBestZ')),
      queries: g('zQueries'),
      zoneQueries: g('zZoneQueries'),
      cacheHits: g('zCacheHits'),
    };
  }

  distance(
    px: number,
    py: number,
    pz: number,
    gradient: Float64Array | undefined,
    threshold: number,
  ) {
    const value = this.x.colliderDistance(px, py, pz, gradient ? 1 : 0, threshold);
    if (gradient && value < threshold) {
      gradient[0] = this.out[0];
      gradient[1] = this.out[1];
      gradient[2] = this.out[2];
    }
    return value;
  }
  exact(px: number, py: number, pz: number, threshold: number) {
    return this.x.colliderExact(px, py, pz, threshold);
  }
  surface(px: number, py: number, pz: number, out: Float64Array) {
    this.x.colliderSurface(px, py, pz);
    out[0] = this.out[0];
    out[1] = this.out[1];
    out[2] = this.out[2];
  }
}

/** The production factory: one instance per collider from the embedded module. */
export const wasmColliderKernels: ColliderKernelFactory = (sdf, pose) =>
  new ColliderKernels(sdf, pose);
