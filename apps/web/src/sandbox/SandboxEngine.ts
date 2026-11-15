// Framework-agnostic jacket sandbox: wraps the kiosk's own Viewer (same renderer, tone mapping,
// exposure, lights, GarmentLayer shader) and adds camera presets, alternative lighting looks and
// debug overlays. Nothing here changes how the garment is rendered while every debug toggle is off
// and the lighting is "kiosk".
import {
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  type MeshPhysicalMaterial,
  type MeshStandardMaterial,
} from 'three';
import {
  api,
  type Capabilities,
  type FitResponse,
  type GarmentFitResponse,
  type GarmentSpec,
} from '../api';
import { garmentCoordinates } from '../engine/garmentSurface';
import { Viewer } from '../engine/Viewer';
import { averageSrgb, type Rgb } from './colour';
import {
  ALT_LIGHTING,
  garmentGeo,
  sortSizes,
  viewPose,
  type GarmentGeo,
  type LightingId,
  type LightingLook,
  type ViewId,
} from './presets';
import { bafflePhase, isolineSegments, panelBoundarySegments } from './seams';

export interface DebugFlags {
  wireframe: boolean;
  seams: boolean;
  normals: boolean;
  garment: boolean;
  body: boolean;
}
export const DEBUG_OFF: DebugFlags = {
  wireframe: false,
  seams: false,
  normals: false,
  garment: true,
  body: true,
};

export interface BodyInput {
  sex: 'female' | 'male';
  height_cm: number;
  weight_kg: number;
}

/** Kiosk fit defaults (KioskApp: t-shirt under-layer, regular preference, neutral shape). */
const DEFAULT_LAYER = 't-shirt';
/** One colour per shell panel id (garmentSurface.ts PANEL), for the boundary lines. */
const PANEL_COLOURS = [
  0xff5a36, 0x2bb5ff, 0xffd400, 0x39d353, 0xb36bff, 0xff7ad9, 0x00e0c6, 0xff9d2e, 0xffffff,
];
const BAFFLE_COLOUR = 0xff00aa;
/** Lines sit this far above the base shell: the chamber grooves, where the shader pinches the fabric. */
const LINE_LIFT_M = 0.0015;

const NORMAL_VIEW_HOOK = '#include <dithering_fragment>';

export class SandboxEngine {
  readonly viewer: Viewer;
  fit?: GarmentFitResponse;
  body?: FitResponse;
  product?: GarmentSpec;
  size = '';
  geo?: GarmentGeo;
  /** Line segments drawn by the seam overlay (0 = nothing found on this shell). */
  seamStats = { boundary: 0, baffle: 0 };
  lighting: LightingId = 'kiosk';
  debug: DebugFlags = { ...DEBUG_OFF };
  private capabilities?: Capabilities;
  private layerCm?: number;
  private kioskLook: LightingLook;
  private directional: DirectionalLight[];
  private hemisphere: HemisphereLight;
  private ground: Mesh;
  private seams = new Group();
  private originalCompile?: MeshPhysicalMaterial['onBeforeCompile'];
  private normalUniform = { value: 0 };
  /** Guards stale async loads: only the latest request may touch the scene. */
  private ticket = 0;

  constructor(container: HTMLElement) {
    this.viewer = new Viewer(container, () => undefined);
    const { viewer } = this;
    viewer.idleTurntable = false;
    viewer.tapes.visible = false;
    viewer.fitAnnotations.visible = false;
    viewer.fitAnnotations.configure({ seamOnly: true });
    // Close-ups go closer than the kiosk's 0.45 m orbit limit (control limit only, not the look).
    viewer.controls.minDistance = 0.12;
    viewer.scene.add(this.seams);
    const children = viewer.scene.children;
    this.directional = children.filter((c): c is DirectionalLight => c instanceof DirectionalLight);
    this.hemisphere = children.find((c): c is HemisphereLight => c instanceof HemisphereLight)!;
    this.ground = children.find((c): c is Mesh => c instanceof Mesh)!;
    if (this.directional.length !== 3 || !this.hemisphere || !this.ground)
      throw new Error('Viewer lights changed: update SandboxEngine.captureKioskLook');
    this.kioskLook = this.captureKioskLook();
  }

  get canvas() {
    return this.viewer.renderer.domElement;
  }

  // ------------------------------------------------------------ lighting
  /** The Viewer's own look, read back from the live scene so it can never drift from the demo. */
  private captureKioskLook(): LightingLook {
    const { viewer } = this;
    const [key, fill, rim] = this.directional.map((l) => ({
      colour: l.color.getHex(),
      intensity: l.intensity,
      position: [l.position.x, l.position.y, l.position.z] as const,
    }));
    return {
      label: 'kiosk',
      background: `#${(viewer.scene.background as Color).getHexString()}`,
      ground: (this.ground.material as MeshStandardMaterial).color.getHex(),
      exposure: viewer.renderer.toneMappingExposure,
      environment: viewer.scene.environmentIntensity,
      hemisphere: {
        sky: this.hemisphere.color.getHex(),
        ground: this.hemisphere.groundColor!.getHex(),
        intensity: this.hemisphere.intensity,
      },
      lights: [key, fill, rim],
    };
  }

  setLighting(id: LightingId) {
    this.lighting = id;
    const look = id === 'kiosk' ? this.kioskLook : ALT_LIGHTING[id];
    const { viewer } = this;
    (viewer.scene.background as Color).set(look.background);
    (this.ground.material as MeshStandardMaterial).color.set(look.ground);
    viewer.renderer.toneMappingExposure = look.exposure;
    viewer.scene.environmentIntensity = look.environment;
    this.hemisphere.color.set(look.hemisphere.sky);
    this.hemisphere.groundColor!.set(look.hemisphere.ground);
    this.hemisphere.intensity = look.hemisphere.intensity;
    this.directional.forEach((light, i) => {
      const spec = look.lights[i];
      light.color.set(spec.colour);
      light.intensity = spec.intensity;
      light.position.set(...spec.position);
    });
  }

  // ------------------------------------------------------------ data
  async loadBody(input: BodyInput) {
    const ticket = ++this.ticket;
    this.capabilities ??= await api.capabilities();
    if (this.layerCm === undefined) {
      const options = await api.garmentOptions();
      const layer = options.layer_presets_cm[DEFAULT_LAYER];
      if (layer === undefined) throw new Error(`Missing under-layer preset ${DEFAULT_LAYER}`);
      this.layerCm = layer;
    }
    // Only the three fields: the API rejects unknown ones (a preset also carries id and label).
    const body = await api.fit({
      sex: input.sex,
      height_cm: input.height_cm,
      weight_kg: input.weight_kg,
      shape_reference: 'neutral',
      density_kg_m3: this.capabilities.default_density_kg_m3,
      known_measurements: {},
    });
    const landmarks = await api.landmarks(body.body_id);
    if (ticket !== this.ticket) return false;
    await this.viewer.setBody(body, landmarks);
    this.body = body;
    this.fit = undefined;
    this.geo = undefined;
    this.clearSeams();
    return true;
  }

  async loadJacket(product: GarmentSpec, size?: string) {
    if (!this.body || this.layerCm === undefined) throw new Error('Load a body first');
    const ticket = ++this.ticket;
    const fit = await api.garmentFit({
      body_id: this.body.body_id,
      product_id: product.product_id,
      layer_cm: this.layerCm,
      preference: 'regular',
    });
    if (ticket !== this.ticket) return false;
    this.product = product;
    this.fit = fit;
    const sizes = sortSizes(Object.keys(fit.sizes));
    return this.showSize(
      size && sizes.includes(size) ? size : (fit.recommended_size ?? sizes[0]),
      ticket,
    );
  }

  sizes() {
    return this.fit ? sortSizes(Object.keys(this.fit.sizes)) : [];
  }

  async setSize(size: string) {
    return this.showSize(size, ++this.ticket);
  }

  private async showSize(size: string, ticket: number) {
    const fit = this.fit;
    if (!fit) throw new Error('Load a jacket first');
    await this.viewer.setGarment(fit, size);
    if (ticket !== this.ticket) return false;
    this.size = size;
    this.afterGarment(fit, size);
    return true;
  }

  /** Recomputes the close-up targets and overlays for the shell now on screen. */
  private afterGarment(fit: GarmentFitResponse, size: string) {
    const target = this.viewer.garment.pickTarget;
    this.geo = undefined;
    if (target) {
      const position = target.mesh.geometry.getAttribute('position').array;
      this.geo = garmentGeo(
        position,
        target.asset.panels,
        fit.sizes[size].anchors,
        this.viewer.rig.height,
      );
    }
    this.rebuildSeams();
    this.applyDebug();
  }

  // ------------------------------------------------------------ camera
  goTo(view: ViewId) {
    const pose = viewPose(view, this.viewer.rig.height, this.geo);
    const { viewer } = this;
    viewer.idleTurntable = false;
    // The same 'start' event the rig listens to: cancels a preset transition in flight.
    viewer.controls.dispatchEvent({ type: 'start' });
    viewer.camera.fov = 35;
    viewer.camera.updateProjectionMatrix();
    viewer.controls.target.set(...pose.target);
    viewer.camera.position.set(...pose.position);
    viewer.controls.update();
  }

  // ------------------------------------------------------------ debug
  private garmentMaterial() {
    // GarmentLayer keeps its shader material private; the sandbox only flips debug switches on it.
    return this.viewer.garment['material'] as MeshPhysicalMaterial;
  }

  setDebug(flags: Partial<DebugFlags>) {
    this.debug = { ...this.debug, ...flags };
    this.applyDebug();
  }

  private applyDebug() {
    const { viewer, debug } = this;
    viewer.garment.visible = debug.garment;
    viewer.body.visible = debug.body;
    this.seams.visible = debug.seams && debug.garment;
    viewer.body.wireframe(debug.wireframe);
    const material = this.garmentMaterial();
    material.wireframe = debug.wireframe;
    this.applyNormals(material, debug.normals);
  }

  /**
   * Normals view: the garment's own shading normal (view space, after the shader's baffle and weave
   * relief) written straight to the output. Hooked into the material's onBeforeCompile only while
   * on, so with the toggle off the compiled program is the kiosk's.
   */
  private applyNormals(material: MeshPhysicalMaterial, on: boolean) {
    if (on === (this.originalCompile !== undefined)) return;
    if (on) {
      const original = material.onBeforeCompile;
      this.originalCompile = original;
      material.onBeforeCompile = (shader, renderer) => {
        original.call(material, shader, renderer);
        shader.uniforms.sbxNormals = this.normalUniform;
        shader.fragmentShader =
          'uniform float sbxNormals;\n' +
          shader.fragmentShader.replace(
            NORMAL_VIEW_HOOK,
            `if (sbxNormals > .5) gl_FragColor = vec4(normalize(normal) * .5 + .5, 1.);\n${NORMAL_VIEW_HOOK}`,
          );
      };
      material.customProgramCacheKey = () => 'sandbox-normals';
      this.normalUniform.value = 1;
    } else {
      material.onBeforeCompile = this.originalCompile!;
      material.customProgramCacheKey = Object.getPrototypeOf(material).customProgramCacheKey;
      this.originalCompile = undefined;
      this.normalUniform.value = 0;
    }
    material.needsUpdate = true;
  }

  private clearSeams() {
    for (const child of [...this.seams.children]) {
      this.seams.remove(child);
      if (child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as LineBasicMaterial).dispose();
      }
    }
  }

  /**
   * Solid where the line is on the visible side, plus a faint see-through pass: the chamber
   * grooves the lines sit in are often hidden behind the neighbouring bulges.
   */
  private addLines(geometry: BufferGeometry, material: { vertexColors?: boolean; color?: number }) {
    const solid = new LineSegments(
      geometry,
      new LineBasicMaterial({ ...material, toneMapped: false }),
    );
    const ghost = new LineSegments(
      geometry,
      new LineBasicMaterial({
        ...material,
        toneMapped: false,
        depthTest: false,
        transparent: true,
        opacity: 0.5,
      }),
    );
    ghost.renderOrder = 5;
    this.seams.add(solid, ghost);
  }

  /** Panel boundaries (coloured per panel) and baffle stitch lines on the shell on screen. */
  private rebuildSeams() {
    this.clearSeams();
    this.seamStats = { boundary: 0, baffle: 0 };
    const target = this.viewer.garment.pickTarget;
    if (!target) return;
    const { asset, mesh } = target;
    const geometry = mesh.geometry;
    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal')?.array;
    const boundary = panelBoundarySegments(
      asset.triangles,
      asset.panels,
      positions,
      normals,
      LINE_LIFT_M,
    );
    this.seamStats.boundary = boundary.panel.length;
    if (boundary.panel.length) {
      const colours = new Float32Array(boundary.panel.length * 6);
      const c = new Color();
      boundary.panel.forEach((panel, i) => {
        c.set(PANEL_COLOURS[panel % PANEL_COLOURS.length]);
        colours.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      });
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(boundary.positions, 3));
      g.setAttribute('color', new Float32BufferAttribute(colours, 3));
      this.addLines(g, { vertexColors: true });
    }
    if (asset.quilt?.length) {
      const coordinates = garmentCoordinates(asset, asset.initial);
      const { phase, valid } = bafflePhase(
        asset.panels,
        coordinates.quiltUv,
        coordinates.arc,
        asset.quilt,
      );
      const baffles = isolineSegments(
        asset.triangles,
        phase,
        valid,
        positions,
        normals,
        LINE_LIFT_M,
      );
      this.seamStats.baffle = baffles.length / 6;
      if (baffles.length) {
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(baffles, 3));
        this.addLines(g, { color: BAFFLE_COLOUR });
      }
    }
  }

  // ------------------------------------------------------------ pixels
  /** Renders once and copies the frame (the WebGL buffer is only readable in the same task). */
  capture(): HTMLCanvasElement {
    this.viewer.composer.render();
    const source = this.canvas;
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d')!.drawImage(source, 0, 0);
    return copy;
  }

  /** sRGB colour under a client point, averaged over a (2r+1)^2 pixel square in linear light. */
  sampleColour(clientX: number, clientY: number, radius: number): Rgb {
    const rect = this.canvas.getBoundingClientRect();
    const frame = this.capture();
    const sx = frame.width / rect.width,
      sy = frame.height / rect.height;
    const x = Math.round((clientX - rect.left) * sx),
      y = Math.round((clientY - rect.top) * sy);
    const r = Math.max(0, Math.round(radius * Math.max(sx, sy)));
    const x0 = Math.max(0, x - r),
      y0 = Math.max(0, y - r);
    const w = Math.min(frame.width, x + r + 1) - x0,
      h = Math.min(frame.height, y + r + 1) - y0;
    if (w <= 0 || h <= 0) throw new Error('Point is outside the 3D view');
    return averageSrgb(frame.getContext('2d')!.getImageData(x0, y0, w, h).data);
  }

  dispose() {
    this.ticket++;
    this.applyNormals(this.garmentMaterial(), false);
    this.clearSeams();
    this.viewer.dispose();
  }
}
