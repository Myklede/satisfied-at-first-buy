// Finishing-pass shaders (agent V4). WebGL2 (three wraps GLSL1-style ShaderMaterials in
// #version 300 es, so textureLod is available). Coordinates: vUv has its origin bottom left;
// a fragment's source pixel is p = (vUv.x · W, (1 − vUv.y) · H), y down, like the landmarks.
// Masks are row 0 = top and are sampled at p / (W, H). The region test mirrors geometry.ts
// regionAt (unit-tested there).

export const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Shared: the jacket's grade (exposure, white balance, tone mapping, sRGB, black lift). */
const grade = /* glsl */ `
  uniform float uExposure;
  uniform vec3 uGain;
  uniform float uLift;
  // Khronos PBR Neutral (three's NeutralToneMapping), exposure applied first: the kiosk's look.
  vec3 neutral(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    color *= uExposure;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }
  vec3 toSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
#ifdef F4_CAMERA
  // F4X (?f4light=1): a camera-like tone curve. Each channel rolls off and clips on its own, as the
  // sensor and ISP do, so lit crowns reach white while the shaded channels keep the camera's cast
  // (Neutral preserves hue up to the peak: a cool-balanced white parka could never reach white).
  vec3 camera(vec3 c) {
    c *= uExposure;
    const float a = 0.75;
    vec3 over = max(c - a, 0.0);
    return min(c, vec3(a)) + (1.0 - a) * (1.0 - exp(-over / (1.0 - a)));
  }
#endif
  vec3 gradeColour(vec3 linear) {
#ifdef F4_CAMERA
    vec3 s = toSrgb(camera(linear * uGain));
#else
    vec3 s = toSrgb(neutral(linear * uGain));
#endif
    return uLift + (1.0 - uLift) * s;
  }
`;

/**
 * Pass A, at half the canvas size into a mipmapped target: the graded jacket, premultiplied
 * (display sRGB · alpha). Its mip chain is the push-pull pyramid for the coverage fill and the
 * blurred jacket cover for the shadows and the near-jacket test.
 */
export const fillFragment = /* glsl */ `
  uniform sampler2D tWarped;
  varying vec2 vUv;
  ${grade}
  void main() {
    vec4 w = texture2D(tWarped, vUv);
    if (w.a < 0.003) { gl_FragColor = vec4(0.0); return; }
    gl_FragColor = vec4(gradeColour(w.rgb / w.a) * w.a, w.a);
  }
`;

/**
 * Pass B, the composite onto the canvas (which holds the video), premultiplied over:
 *   jacket (blurred to the camera's softness, feathered, graded, collar inner shadow)
 *   + coverage fill where real clothing shows beside the jacket in the upper-body region, shaded
 *     with the real garment's folds
 *   × closed dark cuffs (foreshortened sleeves); real hands cut back out beyond the opening;
 *   + contact shadow on the real body next to the jacket and in enclosed gaps (never a halo on
 *     the background); + grain at the camera's σ.
 * uMode 1 (evaluation): R = upper-body clothing (the fill's region), G = uncovered before
 * (warped alpha < 0.5), B = uncovered after (final alpha < 0.5), A = the fill's own alpha.
 * uMode 2 (evaluation, independent of the fill's region): R = every clothes-class person pixel
 * above the hip line except the forearms; G, B as in mode 1.
 */
export const compositeFragment = /* glsl */ `
  uniform sampler2D tWarped;
  uniform sampler2D tFill;
  uniform sampler2D tVideo;
  uniform sampler2D tPerson;
  uniform sampler2D tClass;
  uniform float uHasPerson;
  uniform float uHasClass;
  uniform vec4 uClassRect;
  // Motion since the mask's frame (motion.ts): affine rows, torso and the four arm segments.
  uniform vec3 uClassTorso[2];
  uniform vec3 uClassArm[8];
  uniform float uClassArmOn[4];
  uniform vec2 uSrc;
  uniform vec2 uTexel;
  uniform float uScale;
  uniform float uSpan;
  uniform vec2 uTorso[4];
  uniform float uTorsoOn;
  uniform vec2 uBand[4];
  uniform float uBandOn;
  uniform vec2 uSegA[4];
  uniform vec2 uSegB[4];
  uniform float uSegR[4];
  uniform float uSegFlat[4];
  uniform float uSegFlatStart[4];
  uniform vec4 uHead;
  uniform float uHeadUp;
  uniform float uHeadOn;
  uniform vec4 uNeck;
  uniform float uNeckHalf;
  uniform vec2 uHandA[2];
  uniform vec2 uHandB[2];
  uniform float uHandR[2];
  uniform vec2 uCuffW[2];
  uniform vec2 uCuffD[2];
  uniform float uCuffR[2];
  uniform float uCuffDepth[2];
  uniform float uLining;
  uniform float uMarchFrom;
  uniform float uMarchTo;
  uniform float uMinFacing;
  uniform float uMaxEnd;
  uniform float uHandSoft;
  uniform float uGrain;
  uniform float uSeed;
  uniform float uBlur;
  uniform float uFeather;
  uniform float uNear;
  uniform vec2 uPersonEdge;
  uniform vec2 uClassEdge;
  uniform float uContactR;
  uniform float uContactS;
  uniform float uEnclosureR;
  uniform float uEnclosureS;
  uniform float uInnerR;
  uniform float uInnerS;
  uniform float uShadeR;
  uniform float uShadeK;
  uniform vec2 uShadeRange;
  uniform float uShadeEdge;
  uniform float uCover;
  uniform float uCuffs;
  uniform float uHands;
  uniform float uShadow;
  uniform float uMode;
  // F4 (?f4edge=1): edge-aware person mask (joint-bilateral upsampling against the video).
  uniform float uEdge;
  uniform vec2 uPersonTexel;
  uniform float uJbuRange;
  uniform float uJbuSpatial;
  uniform vec2 uJbuBand;
  uniform vec2 uClassTexel;
  uniform float uSharpen;
  // F4 (?f4shadow=1): direction from a receiver toward its occluder (image px, y down: toward the
  // key light), and the directional reach / strength.
  // F4 (?f4hands=2): while the still lock holds the class mask, a hand's skin also comes from
  // the live frame's own colour (YCbCr skin box), so a stale mask cannot hide a real hand.
  uniform float uHandsLive;
  uniform vec2 uShadowDir;
  uniform float uShadowReach;
  uniform float uShadowS;
  // F4 (?f4fill=1): the fill continues the jacket's own texture (mirrored across its edge).
  uniform float uMirrorFill;
  varying vec2 vUv;
  ${grade}

  vec2 toUv(vec2 p) { return vec2(p.x / uSrc.x, 1.0 - p.y / uSrc.y); }
  float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
  // Mip level of tFill (half the canvas) whose texel spans 'px' source pixels.
  float lodFor(float px) { return max(0.0, log2(max(1.0, px * uScale * 0.5))); }
  float coverAt(vec2 p, float lod) { return textureLod(tFill, toUv(p), lod).a; }
  // Jacket cover averaged on a ring of radius r (source px) at a mip level: a smooth blur.
  float ringCover(vec2 p, float r, float lod) {
    float s = coverAt(p, lod);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      s += coverAt(p + vec2(cos(a), sin(a)) * r, lod);
    }
    return s / 9.0;
  }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float videoLuma(vec2 p) { return luma(texture2D(tVideo, toUv(p)).rgb); }

  float inQuad4(vec2 p, vec2 q0, vec2 q1, vec2 q2, vec2 q3) {
    float s0 = cross2(q1 - q0, p - q0);
    float s1 = cross2(q2 - q1, p - q1);
    float s2 = cross2(q3 - q2, p - q2);
    float s3 = cross2(q0 - q3, p - q3);
    bool pos = s0 >= 0.0 && s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0;
    bool neg = s0 <= 0.0 && s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0;
    return (pos || neg) ? 1.0 : 0.0;
  }
  float inQuad(vec2 p) { return inQuad4(p, uTorso[0], uTorso[1], uTorso[2], uTorso[3]); }
  float inCapsule(vec2 p, vec2 a, vec2 b, float r) {
    vec2 ab = b - a;
    float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    return length(p - a - ab * h) <= r ? 1.0 : 0.0;
  }
  // geometry.ts inHead: an ellipse round the nose, up to uHeadUp above it, down to the chin.
  float inHead(vec2 p) {
    float dx = (p.x - uHead.x) / uHead.z;
    float ry = p.y >= uHead.y ? max(uHead.w - uHead.y, 0.5 * uHead.z) : uHeadUp;
    float dy = (p.y - uHead.y) / ry;
    return dx * dx + dy * dy < 1.0 ? 1.0 : 0.0;
  }

  // geometry.ts regionAt: torso quad or arm capsules, minus the head (and the neck without classes).
  // Returns 1 inside the region, 2 inside only the shoulder band (clothes class only), 0 outside.
  float regionAt(vec2 p, out vec2 armDir, out float seg) {
    armDir = vec2(0.0);
    seg = -1.0;
    float r = 0.0;
    if (uSpan > 0.0) {
      r = uTorsoOn > 0.5 ? inQuad(p) : 0.0;
      for (int i = 0; i < 4; i++) {
        if (uSegR[i] <= 0.0) continue;
        vec2 ab = uSegB[i] - uSegA[i];
        float h = dot(p - uSegA[i], ab) / max(dot(ab, ab), 1e-6);
        if ((uSegFlat[i] > 0.5 && h > 1.0) || (uSegFlatStart[i] > 0.5 && h < 0.0)) continue;
        if (length(p - uSegA[i] - ab * clamp(h, 0.0, 1.0)) <= uSegR[i]) {
          r = 1.0;
          armDir = normalize(ab);
          seg = float(i);
        }
      }
      if (r < 0.5 && uBandOn > 0.5 && inQuad4(p, uBand[0], uBand[1], uBand[2], uBand[3]) > 0.5) r = 2.0;
      if (uHeadOn > 0.5 && inHead(p) > 0.5) r = 0.0;
      if (uHasClass < 0.5 && uNeckHalf > 0.0 && inCapsule(p, uNeck.xy, uNeck.zw, uNeckHalf) > 0.5) r = 0.0;
    }
    if (r < 0.5) { armDir = vec2(0.0); seg = -1.0; }
    return r;
  }

  float personAt(vec2 p) {
    float m = 1.0;
    if (uHasPerson > 0.5) m = smoothstep(uPersonEdge.x, uPersonEdge.y, texture2D(tPerson, p / uSrc).r);
    return m;
  }
#ifdef F4_EDGE
  // F4: the person mask refined against the full-resolution video where the low-res mask is
  // undecided (joint-bilateral upsampling: 7×7 taps of the mask, each weighted by its distance and
  // by how far the video's colour there is from this pixel's). Interior and exterior: unchanged.
  float personRefined(vec2 p) {
    float m0 = texture2D(tPerson, p / uSrc).r;
    if (m0 < 0.03 || m0 > 0.97) return m0;
    vec3 c0 = texture2D(tVideo, toUv(p)).rgb;
    float acc = 0.0, wsum = 0.0;
    float k = 0.5 / (uJbuRange * uJbuRange);
    float ks = 0.5 / (uJbuSpatial * uJbuSpatial);
    for (int j = -3; j <= 3; j++)
      for (int i = -3; i <= 3; i++) {
        vec2 q = p + vec2(float(i), float(j)) * uPersonTexel;
        float m = textureLod(tPerson, q / uSrc, 0.0).r;
        vec3 d = textureLod(tVideo, toUv(q), 0.0).rgb - c0;
        float w = exp(-dot(d, d) * k - float(i * i + j * j) * ks);
        acc += w * m;
        wsum += w;
      }
    return acc / max(wsum, 1e-5);
  }
  float personEdge(vec2 p) {
    return uHasPerson > 0.5 ? smoothstep(uJbuBand.x, uJbuBand.y, personRefined(p)) : 1.0;
  }

#endif

  // The person mask smoothed over ±1.5 source px (its edge is blocky from the 256-px model; the
  // fill's outline follows it).
  float personSoft(vec2 p) {
#ifdef F4_EDGE
    return personEdge(p);
#endif
    float m = 1.0;
    if (uHasPerson > 0.5) {
      vec2 e = vec2(1.5, 0.0);
      float v = texture2D(tPerson, p / uSrc).r * 0.4
        + (texture2D(tPerson, (p + e.xy) / uSrc).r + texture2D(tPerson, (p - e.xy) / uSrc).r
        + texture2D(tPerson, (p + e.yx) / uSrc).r + texture2D(tPerson, (p - e.yx) / uSrc).r) * 0.15;
      m = smoothstep(uPersonEdge.x, uPersonEdge.y, v);
    }
    return m;
  }

  // The class mask (a worker's, a few frames old): looked up where p was when the mask was taken
  // (its region's motion: the arm segment p lies on, else the torso), then through its box;
  // vec4(-1) outside its box.
  vec2 classPoint(vec2 p, float seg) {
    vec3 q = vec3(p, 1.0);
    vec2 r = vec2(dot(uClassTorso[0], q), dot(uClassTorso[1], q));
    for (int i = 0; i < 4; i++)
      if (abs(seg - float(i)) < 0.5 && uClassArmOn[i] > 0.5)
        r = vec2(dot(uClassArm[i * 2], q), dot(uClassArm[i * 2 + 1], q));
    return r;
  }
  vec4 classAt(vec2 p, float seg) {
    vec4 k = vec4(-1.0);
    if (uHasClass > 0.5) {
      vec2 c = (classPoint(p, seg) - uClassRect.xy) / uClassRect.zw;
      if (c.x >= 0.0 && c.y >= 0.0 && c.x <= 1.0 && c.y <= 1.0) k = texture2D(tClass, c);
    }
    return k;
  }

  // Real clothing that must be covered: classes = clothes/others, plus skin on the arms up to the
  // wrist (the sleeve covers the forearm), within the current person mask; else the person mask.
  float clothingAt(vec2 p, float onArm, float seg, float bandOnly) {
    vec4 k = classAt(p, seg);
    // No person mask and no class here: nothing is known to be clothing.
    float c = uHasPerson > 0.5 ? personSoft(p) : (k.a >= 0.0 ? 1.0 : 0.0);
    // The shoulder band holds hair and skin too: only the clothes class counts there.
    if (bandOnly > 0.5) return k.a >= 0.0 ? c * smoothstep(uClassEdge.x, uClassEdge.y, k.r) : 0.0;
    if (k.a >= 0.0) {
      float clothes = smoothstep(uClassEdge.x, uClassEdge.y, k.r);
      float skin = onArm * smoothstep(uClassEdge.x, uClassEdge.y, k.g);
      c *= max(clothes, skin);
    }
    return c;
  }

#ifdef F4_EDGE
  // classAt without implicit derivatives (it is sampled in loops: D3D warns X3595 otherwise).
  vec4 classAtLod(vec2 p, float seg) {
    vec4 k = vec4(-1.0);
    if (uHasClass > 0.5) {
      vec2 c = (classPoint(p, seg) - uClassRect.xy) / uClassRect.zw;
      if (c.x >= 0.0 && c.y >= 0.0 && c.x <= 1.0 && c.y <= 1.0) k = textureLod(tClass, c, 0.0);
    }
    return k;
  }
  // F4: the class mask's skin channel refined against the video like the person mask (a real hand
  // over the jacket gets the video's own outline, not the 256-px model's).
  float skinRefined(vec2 p, float seg, float g0) {
    if (g0 < 0.03 || g0 > 0.97) return g0;
    vec3 c0 = texture2D(tVideo, toUv(p)).rgb;
    float acc = 0.0, wsum = 0.0;
    float k = 0.5 / (uJbuRange * uJbuRange);
    float ks = 0.5 / (uJbuSpatial * uJbuSpatial);
    for (int j = -3; j <= 3; j++)
      for (int i = -3; i <= 3; i++) {
        vec2 q = p + vec2(float(i), float(j)) * uClassTexel;
        vec4 kq = classAtLod(q, seg);
        if (kq.a < 0.0) continue;
        vec3 d = textureLod(tVideo, toUv(q), 0.0).rgb - c0;
        float w = exp(-dot(d, d) * k - float(i * i + j * j) * ks);
        acc += w * kq.g;
        wsum += w;
      }
    return wsum > 1e-5 ? acc / wsum : g0;
  }

#endif

  float skinAt(vec2 p, float seg) {
    vec4 k = classAt(p, seg);
#ifdef F4_EDGE
    float s = uHasPerson > 0.5 ? personEdge(p) : (k.a >= 0.0 ? 1.0 : 0.0);
    if (k.a >= 0.0) s *= smoothstep(uJbuBand.x, uJbuBand.y, skinRefined(p, seg, k.g));
#else
    float s = uHasPerson > 0.5 ? personAt(p) : (k.a >= 0.0 ? 1.0 : 0.0);
    if (k.a >= 0.0) s *= smoothstep(uClassEdge.x, uClassEdge.y, k.g);
#endif
    return s;
  }

  // Is the jacket within uNear beside p, below it (collar, shoulder tops), or up the arm from it?
  // A half ring of taps (never above: that would grow the hem downward), two radii.
  float nearJacket(vec2 p, vec2 armDir) {
    float lod = lodFor(uNear * 0.35);
    float m = 0.0;
    bool arm = dot(armDir, armDir) > 0.0;
    for (int k = 1; k <= 2; k++) {
      float r = uNear * 0.5 * float(k);
      m = max(m, coverAt(p + vec2(r, 0.0), lod));
      m = max(m, coverAt(p - vec2(r, 0.0), lod));
      m = max(m, coverAt(p + vec2(0.7, 0.7) * r, lod));
      m = max(m, coverAt(p + vec2(-0.7, 0.7) * r, lod));
      m = max(m, coverAt(p + vec2(0.0, r), lod));
      if (arm) m = max(m, coverAt(p - armDir * r, lod));
    }
    return smoothstep(0.03, 0.25, m);
  }

  // Push-pull: the nearest jacket colour, from the fill pyramid (fine levels first).
  vec3 pushPull(vec2 uv) {
    vec4 acc = vec4(0.0);
    float w = 1.0;
    for (int k = 1; k <= 7; k++) {
      acc += textureLod(tFill, uv, float(k)) * w;
      w *= 0.5;
    }
    return acc.a > 1e-4 ? acc.rgb / acc.a : vec3(0.5);
  }

  // The fill carries the real garment's folds (luminance over its local mean) and darkens toward
  // the person's outline.
  float fillShade(vec2 p) {
    float r = uShadeR;
    float y = videoLuma(p);
    float m = (videoLuma(p + vec2(r, 0.0)) + videoLuma(p - vec2(r, 0.0))
      + videoLuma(p + vec2(0.0, r)) + videoLuma(p - vec2(0.0, r))) * 0.25;
    float folds = clamp(pow((y + 0.04) / (m + 0.04), uShadeK), uShadeRange.x, uShadeRange.y);
    float inner = (personAt(p + vec2(r, 0.0)) + personAt(p - vec2(r, 0.0))
      + personAt(p + vec2(0.0, r)) + personAt(p - vec2(0.0, r))) * 0.25;
    return folds * mix(uShadeEdge, 1.0, smoothstep(0.5, 0.95, inner));
  }

#ifdef F4_FILL
  // F4 mirror fill: the jacket reflected across its nearest edge, so the quilting, its shading and
  // the light carry on into the fill instead of a flat push-pull colour. The edge is found by
  // marching toward the jacket along its blurred cover's gradient (≤ reach); the reflection must
  // land well inside the jacket. a = weight (0 = no edge found: the push-pull colour).
  vec4 mirrorFill(vec2 p, float reach) {
    float h = max(1.0, reach * 0.2);
    float lod = lodFor(h);
    vec2 g = vec2(coverAt(p + vec2(h, 0.0), lod) - coverAt(p - vec2(h, 0.0), lod),
                  coverAt(p + vec2(0.0, h), lod) - coverAt(p - vec2(0.0, h), lod));
    if (dot(g, g) < 1e-8) return vec4(0.0);
    vec2 n = normalize(g);
    float d = -1.0;
    for (int k = 1; k <= 16; k++) {
      float t = reach * float(k) / 16.0;
      if (textureLod(tWarped, toUv(p + n * t), 0.0).a > 0.5) { d = t; break; }
    }
    if (d < 0.0) return vec4(0.0);
    // Refine the edge between the last two steps (two bisections).
    float lo = d - reach / 16.0, hi = d;
    for (int k = 0; k < 2; k++) {
      float mid = 0.5 * (lo + hi);
      if (textureLod(tWarped, toUv(p + n * mid), 0.0).a > 0.5) hi = mid; else lo = mid;
    }
    d = hi;
    vec4 w = texture2D(tWarped, toUv(p + n * (2.0 * d + 1.0)));
    if (w.a < 0.9) return vec4(0.0);
    return vec4(gradeColour(w.rgb / w.a), 1.0 - smoothstep(0.6, 1.0, d / reach));
  }

#endif

  // Skin by colour in the live frame (Chai & Ngan 1999 YCbCr box, soft edges), dark pixels out.
  float liveSkin(vec2 p) {
    vec3 c = texture2D(tVideo, toUv(p)).rgb;
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    float cb = 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5));
    float cr = 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312));
    return smoothstep(0.10, 0.16, y)
      * smoothstep(0.28, 0.31, cb) * (1.0 - smoothstep(0.49, 0.52, cb))
      * smoothstep(0.51, 0.54, cr) * (1.0 - smoothstep(0.67, 0.70, cr));
  }

  float hash(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }

  void main() {
    vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSrc;
    // uMode 5 (F4 skin mask for other passes, ArFinish.skinMask): R = the real skin here (class
    // skin × person, JBU-refined under F4_EDGE, motion-compensated with the hand's forearm), G = the
    // real-hand capsules' coverage. Canvas-aligned; nothing else is computed.
    if (uMode > 4.5) {
      vec2 dir5;
      float seg5;
      regionAt(p, dir5, seg5);
      float handIn = 0.0;
      for (int i = 0; i < 2; i++) {
        if (uHandR[i] <= 0.0) continue;
        vec2 ab = uHandB[i] - uHandA[i];
        float h = clamp(dot(p - uHandA[i], ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        float inside = 1.0 - smoothstep(uHandR[i] * (1.0 - uHandSoft), uHandR[i], length(p - uHandA[i] - ab * h));
        if (inside > handIn) { handIn = inside; seg5 = float(i * 2 + 1); }
      }
      float sk5 = skinAt(p, seg5);
      // ?f4hands=2 while held: the frozen class mask may miss a hand; the live colour does not.
      if (uHandsLive > 0.5) sk5 = max(sk5, handIn * liveSkin(p));
      gl_FragColor = vec4(sk5, handIn, 0.0, 1.0);
      return;
    }
    float aRaw = texture2D(tWarped, vUv).a;

    // Jacket: blur to the camera's softness (4 diagonal taps + centre), feather the edge.
    vec2 o = uTexel * uBlur;
    vec4 w = texture2D(tWarped, vUv) * 0.4
      + (texture2D(tWarped, vUv + vec2(o.x, o.y)) + texture2D(tWarped, vUv + vec2(-o.x, o.y))
      + texture2D(tWarped, vUv + vec2(o.x, -o.y)) + texture2D(tWarped, vUv + vec2(-o.x, -o.y))) * 0.15;
    vec2 f = uTexel * uFeather;
    float crossA = (texture2D(tWarped, vUv + vec2(f.x, 0.0)).a + texture2D(tWarped, vUv - vec2(f.x, 0.0)).a
      + texture2D(tWarped, vUv + vec2(0.0, f.y)).a + texture2D(tWarped, vUv - vec2(0.0, f.y)).a) * 0.25;
    float a = min(w.a, (2.0 * w.a + 4.0 * crossA) / 6.0);
#ifdef F4_EDGE
    // The glue's bilinear resample (≈ a half-pixel box at random sub-pixel offsets) softens the
    // jacket's detail: a mild unsharp mask restores it, inside the jacket only (no edge halo).
    {
      vec4 nb = (texture2D(tWarped, vUv + vec2(uTexel.x, 0.0)) + texture2D(tWarped, vUv - vec2(uTexel.x, 0.0))
        + texture2D(tWarped, vUv + vec2(0.0, uTexel.y)) + texture2D(tWarped, vUv - vec2(0.0, uTexel.y))) * 0.25;
      if (w.a > 0.999 && nb.a > 0.999) w.rgb = max(w.rgb + uSharpen * (w.rgb - nb.rgb), vec3(0.0));
    }
#endif
    vec3 jc = w.a > 0.003 ? gradeColour(w.rgb / w.a) : vec3(0.0);

    vec2 armDir;
    float seg;
    float region = regionAt(p, armDir, seg);
    float onArm = dot(armDir, armDir) > 0.0 ? 1.0 : 0.0;

    // Inner shadow where the collar meets the neck: jacket pixels near its edge, round the neck.
    if (uShadow > 0.5 && a > 0.0 && uNeckHalf > 0.0
        && inCapsule(p, uNeck.xy, uNeck.zw, uNeckHalf * 1.4) > 0.5) {
      float edge = 1.0 - ringCover(p, uInnerR, lodFor(uInnerR * 0.5));
      jc *= 1.0 - uInnerS * smoothstep(0.05, 0.5, edge);
    }
    vec4 col = vec4(jc * a, a);

    // Coverage: real clothing in the region, near the jacket, not under it.
    float bandOnly = region > 1.5 ? 1.0 : 0.0;
    float clothing = region > 0.5 ? clothingAt(p, onArm, seg, bandOnly) : 0.0;
    float fillA = 0.0;
    if (uCover > 0.5 && clothing > 0.0 && col.a < 0.999) {
      float cover = clothing * nearJacket(p, armDir);
      fillA = cover * (1.0 - col.a);
      if (cover > 0.0) {
        vec3 fc = pushPull(vUv);
#ifdef F4_FILL
        vec4 mf = mirrorFill(p, uNear);
        fc = mix(fc, mf.rgb, mf.a);
#endif
        col += vec4(fc * fillShade(p), 1.0) * fillA;
      }
    }

    // Cuffs: the sleeve opening, closed and dark; the real hand comes out beyond it.
    float hand = 0.0;
    for (int i = 0; i < 2; i++) {
      float r = uCuffR[i];
      float cut = -1e9;
      bool hasCut = false;
      if (r > 0.0 && (uCuffs > 0.5 || uHands > 0.5)) {
        vec2 q = p - uCuffW[i];
        float t = dot(q, uCuffD[i]);
        float s = cross2(uCuffD[i], q);
        if (abs(s) < 1.6 * r && t > (uMarchFrom - 1.0) * r && t < (uMarchTo + 1.0) * r) {
          float tEnd = -1e9;
          bool found = false, done = false, open = false;
          for (int k = 0; k <= 14; k++) {
            if (done) break;
            float tt = mix(uMarchFrom, uMarchTo, float(k) / 14.0) * r;
            float aa = texture2D(tWarped, toUv(uCuffW[i] + uCuffD[i] * tt)).a;
            if (aa > 0.5) { tEnd = tt; found = true; }
            else if (found) { done = true; open = true; }
          }
          if (found && open && abs(tEnd) <= uMaxEnd * r) {
            float b = uCuffDepth[i] * r;
            float tc = tEnd - b;
            cut = tc - 0.3 * b;
            hasCut = true;
            // The closed opening only when the sleeve reaches the wrist: a sleeve that ends short
            // is extended to the wrist by the fill, and a dark band there would sit mid-forearm.
            if (uCuffs > 0.5 && col.a > 0.0 && uCuffDepth[i] >= uMinFacing && tEnd >= -0.5 * r) {
              float e = (t - tc) * (t - tc) / (b * b) + s * s / (0.85 * 0.85 * r * r);
              float inside = 1.0 - smoothstep(0.5, 1.0, e);
              // Darker toward the centre, like a lining falling into shadow.
              col.rgb *= mix(1.0, uLining, inside * (0.6 + 0.4 * (1.0 - e)));
            }
          }
        }
      }
      if (uHands > 0.5 && uHandR[i] > 0.0) {
        vec2 ab = uHandB[i] - uHandA[i];
        float h = clamp(dot(p - uHandA[i], ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        float dist = length(p - uHandA[i] - ab * h);
        float inside = 1.0 - smoothstep(uHandR[i] * (1.0 - uHandSoft), uHandR[i], dist);
        if (inside > 0.0) {
          // Beyond the cuff opening (or the wrist when the opening was not found).
          float t = r > 0.0 ? dot(p - uCuffW[i], uCuffD[i]) : dot(p - uHandA[i], normalize(ab));
          // Never above the wrist: the forearm belongs to the sleeve (the fill extends it).
          float limit = hasCut ? max(cut, -0.15 * uHandR[i]) : -0.15 * uHandR[i];
          float beyond = smoothstep(limit - 0.15 * uHandR[i], limit + 0.15 * uHandR[i], t);
          float sk = skinAt(p, float(i * 2 + 1));
          if (uHandsLive > 0.5) sk = max(sk, liveSkin(p));
          hand = max(hand, inside * beyond * sk);
        }
      }
    }
    col *= 1.0 - hand;

    // uMode 4 (rest-stability evaluation): R = the jacket's alpha before this pass, G = the fill's
    // own alpha, B = the final alpha (before shadows).
    if (uMode > 3.5) {
      gl_FragColor = vec4(aRaw, fillA * (1.0 - hand), col.a, 1.0);
      return;
    }
    // uMode 2: the independent metric. Every clothes-class person pixel above the hip line, the
    // forearms excluded, whatever the fill's region: misses outside the region count too.
    if (uMode > 1.5) {
      float m = 0.0;
      if (uTorsoOn > 0.5) {
        vec4 k = classAt(p, seg);
        if (k.a >= 0.0 && k.r >= 0.5 && personAt(p) > 0.5) {
          vec2 hd = uTorso[2] - uTorso[3];
          vec2 n = vec2(-hd.y, hd.x);
          if (dot(uTorso[0] - uTorso[3], n) < 0.0) n = -n;
          bool above = dot(p - uTorso[3], n) > 0.0;
          bool fore = (uSegR[1] > 0.0 && inCapsule(p, uSegA[1], uSegB[1], uSegR[1]) > 0.5)
            || (uSegR[3] > 0.0 && inCapsule(p, uSegA[3], uSegB[3], uSegR[3]) > 0.5);
          if (above && !fore) m = 1.0;
        }
      }
      gl_FragColor = vec4(m, m * step(aRaw, 0.4999), m * step(col.a, 0.4999), 1.0);
      return;
    }
    if (uMode > 0.5) {
      float c = (region > 0.5 && clothing > 0.5 && hand < 0.5) ? 1.0 : 0.0;
      // A = the fill's own coverage (stale-mask evaluation: fill on what is not clothing).
      gl_FragColor = vec4(c, c * step(aRaw, 0.4999), c * step(col.a, 0.4999), fillA * (1.0 - hand));
      return;
    }

    // Contact shadow on the real body next to the jacket; enclosed gaps (armpits) darken too.
    // (Skipped far from the jacket: nothing within twice the enclosure radius.)
    if (uShadow > 0.5 && col.a < 0.995 && uSpan > 0.0
        && textureLod(tFill, vUv, lodFor(uEnclosureR * 4.0)).a > 0.001) {
      float contact = ringCover(p, uContactR, lodFor(uContactR * 0.5));
      float enclosed = ringCover(p, uEnclosureR, lodFor(uEnclosureR * 0.5));
      float person = uHasPerson > 0.5 ? personAt(p) : 0.0;
#ifdef F4_SHADOW
      // Short-range occlusion biased by the key light: the jacket's blurred cover toward the light
      // (the collar over the neck and chin, the hem over the trousers, a cuff over the hand) at two
      // distances, plus a weak symmetric part (ambient occlusion right at the edge).
      float lodS = lodFor(uShadowReach * 0.3);
      float toward = max(coverAt(p + uShadowDir * uShadowReach * 0.45, lodS),
                         0.75 * coverAt(p + uShadowDir * uShadowReach, lodS));
      float ao = ringCover(p, uContactR * 0.6, lodFor(uContactR * 0.3));
      float occ = max(toward, 0.6 * ao);
      float s = max(uShadowS * smoothstep(0.05, 0.6, occ) * person,
                    uEnclosureS * smoothstep(0.5, 0.85, enclosed));
      // On a real hand right under its cuff the shadow stays (it is where the cuff shades it).
      s *= 1.0 - hand * 0.2;
#else
      float s = max(uContactS * smoothstep(0.03, 0.45, contact) * person,
                    uEnclosureS * smoothstep(0.5, 0.85, enclosed));
      s *= 1.0 - hand * 0.5;
#endif
      col += vec4(0.0, 0.0, 0.0, s * (1.0 - col.a));
    }

    // Grain at the camera's σ and grain size (source pixels).
    if (uGrain > 0.0 && col.a > 0.0) {
      vec2 cell = floor(p);
      float n = (hash(cell) + hash(cell + 17.17) - 1.0) * 2.449;
      col.rgb += col.a * n * uGrain;
    }
    gl_FragColor = col;
  }
`;
