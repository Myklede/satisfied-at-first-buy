// WebAssembly kernels for ClothSolver's full-mesh small-steps loops (motion bakes only, never
// the hand pull). The solver's hot arrays move into one WebAssembly linear memory: the solver
// keeps working on typed-array views of it (ClothSolver.attachKernels), JS and WebAssembly see
// the same numbers, and a substep copies nothing across the boundary. Results are bit-identical
// to the JS loops (solver.as.ts explains how); selfCheck.ts verifies that at runtime.
import type { BodyCollider } from '../collider.ts';
import { SOLVER_WASM_BASE64 } from './solverWasm.ts';

/** Arrays the solver hands over; the `shared` ones are replaced by views on the wasm memory. */
export type KernelInput = {
  shared: {
    positions: Float64Array;
    previous: Float64Array;
    velocity: Float64Array;
    inverseMass: Float64Array;
    contactNormals: Float64Array;
    contactDepth: Float64Array;
    planeStamp: Int32Array;
    planeVelocity: Float64Array;
    edgeLambda: Float64Array;
    hingeLambda: Float64Array;
    surfaceVelocity: Float64Array;
    contactSlack: Float64Array;
    contactAnchor: Float64Array;
    planeData: Float64Array;
    gradient: Float64Array;
  };
  panels: Int32Array;
  edges: Uint32Array;
  restLengths: Float64Array;
  edgeCompliance: Float64Array;
  edgeLimit: Float64Array;
  hinges: Uint32Array;
  hingeLengths: Float64Array;
  supports: Uint32Array;
  supportLengths: Float64Array;
  tethers: Uint32Array;
  tetherLengths: Float64Array;
  tetherInitial: Float64Array;
  rootIds: Uint32Array;
  collisionMasks: Int32Array;
  excludedOffsets: Int32Array;
  excludedIds: Int32Array;
  layerOffset: Float64Array;
  loft: Float64Array;
  elastic: Float64Array;
  triangles: Int32Array;
  /** The solver's current layer pairs and pairs per source (rebuildLayerPairs). */
  pairs: LayerPairs;
  perSource: number;
};
/** ClothSolver's layer contact pairs (layerPairA, B, Triangle, Side, Gap). */
export type LayerPairs = {
  a: Int32Array<ArrayBuffer>;
  b: Int32Array<ArrayBuffer>;
  triangle: Int32Array<ArrayBuffer>;
  side: Float64Array<ArrayBuffer>;
  gap: Float64Array<ArrayBuffer>;
};
export type SharedArrays = KernelInput['shared'];
export type KernelFactory = (input: KernelInput) => SolverKernels;

type Exports = {
  memory: WebAssembly.Memory;
  heapBase(): number;
  integrate(n: number, gh: number, h: number): void;
  resetLambdas(edges: number, hinges: number): void;
  stretch(count: number, inverseH2: number, reverse: number, neutral: number): void;
  hinge(count: number, alpha: number): void;
  tethers(
    supports: number,
    roots: number,
    count: number,
    max: number,
    neutral: number,
    collarCompression: number,
    anchored: number,
    beta: number,
    liftFree: number,
    alpha: number,
    oneWay: number,
  ): void;
  selfCollide(n: number, cell: number, invCell: number, cell2: number): void;
  limitHot(): void;
  limitAfterContact(n: number, edges: number, passes: number): void;
  velocity(n: number, h: number, mu: number, limit: number, decay: number, stamp: number): number;
  collectHot(edges: number): void;
  contact(
    n: number,
    accumulate: number,
    base: number,
    neutral: number,
    planeRadius: number,
    planeRadius2: number,
    stamp: number,
    soft: number,
    hardElastic: number,
    hardMin: number,
    contactAlpha: number,
    hasSurface: number,
  ): void;
  layerContact(trust: number, grow: number): void;
  pairSetup(triangles: number, tableSize: number): void;
  rebuildPairs(
    n: number,
    edges: number,
    triangles: number,
    radius: number,
    gapLimit: number,
    perSource: number,
    grow: number,
  ): number;
  hotCount: WebAssembly.Global;
  pairCount: WebAssembly.Global;
} & Record<string, WebAssembly.Global>;

let compiled: WebAssembly.Module | undefined;
/** The kernels' module, compiled once per thread (synchronous: workers and Node only). */
export function solverModule() {
  if (!compiled) {
    const text = atob(SOLVER_WASM_BASE64),
      bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    compiled = new WebAssembly.Module(bytes);
  }
  return compiled;
}

/** A module instance reused by one solver or collider at a time (one memory per thread and role). */
export type PooledInstance = {
  exports: WebAssembly.Exports;
  module: WebAssembly.Module;
  busy: boolean;
  /** The kernels object currently using it (import callbacks route here). */
  owner?: unknown;
};
const pools = new Map<string, PooledInstance>();
/**
 * An instance of `module` for `role` ('solver', 'collider'): the thread's pooled one when it is
 * free (its memory above heapBase zero-filled and resetState() called, so it behaves exactly like
 * a fresh instance), otherwise a new one. The first instance of a role becomes the pooled one.
 * Before this, every bake made up to four memories that only GC freed.
 */
export function acquireInstance(
  role: string,
  module: WebAssembly.Module,
  imports: (pooled: PooledInstance) => WebAssembly.Imports,
): PooledInstance {
  const pooled = pools.get(role);
  if (pooled && !pooled.busy && pooled.module === module) {
    const x = pooled.exports as {
        memory: WebAssembly.Memory;
        heapBase(): number;
        resetState(): void;
      },
      base = x.heapBase();
    new Uint8Array(x.memory.buffer, base, x.memory.buffer.byteLength - base).fill(0);
    x.resetState();
    pooled.busy = true;
    return pooled;
  }
  const fresh: PooledInstance = { exports: {}, module, busy: true };
  fresh.exports = new WebAssembly.Instance(module, imports(fresh)).exports;
  if (!pooled || pooled.module !== module) pools.set(role, fresh);
  return fresh;
}
/** Instances created per role in this thread (diagnostics and tests). */
export const pooledInstance = (role: string) => pools.get(role);

type View = Float64Array | Int32Array | Uint32Array;
type ViewOf<T> = T extends Float64Array ? Float64Array : T extends Int32Array ? Int32Array : T;

/**
 * One solver's kernels: its own instance and memory (sized once, never grown, so the views stay
 * valid). `collider` is the solver's current body collider (the `surface` import reads it).
 */
export class SolverKernels {
  readonly views: SharedArrays;
  collider?: BodyCollider;
  private readonly x: Exports;
  private readonly hot: Int32Array<ArrayBuffer>;
  /** The view the solver holds as hotEdges after the last collectHot (identity = in sync). */
  private hotList?: Int32Array<ArrayBuffer>;

  private readonly pooled: PooledInstance;

  constructor(input: KernelInput, module: WebAssembly.Module = solverModule()) {
    this.pooled = acquireInstance('solver', module, (pooled) => {
      const imports: WebAssembly.Imports = {},
        owner = () => pooled.owner as SolverKernels;
      for (const entry of WebAssembly.Module.imports(module)) {
        const table = (imports[entry.module] ??= {});
        if (entry.name === 'surface')
          table.surface = (px: number, py: number, pz: number) =>
            owner().collider!.surfaceVelocity!(px, py, pz, owner().views.surfaceVelocity);
        else if (entry.name === 'distance')
          table.distance = (px: number, py: number, pz: number, threshold: number) =>
            owner().collider!.distance(px, py, pz, owner().views.gradient, threshold);
        else if (entry.name === 'hypot')
          table.hypot = Math.hypot; // collider section only
        else throw new Error(`Unexpected solver kernel import ${entry.module}.${entry.name}`);
      }
      return imports;
    });
    this.pooled.owner = this;
    const x = this.pooled.exports as unknown as Exports;
    this.x = x;
    const s = input.shared,
      n = s.inverseMass.length,
      edges = input.restLengths.length,
      triangles = input.triangles.length / 3,
      capacity = input.perSource * (n + edges);
    let tableSize = 1;
    while (tableSize < triangles * 6) tableSize *= 2;
    // Layout: [pointer global, element type, element count], 16-byte aligned from __heap_base.
    const plan: [string, 'f64' | 'i32', number][] = [
      ['P', 'f64', n * 3],
      ['PREV', 'f64', n * 3],
      ['V', 'f64', n * 3],
      ['W', 'f64', n],
      ['NORMAL', 'f64', n * 3],
      ['DEPTH', 'f64', n],
      ['BEFORE', 'f64', n * 3],
      ['PSTAMP', 'i32', n],
      ['PVEL', 'f64', n * 3],
      ['PANEL', 'i32', n],
      ['SV', 'f64', 3],
      ['EDGE', 'i32', edges * 2],
      ['REST', 'f64', edges],
      ['ELAMBDA', 'f64', edges],
      ['ECOMP', 'f64', edges],
      ['ELIMIT', 'f64', edges],
      ['EQUEUE', 'i32', edges],
      ['HOT', 'i32', edges],
      ['HINGE', 'i32', input.hinges.length],
      ['HREST', 'f64', input.hingeLengths.length],
      ['HLAMBDA', 'f64', input.hingeLengths.length],
      ['SUPPORT', 'i32', input.supports.length],
      ['SLEN', 'f64', input.supportLengths.length],
      ['TETHER', 'i32', input.tethers.length],
      ['TLEN', 'f64', input.tetherLengths.length],
      ['TINIT', 'f64', input.tetherInitial.length],
      ['ROOT', 'i32', input.rootIds.length],
      ['RANCHOR', 'f64', input.rootIds.length * 3],
      ['MASK', 'i32', input.collisionMasks.length],
      ['CCOUNT', 'i32', 65536],
      ['CSTART', 'i32', 65537],
      ['CCURSOR', 'i32', 65536],
      ['CENTRY', 'i32', n],
      ['CKEY', 'i32', n],
      ['CX', 'i32', n],
      ['CY', 'i32', n],
      ['CZ', 'i32', n],
      ['EXOFF', 'i32', input.excludedOffsets.length],
      ['EXID', 'i32', input.excludedIds.length],
      ['SLACK', 'f64', n],
      ['ANCHOR', 'f64', n * 3],
      ['LAYER', 'f64', n],
      ['LOFT', 'f64', n],
      ['ELASTIC', 'f64', n],
      ['PLANE', 'f64', n * 8],
      ['GRAD', 'f64', 3],
      ['LPA', 'i32', capacity],
      ['LPB', 'i32', capacity],
      ['LPT', 'i32', capacity * 3],
      ['LPS', 'f64', capacity],
      ['LPG', 'f64', capacity],
      ['TRI', 'i32', triangles * 3],
      ['TGROUP', 'i32', triangles],
      ['TKEYS', 'i32', tableSize],
      ['TUSED', 'i32', tableSize],
      ['TBUCKET', 'i32', tableSize],
      ['BSTART', 'i32', triangles * 3 + 1],
      ['BCURSOR', 'i32', triangles * 3 + 1],
      ['BENTRY', 'i32', triangles * 3],
      ['EKEY', 'i32', triangles * 3],
      ['ETRI', 'i32', triangles * 3],
      ['TSTAMP', 'i32', triangles],
      ['BESTD', 'f64', input.perSource],
      ['BESTT', 'i32', input.perSource],
      ['BESTS', 'f64', input.perSource],
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
    for (const [name] of plan) x[name].value = offsets.get(name)!;
    const buffer = x.memory.buffer,
      f64 = (name: string, count: number) => new Float64Array(buffer, offsets.get(name)!, count),
      i32 = (name: string, count: number) => new Int32Array(buffer, offsets.get(name)!, count),
      u32 = (name: string, count: number) => new Uint32Array(buffer, offsets.get(name)!, count);
    /** A view on the wasm memory holding a copy of `source`. */
    const copy = <T extends View>(name: string, source: T): ViewOf<T> => {
      const view =
        source instanceof Float64Array
          ? f64(name, source.length)
          : source instanceof Uint32Array
            ? u32(name, source.length)
            : i32(name, source.length);
      view.set(source);
      return view as ViewOf<T>;
    };
    this.views = {
      positions: copy('P', s.positions),
      previous: copy('PREV', s.previous),
      velocity: copy('V', s.velocity),
      inverseMass: copy('W', s.inverseMass),
      contactNormals: copy('NORMAL', s.contactNormals),
      contactDepth: copy('DEPTH', s.contactDepth),
      planeStamp: copy('PSTAMP', s.planeStamp),
      planeVelocity: copy('PVEL', s.planeVelocity),
      edgeLambda: copy('ELAMBDA', s.edgeLambda),
      hingeLambda: copy('HLAMBDA', s.hingeLambda),
      surfaceVelocity: copy('SV', s.surfaceVelocity),
      contactSlack: copy('SLACK', s.contactSlack),
      contactAnchor: copy('ANCHOR', s.contactAnchor),
      planeData: copy('PLANE', s.planeData),
      gradient: copy('GRAD', s.gradient),
    };
    copy('PANEL', input.panels);
    copy('EDGE', input.edges);
    copy('REST', input.restLengths);
    copy('ECOMP', input.edgeCompliance);
    copy('ELIMIT', input.edgeLimit);
    copy('HINGE', input.hinges);
    copy('HREST', input.hingeLengths);
    copy('SUPPORT', input.supports);
    copy('SLEN', input.supportLengths);
    copy('TETHER', input.tethers);
    copy('TLEN', input.tetherLengths);
    copy('TINIT', input.tetherInitial);
    copy('ROOT', input.rootIds);
    copy('MASK', input.collisionMasks);
    copy('EXOFF', input.excludedOffsets);
    copy('EXID', input.excludedIds);
    copy('LAYER', input.layerOffset);
    copy('LOFT', input.loft);
    copy('ELASTIC', input.elastic);
    copy('TRI', input.triangles);
    x.pairSetup(triangles, tableSize);
    this.pairArrays = {
      a: i32('LPA', capacity),
      b: i32('LPB', capacity),
      triangle: i32('LPT', capacity * 3),
      side: f64('LPS', capacity),
      gap: f64('LPG', capacity),
    };
    this.pairs = this.syncPairs(input.pairs);
    this.hot = i32('HOT', edges);
    this.anchors = f64('RANCHOR', input.rootIds.length * 3);
  }
  private readonly anchors: Float64Array;
  private readonly pairArrays: LayerPairs;
  /** The pair views the solver holds after the last syncPairs/rebuildPairs (identity = in sync). */
  pairs: LayerPairs;

  /** Copies the solver's layer pairs in unless they are already the module's (returns views). */
  syncPairs(pairs: LayerPairs): LayerPairs {
    if (this.pairs && pairs.a === this.pairs.a) return this.pairs;
    const count = pairs.a.length,
      out = this.pairViews(count);
    out.a.set(pairs.a);
    out.b.set(pairs.b);
    out.triangle.set(pairs.triangle);
    out.side.set(pairs.side);
    out.gap.set(pairs.gap);
    this.x.pairCount.value = count;
    return (this.pairs = out);
  }
  private pairViews(count: number): LayerPairs {
    const all = this.pairArrays;
    return {
      a: all.a.subarray(0, count),
      b: all.b.subarray(0, count),
      triangle: all.triangle.subarray(0, count * 3),
      side: all.side.subarray(0, count),
      gap: all.gap.subarray(0, count),
    };
  }
  /** ClothSolver.rebuildLayerPairs in WebAssembly; returns the new pair views. */
  rebuildPairs(
    n: number,
    edges: number,
    triangles: number,
    radius: number,
    gapLimit: number,
    perSource: number,
    grow: number,
  ) {
    const count = this.x.rebuildPairs(n, edges, triangles, radius, gapLimit, perSource, grow);
    return (this.pairs = this.pairViews(count));
  }
  layerContact(trust: number, grow: number) {
    this.x.layerContact(trust, grow);
  }
  contact(
    n: number,
    accumulate: boolean,
    base: number,
    neutral: boolean,
    planeRadius: number,
    stamp: number,
    soft: boolean,
    hardElastic: boolean,
    hardMin: number,
    contactAlpha: number,
    hasSurface: boolean,
  ) {
    this.x.contact(
      n,
      +accumulate,
      base,
      +neutral,
      planeRadius,
      planeRadius * planeRadius,
      stamp,
      +soft,
      +hardElastic,
      hardMin,
      contactAlpha,
      +hasSurface,
    );
  }

  /** Gives the instance back to the thread's pool; the views are invalid afterwards. */
  release() {
    if (this.pooled.owner !== this) return;
    this.pooled.owner = undefined;
    this.pooled.busy = false;
  }

  /** Root anchors of this step (ClothSolver.rootAnchors, rootIds order). */
  setRootAnchors(points: Float64Array) {
    this.anchors.set(points);
  }
  /**
   * The strain-limit hot list as the solver holds it: unchanged when it is the view from the
   * last collectHot, copied in otherwise (attach, or a JS step in between).
   */
  syncHot(list: Int32Array) {
    if (list === this.hotList) return;
    this.hot.set(list);
    this.x.hotCount.value = list.length;
  }
  /** collectHotEdges over every edge; returns the hot list view for ClothSolver.hotEdges. */
  collectHot(edges: number) {
    this.x.collectHot(edges);
    return (this.hotList = this.hot.subarray(0, this.x.hotCount.value as number));
  }
  integrate(n: number, gh: number, h: number) {
    this.x.integrate(n, gh, h);
  }
  resetLambdas(edges: number, hinges: number) {
    this.x.resetLambdas(edges, hinges);
  }
  stretch(count: number, inverseH2: number, reverse: boolean, neutral: boolean) {
    this.x.stretch(count, inverseH2, +reverse, +neutral);
  }
  hinge(count: number, alpha: number) {
    this.x.hinge(count, alpha);
  }
  tethers(
    supports: number,
    roots: number,
    count: number,
    max: number,
    neutral: boolean,
    collarCompression: number,
    anchored: boolean,
    beta: number,
    liftFree: boolean,
    alpha: number,
    oneWay: boolean,
  ) {
    this.x.tethers(
      supports,
      roots,
      count,
      max,
      +neutral,
      collarCompression,
      +anchored,
      beta,
      +liftFree,
      alpha,
      +oneWay,
    );
  }
  selfCollide(n: number, cell: number, invCell: number, cell2: number) {
    this.x.selfCollide(n, cell, invCell, cell2);
  }
  limitHot() {
    this.x.limitHot();
  }
  limitAfterContact(n: number, edges: number, passes: number) {
    this.x.limitAfterContact(n, edges, passes);
  }
  velocity(n: number, h: number, mu: number, limit: number, decay: number, stamp: number) {
    return this.x.velocity(n, h, mu, limit, decay, stamp);
  }
}

/** The production factory: a kernel instance per solver from the embedded module. */
export const wasmKernels: KernelFactory = (input) => new SolverKernels(input);
