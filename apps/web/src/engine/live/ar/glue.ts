// The AR "glue" renderer (agent V2; hybrid decision 2026-11-13): the jacket is rendered from the
// 3D solve into an offscreen target, then drawn onto the video through a warped grid (warp.ts)
// so its keypoints land on the person's. All fit numbers come from the 3D, never from the warp;
// the AR view is labelled "visual overlay". Plain Three.js.
//
// Colour: the jacket's materials render linear HDR into the target (three skips tone mapping for
// render targets); this pass applies the kiosk's Khronos PBR Neutral tone mapping with the
// matched exposure and encodes sRGB, over premultiplied alpha (MSAA edges blend cleanly).
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  HalfFloatType,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import {
  createGrid,
  gridFieldAt,
  mlsRigid,
  warpGrid,
  warpGridBounded,
  type BoundedOptions,
  type BoundedReport,
  type Control,
  type Pt,
  type WarpGrid,
  type WarpReport,
} from './warp';
import { UnsignedByteType } from 'three';
import { applySimilarity, type Similarity } from './rigidGlue';
import { readF4Flags } from './finish/f4';

const vertex = /* glsl */ `
  attribute vec2 aUv;
  varying vec2 vUv;
  void main() {
    vUv = aUv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D tJacket;
  uniform float uExposure;
  uniform vec2 uTexel;
  uniform float uFeather;
  varying vec2 vUv;
  // Khronos PBR Neutral (three's NeutralToneMapping), exposure applied first.
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
  void main() {
    vec4 j = texture2D(tJacket, vUv);
    if (j.a < 0.003) discard;
    vec3 rgb = toSrgb(neutral(j.rgb / j.a));
    // Feather: the edge alpha averaged over a ±uFeather px cross (1–2 px soft edge, like a lens).
    vec2 o = uTexel * uFeather;
    float a = (j.a * 2.0 + texture2D(tJacket, vUv + vec2(o.x, 0.0)).a + texture2D(tJacket, vUv - vec2(o.x, 0.0)).a
      + texture2D(tJacket, vUv + vec2(0.0, o.y)).a + texture2D(tJacket, vUv - vec2(0.0, o.y)).a) / 6.0;
    a = min(j.a, a);
    gl_FragColor = vec4(rgb * a, a);
  }
`;

/**
 * Contact shadow under the jacket: where the jacket's alpha, blurred over ≈ uRadius px, is
 * present but the jacket itself is not (just outside its edge: neck, armholes, sides, hem),
 * the video is darkened a little, as a real garment shades the body and clothes it touches.
 */
const shadowFragment = /* glsl */ `
  uniform sampler2D tJacket;
  uniform vec2 uTexel;
  uniform float uRadius;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float here = texture2D(tJacket, vUv).a;
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.785398;
      vec2 d = vec2(cos(ang), sin(ang)) * uTexel * uRadius;
      sum += texture2D(tJacket, vUv + d).a + texture2D(tJacket, vUv + d * 0.5).a;
    }
    float near = sum / 16.0;
    float s = uStrength * near * (1.0 - here);
    if (s < 0.004) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, s);
  }
`;

export type GlueStats = {
  frames: number;
  capBound: number;
  lastKept: number;
  lastMaxScaleChange: number;
  lastResidualPx: number;
  warpMs: number;
};

export class ArGlue {
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly shadowMaterial: ShaderMaterial;
  private readonly shadowMesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly shadowScene = new Scene();
  /** Look knobs (heuristic): edge feather (px) and contact shadow radius (px) and strength. */
  feather = 1.5;
  // Contact shadow OFF by default: agent V4's finisher owns contact shadows, and this pass also
  // darkened the background around the jacket (a grey halo, user recording 15:18).
  shadow = { radius: 9, strength: 0 };
  private grid?: WarpGrid;
  private frame = { width: 0, height: 0 };
  report: WarpReport | null = null;
  /**
   * Bounded local warp (F3, ?f3warp=1; warp.ts warpGridBounded): when set, every grid triangle
   * stays unfolded and within the stretch cap, and where the warp would tear it falls back
   * locally to the 3D render, instead of the global attenuation (or no bound at all).
   */
  bounded: BoundedOptions | null = null;
  /** The last bounded warp's per-vertex keep (null in the global mode). */
  private keep: Float32Array | null = null;
  /** The last bounded report (diagnostics). */
  boundedReport: BoundedReport | null = null;
  /** F3 (?f3rigid=1): the rigid transform of the last warpRigid(), or null (free-form warp). */
  rigid: Similarity | null = null;
  /** Named controls after the warp: where their rendered point ended up (px) and its error. */
  warped: Record<string, { at: Pt; errorPx: number }> = {};
  stats: GlueStats = {
    frames: 0,
    capBound: 0,
    lastKept: 1,
    lastMaxScaleChange: 0,
    lastResidualPx: 0,
    warpMs: 0,
  };

  constructor(
    private readonly cols = 24,
    private readonly scaleCap = 0.15,
  ) {
    this.material = new ShaderMaterial({
      uniforms: {
        tJacket: { value: this.target.texture },
        uExposure: { value: 0.92 },
        uTexel: { value: new Vector2(1, 1) },
        uFeather: { value: 1.5 },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      toneMapped: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.shadowMaterial = new ShaderMaterial({
      uniforms: {
        tJacket: { value: this.target.texture },
        uTexel: { value: new Vector2(1, 1) },
        uRadius: { value: 9 },
        uStrength: { value: 0.28 },
      },
      vertexShader: vertex,
      fragmentShader: shadowFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.shadowMesh = new Mesh(this.geometry, this.shadowMaterial);
    this.shadowMesh.frustumCulled = false;
    this.shadowScene.add(this.shadowMesh);
  }

  /** Sizes the offscreen target to the canvas and the grid to the source frame. */
  ensureSize(renderer: WebGLRenderer, frameWidth: number, frameHeight: number) {
    const size = renderer.getDrawingBufferSize(new Vector2());
    if (this.target.width !== size.x || this.target.height !== size.y)
      this.target.setSize(Math.max(1, size.x), Math.max(1, size.y));
    if (this.frame.width === frameWidth && this.frame.height === frameHeight && this.grid) return;
    this.frame = { width: frameWidth, height: frameHeight };
    this.keep = null;
    const rows = Math.max(4, Math.round((this.cols * frameHeight) / Math.max(1, frameWidth)));
    this.grid = createGrid(frameWidth, frameHeight, this.cols, rows);
    const n = (this.cols + 1) * (rows + 1);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = this.grid.source[i * 2] / frameWidth;
      uv[i * 2 + 1] = 1 - this.grid.source[i * 2 + 1] / frameHeight;
    }
    const index: number[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const a = r * (this.cols + 1) + c,
          b = a + 1,
          d = a + this.cols + 1,
          e = d + 1;
        index.push(a, d, b, b, d, e);
      }
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute('aUv', new BufferAttribute(uv, 2));
    this.geometry.setIndex(index);
    this.setPositions(this.grid.source);
  }

  private setPositions(px: Float32Array) {
    const { width, height } = this.frame;
    const pos = this.geometry.getAttribute('position') as BufferAttribute;
    const a = pos.array as Float32Array;
    for (let i = 0; i < px.length / 2; i++) {
      a[i * 3] = (px[i * 2] / width) * 2 - 1;
      a[i * 3 + 1] = 1 - (px[i * 2 + 1] / height) * 2;
      a[i * 3 + 2] = 0;
    }
    pos.needsUpdate = true;
  }

  /** Warps the grid to the controls (source px → target px); identity with no controls. */
  /** The last frame's controls (diagnostics). */
  lastControls: readonly Control[] = [];

  /** Where this frame's warp sends an arbitrary rendered point (px). */
  mapPoint(p: Pt): Pt {
    if (this.rigid) return applySimilarity(this.rigid, p);
    if (this.lastControls.length < 3 || !this.report) return [p[0], p[1]];
    const kept = this.keepAt(p);
    const [x, y] = mlsRigid(p, this.lastControls);
    return [p[0] + (x - p[0]) * kept, p[1] + (y - p[1]) * kept];
  }

  /** The kept fraction of the warp at a rendered point: the global one, or the local keep. */
  private keepAt(p: Pt): number {
    if (this.rigid) return 1;
    if (this.keep && this.grid) return gridFieldAt(this.grid, this.keep, p);
    return this.report?.kept ?? 1;
  }

  /**
   * F3 (?f3rigid=1): places the whole layer by one transform (rigidGlue.ts), no free-form warp.
   * `controls` are kept for the residual readouts (`warped`).
   */
  warpRigid(t: Similarity, controls: readonly Control[]) {
    const grid = this.grid;
    if (!grid) return;
    const t0 = performance.now();
    this.rigid = t;
    this.keep = null;
    this.boundedReport = null;
    this.lastControls = controls;
    const s = grid.source,
      out = grid.target;
    for (let i = 0; i < s.length; i += 2) {
      const q = applySimilarity(t, [s[i], s[i + 1]]);
      out[i] = q[0];
      out[i + 1] = q[1];
    }
    this.setPositions(out);
    this.warped = {};
    let worst = 0;
    for (const c of controls) {
      if (!c.name) continue;
      const at = applySimilarity(t, c.p);
      const errorPx = Math.hypot(at[0] - c.q[0], at[1] - c.q[1]);
      this.warped[c.name] = { at, errorPx };
      worst = Math.max(worst, errorPx);
    }
    this.report = {
      kept: 1,
      capBound: false,
      maxScaleChange: Math.abs(t.s - 1),
      maxResidualPx: worst,
    };
    this.stats.frames++;
    const k = 0.1;
    this.stats.warpMs = this.stats.warpMs * (1 - k) + (performance.now() - t0) * k;
  }

  warp(controls: readonly Control[]) {
    const grid = this.grid;
    if (!grid) return;
    this.rigid = null;
    // The stillness hold passes the very same controls array: the bounded warp then keeps its
    // grid exactly (its keep would otherwise still be rising toward 1 for a few frames).
    if (this.bounded && this.keep && controls === this.lastControls && controls.length >= 2) return;
    this.lastControls = controls;
    const t0 = performance.now();
    if (controls.length < 2) {
      this.report = null;
      this.keep = null;
      this.boundedReport = null;
      this.setPositions(grid.source);
    } else {
      if (this.bounded) {
        const r = warpGridBounded(grid, controls, { ...this.bounded, previous: this.keep });
        this.report = r;
        this.boundedReport = r;
        this.keep = r.keep;
      } else {
        this.report = warpGrid(grid, controls, this.scaleCap);
        this.keep = null;
        this.boundedReport = null;
      }
      this.setPositions(grid.target);
      this.warped = {};
      for (const c of controls) {
        if (!c.name) continue;
        const [x, y] = mlsRigid(c.p, controls);
        const k = this.keepAt(c.p);
        const at: Pt = [c.p[0] + (x - c.p[0]) * k, c.p[1] + (y - c.p[1]) * k];
        this.warped[c.name] = { at, errorPx: Math.hypot(at[0] - c.q[0], at[1] - c.q[1]) };
      }
      this.stats.frames++;
      if (this.report.capBound) this.stats.capBound++;
      this.stats.lastKept = this.report.kept;
      this.stats.lastMaxScaleChange = this.report.maxScaleChange;
      this.stats.lastResidualPx = this.report.maxResidualPx;
    }
    const k = 0.1;
    this.stats.warpMs = this.stats.warpMs * (1 - k) + (performance.now() - t0) * k;
  }

  /** The warped jacket into its own target (premultiplied linear colour), for the finisher. */
  readonly warpedTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly copyMaterial = new ShaderMaterial({
    uniforms: { tJacket: { value: this.target.texture }, uSize: { value: new Vector2(1, 1) } },
    // F4 (?f4edge=1): Catmull-Rom resample through the warp grid instead of one bilinear tap (a
    // half-pixel box at random sub-pixel offsets: the last ~0.3 px of the jacket's edge softness and
    // much of its fine detail). 9 bilinear taps (Jimenez's bicubic trick), premultiplied, clamped
    // against overshoot. Without the flag the shader is the plain copy.
    defines: readF4Flags().edge ? { F4_EDGE: 1 } : {},
    vertexShader: vertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D tJacket;
      uniform vec2 uSize;
      varying vec2 vUv;
      #ifdef F4_EDGE
      vec4 catmullRom(vec2 uv) {
        vec2 p = uv * uSize;
        vec2 t1 = floor(p - 0.5) + 0.5;
        vec2 f = p - t1;
        vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        vec2 w3 = f * f * (-0.5 + 0.5 * f);
        vec2 w12 = w1 + w2;
        vec2 t0 = (t1 - 1.0) / uSize, t3 = (t1 + 2.0) / uSize, t12 = (t1 + w2 / w12) / uSize;
        vec4 r = texture2D(tJacket, vec2(t0.x, t0.y)) * w0.x * w0.y
          + texture2D(tJacket, vec2(t12.x, t0.y)) * w12.x * w0.y
          + texture2D(tJacket, vec2(t3.x, t0.y)) * w3.x * w0.y
          + texture2D(tJacket, vec2(t0.x, t12.y)) * w0.x * w12.y
          + texture2D(tJacket, vec2(t12.x, t12.y)) * w12.x * w12.y
          + texture2D(tJacket, vec2(t3.x, t12.y)) * w3.x * w12.y
          + texture2D(tJacket, vec2(t0.x, t3.y)) * w0.x * w3.y
          + texture2D(tJacket, vec2(t12.x, t3.y)) * w12.x * w3.y
          + texture2D(tJacket, vec2(t3.x, t3.y)) * w3.x * w3.y;
        r.a = clamp(r.a, 0.0, 1.0);
        r.rgb = max(r.rgb, vec3(0.0));
        return r;
      }
      void main() { gl_FragColor = catmullRom(vUv); }
      #else
      void main() { gl_FragColor = texture2D(tJacket, vUv); }
      #endif
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  /** Draws this warped layer (premultiplied linear) into the current render target. */
  drawCopy(renderer: WebGLRenderer) {
    this.copyMaterial.uniforms.uSize.value.set(this.target.width, this.target.height);
    const material = this.mesh.material;
    this.mesh.material = this.copyMaterial;
    renderer.render(this.scene, this.camera);
    this.mesh.material = material;
  }
  /**
   * All warped layers (this one first, then `over`, e.g. the sleeves) composited into one
   * premultiplied linear target, for the finisher.
   */
  warpTo(renderer: WebGLRenderer, over: readonly ArGlue[] = []) {
    if (
      this.warpedTarget.width !== this.target.width ||
      this.warpedTarget.height !== this.target.height
    )
      this.warpedTarget.setSize(this.target.width, this.target.height);
    renderer.setRenderTarget(this.warpedTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    this.drawCopy(renderer);
    for (const g of over) g.drawCopy(renderer);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    return this.warpedTarget;
  }

  /** Draws the warped jacket over whatever the canvas holds (premultiplied alpha). */
  draw(renderer: WebGLRenderer, exposure: number) {
    const texel = new Vector2(1 / this.target.width, 1 / this.target.height);
    this.material.uniforms.uExposure.value = exposure;
    this.material.uniforms.uTexel.value.copy(texel);
    this.material.uniforms.uFeather.value = this.feather;
    renderer.setRenderTarget(null);
    if (this.shadow.strength > 0) {
      this.shadowMaterial.uniforms.uTexel.value.copy(texel);
      this.shadowMaterial.uniforms.uRadius.value = this.shadow.radius;
      this.shadowMaterial.uniforms.uStrength.value = this.shadow.strength;
      renderer.render(this.shadowScene, this.camera);
    }
    renderer.render(this.scene, this.camera);
  }

  /** Evaluation: the warped jacket's alpha at the source resolution (row 0 = top). */
  readMask(renderer: WebGLRenderer): { data: Uint8Array; width: number; height: number } {
    const { width, height } = this.frame;
    const rt = new WebGLRenderTarget(width, height, { type: UnsignedByteType });
    const px = new Uint8Array(width * height * 4);
    try {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      // V4's async colour reads may leave a PIXEL_PACK buffer bound: a sync read then fails.
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      renderer.readRenderTargetPixels(rt, 0, 0, width, height, px);
    } finally {
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      rt.dispose();
    }
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        out[y * width + x] = px[((height - 1 - y) * width + x) * 4 + 3];
    return { data: out, width, height };
  }

  dispose() {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.shadowMaterial.dispose();
    this.warpedTarget.dispose();
    this.copyMaterial.dispose();
  }
}
