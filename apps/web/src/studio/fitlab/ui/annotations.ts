// On-image fit annotations (agent U): leader lines from the projected 3D anchor to small label
// cards stacked at the left and right edges. DOM cards + one DPR-aware canvas for the lines.
import { Vector3, type PerspectiveCamera } from 'three';
import type { Annotation, AnnotationLayer } from '../look/types';
import { TONE_COLOR } from './theme';
import '../fitlab.css';

const CARD_H = 56;
const GAP = 8;
const EDGE = 10;
const MIN_FADE = 0.01;

interface Placed {
  a: Annotation;
  px: number;
  py: number;
  side: 'left' | 'right';
  top: number;
}

/** Pure layout: stack cards per side without overlap, ordered by anchor y (so lines rarely cross). */
export function layoutAnnotations(
  pts: { id: string; x: number; y: number }[],
  width: number,
  height: number,
  cardH = CARD_H,
): Map<string, { side: 'left' | 'right'; top: number }> {
  const out = new Map<string, { side: 'left' | 'right'; top: number }>();
  const mid = width / 2;
  for (const side of ['left', 'right'] as const) {
    const col = pts
      .filter((p) => (side === 'left' ? p.x < mid : p.x >= mid))
      .sort((a, b) => a.y - b.y);
    let next = EDGE;
    for (const p of col) {
      const top = Math.max(next, p.y - cardH / 2);
      out.set(p.id, { side, top });
      next = top + cardH + GAP;
    }
    // Push back up if the stack ran off the bottom.
    let limit = height - EDGE;
    for (let i = col.length - 1; i >= 0; i--) {
      const o = out.get(col[i].id)!;
      if (o.top + cardH > limit) o.top = Math.max(EDGE, limit - cardH);
      limit = o.top - GAP;
    }
  }
  return out;
}

export class AnnotationOverlay implements AnnotationLayer {
  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private cards = new Map<string, HTMLDivElement>();
  private v = new Vector3();
  private lastSize = '';

  constructor() {
    this.root.className = 'fl-ann';
    this.canvas.className = 'fl-ann-lines';
    this.root.append(this.canvas);
  }

  mount(host: HTMLElement) {
    host.append(this.root);
  }

  update(
    camera: PerspectiveCamera,
    viewport: { width: number; height: number },
    items: readonly Annotation[],
    visible: number,
  ) {
    const { width, height } = viewport;
    const alpha = Math.max(0, Math.min(1, visible));
    this.root.style.opacity = String(alpha);
    this.root.style.visibility = alpha < MIN_FADE ? 'hidden' : 'visible';
    if (alpha < MIN_FADE || width < 2 || height < 2) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const key = `${width}x${height}@${dpr}`;
    if (key !== this.lastSize) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.lastSize = key;
    }

    const pts: { id: string; x: number; y: number }[] = [];
    const byId = new Map<string, Annotation>();
    for (const a of items) {
      this.v.copy(a.anchor).project(camera);
      if (this.v.z > 1) continue; // behind the camera
      pts.push({ id: a.id, x: ((this.v.x + 1) / 2) * width, y: ((1 - this.v.y) / 2) * height });
      byId.set(a.id, a);
    }
    const lay = layoutAnnotations(pts, width, height);

    for (const [id, el] of this.cards)
      if (!byId.has(id)) {
        el.remove();
        this.cards.delete(id);
      }
    const cardW = Math.max(108, Math.min(152, width * 0.29));
    const placed: Placed[] = [];
    for (const p of pts) {
      const a = byId.get(p.id)!;
      const l = lay.get(p.id)!;
      let el = this.cards.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'fl-ann-card';
        el.innerHTML = '<i class="fl-ann-dot"></i><b></b><span></span>';
        this.root.append(el);
        this.cards.set(p.id, el);
      }
      (el.children[0] as HTMLElement).style.background = TONE_COLOR[a.tone];
      if (el.children[1].textContent !== a.title) el.children[1].textContent = a.title;
      if (el.children[2].textContent !== a.detail) el.children[2].textContent = a.detail;
      el.style.width = `${cardW}px`;
      el.style.top = `${l.top}px`;
      el.style.left = l.side === 'left' ? `${EDGE}px` : `${width - EDGE - cardW}px`;
      placed.push({ a, px: p.x, py: p.y, side: l.side, top: l.top });
    }

    // Leader lines: from the card's inner edge (vertical centre) with a short elbow to the anchor.
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const p of placed) {
      const x0 = p.side === 'left' ? EDGE + cardW : width - EDGE - cardW;
      const y0 = p.top + CARD_H / 2;
      const elbow = p.side === 'left' ? x0 + 14 : x0 - 14;
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = 'rgba(29,29,31,0.55)';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(elbow, y0);
      ctx.lineTo(p.px, p.py);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = TONE_COLOR[p.a.tone];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.px, p.py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  dispose() {
    this.root.remove();
    this.cards.clear();
  }
}

export function createAnnotationLayer(): AnnotationLayer {
  return new AnnotationOverlay();
}
