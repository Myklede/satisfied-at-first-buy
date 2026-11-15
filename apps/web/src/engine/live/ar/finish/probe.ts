// Video statistics without stalling the main thread (agent V4): a rectangle of the video texture is
// drawn into a tiny render target and read back with readRenderTargetPixelsAsync (a pixel buffer
// object + fence, polled), so the CPU never waits for the GPU. Replaces drawImage(video) +
// getImageData, which forces a synchronous frame readback. Bytes are the video's raw sRGB (three
// does not decode a VideoTexture in a ShaderMaterial). Rows come back bottom-up (GL order).
import {
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector4,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { quadVertex } from './shaders';

export type PixelRect = { x: number; y: number; w: number; h: number };

export class VideoProbe {
  private readonly material = new ShaderMaterial({
    uniforms: { tVideo: { value: null }, uRect: { value: new Vector4(0, 0, 1, 1) } },
    vertexShader: quadVertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D tVideo;
      uniform vec4 uRect;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(tVideo, mix(uRect.xy, uRect.zw, vUv)).rgb, 1.0); }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly targets = new Map<string, WebGLRenderTarget>();
  private readonly busy = new Set<string>();

  constructor() {
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /**
   * Draws `rect` (source px, y down) of the video into a w×h target and starts an asynchronous
   * readback. Null when a read under `name` is still in flight (one per name).
   */
  read(
    renderer: WebGLRenderer,
    name: string,
    video: Texture,
    rect: PixelRect,
    frame: { width: number; height: number },
    w: number,
    h: number,
  ): Promise<Uint8Array> | null {
    if (this.busy.has(name)) return null;
    let target = this.targets.get(name);
    if (!target || target.width !== w || target.height !== h) {
      target?.dispose();
      target = new WebGLRenderTarget(w, h, { type: UnsignedByteType, depthBuffer: false });
      this.targets.set(name, target);
    }
    const W = frame.width,
      H = frame.height;
    this.material.uniforms.tVideo.value = video;
    this.material.uniforms.uRect.value.set(
      rect.x / W,
      1 - (rect.y + rect.h) / H,
      (rect.x + rect.w) / W,
      1 - rect.y / H,
    );
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    this.busy.add(name);
    const buffer = new Uint8Array(w * h * 4);
    const pending = (
      renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h, buffer) as Promise<Uint8Array>
    ).finally(() => this.busy.delete(name));
    // three r181 leaves its PIXEL_PACK_BUFFER bound while it waits for the fence; any synchronous
    // readPixels meanwhile (evaluation readbacks, other code in this context) then fails with
    // INVALID_OPERATION. Unbind it now; three re-binds it to copy the data when the fence lands.
    const gl = renderer.getContext();
    if ('PIXEL_PACK_BUFFER' in gl) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return pending;
  }

  dispose() {
    for (const t of this.targets.values()) t.dispose();
    this.targets.clear();
    this.material.dispose();
    this.geometry.dispose();
  }
}
