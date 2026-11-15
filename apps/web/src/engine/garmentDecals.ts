import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, Vector4 } from 'three';
import type { ClothAsset } from '../api';
import { PANEL } from './garmentSurface';
import { detailEstimates } from './garmentLook';

/**
 * Logos and lettering on the garment (agent L1a). RENDERING ONLY: decals are drawn into the
 * shell's colour in the material charts (metres), never move the fit surface, and keep their real
 * size on every graded size (embroidery and prints are not graded). Shapes are vector paths drawn
 * by hand from the user's reference photos into one mask atlas; sizes and positions are labelled
 * photo estimates in garmentLook.detailEstimates.
 */

// ------------------------------------------------------------------------------------- shapes

type Pt = readonly [number, number];
type Path2 = { start: Pt; curves: readonly (readonly [Pt, Pt, Pt])[] };

/**
 * Swoosh outline in a 100 x 37.5 box (y down): tail tip at the top right, round heel at the bottom
 * left, hook tip at the upper left. Hand-fitted to the printed back swoosh in the user's photo
 * (Parka7) by overlaying it; aspect 2.67 (box) matches that photo within ~5 %.
 */
export const SWOOSH: Path2 = {
  start: [100, 0],
  curves: [
    [
      [76, 11],
      [44, 26],
      [27, 32],
    ],
    [
      [13, 37.5],
      [0.5, 37],
      [0.5, 28],
    ],
    [
      [0.5, 20],
      [9, 11],
      [17.5, 4],
    ],
    [
      [13, 11],
      [10.5, 21],
      [18, 24.5],
    ],
    [
      [27, 27.5],
      [52, 17],
      [100, 0],
    ],
  ],
};
export const SWOOSH_BOX = [100, 37.5] as const;
/** Drawn width / height of a swoosh: Parka2/Parka7 back print ≈ 2.9 (the path box is squeezed to it). */
export const SWOOSH_ASPECT = 2.9;
// (The atlas swoosh slot below is 2000 x 690 px = SWOOSH_ASPECT.)

/**
 * Letters of the NIKE wordmark (upright, 10 units tall, y down); the logo slants them by
 * WORDMARK_SLANT. Hand-drawn polygons matched to the embroidered chest logo (Parka1/3/4): wide,
 * fairly flat letters with stems 0.21 of the cap height, over a long thin swoosh whose tail runs
 * well past the E.
 */
const WORDMARK: Record<string, { width: number; poly: Pt[] }> = {
  N: {
    width: 8.2,
    poly: [
      [0, 10],
      [0, 0],
      [2.3, 0],
      [6.3, 6.2],
      [6.3, 0],
      [8.2, 0],
      [8.2, 10],
      [6.1, 10],
      [2.1, 3.8],
      [2.1, 10],
    ],
  },
  I: {
    width: 2.1,
    poly: [
      [0, 0],
      [2.1, 0],
      [2.1, 10],
      [0, 10],
    ],
  },
  K: {
    width: 8,
    poly: [
      [0, 10],
      [0, 0],
      [2.1, 0],
      [2.1, 4.2],
      [5.7, 0],
      [8, 0],
      [3.8, 4.7],
      [8, 10],
      [5.7, 10],
      [2.6, 5.8],
      [2.1, 6.5],
      [2.1, 10],
    ],
  },
  E: {
    width: 6.6,
    poly: [
      [0, 10],
      [0, 0],
      [6.6, 0],
      [6.6, 1.8],
      [2.1, 1.8],
      [2.1, 4.1],
      [5.9, 4.1],
      [5.9, 5.9],
      [2.1, 5.9],
      [2.1, 8.2],
      [6.6, 8.2],
      [6.6, 10],
    ],
  },
};
const WORDMARK_SLANT = 0.4;
const WORDMARK_GAP = 0.9;

/**
 * Embroidered "THERMA-FIT" (Parka5): square techno capitals as stroke polylines on a unit cap
 * height (y down), advance in cap heights. Stroke width STROKE cap heights (Parka5 strokes ≈ 0.19 caps).
 */
const LETTERS: Record<string, { advance: number; strokes: Pt[][] }> = {
  T: {
    advance: 0.62,
    strokes: [
      [
        [0, 0],
        [0.62, 0],
      ],
      [
        [0.31, 0],
        [0.31, 1],
      ],
    ],
  },
  H: {
    advance: 0.62,
    strokes: [
      [
        [0, 0],
        [0, 1],
      ],
      [
        [0.62, 0],
        [0.62, 1],
      ],
      [
        [0, 0.52],
        [0.62, 0.52],
      ],
    ],
  },
  E: {
    advance: 0.56,
    strokes: [
      [
        [0.56, 0],
        [0, 0],
        [0, 1],
        [0.56, 1],
      ],
      [
        [0, 0.5],
        [0.48, 0.5],
      ],
    ],
  },
  R: {
    advance: 0.6,
    strokes: [
      [
        [0, 1],
        [0, 0],
        [0.5, 0],
        [0.6, 0.1],
        [0.6, 0.4],
        [0.5, 0.5],
        [0, 0.5],
      ],
      [
        [0.34, 0.5],
        [0.6, 1],
      ],
    ],
  },
  M: {
    advance: 0.74,
    strokes: [
      [
        [0, 1],
        [0, 0],
        [0.37, 0.6],
        [0.74, 0],
        [0.74, 1],
      ],
    ],
  },
  A: {
    advance: 0.66,
    strokes: [
      [
        [0, 1],
        [0.33, 0],
        [0.66, 1],
      ],
      [
        [0.13, 0.64],
        [0.53, 0.64],
      ],
    ],
  },
  '-': {
    advance: 0.42,
    strokes: [
      [
        [0.04, 0.55],
        [0.38, 0.55],
      ],
    ],
  },
  F: {
    advance: 0.54,
    strokes: [
      [
        [0.54, 0],
        [0, 0],
        [0, 1],
      ],
      [
        [0, 0.5],
        [0.44, 0.5],
      ],
    ],
  },
  I: {
    advance: 0.36,
    strokes: [
      [
        [0, 0],
        [0.36, 0],
      ],
      [
        [0.18, 0],
        [0.18, 1],
      ],
      [
        [0, 1],
        [0.36, 1],
      ],
    ],
  },
};
const STROKE = 0.19;
const TRACKING = 0.28;
/** The embroidered face is extended: glyph x is stretched by WIDE (Parka5: line ≈ 11.7 caps long). */
const WIDE = 1.4;

/** Width of `text` in cap heights (pure; unit tested). */
export function letteringWidth(text: string) {
  let w = 0;
  for (const ch of text) {
    const g = LETTERS[ch];
    if (!g) throw new Error(`No glyph for ${ch}`);
    w += g.advance * WIDE + TRACKING;
  }
  return w - TRACKING + STROKE; // half a stroke overhangs at each end
}
export const THERMA_FIT = 'THERMA-FIT';

/** Width / height of the NIKE wordmark-with-swoosh logo box (pure; drawn in the same units). */
export function wordmarkLogoBox() {
  let x = 0;
  for (const ch of 'NIKE') x += WORDMARK[ch].width + WORDMARK_GAP;
  x -= WORDMARK_GAP;
  // Letters 10 tall (+ slant overhang); the swoosh hangs below, starting left of the N.
  const swooshLeft = -5,
    swooshW = 47,
    swooshTop = 6.6,
    swooshH = 8.5;
  const left = Math.min(0, swooshLeft),
    right = Math.max(x + WORDMARK_SLANT * 10, swooshLeft + swooshW);
  return {
    width: right - left,
    height: swooshTop + swooshH,
    left,
    swoosh: [swooshLeft, swooshTop, swooshW, swooshH] as const,
  };
}

// ------------------------------------------------------------------------------------- atlas

/** Atlas layout in canvas pixels (x, y, w, h), y down. */
export const ATLAS = { width: 2048, height: 1024 } as const;
const SLOT = {
  swoosh: [24, 24, 2000, 690],
  wordmark: [24, 800, 700, 200],
  lettering: [760, 860, 1260, 112],
} as const;
type SlotName = keyof typeof SLOT;

/** Atlas rectangle of a slot in texture coordinates (u0, v0, u1, v1; v down, flipY off). */
export function slotRect(name: SlotName): [number, number, number, number] {
  const [x, y, w, h] = SLOT[name];
  return [x / ATLAS.width, y / ATLAS.height, (x + w) / ATLAS.width, (y + h) / ATLAS.height];
}

/** Pixel size of a slot's drawn content (drawn centred in the slot, aspect kept). */
export function slotContent(name: SlotName): [number, number] {
  const [, , w, h] = SLOT[name];
  if (name === 'wordmark') {
    const box = wordmarkLogoBox(),
      s = Math.min(w / box.width, h / box.height);
    return [box.width * s, box.height * s];
  }
  if (name === 'lettering') {
    const cap = Math.min(h / (1 + STROKE), w / letteringWidth(THERMA_FIT));
    return [letteringWidth(THERMA_FIT) * cap, (1 + STROKE) * cap];
  }
  return [w, h];
}

/** Decal box (metres) whose drawn content is `contentWidthM` wide: the whole slot, same scale. */
export function slotBox(name: SlotName, contentWidthM: number) {
  const [, , w, h] = SLOT[name],
    k = contentWidthM / slotContent(name)[0];
  return { width: w * k, height: h * k };
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  p: Path2,
  x: number,
  y: number,
  sx: number,
  sy: number,
) {
  ctx.moveTo(x + p.start[0] * sx, y + p.start[1] * sy);
  for (const [a, b, c] of p.curves)
    ctx.bezierCurveTo(
      x + a[0] * sx,
      y + a[1] * sy,
      x + b[0] * sx,
      y + b[1] * sy,
      x + c[0] * sx,
      y + c[1] * sy,
    );
  ctx.closePath();
}

/** Draw each shape white-on-black into its slot, fitted to the slot keeping its aspect. */
function drawMasks(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  {
    const [x, y, w, h] = SLOT.swoosh;
    ctx.beginPath();
    tracePath(ctx, SWOOSH, x, y, w / SWOOSH_BOX[0], h / SWOOSH_BOX[1]);
    ctx.fill();
  }
  {
    const [x, y, w, h] = SLOT.wordmark;
    const box = wordmarkLogoBox(),
      s = Math.min(w / box.width, h / box.height);
    const [cw, chh] = slotContent('wordmark');
    const ox = x + (w - cw) / 2 - box.left * s;
    const oy = y + (h - chh) / 2;
    let cx = 0;
    ctx.beginPath();
    for (const ch of 'NIKE') {
      const g = WORDMARK[ch];
      g.poly.forEach(([px, py], i) => {
        const X = ox + (cx + px + WORDMARK_SLANT * (10 - py)) * s,
          Y = oy + py * s;
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      ctx.closePath();
      cx += g.width + WORDMARK_GAP;
    }
    ctx.fill();
    const [sl, st, sw, sh] = box.swoosh;
    // Knock-out: the letters stop short of the swoosh's top edge (white gap in the real logo).
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    tracePath(
      ctx,
      SWOOSH,
      ox + sl * s,
      oy + (st - 0.9) * s,
      (sw / SWOOSH_BOX[0]) * s,
      (sh / SWOOSH_BOX[1]) * s,
    );
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    tracePath(
      ctx,
      SWOOSH,
      ox + sl * s,
      oy + st * s,
      (sw / SWOOSH_BOX[0]) * s,
      (sh / SWOOSH_BOX[1]) * s,
    );
    ctx.fill();
  }
  {
    const [x, y, w, h] = SLOT.lettering;
    const cap = Math.min(h / (1 + STROKE), w / letteringWidth(THERMA_FIT));
    ctx.lineWidth = STROKE * cap;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    let cx = x + (w - slotContent('lettering')[0]) / 2 + (STROKE * cap) / 2;
    const top = y + (h - cap) / 2;
    for (const ch of THERMA_FIT) {
      const g = LETTERS[ch];
      for (const stroke of g.strokes) {
        ctx.beginPath();
        stroke.forEach(([px, py], i) =>
          i === 0
            ? ctx.moveTo(cx + px * WIDE * cap, top + py * cap)
            : ctx.lineTo(cx + px * WIDE * cap, top + py * cap),
        );
        ctx.stroke();
      }
      cx += (g.advance * WIDE + TRACKING) * cap;
    }
  }
}

/**
 * Mask atlas: R = shape coverage (crisp, anti-aliased), G = the same shape blurred (~4 mm on the
 * back swoosh), used to shade the thread's relief round embroidery. Mipmapped for the far view.
 */
export function buildDecalAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS.width;
  canvas.height = ATLAS.height;
  const ctx = canvas.getContext('2d')!;
  const sharp = document.createElement('canvas');
  sharp.width = ATLAS.width;
  sharp.height = ATLAS.height;
  const s = sharp.getContext('2d')!;
  s.fillStyle = '#000';
  s.fillRect(0, 0, ATLAS.width, ATLAS.height);
  drawMasks(s);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ATLAS.width, ATLAS.height);
  ctx.filter = 'blur(10px)';
  ctx.drawImage(sharp, 0, 0);
  ctx.filter = 'none';
  // Combine: red from the sharp mask, green from the blurred one.
  const blurred = ctx.getImageData(0, 0, ATLAS.width, ATLAS.height),
    crisp = s.getImageData(0, 0, ATLAS.width, ATLAS.height);
  for (let i = 0; i < crisp.data.length; i += 4) {
    blurred.data[i] = crisp.data[i];
    blurred.data[i + 2] = 0;
    blurred.data[i + 3] = 255;
  }
  ctx.putImageData(blurred, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  texture.name = 'garment-decals';
  return texture;
}

// ---------------------------------------------------------------------------------- placement

/** Region codes in the shader. */
export const REGION = { none: 0, front: 1, back: 2, sleeveL: 3 } as const;
/** Ink modes: black print (plastisol), black embroidery, tonal embroidery (self colour). */
export const INK = { print: 0, embroidery: 1, tonal: 2 } as const;
export const MAX_DECALS = 4;

export interface DecalPlacement {
  region: number;
  /** Lateral centre (m): front = arc from CF toward the wearer's left; back = arc from CB toward
   * the wearer's right (the viewer's right from behind); sleeve = signed arc from the outer line,
   * + toward the front. */
  lateral: number;
  /** Along centre (m): torso = depth below HPS; sleeve = distance from the cuff edge. */
  along: number;
  /** Size in metres (sleeve lettering: width runs along the sleeve). */
  width: number;
  height: number;
  slot: SlotName;
  ink: number;
}

/**
 * The decals of a garment, from its sourced render details and the labelled photo estimates.
 * The set is chosen by the front construction (two-way zip = FB7675 parka, storm flap = DQ4920
 * puffer), as the pocket estimates already are (garmentShader).
 */
export function decalPlacements(details: Record<string, number>): DecalPlacement[] {
  const yoke = details.yoke_depth_m ?? 0,
    pitch = details.chamber_height_m ?? 0;
  if (details.front_kind === 1) {
    const e = detailEstimates.parkaLogos;
    const firstChamber = yoke + 0.5 * pitch;
    const length = e.sleeveLetteringCapM * letteringWidth(THERMA_FIT);
    return [
      {
        region: REGION.front,
        lateral: e.chestLogoArcFromCfM,
        along: firstChamber,
        ...slotBox('wordmark', e.chestLogoWidthM),
        slot: 'wordmark',
        ink: INK.embroidery,
      },
      {
        region: REGION.back,
        lateral: 0,
        along: firstChamber,
        ...slotBox('swoosh', e.backSwooshWidthM),
        slot: 'swoosh',
        ink: INK.print,
      },
      {
        region: REGION.sleeveL,
        lateral: -e.sleeveLetteringBehindOuterM,
        along: e.sleeveLetteringFromCuffM + 0.5 * length,
        ...slotBox('lettering', length),
        slot: 'lettering',
        ink: INK.embroidery,
      },
    ];
  }
  if (details.front_kind === 2) {
    const e = detailEstimates.pufferLogos;
    return [
      {
        region: REGION.front,
        lateral: e.chestSwooshArcFromCfM,
        along: yoke + e.chestSwooshChamberFraction * pitch,
        ...slotBox('swoosh', e.chestSwooshWidthM),
        slot: 'swoosh',
        ink: INK.tonal,
      },
    ];
  }
  return [];
}

/** Shader uniform values (fixed-size vec4 arrays) for a garment's decals. */
export function decalUniformValues(details: Record<string, number>) {
  const list = decalPlacements(details).slice(0, MAX_DECALS);
  const a: Vector4[] = [],
    b: Vector4[] = [],
    c: Vector4[] = [];
  for (let i = 0; i < MAX_DECALS; i++) {
    const d = list[i];
    if (!d) {
      a.push(new Vector4(0, 0, 0, 1));
      b.push(new Vector4(0, 0, 1, 1));
      c.push(new Vector4(1, 0, 0, 0));
      continue;
    }
    a.push(new Vector4(d.region, d.lateral, d.along, d.width));
    b.push(new Vector4(...slotRect(d.slot)));
    c.push(new Vector4(d.height, d.ink, 0, 0));
  }
  return { gDecalA: a, gDecalB: b, gDecalC: c };
}

/**
 * Decal lateral coordinates, mirrored by the shader (pure; unit tested). The server's torso u is
 * the signed arc from centre front (negative toward the wearer's left, wrap seam at the left side)
 * and garmentCoordinates' arcs satisfy arcX + arcY = u at centre back on every row, so:
 * front lateral (+ = wearer's left) = -u; back lateral (+ = wearer's right) = arcX + arcY - u,
 * linear in the vertex values and so exact across centre back (no new vertex attribute: WebGL
 * allows 16 and the garment already uses them).
 */
export function torsoLaterals(u: number, arcX: number, arcY: number) {
  return { front: -u, back: arcX + arcY - u };
}

/**
 * Left sleeve frame for the shader: the server's sleeve u at the outer line (found as
 * garmentCoordinates finds it: the cuff-row vertex reaching furthest out), the circumference,
 * and the sign that makes (u - outer), wrapped, positive toward the front (+Z). Pure function.
 */
export function sleeveDecalFrame(asset: ClothAsset, positions: ArrayLike<number>) {
  const n = asset.panels.length,
    panels = asset.panels,
    uv = asset.render_uv ?? [];
  const none = { outer: 0, circumference: 0, flip: 0 };
  if (uv.length !== n * 2) return none;
  let maxV = -Infinity;
  for (let i = 0; i < n; i++) if (panels[i] === PANEL.sleeveL) maxV = Math.max(maxV, uv[i * 2 + 1]);
  let outer = NaN,
    reach = -Infinity,
    circumference = 0;
  for (let i = 0; i < n; i++) {
    if (panels[i] !== PANEL.sleeveL || uv[i * 2 + 1] < maxV - 0.002) continue;
    circumference = Math.max(circumference, uv[i * 2]);
    if (positions[i * 3] > reach) {
      reach = positions[i * 3];
      outer = uv[i * 2];
    }
  }
  if (!Number.isFinite(outer) || circumference <= 0) return none;
  let zPlus = 0,
    nPlus = 0,
    zMinus = 0,
    nMinus = 0;
  for (let i = 0; i < n; i++) {
    if (panels[i] !== PANEL.sleeveL) continue;
    const d = wrapArc(uv[i * 2] - outer, circumference);
    if (d > 0.01 && d < 0.05) {
      zPlus += positions[i * 3 + 2];
      nPlus++;
    } else if (d < -0.01 && d > -0.05) {
      zMinus += positions[i * 3 + 2];
      nMinus++;
    }
  }
  const flip = nPlus && nMinus && zPlus / nPlus < zMinus / nMinus ? -1 : 1;
  return { outer, circumference, flip };
}

/** Wrap an arc difference into [-c/2, c/2) (as the shader does). */
export function wrapArc(d: number, c: number) {
  return d - c * Math.floor(d / c + 0.5);
}

// ------------------------------------------------------------------------------------- shader

export const decalFragmentDeclaration = /* glsl */ `
uniform sampler2D gDecalTex;
uniform vec4 gDecalA[${MAX_DECALS}]; uniform vec4 gDecalB[${MAX_DECALS}]; uniform vec4 gDecalC[${MAX_DECALS}];
uniform vec3 gDecalSleeve; // left sleeve: outer-line u, circumference, front sign (0 = none)
`;

/**
 * Runs in color_fragment after garmentColour. Textures are sampled in uniform control flow
 * (derivatives stay defined); the panel/region test only weights the result.
 */
export const decalColour = /* glsl */ `
{
  float p = gPanelV;
  bool torsoFront = p < 1.5 || (p > 2.5 && p < 3.5 && gArcV.x <= gArcV.y);
  bool torsoBack = (p > 1.5 && p < 2.5) || (p > 2.5 && p < 3.5 && gArcV.x > gArcV.y);
  bool sleeveL = p > 3.5 && p < 4.5 && gDecalSleeve.z != 0.;
  float u = gUvV.x;
  float frontLat = -u, backLat = gArcV.x + gArcV.y - u;
  float c = max(gDecalSleeve.y, 1e-3), ds = u - gDecalSleeve.x;
  float sleeveLat = gDecalSleeve.z * (ds - c * floor(ds / c + .5));
  for (int i = 0; i < ${MAX_DECALS}; i++) {
    vec4 A = gDecalA[i], B = gDecalB[i], C = gDecalC[i];
    if (A.x < .5) continue;
    float w = A.w, h = C.x;
    vec2 d;
    if (A.x < 1.5) d = vec2((frontLat - A.y) / w, (gUvV.y - A.z) / h);
    else if (A.x < 2.5) d = vec2((backLat - A.y) / w, (gUvV.y - A.z) / h);
    else d = vec2(((gSleeveL - gUvV.y) - A.z) / w, (A.y - sleeveLat) / h);
    d += .5;
    vec2 uv = mix(B.xy, B.zw, clamp(d, 0., 1.));
    vec4 t = texture2D(gDecalTex, uv);
    bool region = A.x < 1.5 ? torsoFront : A.x < 2.5 ? torsoBack : sleeveL;
    float inside = region && gl_FrontFacing && d.x > 0. && d.x < 1. && d.y > 0. && d.y < 1. ? 1. : 0.;
    // Crisp edge when magnified; plain (mipmapped) coverage once a screen pixel spans more than
    // about one atlas texel, so thin strokes fade instead of breaking up at kiosk distance.
    vec2 texels = d * (B.zw - B.xy) * vec2(${ATLAS.width}., ${ATLAS.height}.);
    float perPixel = max(length(dFdx(texels)), length(dFdy(texels)));
    float fw = fwidth(t.r);
    float sharp = clamp((t.r - .5) / max(fw, 1e-4) + .5, 0., 1.);
    // Minified: boost partial coverage (1 - (1 - c)^3), as text renderers do, so 1-2 px strokes
    // read as solid thread at kiosk distance instead of breaking up.
    float boosted = 1. - pow(1. - t.r, 3.);
    float a = mix(sharp, boosted, smoothstep(.6, 1.6, perPixel)) * inside;
    float ring = 4. * t.g * (1. - t.g) * inside;
    if (C.y < .5) {
      // Printed black (plastisol): flat, slightly glossier than the shell.
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.016, .016, .018), a);
      if (a > .5) gRough = .42;
    } else if (C.y < 1.5) {
      // Black embroidery: thread sheen lines, raised edge casting a faint shadow on the shell.
      float stitch = .85 + .15 * sin(6.2832 * dot(d * vec2(w, h), vec2(.7, .7)) / .0011);
      stitch = mix(stitch, 1., smoothstep(.3, .8, fwidth(dot(d * vec2(w, h), vec2(.7, .7)) / .0011)));
      diffuseColor.rgb *= 1. - .16 * t.g * (1. - a) * inside;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.02, .02, .022) * stitch, a);
      if (a > .5) gRough = .58;
    } else {
      // Tonal embroidery: self-coloured thread, read by its relief (shaded outline).
      diffuseColor.rgb *= (1. - .14 * a) * (1. - .38 * ring);
    }
  }
}
`;
