import type { ClothAsset } from '../api';
import { detailEstimates, look, type Finish } from './garmentLook';

/**
 * Garment look-dev shader (agent L). The relief is drawn OUTWARD from the tape-true inner
 * surface and never exceeds the product's taped loft; every feature position/size comes from
 * the product `visual` spec (asset.render_details) or a labelled photo estimate (garmentLook).
 */
/**
 * Unit axis (scene frame) of a sleeve on the shown wrap: armhole-row centroid -> cuff-row
 * centroid, from the server sleeve uv (v grows toward the cuff). The shader uses it as the
 * smooth reference direction of the sleeve chart (no per-triangle tangents). [0, -1, 0] when the
 * asset has no such sleeve.
 */
export function sleeveAxis(asset: ClothAsset, panel: number): [number, number, number] {
  const uv = asset.render_uv ?? [],
    p = asset.initial ?? [];
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < asset.panels.length; i++)
    if (asset.panels[i] === panel) {
      lo = Math.min(lo, uv[i * 2 + 1] ?? 0);
      hi = Math.max(hi, uv[i * 2 + 1] ?? 0);
    }
  const band = 0.15 * (hi - lo),
    a = [0, 0, 0, 0],
    b = [0, 0, 0, 0];
  for (let i = 0; i < asset.panels.length; i++) {
    if (asset.panels[i] !== panel || p.length < i * 3 + 3) continue;
    const v = uv[i * 2 + 1] ?? 0,
      s = v <= lo + band ? a : v >= hi - band ? b : undefined;
    if (!s) continue;
    for (let k = 0; k < 3; k++) s[k] += p[i * 3 + k];
    s[3]++;
  }
  if (!a[3] || !b[3]) return [0, -1, 0];
  const d = [0, 1, 2].map((k) => b[k] / b[3] - a[k] / a[3]),
    l = Math.hypot(d[0], d[1], d[2]);
  return l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : [0, -1, 0];
}

/**
 * Inner (fit-surface) circumference of a sleeve's end ring: the largest server sleeve u (arc
 * round the ring from the underarm) on the panel's last row. 0 when the asset has no such sleeve.
 */
export function sleeveEndCircumference(asset: ClothAsset, panel: number) {
  const uv = asset.render_uv ?? [];
  let vMax = -Infinity;
  for (let i = 0; i < asset.panels.length; i++)
    if (asset.panels[i] === panel) vMax = Math.max(vMax, uv[i * 2 + 1] ?? 0);
  let c = 0;
  for (let i = 0; i < asset.panels.length; i++)
    if (asset.panels[i] === panel && (uv[i * 2 + 1] ?? 0) >= vMax - 0.003)
      c = Math.max(c, uv[i * 2] ?? 0);
  return c;
}

export function garmentUniformValues(asset: ClothAsset, collarHeight: number) {
  const d = asset.render_details ?? {},
    finish = (asset.finish as Finish) ?? 'satin_matte',
    glossy = finish === 'glossy_ripstop';
  let hemV = 0;
  const uv = asset.render_uv ?? [];
  for (let i = 0; i < asset.panels.length; i++)
    if (asset.panels[i] <= 2) hemV = Math.max(hemV, uv[i * 2 + 1] ?? 0);
  // Collar half-circumference: largest |u| (signed arc from CF) on the collar panel.
  let collarHalf = 0;
  for (let i = 0; i < asset.panels.length; i++)
    if (asset.panels[i] === 6) collarHalf = Math.max(collarHalf, Math.abs(uv[i * 2] ?? 0));
  const pocketKind = d.pockets_kind ?? 0;
  const estimate = pocketKind === 2 ? detailEstimates.puffer : detailEstimates.parka;
  const axL = sleeveAxis(asset, 4),
    axR = sleeveAxis(asset, 5);
  const cuffC = Math.max(sleeveEndCircumference(asset, 4), sleeveEndCircumference(asset, 5));
  return {
    gLoft: asset.maximum_loft_m,
    gExponent: look.chamberExponent[finish],
    gValley: look.chamberValley[finish],
    gDipW: look.chamberDipWidthM[finish],
    gSValley: look.sleeveValley[finish],
    gSValleyGeom: look.sleeveGeomValley[finish],
    gSDipW: look.sleeveDipWidthM[finish],
    gSExponent: look.sleeveExponent[finish],
    gSeamH: look.seamRelief,
    gGroove: look.grooveHalfWidthM[finish],
    gIrreg: look.chamberIrregularity[finish],
    gPinchReach: look.pinchReachM[finish],
    gPinchLambda: look.pinchWavelengthM[finish],
    gPinchAmp: look.pinchAmplitude[finish],
    gCrinkleScale: look.crinkleScaleM[finish],
    gCrinkle: look.crinkleStrength[finish],
    gFold: look.foldWavelengthM[finish],
    gGather: look.gatherPeriodM,
    gInnerCuff: look.innerCuffGatherM,
    // Tab width as seen on the lofted outside -> the inner-surface arc it is charted on (L3).
    gTab:
      cuffC > 0
        ? (look.cuffTabArcM * cuffC) /
          (cuffC + 2 * Math.PI * look.cuffTabRelief * (asset.maximum_loft_m ?? 0))
        : look.cuffTabArcM,
    gTabH: look.cuffTabRelief,
    gTabLen: look.cuffTabLengthM,
    gGatherAmp: look.elasticGatherAmplitude[finish],
    gSideSeam: look.sideSeamDepth[finish],
    gWelt: look.weltWidthM,
    gHoodPanel: look.hoodCentrePanelM,
    gFront: d.front_kind ?? 0,
    gFlap: d.storm_flap_width_m ?? 0,
    gCuff: d.cuffs_kind ?? 0,
    gHem: d.hem_kind ?? 0,
    gHoodKind: d.hood_kind ?? 0,
    gPockets: pocketKind,
    gPocketTop: d.pocket_top_m ?? 0,
    gPocketLen: d.pocket_length_m ?? 0,
    gPocketArc: pocketKind ? estimate.pocketArcFromCfM : 0,
    gPocketSlant: pocketKind ? (estimate.pocketSlantDeg * Math.PI) / 180 : 0,
    gSleeveL: d.sleeve_L_length_m ?? 0,
    gSleeveR: d.sleeve_R_length_m ?? 0,
    gHemV: hemV,
    gCollarH: collarHeight,
    gCollarHalf: collarHalf,
    gGlossy: glossy ? 1 : 0,
    gLining: look.liningShade,
    gAxLx: axL[0],
    gAxLy: axL[1],
    gAxLz: axL[2],
    gAxRx: axR[0],
    gAxRy: axR[1],
    gAxRz: axR[2],
    gSpecAA: look.specularAntiAliasing,
    gSAO: look.sleeveCreaseAO[finish],
    gSThread: look.sleeveThread[finish],
    gSPinch: look.sleevePinch[finish],
    gSWander: look.sleeveWander[finish],
    gSFold: look.sleeveFold[finish],
    gSFoldScale: look.sleeveFoldScaleM,
    gZipHem: detailEstimates.pufferZip.showAboveHemM,
    gZipCollar: detailEstimates.pufferZip.showBelowCollarTopM,
  };
}
export type GarmentUniforms = ReturnType<typeof garmentUniformValues>;

const shared = /* glsl */ `
#define GP 3.14159265359
uniform float gLoft; uniform float gExponent; uniform float gGroove; uniform float gIrreg;
uniform float gValley; uniform float gDipW;
uniform float gSValley; uniform float gSDipW; uniform float gSExponent; uniform float gSeamH;
uniform float gPinchReach; uniform float gPinchLambda; uniform float gPinchAmp;
uniform float gCrinkleScale; uniform float gCrinkle; uniform float gFold; uniform float gGather;
uniform float gInnerCuff; uniform float gTab; uniform float gWelt; uniform float gHoodPanel;
uniform float gTabLen; uniform float gGatherAmp; uniform float gSideSeam;
uniform float gFront; uniform float gFlap; uniform float gCuff; uniform float gHem; uniform float gHoodKind;
uniform float gPockets; uniform float gPocketTop; uniform float gPocketLen; uniform float gPocketArc;
uniform float gPocketSlant; uniform float gSleeveL; uniform float gSleeveR; uniform float gHemV;
uniform float gCollarH; uniform float gCollarHalf; uniform float gGlossy; uniform float gLining;
uniform float gAxLx; uniform float gAxLy; uniform float gAxLz;
uniform float gAxRx; uniform float gAxRy; uniform float gAxRz; uniform float gSpecAA;
uniform float gTabH; uniform float gZipHem; uniform float gZipCollar;
uniform float gSAO; uniform float gSThread; uniform float gSPinch; uniform float gSWander;
uniform float gSFold; uniform float gSFoldScale; uniform float gSValleyGeom;

float gHash3(vec3 p) {
  p = fract(p * .3183099 + .1); p *= 17.;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float gNoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(gHash3(i), gHash3(i + vec3(1, 0, 0)), f.x),
                 mix(gHash3(i + vec3(0, 1, 0)), gHash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gHash3(i + vec3(0, 0, 1)), gHash3(i + vec3(1, 0, 1)), f.x),
                 mix(gHash3(i + vec3(0, 1, 1)), gHash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Chamber cross-section at material distance d (m) from the nearest stitch line, pitch P, profile
// pr = (valley, dip half-width, exponent) (look, garmentLook chamber* for the torso, sleeve* for
// sleeves and hood): valley floor on the stitch, crown 1 once d reaches the dip half-width (half
// the pitch when 0: a full round tube).
float gChamberD(float d, float P, vec3 pr) {
  float w = pr.y > 0. ? min(pr.y, .5 * P) : .5 * P;
  return pr.x + (1. - pr.x) * pow(max(sin(.5 * GP * clamp(d / w, 0., 1.)), .015), pr.z);
}
// Chamber at phase t (integers = stitch lines). geom: the displaced mesh samples a chamber with
// only 4-7 rows at phases that drift from chamber to chamber; the sharp shading profile sampled
// there drew alternately deep and shallow valleys (big/pinched lumps). The geometry takes the
// same valley and crown on one cosine (band-limited: every chamber samples alike); the shading
// normal uses the full profile.
float gChamberP(float t, float P, vec3 pr, bool geom) {
  t = fract(t);
  if (geom) return pr.x + (1. - pr.x) * (.5 - .5 * cos(2. * GP * t));
  return gChamberD(min(t, 1. - t) * P, P, pr);
}
float gGauss(float x, float w) { return exp(-(x * x) / (w * w)); }
// Sleeves (L3): stitch-line wander (metres of material arc) and gentle fold relief (fraction of
// the loft), smooth noise fixed to the material (rest positions). Zero-mean.
float gSleeveWander(vec3 rest, float P) {
  return gSWander * P * (gNoise3(rest / (.6 * gSFoldScale) + 5.) - .5);
}
float gSleeveFold(vec3 rest) {
  vec3 r = rest / gSFoldScale;
  return gSFold * (gNoise3(r * vec3(1., .7, 1.) + 9.) + .5 * gNoise3(r * 2.1 + 17.) - .75);
}

struct GCtx { float panel; vec4 q; vec4 arc; float elastic; float comp; float tilt; float sleeveEnd; vec3 rest; };

// Elastic gathers: irregular bunched puckers running across the band.
float gGatherH(float L, vec3 rest, bool geom) {
  if (geom) return .42;
  // Domain-warped phase: puckers of uneven width and height, slightly skewed.
  float ph = L / gGather + 2.4 * gNoise3(rest * 19.) + .8 * gNoise3(rest * 47. + 2.);
  float a = .25 + .75 * gNoise3(rest * 38. + 7.);
  float s = sin(2. * GP * ph);
  return .42 + gGatherAmp * a * sign(s) * pow(abs(s), .7);
}

// Relief above the inner fit surface, as a fraction of the loft (plus folds in metres via out).
// L: lateral chart arc (CF/CB/outer-line/hood-centre distance), V: depth chart coordinate.
float gRelief(GCtx c, float L, float V, bool geom, out float ao, out float foldM) {
  ao = 1.; foldM = 0.;
  float p = c.panel;
  bool front = p < 1.5, back = p > 1.5 && p < 2.5, yoke = p > 2.5 && p < 3.5;
  bool torso = p < 3.5, sleeve = p > 3.5 && p < 5.5, collar = p > 5.5 && p < 6.5, hood = p > 6.5;
  bool centre = front || yoke || collar;
  vec4 q = c.q;
  // Rows between quilted and plain bands interpolate the kind: draw them plain (no aliasing).
  if (abs(q.w - floor(q.w + .5)) > .02) q.w = 0.;
  // Sleeves: the displaced geometry keeps the measured outline dip, the shading a shallower one.
  vec3 prT = vec3(gValley, gDipW, gExponent);
  vec3 prS = vec3(sleeve && geom ? gSValleyGeom : gSValley, gSDipW, gSExponent);
  vec3 pr = sleeve || hood ? prS : prT;
  float h = .55;
  if (collar) {
    // Padded collar: rises from the neck seam, rounded fold at the top, edge stitch below it.
    // Height per column (arc.w; the parka's hood edges rise in a V from the zip).
    float topH = c.arc.w > 0. ? c.arc.w : gCollarH;
    float y = clamp(V / max(topH, .01), 0., 1.);
    h = .62 * smoothstep(0., min(.22, .012 / max(topH, .01)), y) * (1. - .4 * smoothstep(.8, 1., y));
    if (!geom) h -= .14 * gGauss(topH - V - .008, .0012);
    ao = mix(.6, 1., smoothstep(0., .3, y));
  } else if (q.w > .5) {
    if (V < q.z) {
      // Yoke: padded panel diving into the yoke stitch line over its last 3 cm.
      h = .62 * gChamberD(clamp(q.z - V, 0., .03), .06, prT);
      ao = mix(.5, 1., smoothstep(0., .3, h));
    } else {
      // Sleeves: chambers follow the material (rest) arc, so stacked sleeves draw them
      // compressed (server render_material_v in arc.y; 0 = not provided).
      float Vq = sleeve && c.arc.y > 0. ? c.arc.y : V;
      if (sleeve) Vq += gSleeveWander(c.rest, q.y);
      float pv = gChamberP((Vq - q.z) / q.y, q.y, pr, geom);
      float pu = 1.;
      if (q.w > 1.5 && torso)
        pu = mix(.42, 1., gChamberP(back ? L / q.x + .5 : L / q.x, q.x, pr, geom));
      // Crevice occlusion by the depth of the valley (1 - valley of the loft), not by absolute
      // height: shallow sleeve creases stay light, deep body valleys darken softly (L2).
      float rel = clamp((pu * pv - pr.x) / max(1. - pr.x, .05), 0., 1.);
      ao = 1. - (1. - pr.x) * mix(.45, .6, gGlossy) * (sleeve ? gSAO : 1.) * (1. - smoothstep(0., .55, rel));
      if (hood && gHoodKind < 1.5 && L > .5 * gHoodPanel) { pv = .62; ao = 1.; } // parka: plain side panels
      h = pu * pv;
      if (sleeve) h += gSleeveFold(c.rest);
    }
  }
  if (hood) {
    // Centre panel seams.
    float s = abs(L - .5 * gHoodPanel);
    h *= mix(.4, 1., smoothstep(0., .009, s));
    ao *= mix(.62, 1., smoothstep(0., .006, s));
  }
  if (torso && c.arc.z >= 0. && V > q.z) {
    // Side seam (front/back panels meet under the arm).
    float s = abs(L - (back ? c.arc.w : c.arc.z));
    h *= mix(1. - gSideSeam, 1., smoothstep(0., .016, s));
    ao *= mix(1. - .55 * gSideSeam, 1., smoothstep(0., .008, s));
  }
  if (centre && gFront > .5 && gFront < 1.5) {
    // Two-way zip: chambers pinch into a flat tape; teeth stand slightly proud.
    h = mix(.3, h, smoothstep(.0045, .022, L));
    h = mix(h, .34, 1. - smoothstep(.0075, .0095, L));
    if (!geom) h += .1 * (1. - smoothstep(.0028, .0036, L));
    ao *= mix(.68, 1., smoothstep(.004, .016, L));
  }
  if (centre && gFront > 1.5 && gFlap > 0.) {
    // Storm flap (sourced width) on top of the chambers; chambers dive under its edge.
    float e = .5 * gFlap;
    // Flat padded placket (Puffer2: ~6.5 cm, flush with the baffle crowns, stitched through at
    // each baffle line), not a raised strip: it follows the chambers at 30 % of their relief.
    // Its edge rolls over ~1 cm with a faint edge stitch (L2: a 4 mm step and a deep groove drew
    // flickering double lines down both edges at kiosk distance).
    float pf = q.w > .5 && V >= q.z ? gChamberP((V - q.z) / q.y, q.y, prT, geom) : 1.;
    float edge = smoothstep(e + .001, e - .009, L);
    float flap = (.66 + .3 * pf) * edge;
    // On the funnel collar the placket is flush with the collar's own padding (Puffer2).
    if (collar) flap = h * edge;
    if (!geom) flap -= .03 * gGauss(L - (e - .007), .0012) * step(L, e);
    float under = h * mix(.88, 1., smoothstep(e, e + .02, L));
    ao *= L > e ? mix(.85, 1., smoothstep(e, e + .012, L)) : 1.;
    h = max(under, flap);
    if (L < e) ao = max(ao, .92);
  }
  if (!geom && front && gPockets > .5 && gPocketLen > 0.) {
    vec2 dir = vec2(sin(gPocketSlant), cos(gPocketSlant));
    vec2 d = vec2(L - gPocketArc, V - gPocketTop);
    float s = dot(d, dir), t = d.x * dir.y - d.y * dir.x;
    float ends = smoothstep(-.002, .003, s) * (1. - smoothstep(gPocketLen - .003, gPocketLen + .002, s));
    if (gPockets < 1.5) {
      // Vertical zip pocket: concealed coil zip between two narrow welts.
      float a = abs(t), half_ = .5 * gWelt;
      float strip = (1. - smoothstep(half_ - .001, half_ + .001, a)) * ends;
      float wh = .45 - .14 * gGauss(a - half_ + .0016, .0007) - .2 * (1. - smoothstep(.0011, .0021, a));
      h = mix(h * mix(.75, 1., smoothstep(half_, half_ + .012, a)), wh, strip);
      ao *= mix(1., .5, (1. - smoothstep(.0008, .0024, a)) * ends);
    } else {
      // Angled welt: a flat lip on the centre-front side of a dark opening.
      float lip = smoothstep(-gWelt - .0015, -gWelt, t) * (1. - smoothstep(-.0012, 0., t)) * ends;
      float lipH = .6 - .12 * gGauss(t + gWelt - .0022, .0008);
      float slit = (1. - smoothstep(0., .0019, abs(t - .0006))) * ends;
      h = mix(h * mix(.8, 1., smoothstep(0., .015, abs(t))), lipH, lip);
      h = mix(h, .1, slit);
      ao *= mix(1., .28, slit);
    }
  }
  if (torso && V > q.z) {
    float hemDist = gHemV - V;
    if (gHem > 1.5 && c.elastic > .5) {
      h = gGatherH(L, c.rest, geom);
      ao *= mix(.7, 1., smoothstep(.3, .55, h));
    } else if (gHem > .5) {
      // Open hem: turned edge with a stitch line.
      h *= mix(.35, 1., smoothstep(0., .012, hemDist));
      if (!geom) h -= .08 * gGauss(hemDist - .014, .001);
    }
  }
  if (sleeve) {
    float se = c.sleeveEnd - V;
    if (c.elastic > .5) {
      h = gGatherH(L, c.rest, geom);
      ao *= mix(.7, 1., smoothstep(.3, .55, h));
    } else if (gCuff > .5 && gCuff < 1.5) {
      // Inner elastic: the cuff end bunches over the gathered band.
      h = mix(h, gGatherH(L, c.rest, geom), 1. - smoothstep(gInnerCuff * .6, gInnerCuff, se));
    }
    h *= mix(.4, 1., smoothstep(0., .006, se));
    if (gCuff > 1.5) {
      // Hook-and-loop adjuster tab on the outer cuff (retailer_copy feature).
      float tab = (1. - smoothstep(gTab * .5 - .002, gTab * .5, L)) * smoothstep(.003, .005, se) *
                  (1. - smoothstep(gTabLen - .002, gTabLen, se));
      h = mix(h, gTabH, tab);
      ao *= mix(1., .7, (1. - tab) * (1. - smoothstep(gTab * .5, gTab * .5 + .006, L)) *
                       smoothstep(.003, .005, se) * (1. - smoothstep(gTabLen - .002, gTabLen + .005, se)));
    }
    // Stacking folds from the measured axial compression: A = L sqrt(c) / pi (look: tilt, mix).
    // Plain sleeve fabric only: quilted chambers already take the stacking (their phase runs on
    // the material arc); a fold wave on top beat against them into alternating lumps (L1b).
    float comp = clamp(c.comp, 0., .6);
    if (comp > 0. && c.elastic < .5 && c.q.w < .5) {
      float lw = gFold, A = min(gLoft, lw * sqrt(comp) / GP);
      float ph = 2. * GP * (V + c.tilt) / lw;
      float m = 1. - mix(.12, .28, gGlossy) * (1. - sin(41. * c.tilt / lw + 23. * V));
      foldM = A * m * (.5 + .5 * sin(ph)) * (geom ? .7 : 1.);
      ao *= mix(.78, 1., .5 + .5 * sin(ph));
    }
  }
  return h;
}

// Fine relief that only shades (never displaced): pinch wrinkles fanning out of the stitch
// valleys and the shell's crinkle, both fixed to the material (rest positions).
float gMicro(GCtx c, float L, float V) {
  float m = 0.;
  vec4 q = c.q;
  if (abs(q.w - floor(q.w + .5)) > .02) q.w = 0.;
  // Sleeves: same material arc as the chambers (the pinches sit on their stitch lines).
  if (c.panel > 3.5 && c.panel < 5.5 && c.arc.y > 0.) V = c.arc.y + gSleeveWander(c.rest, q.y);
  // Pinch wrinkles scale with the valley depth (1 - valley) of the chamber profile: shallow
  // sleeve creases only gather faintly (full-depth pinches drew dark dashes along them; L2).
  bool tube = c.panel > 3.5 && c.panel < 5.5 || c.panel > 6.5;
  float pinch = gPinchAmp * (1. - (tube ? gSValley : gValley)) * (tube ? gSPinch : 1.);
  if (q.w > .5 && V >= q.z) {
    float tv = fract((V - q.z) / q.y);
    float dv = min(tv, 1. - tv) * q.y;
    float env = exp(-dv / gPinchReach) * smoothstep(0., .004, dv);
    float ph = L / gPinchLambda + 2.2 * gNoise3(c.rest * 13.);
    float k = gNoise3(c.rest * 29. + 3.);
    m += pinch * gLoft * env * sin(2. * GP * ph) * 2.2 * k * k;
    if (q.w > 1.5 && c.panel < 2.5) {
      float tu = fract(c.panel > 1.5 ? L / q.x + .5 : L / q.x);
      float du = min(tu, 1. - tu) * q.x;
      float envU = exp(-du / gPinchReach) * smoothstep(0., .004, du);
      float phU = V / gPinchLambda + 2.2 * gNoise3(c.rest * 13. + 5.);
      float kU = gNoise3(c.rest * 29. + 9.);
      m += pinch * gLoft * envU * sin(2. * GP * phU) * 2.2 * kU * kU;
    }
  }
  vec3 r = c.rest / gCrinkleScale;
  m += gCrinkle * gCrinkleScale * .3 * (gNoise3(r) + .5 * gNoise3(r * 2.31 + 11.));
  return m;
}
float gTiltField(vec3 p) {
  // Fold skew (look): stiff glossy padding folds irregularly, soft satin in cleaner rings.
  float k = mix(.4, 1., gGlossy);
  return k * (.3 * gFold * sin(37. * (p.x + p.z) + 11. * p.y) + .15 * gFold * sin(53. * (p.z - .6 * p.x)));
}
`;

const attributes = /* glsl */ `
attribute vec2 _quilt_uv; attribute vec4 _quilt_params; attribute vec4 _compression;
attribute vec3 _fabric_aux; attribute vec4 _g_arc; attribute float _g_seam; attribute vec3 _g_rest;
attribute float _elastic_gather;
`;
const varyings = /* glsl */ `
varying vec2 gUvV; varying vec4 gQV; varying vec4 gArcV; varying float gPanelV; varying float gSeamV;
varying vec3 gRestV; varying float gElasticV; varying float gCompV; varying float gTiltV;
`;

export const garmentVertexDeclaration = attributes + varyings + shared;
export const garmentVertexDisplacement = /* glsl */ `
{
  float panel = _fabric_aux.z;
  // A dropped shoulder's cap (sleeve vertices flagged arc.w = 1, garmentSurface) is body panel:
  // drawn as yoke/body rows in the body's chart (L3).
  if (panel > 3.5 && panel < 5.5 && _g_arc.w > .5) panel = 3.;
  float tilt = gTiltField(_g_rest);
  float sleeveEnd = panel < 4.5 ? gSleeveL : gSleeveR;
  GCtx c = GCtx(panel, _quilt_params, _g_arc, _elastic_gather, _compression.w, tilt, sleeveEnd, _g_rest);
  bool collar = panel > 5.5 && panel < 6.5, back = panel > 1.5 && panel < 2.5;
  float ao, fold;
  float h = gRelief(c, back ? _g_arc.y : _g_arc.x, collar ? _g_arc.z : _quilt_uv.y, true, ao, fold);
  float fac = 1. - gIrreg * gNoise3(_g_rest * vec3(4.5, 7., 4.5));
  float w = smoothstep(.002, .03, _g_seam);
  // Outward only and never beyond the taped loft (folds are bounded by it too). Yoke rows
  // (no side seam: arc.z < 0) and folding front vertices carry their fold-safe fraction in
  // arc.w = -2 + s (garmentSurface; L3).
  float safe = (panel > 2.5 && panel < 3.5 && _g_arc.z < 0.) || (panel < 1.5 && _g_arc.w < -.5)
    ? clamp(_g_arc.w + 2., 0., 1.) : 1.;
  transformed += normal * safe * min(gLoft, mix(gSeamH * gLoft, h * fac * gLoft + fold, w));
  gUvV = _quilt_uv; gQV = _quilt_params; gArcV = _g_arc; gPanelV = panel; gSeamV = _g_seam;
  gRestV = _g_rest; gElasticV = _elastic_gather; gCompV = _compression.w; gTiltV = tilt;
}
`;

export const garmentFragmentDeclaration =
  varyings +
  shared +
  /* glsl */ `
float gAO = 1.; float gMetal = 0.; float gRough = -1.; float gCoat = 1.; vec3 gClearN = vec3(0., 0., 1.);
GCtx gContext() {
  float sleeveEnd = gPanelV < 4.5 ? gSleeveL : gSleeveR;
  return GCtx(gPanelV, gQV, gArcV, gElasticV, gCompV, gTiltV, sleeveEnd, gRestV);
}
// Surface gradient of a scalar field f given its screen derivatives (Mikkelsen 2020).
vec3 gSurfGrad(vec3 n, float fx, float fy) {
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1);
  if (abs(det) < 1e-20) return vec3(0.);
  return (fx * r1 + fy * r2) / det;
}
// Smooth chart gradient. The mesh is piecewise linear, so a chart coordinate's screen-space
// gradient is constant per triangle and jumps at every edge: multiplied by a steep chamber
// slope that drew faceted, torn-looking highlights. Where the triangle gradient agrees with a
// smooth reference direction (unit, tangent plane) it is replaced by that direction (sign from
// the triangle; magnitude given, or the triangle's own when mag < 0).
vec3 gSmoothGrad(vec3 gTri, vec3 ref, float mag) {
  float lt = length(gTri), lr = length(ref);
  if (lt < 1e-6 || lr < .2) return gTri;
  ref /= lr;
  float d = dot(gTri, ref);
  float agree = smoothstep(.6, .85, abs(d) / lt) * smoothstep(.2, .35, lr);
  return mix(gTri, sign(d) * (mag < 0. ? abs(d) : mag) * ref, agree);
}
`;

/** Colour, metal and roughness of sourced details (runs in color_fragment). */
export const garmentColour = /* glsl */ `
{
  GCtx c = gContext();
  float p = c.panel;
  bool front = p < 1.5, collar = p > 5.5 && p < 6.5, yoke = p > 2.5 && p < 3.5;
  bool centre = front || yoke || collar, sleeve = p > 3.5 && p < 5.5, hood = p > 6.5;
  float L = (p > 1.5 && p < 2.5) ? gArcV.y : gArcV.x;
  float V = collar ? gArcV.z : gUvV.y;
  float seamW = smoothstep(.002, .03, gSeamV);
  // Quilting thread: a fine line in the valley (darker on the glossy shell, self-colour on white).
  if (c.q.w > .5 && abs(c.q.w - floor(c.q.w + .5)) < .02 && V >= c.q.z && !collar) {
    // Sleeves: on the material arc like the shaded chambers (the shown v put the thread off the
    // valley where the sleeve stacks; L2).
    float Vt = sleeve && c.arc.y > 0. ? c.arc.y + gSleeveWander(gRestV, c.q.y) : V;
    float tv = fract((Vt - c.q.z) / c.q.y);
    float dist = min(tv, 1. - tv) * c.q.y;
    if (c.q.w > 1.5 && p < 2.5) {
      float tu = fract(p > 1.5 ? L / c.q.x + .5 : L / c.q.x);
      dist = min(dist, min(tu, 1. - tu) * c.q.x);
    }
    float line = (1. - smoothstep(.0004, .0009, dist)) * seamW;
    diffuseColor.rgb *= 1. - mix(.06, .14, gGlossy) * line * (sleeve ? gSThread : 1.);
  }
  if (centre && gFront > .5 && gFront < 1.5) {
    // FB7675-100 (user photos Parka1/3/5): black polyester tape and black nylon coil, the
    // visible black band ~1.5 cm wide (Parka1 8 px at 0.203 cm/px, Parka3 17 px at 0.086 cm/px).
    float tooth = step(.5, fract(gUvV.y / .0042));
    float teeth = 1. - smoothstep(.0026, .0033, L);
    float tape = 1. - smoothstep(.0068, .0076, L);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.011, .011, .012), tape);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.006, .006, .007) * mix(.6, 2.2, tooth), teeth);
    gRough = tape > .5 ? mix(.78, .4, teeth) : gRough;
  }
  if (centre && gFront > 1.5 && gFlap > 0.) {
    // DQ4920-206 storm placket (L3). Topstitch: a running stitch 7 mm in from both edges (Puffer2
    // collar/hem close-ups), on the relief groove already drawn there.
    float e = .5 * gFlap;
    float st = (1. - smoothstep(.0003, .0008, abs(L - (e - .007)))) * step(.35, fract(V / .0045));
    diffuseColor.rgb *= 1. - mix(.08, .16, gGlossy) * st * seamW;
    // The metal main zip under the placket shows as a dark slit at its free edge (wearer's right =
    // scene -X) above the hem and at the collar top (garmentLook detailEstimates.pufferZip).
    float topH = gArcV.w > 0. ? gArcV.w : gCollarH;
    float zone = collar ? smoothstep(topH - gZipCollar - .003, topH - gZipCollar, V)
                        : 1. - smoothstep(gZipHem - .003, gZipHem, gHemV - V);
    zone *= step(gRestV.x, 0.) * (yoke ? 0. : 1.);
    float slit = (1. - smoothstep(.0025, .0035, abs(L - (e + .001)))) * zone;
    float teeth = (1. - smoothstep(.0012, .0018, abs(L - (e + .0012)))) * zone;
    float tooth = step(.5, fract(V / .0042));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .35, slit);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.23, .23, .235) * mix(.55, 1., tooth), teeth);
    gMetal = max(gMetal, .8 * teeth);
    gRough = teeth > .5 ? .35 : gRough;
  }
  if (front && gPockets > .5 && gPocketLen > 0.) {
    vec2 dir = vec2(sin(gPocketSlant), cos(gPocketSlant));
    vec2 d = vec2(L - gPocketArc, V - gPocketTop);
    float s = dot(d, dir), t = d.x * dir.y - d.y * dir.x;
    float ends = step(0., s) * step(s, gPocketLen);
    if (gPockets < 1.5) {
      // Parka hip zip pockets: black tape (~1 cm, Parka3) round a black coil.
      float tape = (1. - smoothstep(.0046, .0054, abs(t))) * smoothstep(-.004, -.003, s) *
                   (1. - smoothstep(gPocketLen + .003, gPocketLen + .004, s));
      float coil = (1. - smoothstep(.0016, .0022, abs(t))) * ends;
      float tooth = step(.5, fract(s / .0042));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.011, .011, .012), tape);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.006, .006, .007) * mix(.6, 2.2, tooth), coil);
      gRough = tape > .5 ? mix(.78, .4, coil) : gRough;
    } else {
      float slit = (1. - smoothstep(.0008, .0019, abs(t - .0006))) * ends;
      diffuseColor.rgb *= 1. - .7 * slit;
    }
  }
  if (sleeve && gCuff > 1.5) {
    float se = c.sleeveEnd - gUvV.y;
    float tab = (1. - smoothstep(gTab * .5 - .002, gTab * .5, L)) * smoothstep(.003, .005, se) *
                (1. - smoothstep(gTabLen - .002, gTabLen, se));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.03, .03, .033), tab);
    gRough = mix(-1., .95, step(.5, tab));
    gCoat = 1. - step(.5, tab);
  }
  if (collar && gHoodKind > 1.5 && gCollarHalf > 0.) {
    // DQ4920-206 hood attachment zip (user's photos puffer-a4-2, Head-for-puffer): a silver zip
    // track along the funnel's top edge round the back, where the detachable hood zips on. It
    // shows when the hood is off; under the hood it is covered. Look convention: 6 mm tape,
    // 3 mm teeth, the track over the back 60 % of the collar.
    float back = smoothstep(.38, .42, gArcV.x / gCollarHalf);
    float dTop = abs(gArcV.w - .006 - gArcV.z);
    float tape = (1. - smoothstep(.003, .0036, dTop)) * back;
    float teeth = (1. - smoothstep(.0013, .0018, dTop)) * back;
    float tooth = step(.5, fract(gArcV.x / .0042));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .8, tape);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.62, .62, .6) * mix(.7, 1., tooth), teeth);
    gMetal = max(gMetal, teeth * .85);
    gRough = teeth > .5 ? .3 : gRough;
  }
  if (hood && gHoodKind > 1.5) {
    // Removable hood: its attachment (retailer copy: metal zip) sits under the funnel's back edge
    // and never shows in Puffer1-3; only the self-colour root seam stitch does (L2: the grey
    // teeth band drew the dark bits round the collar).
    diffuseColor.rgb *= 1. - .06 * (1. - smoothstep(.0005, .0012, abs(gSeamV - .006)));
  }
  // FB7675-100 inner hem (Parka6 from below): a white shirred elastic band ~4 cm deep inside the
  // open hem, so the inside near the hem is the shell's own white, gathered, not dark lining.
  float innerHem = (!gl_FrontFacing && p < 3.5 && gHem > .5 && gHem < 1.5 && gFront > .5 &&
                    gFront < 1.5) ? 1. - smoothstep(.035, .045, gHemV - gUvV.y) : 0.;
  if (innerHem > .5) {
    float shirr = .5 + .5 * sin(2. * GP * (L / .006 + .8 * gNoise3(gRestV * 41.)));
    diffuseColor.rgb *= mix(.72, 1., shirr);
    gCoat = 0.; gRough = .7;
  } else if (!gl_FrontFacing && (collar || hood)) {
    // Inside of the funnel/hood edge and the underside of the folded hood: shell fabric of the
    // jacket's own colour (Puffer1, Parka3/4), only less lit (L2: the dark lining shade drew grey
    // "ears" round the collar).
    diffuseColor.rgb *= .92; gCoat = 0.;
  } else if (!gl_FrontFacing) { diffuseColor.rgb *= gLining; gCoat = 0.; gRough = .85; }
}
`;

/** Relief normal (runs after normal_fragment_maps; `normal` already carries the weave). */
export const garmentNormal = /* glsl */ `
{
  GCtx c = gContext();
  bool collar = c.panel > 5.5 && c.panel < 6.5, back = c.panel > 1.5 && c.panel < 2.5;
  bool torso = c.panel < 3.5, sleeve = c.panel > 3.5 && c.panel < 5.5;
  float L = back ? gArcV.y : gArcV.x;
  float V = collar ? gArcV.z : gUvV.y;
  const float e = .0007;
  float ao, a1, a2, a3, f0, f1, f2, f3;
  float h0 = gRelief(c, L, V, false, ao, f0);
  float hL = gRelief(c, L + e, V, false, a1, f1);
  float hV = gRelief(c, L, V + e, false, a2, f2);
  float irr = gNoise3(gRestV * vec3(4.5, 7., 4.5));
  float fac = 1. - gIrreg * irr;
  float w = smoothstep(.002, .03, gSeamV);
  float H = h0 * fac * gLoft + f0;
  float dHdL = w * (fac * gLoft * (hL - h0) + (f1 - f0)) / e;
  float dHdV = w * (fac * gLoft * (hV - h0) + (f2 - f0)) / e;
  // Sleeve chambers follow the material arc (arc.y), not the shown v: differentiate it too.
  float dHdA = 0.;
  bool matArc = sleeve && c.arc.y > 0.;
  if (matArc) {
    GCtx cA = c; cA.arc.y += e;
    float hA = gRelief(cA, L, V, false, a3, f3);
    dHdA = w * (fac * gLoft * (hA - h0) + (f3 - f0)) / e;
  }
  vec3 n0 = nonPerturbedNormal;
  vec3 sL = gSurfGrad(n0, dFdx(L), dFdy(L));
  vec3 sV, sA = vec3(0.);
  // Depth charts from smooth, exact references (view space), never from screen derivatives:
  // the mesh is piecewise linear, so a chart's screen gradient is constant per triangle and the
  // chamber slopes drew faceted highlights (L1b). Torso/yoke/hood V is depth below a fixed height
  // (= -world y on the shown wrap): its surface gradient is -up projected on the tangent plane,
  // exactly; the collar's V is height (+up). Sleeve v and the material arc run along the sleeve
  // axis; material arc per shown arc is a per-vertex scale (garmentSurface, arc.z), interpolated
  // (the per-triangle ratio it replaces jumped from edge to edge where the sleeve stacks).
  vec3 up = (viewMatrix * vec4(0., 1., 0., 0.)).xyz;
  vec3 upT = up - dot(up, n0) * n0;
  if (sleeve) {
    vec3 ax = c.panel < 4.5 ? vec3(gAxLx, gAxLy, gAxLz) : vec3(gAxRx, gAxRy, gAxRz);
    ax = (viewMatrix * vec4(ax, 0.)).xyz;
    vec3 axT = ax - dot(ax, n0) * n0;
    sV = axT;
    if (matArc) sA = clamp(c.arc.z, .5, 4.) * axT;
    sL = gSmoothGrad(sL, cross(ax, n0), 1.);
  } else {
    sV = collar ? upT : -upT;
    if (torso || collar) sL = gSmoothGrad(sL, cross(up, n0), 1.);
    else {
      // Hood: L = |world x| (exact gradient: the projected x axis, signed by the side).
      vec3 xa = (viewMatrix * vec4(1., 0., 0., 0.)).xyz;
      sL = sign(gRestV.x) * (xa - dot(xa, n0) * n0);
    }
  }
  float okL = step(length(sL), 4.), okV = step(length(sV), 4.), okA = step(length(sA), 8.);
  float micro = gMicro(c, L, V) * w;
  float fade = 1. - smoothstep(.25, .8, max(fwidth(L), fwidth(V)) / .006);
  // (No seam-distance term: the edge-graph distance has a noisy per-triangle gradient; the
  // pinched seam is in the displaced geometry and the AO.)
  // Sleeve folds (L3) are fixed to the rest positions, not the charts: screen derivatives (smooth,
  // low-frequency field), like the irregularity.
  float sf = sleeve && c.q.w > .5 && c.elastic < .5 ? gSleeveFold(gRestV) * fac * gLoft : 0.;
  vec3 grad = okL * dHdL * sL + okV * dHdV * sV + okA * dHdA * sA
            - w * h0 * gIrreg * gLoft * gSurfGrad(normal, dFdx(irr), dFdy(irr))
            + w * gSurfGrad(normal, dFdx(sf), dFdy(sf))
            + fade * gSurfGrad(normal, dFdx(micro), dFdy(micro));
  normal = normalize(normal - grad);
  gClearN = normalize(nonPerturbedNormal - grad);
  // Seam crease: gSeamV is a per-vertex edge-graph distance, so its iso-lines follow triangle edges.
  // The old hard edge (x.62 within 0.7 cm) drew a blocky, stair-stepped grey band along the
  // armhole / dropped-shoulder seam ring (agent SH: gone with this term alone removed; shadow map,
  // AO pass, lights and normal map were all ruled out). A 2.4 cm ramp to x.86 stays a soft crease.
  gAO = mix(1., ao, w) * mix(.86, 1., smoothstep(0., .024, gSeamV));
  // Specular anti-aliasing (Tokuyoshi & Kaplanyan 2019): widen roughness by the screen-space
  // variance of the shading normal, so sub-pixel relief cannot alias into glittering streaks.
  vec3 dnx = dFdx(normal), dny = dFdy(normal);
  float kernel = min(2. * gSpecAA * (dot(dnx, dnx) + dot(dny, dny)), .18);
  roughnessFactor = sqrt(roughnessFactor * roughnessFactor + kernel);
}
`;
