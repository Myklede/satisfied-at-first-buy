// The mirror view: the posed avatar (LiveAvatar) facing the viewer, in the kiosk's stage light
// (MotionScene.ts: neutral tone mapping, room environment, key/fill/rim). Shader programs are
// compiled ahead (programWarmup.ts), so the first live frame never stalls on a compile.
// Plain Three.js; the engine owns the canvas inside the container.
import {
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
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
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ProgramWarmup, shadowDepthStandIn, standIn } from '../programWarmup.ts';
import { liveBodyMaterial, liveJacketMaterial } from './LiveAvatar.ts';

export class MirrorView {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(28, 1, 0.05, 30);
  readonly renderer: WebGLRenderer;
  private observer: ResizeObserver;
  private environment;
  private programs: ProgramWarmup;
  private ready = false;
  private frames: number[] = [];
  /** Rendered frames over the last second. */
  fps = 0;

  constructor(private container: HTMLElement) {
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
    const canvas = this.renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.append(canvas);
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(-2, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -1.6;
    key.shadow.camera.right = key.shadow.camera.top = 1.6;
    key.shadow.normalBias = 0.001;
    const fill = new DirectionalLight(0xf4f6ff, 0.45);
    fill.position.set(3, 2, 1);
    const rim = new DirectionalLight(0xffffff, 1.0);
    rim.position.set(0, 3, -3);
    this.scene.add(key, fill, rim, new HemisphereLight(0xffffff, 0x8a8885, 0.2));
    const ground = new Mesh(
      new CircleGeometry(2.4, 96),
      new MeshStandardMaterial({ color: 0xe4e2de, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.008;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.programs = new ProgramWarmup(this.renderer, this.scene, this.camera);
    const shadowKey = new WebGLRenderTarget(1, 1);
    void Promise.all([
      this.programs.compile(
        'mirror',
        null,
        () => [
          standIn(ground.material),
          standIn(liveBodyMaterial()),
          standIn(liveJacketMaterial()),
        ],
        [ground.material],
      ),
      this.programs.compile('casters', shadowKey, () => [
        shadowDepthStandIn(FrontSide),
        shadowDepthStandIn(DoubleSide),
      ]),
    ]).then(() => {
      shadowKey.dispose();
      this.ready = true;
    });
    this.frame('upper');
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  /** 'upper' = head to hips (the kiosk framing); 'full' = the whole body. */
  frame(view: 'upper' | 'full') {
    if (view === 'full') {
      this.camera.position.set(0, 1.05, 4.6);
      this.camera.lookAt(0, 0.98, 0);
    } else {
      this.camera.position.set(0, 1.32, 3.3);
      this.camera.lookAt(0, 1.22, 0);
    }
  }

  add(object: Object3D) {
    this.scene.add(object);
  }
  remove(object: Object3D) {
    this.scene.remove(object);
  }

  private resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    const now = performance.now();
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    this.fps = this.frames.length;
    if (this.ready) this.renderer.render(this.scene, this.camera);
    else {
      this.renderer.setClearColor(this.scene.background as Color);
      this.renderer.clear();
    }
  }

  dispose() {
    this.observer.disconnect();
    this.programs.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
