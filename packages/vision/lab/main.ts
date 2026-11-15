// Vision Lab home: camera check (resolution, delivered fps) + links to the module pages.
// Frames are only shown on screen; nothing is recorded or sent anywhere.
import { CameraError, listCameras, openCamera } from '../src/camera';
import type { CameraHandle } from '../src/types';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <style>
    body { font: 14px system-ui, sans-serif; margin: 16px; background: #f4f2ee; color: #222; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    video { max-width: 100%; max-height: 70vh; background: #000; border-radius: 8px; }
    canvas { max-height: 70vh; background: #000; border-radius: 8px; }
    #info { font: 13px ui-monospace, monospace; white-space: pre; }
    a { margin-right: 12px; }
  </style>
  <h2>Satisfy · Vision Lab</h2>
  <div class="row"><a href="./hands.html">Hand pinch →</a><a href="./scan.html">Body scan →</a><a href="./pose.html">Webcam pose →</a><a href="./replay.html">Replay recordings →</a></div>
  <div class="row">
    <select id="device"></select>
    <select id="rotate">
      <option value="0">No rotation</option>
      <option value="90">Rotate 90° (portrait)</option>
      <option value="270">Rotate 270° (portrait)</option>
    </select>
    <select id="size">
      <option value="1280x720">1280×720</option>
      <option value="1920x1080">1920×1080</option>
      <option value="640x480">640×480</option>
    </select>
    <button id="open">Open camera</button>
    <button id="refresh">Refresh list</button>
  </div>
  <div id="info">Choose a camera and press "Open camera".</div>
  <div id="view"></div>
`;

const deviceSelect = app.querySelector<HTMLSelectElement>('#device')!;
const rotateSelect = app.querySelector<HTMLSelectElement>('#rotate')!;
const sizeSelect = app.querySelector<HTMLSelectElement>('#size')!;
const info = app.querySelector<HTMLDivElement>('#info')!;
const view = app.querySelector<HTMLDivElement>('#view')!;
let camera: CameraHandle | undefined;
let timer = 0;

async function refresh() {
  const cameras = await listCameras();
  deviceSelect.innerHTML = cameras
    .map((c) => `<option value="${c.deviceId}">${c.label.replace(/</g, '&lt;')}</option>`)
    .join('');
  if (!cameras.length) deviceSelect.innerHTML = '<option value="">(no camera found)</option>';
}

async function open() {
  camera?.close();
  clearInterval(timer);
  view.replaceChildren();
  const [width, height] = sizeSelect.value.split('x').map(Number);
  try {
    camera = await openCamera({
      deviceId: deviceSelect.value || undefined,
      rotate: Number(rotateSelect.value) as 0 | 90 | 270,
      width,
      height,
    });
  } catch (error) {
    info.textContent =
      error instanceof CameraError ? `Error [${error.code}]: ${error.message}` : String(error);
    return;
  }
  view.append(camera.source);
  await refresh();
  const opened = camera;
  timer = window.setInterval(() => {
    const i = opened.info();
    const verdict =
      Math.min(i.width, i.height) >= 720
        ? 'OK for scan and hands'
        : 'Low resolution: hands OK, scan accuracy reduced';
    info.textContent =
      `Camera:     ${i.label}\n` +
      `Resolution: ${i.width}×${i.height}${i.portrait ? ' (rotated to portrait)' : ''}\n` +
      `Delivered:  ${i.fps} fps\n` +
      `Verdict:    ${verdict}`;
  }, 500);
}

app.querySelector('#open')!.addEventListener('click', () => void open());
app.querySelector('#refresh')!.addEventListener('click', () => void refresh());
void refresh();
