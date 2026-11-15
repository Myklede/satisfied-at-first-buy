// Splittable seams for the interactive zip and the detachable hood (agent Z).
//
// The shell (services/body/body_service/garment/shell.py) is one closed, welded mesh: the
// centre-front (CF) zip line and the hood's attachment line are ordinary shared vertices. To
// open the zip or take the hood off, this module builds a *split copy* of the cloth asset:
//  - every CF vertex is duplicated; triangles on the wearer's right of the CF (x < 0) use the
//    duplicate, the wearer's left keeps the original (shell.py PANEL_FRONT_L = 0 is +X);
//  - every vertex the hood (panel 7) shares with the body is duplicated for the hood triangles.
// The pairs (original, duplicate) are the zip teeth: closed pairs are welded by the
// interaction driver (weld.ts), open pairs are free cloth edges.
//
// Asset contract used (prototype, client side, until L2 exposes it; docs/requests/Z-to-L2.md):
//  - panel ids from shell.py: 0 front L (+X), 1 front R, 2 back, 3 yoke, 6 collar, 7 hood;
//  - the CF line = front/yoke/collar vertices at x = 0 on the front (shell.py's CF column),
//    one connected vertex chain from the collar top to the hem;
//  - the hood is attached wherever its triangles share a vertex with another panel.
// The original asset is never modified; the closed jacket is always the original solver.
import type { ClothAsset } from '../cloth/ClothSolver';

export const PANEL = { frontL: 0, frontR: 1, back: 2, yoke: 3, collar: 6, hood: 7 } as const;

/** |x| (m) within which a front vertex is on the CF line (numerical; see findCentreFront). */
const CF_TOLERANCE_M = 0.002;

/** Per-vertex arrays of the cloth asset (element stride = length / vertex count). */
const PER_VERTEX = [
  'rest',
  'initial',
  'panels',
  'elastic',
  'stitch',
  'loft',
  'render_uv',
  'quilt',
  'stitch_distance_m',
  'puff_frames',
  'puff_components',
  'render_offsets',
  'render_material_v',
] as const;

/** A line of teeth: pair k joins `a[k]` (kept side) and `b[k]` (duplicate); `arc` from its start. */
export interface ZipLine {
  a: Int32Array;
  b: Int32Array;
  /** Arc length (m, on the asset's `initial` shape) of pair k from the line's start. */
  arc: Float64Array;
  /** Total arc length (m). */
  length: number;
}

export interface SeamSplit {
  asset: ClothAsset;
  /** Vertex count of the original asset; split vertices n.. are duplicates. */
  sourceCount: number;
  /** For every vertex of the split asset, the original vertex it copies (identity below n). */
  source: Int32Array;
  /** Centre-front zip, ordered from the collar top (arc 0) down to the hem. */
  zip: ZipLine;
  /** Hood attachment (detachable hoods only), ordered round the neck from the wearer's right. */
  hood?: ZipLine;
  /** Tethers dropped because they cross an opened seam (count, for diagnostics). */
  droppedTethers: number;
}

/** Undirected edge set of a triangle list, as "a:b" keys (a < b). */
function edgeKeys(triangles: ArrayLike<number>) {
  const keys = new Set<string>();
  for (let t = 0; t + 2 < triangles.length; t += 3)
    for (let c = 0; c < 3; c++) {
      const a = triangles[t + c],
        b = triangles[t + ((c + 1) % 3)];
      keys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  return keys;
}

/**
 * Centre-front vertex chain, top (collar) first. Throws when the asset has no single connected
 * CF chain (the interaction is then unavailable, never faked).
 */
export function findCentreFront(asset: ClothAsset): number[] {
  const given = asset.paths?.center_front;
  if (given?.length >= 3) return checkedChain(asset, given);
  const n = asset.panels.length,
    p = asset.initial,
    front = new Set<number>([PANEL.frontL, PANEL.frontR, PANEL.yoke, PANEL.collar]);
  // Front half: in front of the mid-depth between the front and back panels.
  let zf = 0,
    cf = 0,
    zb = 0,
    cb = 0;
  for (let i = 0; i < n; i++) {
    if (asset.panels[i] === PANEL.frontL || asset.panels[i] === PANEL.frontR) {
      zf += p[i * 3 + 2];
      cf++;
    } else if (asset.panels[i] === PANEL.back) {
      zb += p[i * 3 + 2];
      cb++;
    }
  }
  if (!cf || !cb) throw new Error('No front/back panels: the zip line cannot be found');
  const zMid = (zf / cf + zb / cb) / 2;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!front.has(asset.panels[i]) || p[i * 3 + 2] <= zMid) continue;
    // The shell is built symmetric about x = 0 with its CF grid column on it (shell.py: column
    // n/4, render_uv u = 0 there on the torso). Measured on the P2 fixtures the CF column lies
    // within 0.1 mm of x = 0 while its neighbours are ≥ 1 cm away; render_uv alone is not
    // enough (the attached-hood parka's collar carries u = 0 on every collar vertex).
    const onLine = Math.abs(p[i * 3]) < CF_TOLERANCE_M;
    if (onLine) ids.push(i);
  }
  if (ids.length < 3) throw new Error('No centre-front zip line in this jacket');
  // Walk the mesh edges from the highest candidate (collar top) down to the lowest (hem),
  // always to the lowest unvisited candidate neighbour. Candidates off that walk (a vertex of
  // another construction that happens to sit on x = 0) are left out; a walk that does not reach
  // the hem means there is no single zip line.
  const set = new Set(ids),
    edges = edgeKeys(asset.triangles),
    linked = new Map<number, number[]>(ids.map((i) => [i, []]));
  for (const key of edges) {
    const [a, b] = key.split(':').map(Number);
    if (set.has(a) && set.has(b)) {
      linked.get(a)!.push(b);
      linked.get(b)!.push(a);
    }
  }
  const y = (i: number) => p[i * 3 + 1];
  let top = ids[0],
    bottom = ids[0];
  for (const i of ids) {
    if (y(i) > y(top)) top = i;
    if (y(i) < y(bottom)) bottom = i;
  }
  const chain = [top],
    seen = new Set([top]);
  for (let at = top; at !== bottom; ) {
    let next = -1;
    for (const j of linked.get(at)!) if (!seen.has(j) && (next < 0 || y(j) < y(next))) next = j;
    if (next < 0)
      throw new Error(`Centre-front line is not one connected chain (stops at ${chain.length})`);
    chain.push(next);
    seen.add(next);
    at = next;
  }
  return chain;
}

/**
 * A path from the asset (L2's contract: shell.py paths.center_front, collar top → hem), checked to
 * be one connected edge chain; returned top first.
 */
function checkedChain(asset: ClothAsset, path: readonly number[]) {
  const ids = path.length > 1 && path[0] === path[path.length - 1] ? path.slice(0, -1) : [...path];
  const edges = edgeKeys(asset.triangles),
    p = asset.initial;
  for (let k = 1; k < ids.length; k++) {
    const a = Math.min(ids[k - 1], ids[k]),
      b = Math.max(ids[k - 1], ids[k]);
    if (!edges.has(`${a}:${b}`))
      throw new Error(`Centre-front path is not one connected chain (break at ${k})`);
  }
  if (p[ids[0] * 3 + 1] < p[ids[ids.length - 1] * 3 + 1]) ids.reverse();
  return ids;
}

/** Vertices the hood triangles share with other panels, ordered round the neck from x < 0. */
export function findHoodLine(asset: ClothAsset): number[] {
  // L2's contract (shell.py paths.hood_zip): the row the removable hood is joined along.
  const given = asset.paths?.hood_zip;
  if (given?.length >= 3)
    return given.length > 1 && given[0] === given[given.length - 1]
      ? given.slice(0, -1)
      : [...given];
  const P = asset.panels,
    t = asset.triangles,
    line = new Set<number>();
  for (let k = 0; k + 2 < t.length; k += 3) {
    const tri = [t[k], t[k + 1], t[k + 2]];
    if (!tri.some((i) => P[i] === PANEL.hood)) continue;
    for (const i of tri) if (P[i] !== PANEL.hood) line.add(i);
  }
  const ids = [...line];
  if (ids.length < 3) return [];
  const p = asset.initial;
  let cx = 0,
    cz = 0;
  for (const i of ids) {
    cx += p[i * 3];
    cz += p[i * 3 + 2];
  }
  cx /= ids.length;
  cz /= ids.length;
  // Angle round the neck measured from the back (-Z): the U-shaped line opens to the front, so
  // its two ends sit near ±π and the order runs wearer's right (x < 0) → back → left.
  const angle = (i: number) => Math.atan2(p[i * 3] - cx, -(p[i * 3 + 2] - cz));
  ids.sort((i, j) => angle(i) - angle(j));
  return ids;
}

function arcAlong(ids: readonly number[], p: ArrayLike<number>) {
  const arc = new Float64Array(ids.length);
  for (let k = 1; k < ids.length; k++) {
    const a = ids[k - 1] * 3,
      b = ids[k] * 3;
    arc[k] = arc[k - 1] + Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
  }
  return arc;
}

/**
 * Builds the split asset. `hood`: also detach the hood (only for hoods that are not sewn in;
 * the caller decides from the product: render_details.hood_kind 2 = removable).
 */
export function splitSeams(asset: ClothAsset, options: { hood: boolean }): SeamSplit {
  const n = asset.panels.length,
    p = asset.initial,
    cf = findCentreFront(asset),
    hoodLine = options.hood ? findHoodLine(asset) : [];
  if (options.hood && !hoodLine.length) throw new Error('This jacket has no detachable hood');
  const cfSet = new Set(cf),
    hoodSet = new Set(hoodLine);
  for (const i of cf)
    if (hoodSet.has(i)) throw new Error('Hood attachment touches the zip line (unsupported)');
  if (asset.welds.length) throw new Error('Welded assets are not supported by the zip split');
  const dup = new Map<number, number>(),
    hoodDup = new Map<number, number>();
  let next = n;
  for (const i of cf) dup.set(i, next++);
  for (const i of hoodLine) hoodDup.set(i, next++);
  const m = next,
    source = new Int32Array(m);
  for (let i = 0; i < n; i++) source[i] = i;
  for (const [i, d] of dup) source[d] = i;
  for (const [i, d] of hoodDup) source[d] = i;

  // Triangles: wearer's-right triangles at the CF take the duplicates; hood triangles take the
  // hood duplicates. The side of a CF triangle is the sign of x of its non-CF corners.
  const tri = Int32Array.from(asset.triangles);
  for (let k = 0; k + 2 < tri.length; k += 3) {
    const corners = [tri[k], tri[k + 1], tri[k + 2]];
    // A hood triangle: its corners off the attachment line are hood (works whether the line
    // itself is labelled hood or collar).
    const rest = corners.filter((i) => !hoodSet.has(i));
    if (rest.length && rest.every((i) => asset.panels[i] === PANEL.hood)) {
      for (let c = 0; c < 3; c++) {
        const d = hoodDup.get(corners[c]);
        if (d !== undefined) tri[k + c] = d;
      }
      continue;
    }
    if (!corners.some((i) => cfSet.has(i))) continue;
    let x = 0;
    for (const i of corners) if (!cfSet.has(i)) x += p[i * 3];
    if (x >= 0) continue;
    for (let c = 0; c < 3; c++) {
      const d = dup.get(corners[c]);
      if (d !== undefined) tri[k + c] = d;
    }
  }

  // Per-vertex arrays: duplicates copy their source's values.
  const out: Record<string, unknown> = { ...asset };
  for (const key of PER_VERTEX) {
    const values = asset[key] as ArrayLike<number> | undefined;
    if (!values || !values.length) continue;
    const stride = values.length / n;
    if (!Number.isInteger(stride)) throw new Error(`Asset array ${key} is not per-vertex`);
    const copy = new Array<number>(m * stride);
    for (let i = 0; i < values.length; i++) copy[i] = values[i];
    for (let i = n; i < m; i++)
      for (let s = 0; s < stride; s++) copy[i * stride + s] = values[source[i] * stride + s];
    out[key] = copy;
  }
  out.triangles = Array.from(tri);
  // The hood side of its attachment belongs to the hood piece (solver panel masks, the hood's
  // layer offset and region filters); rendering keeps the source's look attributes.
  const panels = out.panels as number[];
  for (const d of hoodDup.values()) panels[d] = PANEL.hood;
  // The body side of the hood's zip belongs to the collar once split (the line may be labelled hood).
  for (const i of hoodDup.keys()) if (panels[i] === PANEL.hood) panels[i] = PANEL.collar;

  // Tethers (one-way long-range attachments, root → particle). A tether crossing the opened CF
  // would hold the fronts together, and a hood tether would hold a detached hood: both are
  // dropped. A tether "crosses" the CF when its straight root→particle segment passes x = 0 in
  // front of the body (z above the front/back mid-depth). Tethers to a CF vertex from the right
  // side are re-targeted to its duplicate.
  let zf = 0,
    cfz = 0,
    zb = 0,
    cbz = 0;
  for (let i = 0; i < n; i++)
    if (asset.panels[i] === PANEL.frontL || asset.panels[i] === PANEL.frontR) {
      zf += p[i * 3 + 2];
      cfz++;
    } else if (asset.panels[i] === PANEL.back) {
      zb += p[i * 3 + 2];
      cbz++;
    }
  const zMid = (zf / cfz + zb / cbz) / 2;
  const tethers: number[] = [],
    lengths: number[] = [];
  const srcT = asset.tethers ?? [],
    srcL = asset.tether_lengths ?? [];
  let dropped = 0;
  const side = (i: number) => (Math.abs(p[i * 3]) < 1e-6 ? 0 : Math.sign(p[i * 3]));
  for (let e = 0; e + 1 < srcT.length; e += 2) {
    let root = srcT[e],
      child = srcT[e + 1];
    if (options.hood && (asset.panels[child] === PANEL.hood || asset.panels[root] === PANEL.hood)) {
      dropped++;
      continue;
    }
    const sr = side(root),
      sc = side(child);
    if (sr * sc < 0) {
      const ra = root * 3,
        ca = child * 3,
        t = p[ra] / (p[ra] - p[ca]),
        z = p[ra + 2] + (p[ca + 2] - p[ra + 2]) * t;
      if (z > zMid) {
        dropped++;
        continue;
      }
    }
    // A CF endpoint belongs to the side of the other endpoint.
    if (cfSet.has(child) && sr < 0) child = dup.get(child)!;
    if (cfSet.has(root) && sc < 0) root = dup.get(root)!;
    tethers.push(root, child);
    lengths.push(srcL[e / 2]);
  }
  out.tethers = tethers;
  out.tether_lengths = lengths;
  // Closed rings and the neck chords cross the CF: an open jacket has no closed neckline, chest
  // or hem ring (and those rings are the tape's measured perimeters, not material constraints of
  // an open garment).
  const paths = { ...asset.paths };
  for (const key of ['neckline', 'chest', 'hem']) delete paths[key];
  out.paths = paths;
  out.neck_collider = null;
  out.key = `${asset.key}|split${options.hood ? '+hood' : ''}`;

  const zip: ZipLine = {
    a: Int32Array.from(cf),
    b: Int32Array.from(cf, (i) => dup.get(i)!),
    arc: arcAlong(cf, p),
    length: 0,
  };
  zip.length = zip.arc[zip.arc.length - 1];
  let hood: ZipLine | undefined;
  if (hoodLine.length) {
    hood = {
      a: Int32Array.from(hoodLine),
      b: Int32Array.from(hoodLine, (i) => hoodDup.get(i)!),
      arc: arcAlong(hoodLine, p),
      length: 0,
    };
    hood.length = hood.arc[hood.arc.length - 1];
  }
  return {
    asset: out as unknown as ClothAsset,
    sourceCount: n,
    source,
    zip,
    hood,
    droppedTethers: dropped,
  };
}

/** Split-asset positions from original-asset positions (duplicates take their source's). */
export function expandPositions(
  split: Pick<SeamSplit, 'source'>,
  positions: ArrayLike<number>,
  out = new Float64Array(split.source.length * 3),
) {
  const s = split.source;
  for (let i = 0; i < s.length; i++) {
    const k = s[i] * 3;
    out[i * 3] = positions[k];
    out[i * 3 + 1] = positions[k + 1];
    out[i * 3 + 2] = positions[k + 2];
  }
  return out;
}
