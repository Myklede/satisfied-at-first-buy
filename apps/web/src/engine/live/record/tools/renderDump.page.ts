// V3 render page (driven by renderDump.mjs): 3-view renders (front, side, back) of avatar + simulated
// cloth from the geometry hemExperiments.mjs dumps to .cache/v3/render/ (skinned body, cloth
// positions, triangles). No camera image is involved. One column per variant.
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { smoothNormals } from '../../../cloth/normals.ts';

declare global {
  interface Window {
    v3Render?: (config: { base: string; tags: string[] }) => Promise<string>;
    v3RenderStatus?: string;
  }
}

async function load<T extends Float32Array | Uint32Array>(url: string, kind: 'f32' | 'u32') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const b = await r.arrayBuffer();
  return (kind === 'f32' ? new Float32Array(b) : new Uint32Array(b)) as T;
}

function mesh(positions: Float32Array, index: Uint32Array, colour: string) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length);
  smoothNormals(positions, index, normals);
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setIndex(new BufferAttribute(index, 1));
  return new Mesh(
    g,
    new MeshStandardMaterial({ color: new Color(colour), roughness: 0.7, side: DoubleSide }),
  );
}

window.v3Render = async ({ base, tags }) => {
  const cell = 300;
  const views: [string, number, number][] = [
    ['front', 0, 4.4],
    ['side', 4.4, 0],
    ['back', 0, -4.4],
  ];
  const canvas = document.createElement('canvas');
  canvas.width = cell * tags.length;
  canvas.height = cell * 1.5 * views.length;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(cell, cell * 1.5, false);
  renderer.setClearColor(0xffffff, 1);
  const faces = await load<Uint32Array>(`${base}/faces.u32`, 'u32');
  const triangles = await load<Uint32Array>(`${base}/triangles.u32`, 'u32');
  for (let c = 0; c < tags.length; c++) {
    window.v3RenderStatus = tags[c];
    const body = await load<Float32Array>(`${base}/${tags[c]}-body.f32`, 'f32');
    const cloth = await load<Float32Array>(`${base}/${tags[c]}-cloth.f32`, 'f32');
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1.1));
    const key = new DirectionalLight(0xffffff, 1.8);
    key.position.set(-1.5, 3, 3);
    scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.8);
    fill.position.set(1.5, 2, -3);
    scene.add(fill);
    scene.add(mesh(body, faces, '#c4bfb6'), mesh(cloth, triangles, '#5b7fb8'));
    const camera = new PerspectiveCamera(32, 1 / 1.5, 0.05, 30);
    views.forEach(([, x, z], r) => {
      camera.position.set(x, 1.2, z);
      camera.lookAt(0, 1.15, 0);
      renderer.render(scene, camera);
      ctx.drawImage(renderer.domElement, c * cell, r * cell * 1.5);
    });
    ctx.fillStyle = '#000';
    ctx.font = '14px sans-serif';
    ctx.fillText(tags[c], c * cell + 6, 16);
  }
  renderer.dispose();
  window.v3RenderStatus = 'done';
  return canvas.toDataURL('image/png');
};
window.v3RenderStatus = 'ready';
