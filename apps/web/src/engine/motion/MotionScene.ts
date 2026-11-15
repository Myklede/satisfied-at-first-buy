// Side-by-side motion stage: one scene, one camera, a station per size (body + baked cloth),
// placed SPACING_M apart along X. Plain Three.js; the React shell only calls these methods.
import {
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BodyMotionLayer, motionBodyMaterial } from './BodyMotionLayer.ts';
import { MotionGarmentLayer, motionGarmentMaterial } from './MotionGarmentLayer.ts';
import type { MotionRig } from './rig.ts';
import { ProgramWarmup, shadowDepthStandIn, standIn } from '../programWarmup.ts';

/** Distance between the two bodies (m): hands overhead reach ~0.55 m sideways from the midline. */
export const SPACING_M = 1.15;

export type Station = { group: Group; body: BodyMotionLayer; garment?: MotionGarmentLayer };
export type View = 'front' | 'side' | 'back';

export class MotionScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(30, 1, 0.05, 30);
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  readonly stations: Station[] = [];
  private observer: ResizeObserver;
  private frame = 0;
  private environment;
  /**
   * The stage's programs (ground, posed bodies, baked cloth, shadow casters), compiled in the
   * background before the first draw and kept while baked cloth layers come and go per motion
   * (programWarmup.ts). Until they are linked the stage shows its background colour only.
   */
  private readonly programs: ProgramWarmup;
  private programsReady = false;
  onFrame?: (time: number) => void;

  constructor(
    private container: HTMLElement,
    rig: MotionRig,
    count: number,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.scene.background = new Color('#ecebe8');
    const pmrem = new PMREMGenerator(this.renderer),
      room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.62;
    room.dispose();
    pmrem.dispose();
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 8;
    this.controls.maxPolarAngle = Math.PI * 0.55;
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(-2, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -2.2;
    key.shadow.camera.right = key.shadow.camera.top = 2.2;
    key.shadow.normalBias = 0.001;
    const fill = new DirectionalLight(0xf4f6ff, 0.45);
    fill.position.set(3, 2, 1);
    const rim = new DirectionalLight(0xffffff, 1.0);
    rim.position.set(0, 3, -3);
    this.scene.add(key, fill, rim, new HemisphereLight(0xffffff, 0x8a8885, 0.2));
    const ground = new Mesh(
      new CircleGeometry(3.2, 96),
      new MeshStandardMaterial({ color: 0xe4e2de, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.008;
    ground.receiveShadow = true;
    this.scene.add(ground);
    for (let s = 0; s < count; s++) {
      const group = new Group();
      group.position.x = (s - (count - 1) / 2) * SPACING_M;
      const body = new BodyMotionLayer(rig);
      group.add(body);
      this.scene.add(group);
      this.stations.push({ group, body });
    }
    // The stage draws straight to the canvas (no render target bound); the shadow casters draw
    // into the shadow map (a render target: any 1×1 one gives the same program key).
    this.programs = new ProgramWarmup(this.renderer, this.scene, this.camera);
    const shadowKey = new WebGLRenderTarget(1, 1);
    void Promise.all([
      this.programs.compile(
        'stage',
        null,
        () => [
          standIn(ground.material),
          standIn(motionBodyMaterial()),
          standIn(motionGarmentMaterial()),
        ],
        [ground.material],
      ),
      this.programs.compile('casters', shadowKey, () => [
        shadowDepthStandIn(FrontSide),
        shadowDepthStandIn(DoubleSide),
      ]),
    ]).then(() => {
      shadowKey.dispose();
      this.programsReady = true;
    });
    this.setView('front');
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }

  setGarment(station: number, garment: MotionGarmentLayer | undefined) {
    const s = this.stations[station];
    if (s.garment) {
      s.group.remove(s.garment);
      s.garment.dispose();
    }
    s.garment = garment;
    if (garment) s.group.add(garment);
  }

  setView(view: View) {
    const target = { x: 0, y: 1.08, z: 0 },
      d = 5.0;
    const position =
      view === 'front' ? [0, 1.25, d] : view === 'back' ? [0, 1.25, -d] : [d, 1.25, 0.4];
    this.controls.target.set(target.x, target.y, target.z);
    this.camera.position.set(position[0], position[1], position[2]);
    this.controls.update();
  }

  private resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (time: number) => {
    this.frame = requestAnimationFrame(this.animate);
    this.onFrame?.(time);
    this.controls.update();
    if (this.programsReady) this.renderer.render(this.scene, this.camera);
    else {
      // Same clear as the scene's colour background, with no program to wait for.
      this.renderer.setClearColor(this.scene.background as Color);
      this.renderer.clear();
    }
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    for (const s of this.stations) {
      s.body.dispose();
      s.garment?.dispose();
    }
    this.programs.dispose();
    this.environment.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
