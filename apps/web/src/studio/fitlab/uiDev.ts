// Dev page for the redesign UI (agent U): stub data only, no camera, no Decart, no engine.
import { PerspectiveCamera, Vector3 } from 'three';
import type { SizeLabel } from '../contract';
import type { Annotation } from './look/types';
import { createAnnotationLayer } from './ui/annotations';
import { createSizePicker } from './ui/sizePicker';
import { mountScrollHint } from './ui/scrollHint';
import './fitlab.css';

const root = document.createElement('div');
root.className = 'fl-root';
const head = document.createElement('div');
head.className = 'fl-head';
head.innerHTML =
  '<span class="fl-title">Your fit</span><span class="fl-basis">Puffer, sample body (stub data)</span>';
const stage = document.createElement('div');
stage.className = 'fl-stage';
// Placeholder figure (a plain silhouette, no real image): head + puffer-ish torso + arms + legs.
const figure =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 200' preserveAspectRatio='xMidYMid meet'>" +
  "<g fill='#cfcac2'><circle cx='50' cy='22' r='9'/><rect x='30' y='36' width='40' height='62' rx='14'/>" +
  "<rect x='18' y='38' width='13' height='62' rx='6'/><rect x='69' y='38' width='13' height='62' rx='6'/>" +
  "<rect x='33' y='96' width='15' height='88' rx='6'/><rect x='52' y='96' width='15' height='88' rx='6'/></g></svg>";
stage.style.background = `center / contain no-repeat url("data:image/svg+xml,${encodeURIComponent(figure)}"), linear-gradient(#ecebe8, #dedbd4)`;
document.getElementById('panel')!.append(root);
root.append(head, stage);

const camera = new PerspectiveCamera(30, 1, 0.1, 20);
camera.position.set(0, 1.1, 4);
camera.lookAt(0, 1.1, 0);
camera.updateMatrixWorld();

const layer = createAnnotationLayer();
layer.mount(stage);
mountScrollHint(stage);

const items: Annotation[] = [
  {
    id: 'collar',
    anchor: new Vector3(0, 1.45, 0.1),
    title: 'Collar',
    detail: 'Snug at the neck when zipped',
    tone: 'snug',
  },
  {
    id: 'chest',
    anchor: new Vector3(0.18, 1.2, 0.12),
    title: 'Chest',
    detail: '+17 cm of room around the chest',
    tone: 'loose',
  },
  {
    id: 'shoulder',
    anchor: new Vector3(-0.2, 1.38, 0.05),
    title: 'Shoulders',
    detail: 'Seams sit on the bone',
    tone: 'good',
  },
  {
    id: 'cuff',
    anchor: new Vector3(-0.3, 0.9, 0.05),
    title: 'Sleeves',
    detail: '14 cm past the wrist',
    tone: 'loose',
  },
  {
    id: 'hem',
    anchor: new Vector3(0.2, 0.9, 0.12),
    title: 'Hem',
    detail: 'Ends below the hip',
    tone: 'good',
  },
];
const q = new URLSearchParams(location.search);
const visible = Number(q.get('v') ?? '1');
const redraw = () => {
  const w = stage.clientWidth,
    h = stage.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  layer.update(camera, { width: w, height: h }, items, visible);
};
const loop = () => {
  redraw();
  requestAnimationFrame(loop);
};
loop();

const verdicts: Record<
  SizeLabel,
  { word: string; tone: 'tight' | 'snug' | 'good' | 'loose'; line: string }
> = {
  S: { word: 'Snug', tone: 'snug', line: 'Snug across the chest; collar closes at the neck' },
  M: { word: 'Good', tone: 'good', line: 'Fits your chest and shoulders; collar snug when zipped' },
  L: {
    word: 'Loose',
    tone: 'loose',
    line: 'Loose: +17 cm around the chest, sleeves 14 cm past the wrist',
  },
};
const picker = createSizePicker();
const set = (s: SizeLabel) => {
  picker.setSelected(s);
  picker.setVerdict(verdicts[s]);
};
picker.mount(root, { sizes: ['S', 'M', 'L'], selected: 'M', onSelect: set });
set((q.get('size') as SizeLabel | null) ?? 'M');
