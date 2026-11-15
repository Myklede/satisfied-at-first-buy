// F4T (?f4tex=1, default OFF): the real jackets' fabric on the AR jacket. The kiosk shell is
// procedural (garmentShader: one product colour, drawn relief, drawn logos); with this flag its
// colour comes from the user's own flat-lay photos of the two jackets, laid over the SAME material
// charts the relief is drawn in, so every photographed stitch line sits in its drawn valley:
// - torso front / back: lateral = arc from the centre line in units of the row pitch (the photo's
//   own scale, so a logo keeps its true size whatever the shell's girth), depth = quilting row
//   coordinate (−1 at the shoulder point line, 0 at the yoke stitch, k at the k-th stitch);
// - sleeves: one photographed sleeve half, mirrored about the outer line, rows likewise.
// The photos are the user's (local only, gitignored): scripts/f4t-textures.py builds the chart
// textures from them into apps/web/public/local-textures/<style>/ (never committed). With the flag
// on and no such files, or before they have loaded, the jacket is drawn exactly as without the
// flag (the sampled coverage is 0). Shader: no new vertex attribute (the shell already uses
// WebGL's 16), only uniforms and three samplers, read from the shell's existing varyings.
// COLOUR: by default the product colour stays (the look's exposure, white balance and camera
// adaptation, F4X, are calibrated on it against the real jackets filmed at the venue) and the
// photos give only the detail round it. The photos' own paper-referenced chroma is an opt-in:
//   ?f4tchroma=K  0..1 (default 0): how far the shell's chroma moves to the flat-lay measurement.
//                 Measured on look jobs (jacket / trousers chroma in the same frame, still pose):
//                 at K = 1 the puffer reads r/g 1.35, b/g 0.68 against the real one's 1.10-1.15,
//                 0.80-0.84 at the venue (K = 0: 1.32, 0.76), the parka b/g 0.96 against 1.05
//                 (K = 0: 0.98-1.01): the flat-lay chroma is further from the venue camera's
//                 picture of the real jackets than the calibrated look, so it is not the default.
//   ?f4tdebug=1  logs the shown asset's chart numbers once (console.error -> render service
//                result.json `errors`): the shape check's model side.
//   ?f4tdebug=2  (with f4tex=1) paints every BACK-facing shell fragment magenta: shows where a
//                layer draws the inside of the jacket (its lining shade: 0.38 x the colour, no
//                key light), e.g. a sleeve seen from inside. Diagnosis only.
import {
  ClampToEdgeWrapping,
  DataTexture,
  ImageBitmapLoader,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  Vector3,
  Vector4,
  type MeshPhysicalMaterial,
  type WebGLRenderer,
} from 'three';
import type { ClothAsset } from '../../../api';
import type { Finish } from '../../garmentLook';
import { PANEL } from '../../garmentSurface';

export type F4tFlags = { tex: boolean; debug: boolean; faces: boolean; chroma: number };

const pageSearch = () =>
  typeof location !== 'undefined' && location?.search ? location.search : '';

/** The F4T flags from a query string (default: the page's own; none outside a browser). */
export function readF4tFlags(search?: string): F4tFlags {
  const p = new URLSearchParams(search ?? pageSearch());
  const k = Number(p.get('f4tchroma') ?? 0);
  return {
    tex: p.get('f4tex') === '1',
    debug: p.get('f4tdebug') === '1',
    faces: p.get('f4tdebug') === '2',
    chroma: Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0,
  };
}

/** Where the dev server serves the local texture sets (apps/web/public, gitignored). */
export const F4T_BASE = '/local-textures';
/** The texture set of a shell finish: the two demo jackets, one per finish. */
export const F4T_SET: Record<Finish, string> = {
  satin_matte: 'FB7675-100',
  glossy_ripstop: 'DQ4920-206',
};
/** The photo fades out over this last part of the way to a chart's lateral edge (seam / fold). */
export const F4T_EDGE_FADE = 0.1;
/**
 * A chart's last partial chamber (above the hem / cuff) is stretched to the photo's only when
 * both are at least this fraction of a pitch: a thinner sliver counts as no chamber.
 */
export const F4T_MIN_TAIL = 0.25;

/** One chart texture of a set (meta.json, written by scripts/f4t-textures.py). */
export type F4tChartMeta = {
  file: string;
  /**
   * Stitch rows in the photo chart (row 0 … rows − 1). The texture's v spans the row coordinate
   * −1 … rows: the cell above the first stitch, rows − 1 full chambers, and the last cell from
   * the last stitch to the hem (cuff), each one unit of v × (rows + 1).
   */
  rows: number;
  /** The full chamber (0 … rows − 2) that is repeated, or dropped from, when the counts differ. */
  tile: number;
  /**
   * Height of the photo's cell above its first stitch, in pitches. That cell is shown unsqueezed:
   * the shell's own first cell takes as much of it as it is high (in pitches), from the stitch up.
   */
  top: number;
  /**
   * Torso charts: the chart's half width (centre line to the texture's edge) in pitches: the
   * photo is laid at its own scale. Sleeve chart: unused (it spans outer line to underarm line).
   */
  half: number;
};
export type F4tMeta = {
  version: 1;
  style: string;
  /**
   * The fabric's chroma against the white sheet in the calibration photo, linear sRGB: [r/g, b/g].
   * (Its luminance is not taken from the photo: a satin or glossy shell under ceiling lights
   * reads brighter than its diffuse albedo, the white parka brighter than the paper itself.)
   */
  chroma: [number, number];
  front?: F4tChartMeta;
  back?: F4tChartMeta;
  sleeve?: F4tChartMeta;
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates a fetched meta.json (unknown input): null unless every used field is sane. */
export function parseF4tMeta(raw: unknown): F4tMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.style !== 'string' || !/^[A-Za-z0-9-]{1,24}$/.test(r.style))
    return null;
  const chroma = r.chroma;
  if (
    !Array.isArray(chroma) ||
    chroma.length !== 2 ||
    !chroma.every((v) => finite(v) && v > 0.5 && v < 2)
  )
    return null;
  const chart = (v: unknown): F4tChartMeta | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const c = v as Record<string, unknown>;
    if (typeof c.file !== 'string' || !/^[a-z0-9-]{1,32}\.(png|webp|jpg)$/.test(c.file))
      return undefined;
    const rows = c.rows,
      tile = c.tile;
    if (!finite(rows) || !Number.isInteger(rows) || rows < 2 || rows > 40) return undefined;
    if (!finite(tile) || !Number.isInteger(tile) || tile < 0 || tile > rows - 2) return undefined;
    if (!finite(c.top) || c.top < 0.05 || c.top > 4) return undefined;
    const half = c.half === undefined ? 1 : c.half;
    if (!finite(half) || half < 0.2 || half > 20) return undefined;
    return { file: c.file, rows, tile, top: c.top, half };
  };
  return {
    version: 1,
    style: r.style,
    chroma: chroma as [number, number],
    front: chart(r.front),
    back: chart(r.back),
    sleeve: chart(r.sleeve),
  };
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** The chart numbers of a shown asset that the shader needs (metres; pure). */
export type F4tCharts = {
  /** Torso quilting: depth of the yoke stitch below the shoulder point line, row pitch. */
  yokeM: number;
  pitchM: number;
  /** Torso hem depth and its row coordinate. */
  hemM: number;
  sHem: number;
  /** Fallback half widths (centre line to side seam) for rows without a side seam (the yoke). */
  halfFrontM: number;
  halfBackM: number;
  /**
   * Sleeves, along the material arc (which starts above the armhole: `sleeveStartM` at the first
   * sleeve row): the first stitch at or below the armhole, the pitch, the arc at the cuff and
   * the cuff's row coordinate (0 = that first stitch).
   */
  sleeveStartM: number;
  sleeveYokeM: number;
  sleevePitchM: number;
  sleeveLenM: number;
  sSleeveEnd: number;
  /** Sleeve half circumference (outer line to underarm) at the armhole and at the cuff. */
  sleeveHalf0M: number;
  sleeveHalf1M: number;
};

/**
 * Reads the charts of `asset` from its material uv, quilting parameters and the shell's seam-free
 * arcs (`arc`: the geometry's _g_arc, garmentSurface.garmentCoordinates). Null when the asset has
 * no quilting rows to align a photo to.
 */
export function f4tCharts(asset: ClothAsset, arc: ArrayLike<number>): F4tCharts | null {
  const n = asset.panels.length,
    uv = asset.render_uv ?? [],
    quilt = asset.quilt ?? [],
    mv = asset.render_material_v ?? [];
  if (uv.length !== n * 2 || quilt.length !== n * 4 || arc.length !== n * 4) return null;
  const yoke: number[] = [],
    pitch: number[] = [],
    halfF: number[] = [],
    halfB: number[] = [],
    sYoke: number[] = [],
    sPitch: number[] = [];
  let hem = 0,
    sleeveLen = 0,
    sleeveStart = Infinity;
  const along = (i: number) => (mv[i] > 0 ? mv[i] : uv[i * 2 + 1]);
  for (let i = 0; i < n; i++) {
    const p = asset.panels[i],
      kind = quilt[i * 4 + 3],
      quilted = Math.abs(kind - Math.round(kind)) < 0.02 && kind > 0.5;
    if (p <= PANEL.yoke) {
      hem = Math.max(hem, uv[i * 2 + 1]);
      if (quilted && p <= PANEL.back) {
        pitch.push(quilt[i * 4 + 1]);
        yoke.push(quilt[i * 4 + 2]);
      }
    } else if (p === PANEL.sleeveL || p === PANEL.sleeveR) {
      // Dropped-shoulder caps are drawn in the body's chart (arc.w = 1): not sleeve rows.
      if (arc[i * 4 + 3] > 0.5) continue;
      sleeveLen = Math.max(sleeveLen, along(i));
      sleeveStart = Math.min(sleeveStart, along(i));
      if (quilted) {
        sPitch.push(quilt[i * 4 + 1]);
        sYoke.push(quilt[i * 4 + 2]);
      }
    }
  }
  const pitchM = median(pitch),
    yokeM = median(yoke);
  if (!(pitchM > 0.01) || !(yokeM > 0.005) || !(hem > yokeM)) return null;
  const sleevePitchM = median(sPitch);
  if (!Number.isFinite(sleeveStart)) sleeveStart = 0;
  // The drawn sleeve stitches sit at quilt.z + k × pitch of the material arc: the first one at or
  // below the armhole is row 0 of the sleeve chart.
  const sleeveZero = median(sYoke);
  const sleeveYokeM =
    sleevePitchM > 0.01
      ? sleeveZero + Math.ceil((sleeveStart - sleeveZero) / sleevePitchM - 1e-6) * sleevePitchM
      : 0;
  // Half widths of the upper chest (the rows just below the yoke stitch): what the yoke rows,
  // which have no side seam of their own, are drawn with.
  for (let i = 0; i < n; i++) {
    if (asset.panels[i] > PANEL.yoke || uv[i * 2 + 1] > yokeM + 1.5 * pitchM) continue;
    if (arc[i * 4 + 2] > 0 && arc[i * 4 + 3] > 0) {
      halfF.push(arc[i * 4 + 2]);
      halfB.push(arc[i * 4 + 3]);
    }
  }
  // Sleeve half circumference near the armhole and near the cuff: the largest arc from the outer
  // line among the vertices of the first / last 15 % of the sleeve's material length.
  let half0 = 0,
    half1 = 0;
  for (let i = 0; i < n; i++) {
    const p = asset.panels[i];
    if ((p !== PANEL.sleeveL && p !== PANEL.sleeveR) || arc[i * 4 + 3] > 0.5) continue;
    const t = sleeveLen > sleeveStart ? (along(i) - sleeveStart) / (sleeveLen - sleeveStart) : 0;
    if (t < 0.15) half0 = Math.max(half0, arc[i * 4]);
    else if (t > 0.85) half1 = Math.max(half1, arc[i * 4]);
  }
  return {
    yokeM,
    pitchM,
    hemM: hem,
    sHem: (hem - yokeM) / pitchM,
    halfFrontM: median(halfF),
    halfBackM: median(halfB),
    sleeveStartM: sleeveStart,
    sleeveYokeM,
    sleevePitchM,
    sleeveLenM: sleeveLen,
    sSleeveEnd: sleevePitchM > 0.01 ? (sleeveLen - sleeveYokeM) / sleevePitchM : 0,
    sleeveHalf0M: half0,
    sleeveHalf1M: half1,
  };
}

/** How a model chart's rows take a photo chart's (the shader's gF4tRow* uniform, as numbers). */
export type F4tRowMap = {
  /** The photo chamber repeated (model has more) or dropped from (model has fewer). */
  tile: number;
  /** Model stitch rows minus photo stitch rows. */
  extra: number;
  /** The model's last stitch row (its hem / cuff cell starts here). */
  last: number;
  /** 1 / (model end row − last): the model's last cell onto the photo's last cell. */
  tailInv: number;
};

/**
 * Row alignment of a model chart ending at row coordinate `sModel` (hem or cuff) with a photo
 * chart of `rows` stitches: the cell above the first stitch and the last cell (last stitch to the
 * edge) map onto the photo's own; full chambers map one to one from the top down to `tile`, where
 * the photo's chamber `tile` is repeated when the model has more chambers, or photo chambers are
 * skipped when it has fewer, and one to one again below. Every stitch lands on a stitch. A sliver
 * thinner than F4T_MIN_TAIL of a pitch above the model's edge counts as no chamber.
 */
export function f4tRowMap(sModel: number, chart: Pick<F4tChartMeta, 'rows' | 'tile'>): F4tRowMap {
  const stitches = Math.max(1, Math.floor(sModel - F4T_MIN_TAIL) + 1);
  const last = stitches - 1;
  return {
    tile: chart.tile,
    extra: stitches - chart.rows,
    last,
    tailInv: 1 / Math.max(sModel - last, F4T_MIN_TAIL),
  };
}

/** The row coordinate of depth `v` (m) in a chart with its first stitch at `yoke` and `pitch`. */
export function f4tRow(v: number, yoke: number, pitch: number) {
  return v < yoke ? v / yoke - 1 : (v - yoke) / pitch;
}

/** Photo row coordinate of model row `s` under a row map (mirrors the shader's gF4tRowOf). */
export function f4tPhotoRow(s: number, map: F4tRowMap) {
  const rows = map.last + 1 - map.extra;
  if (s < 0) return s;
  if (s >= map.last) return rows - 1 + Math.min((s - map.last) * map.tailInv, 1);
  const c = Math.floor(s);
  const chamber = c < map.tile ? c : Math.max(map.tile, c - map.extra);
  return Math.min(chamber, Math.max(rows - 2, 0)) + (s - c);
}

export type F4tUniforms = {
  gF4tOn: { value: Vector3 };
  gF4tFaces: { value: number };
  gF4tAlbedo: { value: Vector3 };
  gF4tFront: { value: Texture };
  gF4tBack: { value: Texture };
  gF4tSleeve: { value: Texture };
  gF4tQ: { value: Vector4 };
  gF4tRowF: { value: Vector4 };
  gF4tRowB: { value: Vector4 };
  gF4tRowS: { value: Vector4 };
  gF4tHalf: { value: Vector4 };
  gF4tEdge: { value: Vector3 };
  gF4tTop: { value: Vector3 };
  gF4tLat: { value: Vector3 };
};

const fragmentDeclaration = /* glsl */ `
uniform vec3 gF4tOn; uniform float gF4tFaces; uniform vec3 gF4tAlbedo; uniform sampler2D gF4tFront; uniform sampler2D gF4tBack; uniform sampler2D gF4tSleeve;
uniform vec4 gF4tQ; uniform vec4 gF4tRowF; uniform vec4 gF4tRowB; uniform vec4 gF4tRowS;
uniform vec4 gF4tHalf; uniform vec3 gF4tEdge; uniform vec3 gF4tTop; uniform vec3 gF4tLat;
// Model row coordinate -> the photo chart's v (f4tex.ts f4tPhotoRow; m = tile, extra, last, tailInv).
float gF4tRowOf(float s, vec4 m) {
  float rows = m.z + 1. - m.y, sp;
  if (s < 0.) sp = s;
  else if (s >= m.z) sp = rows - 1. + min((s - m.z) * m.w, 1.);
  else {
    float c = floor(s);
    sp = min(c < m.x ? c : max(m.x, c - m.y), max(rows - 2., 0.)) + (s - c);
  }
  return (sp + 1.) / (rows + 1.);
}
float gF4tInv(vec4 m) { return 1. / (m.z + 2. - m.y); }
`;

/**
 * Runs after the shell's own colour (garmentShader garmentColour + decals), before the lighting:
 * where a photo covers the surface it IS the albedo (its stitch thread, zip tape, pocket zips and
 * logos replace the drawn ones); elsewhere the drawn shell stays. Outside faces only.
 * All three charts are sampled outside any branch on varyings (defined derivatives).
 */
const fragmentColour = /* glsl */ `
{
  float p = gPanelV;
  // Dropped-shoulder cap rows carry arc = (1, 0, -1, 1) and are drawn as yoke: no chart of ours.
  bool cap = gArcV.z < 0. && gArcV.w > .5;
  bool torso = p < 3.5 && !cap, sleeve = p > 3.5 && p < 5.5;
  float V = gUvV.y;
  // Row coordinate: pitches below the first stitch; above it, pitches up as a fraction of the
  // photo's own top cell (gF4tTop), never squeezed.
  bool inYoke = V < gF4tQ.x;
  float rowsT = (V - gF4tQ.x) / gF4tQ.y;
  float sFr = inYoke ? max(rowsT / gF4tTop.x, -1.) : rowsT;
  float sBk = inYoke ? max(rowsT / gF4tTop.y, -1.) : rowsT;
  // Half widths: this row's own arc to the side seam; rows without one (the yoke: -1) and the
  // triangles between the two kinds, whose interpolated arc is meaningless, take the upper
  // chest's (gF4tHalf).
  bool sided = gArcV.z > .6 * gF4tHalf.x;
  float halfF = sided ? gArcV.z : gF4tHalf.x;
  float halfB = sided && gArcV.w > .6 * gF4tHalf.y ? gArcV.w : gF4tHalf.y;
  bool frontSide = gArcV.x <= halfF;
  // Laterals as the decals take them (garmentDecals.torsoLaterals): linear across the centre
  // lines; in metres over the photo's own half width (gF4tLat = its half width in pitches x this
  // shell's pitch), so the photographed logos keep their size.
  vec2 uvF = vec2(.5 - .5 * gUvV.x / gF4tLat.x, gF4tRowOf(sFr, gF4tRowF));
  vec2 uvB = vec2(.5 + .5 * (gArcV.x + gArcV.y - gUvV.x) / gF4tLat.y, gF4tRowOf(sBk, gF4tRowB));
  // Edge fades on the UNSIGNED arcs (exact on the wrap-seam triangles, whose signed u is
  // garbage): toward the shell's side seam and toward the photo's own edge.
  float eF = (1. - smoothstep(1. - gF4tEdge.x, 1., gArcV.x / halfF)) *
             (1. - smoothstep(1. - gF4tEdge.x, 1., gArcV.x / gF4tLat.x));
  float eB = (1. - smoothstep(1. - gF4tEdge.x, 1., gArcV.y / halfB)) *
             (1. - smoothstep(1. - gF4tEdge.x, 1., gArcV.y / gF4tLat.y));
  // Sleeve: material arc from the armhole, mirrored about the outer line.
  float Vs = gArcV.y > 0. ? gArcV.y : V;
  bool sYoke = Vs < gF4tQ.z;
  float rowsS = (Vs - gF4tQ.z) / gF4tQ.w;
  float ss = sYoke ? max(rowsS / gF4tTop.z, -1.) : rowsS;
  float halfS = max(mix(gF4tHalf.z, gF4tHalf.w,
                        clamp((Vs - gF4tEdge.y) / max(gF4tEdge.z - gF4tEdge.y, 1e-3), 0., 1.)), 1e-3);
  vec2 uvS = vec2(gArcV.x / halfS, gF4tRowOf(ss, gF4tRowS));
  // Explicit gradients from the charts' own smooth coordinates: the mip level never spikes where
  // a half width or a row map changes branch.
  vec2 dx = dFdx(gUvV), dy = dFdy(gUvV);
  float rT = 1. / gF4tQ.y;
  float iF = gF4tInv(gF4tRowF) / (inYoke ? gF4tTop.x : 1.), iB = gF4tInv(gF4tRowB) / (inYoke ? gF4tTop.y : 1.);
  vec4 tF = textureGrad(gF4tFront, uvF, vec2(.5 * dx.x / gF4tLat.x, dx.y * rT * iF),
                        vec2(.5 * dy.x / gF4tLat.x, dy.y * rT * iF));
  vec4 tB = textureGrad(gF4tBack, uvB, vec2(.5 * dx.x / gF4tLat.y, dx.y * rT * iB),
                        vec2(.5 * dy.x / gF4tLat.y, dy.y * rT * iB));
  float rS = gF4tInv(gF4tRowS) / (gF4tQ.w * (sYoke ? gF4tTop.z : 1.));
  vec4 tS = textureGrad(gF4tSleeve, uvS, vec2(dFdx(gArcV.x) / halfS, dFdx(Vs) * rS),
                        vec2(dFdy(gArcV.x) / halfS, dFdy(Vs) * rS));
  float seamW = smoothstep(.002, .02, gSeamV);
  float aF = torso && frontSide ? tF.a * eF * gF4tOn.x : 0.;
  float aB = torso && !frontSide ? tB.a * eB * gF4tOn.y : 0.;
  float aS = sleeve ? tS.a * gF4tOn.z : 0.;
  // The textures hold photo / its own low-pass, x 0.5 (headroom): detail round the fabric's albedo.
  // Torso: the photo is the albedo (its logo, zips and pockets replace the drawn ones).
  vec3 photo = 2. * gF4tAlbedo * (aF > 0. ? tF.rgb : tB.rgb);
  float o = gl_FrontFacing ? seamW : 0.;
  diffuseColor.rgb = mix(diffuseColor.rgb, photo, max(aF, aB) * o);
  // Sleeves: the photographed sleeve half carries no lettering and is mirrored, so it only
  // modulates the drawn sleeve (the drawn THERMA-FIT lettering and cuff tab stay).
  diffuseColor.rgb *= mix(vec3(1.), 2. * tS.rgb, aS * o);
  // ?f4tdebug=2: back-facing fragments (the jacket's inside) in magenta.
  if (gF4tFaces > .5 && !gl_FrontFacing) diffuseColor.rgb = vec3(1., 0., 1.);
}
`;

/** A 1×1 transparent texture: what the samplers read until (or unless) a set has loaded. */
function blank(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export function f4tUniforms(): F4tUniforms {
  const none = blank();
  return {
    gF4tOn: { value: new Vector3(0, 0, 0) },
    gF4tFaces: { value: readF4tFlags().faces ? 1 : 0 },
    gF4tAlbedo: { value: new Vector3(1, 1, 1) },
    gF4tFront: { value: none },
    gF4tBack: { value: none },
    gF4tSleeve: { value: none },
    gF4tQ: { value: new Vector4(0.05, 0.1, 0.05, 0.1) },
    gF4tRowF: { value: new Vector4(0, 0, 1, 1) },
    gF4tRowB: { value: new Vector4(0, 0, 1, 1) },
    gF4tRowS: { value: new Vector4(0, 0, 1, 1) },
    gF4tHalf: { value: new Vector4(0.25, 0.25, 0.2, 0.15) },
    gF4tEdge: { value: new Vector3(F4T_EDGE_FADE, 0, 0.5) },
    gF4tTop: { value: new Vector3(1, 1, 1) },
    gF4tLat: { value: new Vector3(0.25, 0.25, 0) },
  };
}

/**
 * Adds the photo charts to the shell `material`'s program (once, before its first compile): the
 * shell's own onBeforeCompile runs first, then ours. The wrapped function's text is the program
 * cache key (three: customProgramCacheKey), so the program is its own, and programWarmup's twins
 * (which copy onBeforeCompile) precompile exactly it.
 */
export function installF4tShader(material: MeshPhysicalMaterial, uniforms: F4tUniforms) {
  const inner = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    inner.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + fragmentDeclaration)
      .replace('#include <alphamap_fragment>', fragmentColour + '\n#include <alphamap_fragment>');
  };
  material.needsUpdate = true;
}

/** Sets the chart uniforms for a shown asset and a loaded set (pure arithmetic on both). */
export function applyF4tCharts(uniforms: F4tUniforms, charts: F4tCharts, meta: F4tMeta) {
  uniforms.gF4tQ.value.set(
    charts.yokeM,
    charts.pitchM,
    charts.sleeveYokeM,
    Math.max(charts.sleevePitchM, 1e-3),
  );
  const row = (sModel: number, chart: F4tChartMeta | undefined, target: Vector4) => {
    if (!chart) return;
    const m = f4tRowMap(sModel, chart);
    target.set(m.tile, m.extra, m.last, m.tailInv);
  };
  row(charts.sHem, meta.front, uniforms.gF4tRowF.value);
  row(charts.sHem, meta.back, uniforms.gF4tRowB.value);
  row(charts.sSleeveEnd, meta.sleeve, uniforms.gF4tRowS.value);
  uniforms.gF4tHalf.value.set(
    Math.max(charts.halfFrontM, 1e-3),
    Math.max(charts.halfBackM, 1e-3),
    charts.sleeveHalf0M,
    charts.sleeveHalf1M,
  );
  uniforms.gF4tEdge.value.set(F4T_EDGE_FADE, charts.sleeveStartM, charts.sleeveLenM);
  uniforms.gF4tTop.value.set(meta.front?.top ?? 1, meta.back?.top ?? 1, meta.sleeve?.top ?? 1);
  uniforms.gF4tLat.value.set(
    Math.max((meta.front?.half ?? 1) * charts.pitchM, 1e-3),
    Math.max((meta.back?.half ?? 1) * charts.pitchM, 1e-3),
    0,
  );
}

/** sRGB hex (#rrggbb) to linear sRGB. */
export function hexToLinear(hex: string): [number, number, number] {
  const c = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [c(0), c(1), c(2)];
}

const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * The shell albedo (linear) to draw with, from the product colour and the photo's paper-referenced
 * chroma: the product colour's luminance (the look's exposure is calibrated on it against the
 * real jackets filmed at the venue) and, at `strength` 1, the measured chroma, counting what the
 * look's camera adaptation (finish/f4.ts cameraAdaptation: per-channel `adaptGain` from the
 * product colour) does to it afterwards, so the measured chroma is what stands after that
 * adaptation. At strength 0 (the default, ?f4tchroma) it is the product colour itself; between,
 * the chroma moves geometrically. Bounded per channel to ±35 % of the product colour: a set
 * further off is broken, not a correction.
 */
export function f4tAlbedo(
  productHex: string,
  chroma: readonly [number, number],
  adaptGain: readonly number[] = [1, 1, 1],
  strength = readF4tFlags().chroma,
): [number, number, number] {
  const base = hexToLinear(productHex);
  if (!(strength > 0)) return base;
  const target = [chroma[0] / adaptGain[0], 1 / adaptGain[1], chroma[1] / adaptGain[2]];
  const raw = target.map((c, i) => Math.pow(c, strength) * Math.pow(base[i], 1 - strength));
  const k = luminance(base) / Math.max(luminance(raw), 1e-4);
  return raw.map((c, i) => Math.min(1.35 * base[i], Math.max(0.65 * base[i], c * k))) as [
    number,
    number,
    number,
  ];
}

type Loaded = { meta: F4tMeta; front?: Texture; back?: Texture; sleeve?: Texture };

/**
 * The local texture sets, fetched once per style: resolves to null when the set is not on this
 * machine (no meta.json, or an invalid one), so the caller keeps the drawn look.
 */
export class F4tSets {
  private readonly sets = new Map<string, Promise<Loaded | null>>();
  private readonly textures: Texture[] = [];
  private disposed = false;

  /**
   * `renderer`: each texture is uploaded as soon as it has loaded (initTexture), while the jacket
   * is still loading and nothing is tracked, so its first drawn frame pays no upload.
   */
  constructor(
    private readonly renderer?: WebGLRenderer,
    private readonly anisotropy = 4,
  ) {}

  load(style: string): Promise<Loaded | null> {
    let set = this.sets.get(style);
    if (!set) {
      set = this.fetchSet(style).catch(() => null);
      this.sets.set(style, set);
    }
    return set;
  }

  private async fetchSet(style: string): Promise<Loaded | null> {
    const base = `${F4T_BASE}/${style}`;
    const response = await fetch(`${base}/meta.json`, { cache: 'no-store' });
    // The dev server answers a missing public file with index.html: only JSON counts.
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return null;
    const meta = parseF4tMeta(await response.json());
    if (!meta || meta.style !== style) return null;
    // Decoded off the main thread (createImageBitmap), unflipped and unpremultiplied: the upload
    // is then a plain copy.
    const loader = new ImageBitmapLoader();
    loader.setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none' });
    const one = async (chart?: F4tChartMeta) => {
      if (!chart) return undefined;
      try {
        const bitmap = await loader.loadAsync(`${base}/${chart.file}`);
        if (this.disposed) {
          bitmap.close();
          return undefined;
        }
        const t = new Texture(bitmap);
        t.colorSpace = SRGBColorSpace;
        t.flipY = false; // row 0 of the image = the chart's top row (v = 0)
        t.wrapS = t.wrapT = ClampToEdgeWrapping;
        t.minFilter = LinearMipmapLinearFilter;
        t.magFilter = LinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = this.anisotropy;
        t.needsUpdate = true;
        this.renderer?.initTexture(t);
        this.textures.push(t);
        return t;
      } catch {
        return undefined; // that chart keeps the drawn look
      }
    };
    const [front, back, sleeve] = await Promise.all([
      one(meta.front),
      one(meta.back),
      one(meta.sleeve),
    ]);
    return { meta, front, back, sleeve };
  }

  dispose() {
    this.disposed = true;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}
