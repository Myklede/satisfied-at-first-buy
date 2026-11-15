// Visual check of the trousers (apps/web/trousers-dev.html), independent of the Fit Lab panel:
// the reference body from the local service, posed on the CPU like the Fit Lab, plus the trousers.
// Query: ?pose=neutral|walk|arms|sit  &trousers=0 (body only)  &view=front|side|back|low
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { api } from '../../../api';
import { LiveAvatar } from '../../../engine/live/LiveAvatar';
import { loadLiveRig } from '../../../engine/live/liveRig';
import { fitBody } from '../../../kiosk/kioskApi';
import { KIOSK_SHAPE_REFERENCE, REFERENCE_PERSON } from '../config';
import { createTrousersFromRest, trousersHeights } from './trousers';

const q = new URLSearchParams(location.search);
const POSES: Record<string, Record<string, number>> = {
  neutral: {},
  walk: {
    hip_L_flexion: 32,
    knee_L_flexion: 12,
    hip_R_flexion: -14,
    knee_R_flexion: 38,
    shoulder_L_elevation: 20,
    shoulder_R_elevation: 20,
    shoulder_R_plane: 90,
    elbow_L_flexion: 25,
    pelvis_drop_m: 0.01,
  },
  arms: { shoulder_L_elevation: 150, shoulder_R_elevation: 150, trunk_flexion: 8 },
  sit: { hip_L_flexion: 85, hip_R_flexion: 85, knee_L_flexion: 90, knee_R_flexion: 90 },
};

async function main() {
  const msg = document.getElementById('msg')!;
  const capabilities = await api.capabilities();
  const { body } = await fitBody({
    height_cm: REFERENCE_PERSON.height_cm,
    weight_kg: REFERENCE_PERSON.weight_kg,
    sex: REFERENCE_PERSON.sex,
    shape_reference: KIOSK_SHAPE_REFERENCE,
    density_kg_m3: capabilities.default_density_kg_m3,
    known_measurements: {},
  });
  const response = await fetch(`/api/motion/${body.body_id}/rig.bin`, { cache: 'no-store' });
  const live = loadLiveRig(await response.arrayBuffer());
  const avatar = new LiveAvatar(live);
  const rig = live.rig;

  const scene = new Scene();
  scene.background = new Color(0xe9e6e1);
  scene.add(new HemisphereLight(0xffffff, 0x8a8478, 1.1), new AmbientLight(0xffffff, 0.35));
  const key = new DirectionalLight(0xffffff, 1.8);
  key.position.set(1.5, 2.6, 2.4);
  scene.add(key);
  const rimLight = new DirectionalLight(0xdfe6ff, 0.8);
  rimLight.position.set(-2, 1.5, -2);
  scene.add(rimLight);
  scene.add(avatar.root);

  // Trousers from the NEUTRAL displayed body (what the Fit Lab shows), joints from the avatar.
  const { positions } = avatar.bodyArrays();
  const { hipY, ankleY, kneeY } = trousersHeights(avatar.joints);
  const withTrousers = q.get('trousers') !== '0';
  const trousers = createTrousersFromRest(positions.slice(), rig.faces, { hipY, ankleY, kneeY });
  if (withTrousers) scene.add(trousers);

  const pose = POSES[q.get('pose') ?? 'neutral'] ?? {};
  avatar.applyPose(pose);
  const bodyMesh = avatar.body.children.find((c): c is Mesh => c instanceof Mesh)!;
  const follow = () => {
    const a = avatar.bodyArrays();
    trousers.sync(a.positions, a.normals);
  };
  follow();
  void bodyMesh;

  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  const W = Number(q.get('w') ?? 640),
    H = Number(q.get('h') ?? 900);
  renderer.setSize(W, H);
  document.body.appendChild(renderer.domElement);
  const camera = new PerspectiveCamera(30, W / H, 0.05, 30);
  const box = new Box3().setFromObject(avatar.root);
  const c = box.getCenter(new Vector3());
  const view = q.get('view') ?? 'front';
  const zoom = view === 'low' ? 0.55 : 1;
  const target = new Vector3(c.x, view === 'low' ? ankleY + 0.55 : c.y, c.z);
  const dist = 4.1 * zoom;
  const dir =
    view === 'side'
      ? new Vector3(1, 0.12, 0)
      : view === 'back'
        ? new Vector3(0, 0.12, -1)
        : new Vector3(0, 0.12, 1);
  camera.position.copy(target).addScaledVector(dir.normalize(), dist);
  camera.lookAt(target);
  renderer.render(scene, camera);
  msg.textContent = `ok pose=${q.get('pose') ?? 'neutral'} view=${view} hipY=${hipY.toFixed(3)} ankleY=${ankleY.toFixed(3)} tris=${trousers.data.indices.length / 3}`;
  (window as unknown as { done: boolean }).done = true;
}
main().catch((e: unknown) => {
  document.getElementById('msg')!.textContent =
    `FAILED ${e instanceof Error ? e.message : String(e)}`;
  (window as unknown as { done: boolean }).done = true;
});
