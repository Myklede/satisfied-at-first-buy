// CT stage v2 hover layer (agent VX, 2026-11-15): the stack of CT layers floats beside the body;
// hovering a layer lights it (CL's cap glow via CtPickable.setHover) and shows a small info card
// with a leader line to the layer: its zone label, the engine verdict line and the torso minimum
// gap with its side, plus front/back/left/right gap marks on the hovered layer only. A slim height
// ruler beside the stack marks every layer and the Collar/Chest/Hem ones. Every number shown is
// the engine's (`CtSlice.gapAt`, `CtSlice.toneOf`, `CtStack.verdicts`); nulls are skipped, never
// faked. Hover is pointermove only (passive, no capture, nothing on pointerdown), so the drag
// rotate and the grabs keep working. DOM/SVG only; nothing is added to the scene.
import { Raycaster, Vector2, Vector3, type PerspectiveCamera, type Scene } from 'three';
import type { CtPickable, CtSlice, CtStack, CtStackLayer, CtTone } from './ctTypes';
import type { CutPoint, Loop } from './crossSection';
import { side } from './crossSection';
import { THEME, TONE_COLOR } from '../ui/theme';
import '../fitlab.css';

export type CalloutDir = 'front' | 'back' | 'left' | 'right';

/** Unit directions in the XZ plane (+Z = body front; the body's left is +X when it faces +Z). */
export const CALLOUT_DIRS: Record<CalloutDir, { x: number; z: number }> = {
  front: { x: 0, z: 1 },
  back: { x: 0, z: -1 },
  left: { x: 1, z: 0 },
  right: { x: -1, z: 0 },
};

export interface CalloutPick {
  dir: CalloutDir;
  point: CutPoint;
  /** Fit zone of the shell segment at the point (-1 when unknown). */
  zone: number;
}

/** Ruler tick spacing (m). */
const TICK_M = 0.05;

/** Zone of segment i (or the previous segment at an open loop's last point). */
function zoneAt(loop: Loop, i: number): number {
  if (i < loop.zones.length) return loop.zones[i];
  return loop.zones.length ? loop.zones[loop.zones.length - 1] : -1;
}

/**
 * Pure: for each of front/back/left/right, the shell point whose direction from the centre is
 * closest to that axis. A direction is skipped when no point lies within 45 degrees of it (e.g. an
 * open zip leaves no front shell), and front/back picks must agree with `side()`.
 */
export function pickCalloutPoints(
  shell: readonly Loop[],
  c: { x: number; z: number },
): CalloutPick[] {
  const out: CalloutPick[] = [];
  for (const dir of Object.keys(CALLOUT_DIRS) as CalloutDir[]) {
    const d = CALLOUT_DIRS[dir];
    let best: CalloutPick | null = null,
      bestCos = Math.SQRT1_2;
    for (const loop of shell)
      loop.points.forEach((p, i) => {
        const dx = p.x - c.x,
          dz = p.z - c.z,
          len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        const cos = (dx * d.x + dz * d.z) / len;
        if (cos > bestCos) {
          bestCos = cos;
          best = { dir, point: p, zone: zoneAt(loop, i) };
        }
      });
    const pick = best as CalloutPick | null;
    if (!pick) continue;
    const s = side(pick.point.x, pick.point.z, c.x, c.z);
    if ((dir === 'front' || dir === 'back') && s !== dir) continue;
    if ((dir === 'left' || dir === 'right') && s !== 'side') continue;
    out.push(pick);
  }
  return out;
}

/** Pure: nearest point of the body loops to (x, z), or null when there is no body cut. */
export function nearestBodyPoint(
  body: readonly Loop[],
  x: number,
  z: number,
): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null,
    bestD = Infinity;
  for (const l of body)
    for (const p of l.points) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: p.x, z: p.z };
      }
    }
  return best;
}

/** Pure: `+3.2 cm` / `−1.5 cm` (+ ` preview` off the solver); null for a missing/invalid gap. */
export function formatGap(cm: number | null, solver: boolean): string | null {
  if (cm === null || !Number.isFinite(cm)) return null;
  const v = Math.round(cm * 10) / 10;
  const sign = v < 0 ? '−' : '+';
  return `${sign}${Math.abs(v).toFixed(1)} cm${solver ? '' : ' preview'}`;
}

/** Pure: label colour, coral only for tight/snug segments, else the calm text colour. */
export function calloutColor(tone: CtTone): string {
  return tone === 'tight' || tone === 'snug' ? TONE_COLOR.tight : THEME.text;
}

/** Pure: widest reach of the loops from the centre (m), 0 when empty. */
export function reach(loops: readonly Loop[], c: { x: number; z: number }): number {
  let r = 0;
  for (const l of loops) for (const p of l.points) r = Math.max(r, Math.hypot(p.x - c.x, p.z - c.z));
  return r;
}

/** Pure: tick heights (m) from lo to hi on a TICK_M grid. */
export function rulerTicks(lo: number, hi: number, step = TICK_M): number[] {
  const out: number[] = [];
  if (!(hi > lo) || !(step > 0)) return out;
  for (let y = Math.ceil(lo / step) * step; y <= hi + 1e-9; y += step) out.push(y);
  return out;
}

/**
 * Pure: the torso minimum gap of one slice, the way CT's inset computes it: the min of `gapAt`
 * over the shell points of the slice's majority fit zone (all points when no zone is painted),
 * with the side (front/back/side) where it sits. null when no point has an engine gap.
 */
export function torsoMinGap(
  s: Pick<CtSlice, 'shell' | 'centre' | 'gapAt'>,
): { cm: number; where: 'front' | 'back' | 'side' } | null {
  const count = new Map<number, number>();
  for (const l of s.shell)
    for (const z of l.zones) if (z >= 0) count.set(z, (count.get(z) ?? 0) + 1);
  const zoneIdx = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const c = s.centre;
  let best: { cm: number; where: 'front' | 'back' | 'side' } | null = null;
  for (const l of s.shell)
    for (let i = 0; i < l.points.length; i++) {
      const p = l.points[i];
      const z = l.zones[i] ?? l.zones[i - 1];
      if (zoneIdx != null && z !== zoneIdx && l.zones[i - 1] !== zoneIdx) continue;
      const g = s.gapAt(p);
      if (g == null || !Number.isFinite(g)) continue;
      if (!best || g < best.cm) best = { cm: g, where: side(p.x, p.z, c.x, c.z) };
    }
  return best;
}

/** Pure: the fit zone most of the shell cut's segments carry (null when none is painted). */
export function majorityZone(shell: readonly Loop[]): number | null {
  const count = new Map<number, number>();
  for (const l of shell) for (const z of l.zones) if (z >= 0) count.set(z, (count.get(z) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Pure: verdict line colour, coral for tight/snug, else the soft text colour. */
export function verdictColor(tone: CtTone): string {
  return tone === 'tight' || tone === 'snug' ? TONE_COLOR.tight : THEME.textSoft;
}

export type VerdictTone = 'tight' | 'snug' | 'good' | 'loose';

/**
 * Pure: the verdict word and its signed number from an engine verdict line, e.g.
 * 'Collar tight zipped: 35.0 vs neck ~36.5 cm (−1.5 cm)' -> { tone: 'tight', cm: '−1.5 cm' }.
 * Only text already in the line is used; null when no fit word is present.
 */
export function shortVerdict(line: string): { tone: VerdictTone; cm: string | null; value: number | null } | null {
  const w = /\b(tight|snug|good|loose)\b/i.exec(line);
  if (!w) return null;
  const n = /([+−-])\s?(\d+(?:\.\d+)?)\s*cm/.exec(line);
  const sign = n ? (n[1] === '+' ? '+' : '−') : '';
  return {
    tone: w[1].toLowerCase() as VerdictTone,
    cm: n ? `${sign}${n[2]} cm` : null,
    value: n ? (sign === '+' ? 1 : -1) * Number(n[2]) : null,
  };
}

/** Pure: the always-visible tag text, e.g. 'Collar · tight −1.5 cm'; '' when nothing to say. */
export function layerTag(label: string, verdict: string): string {
  const sv = shortVerdict(verdict);
  const v = sv ? [sv.tone, sv.cm].filter(Boolean).join(' ') : '';
  return [label, v].filter(Boolean).join(' · ');
}

/** Pure: index of the worst tight layer (most negative number first), null when none is tight. */
export function worstTight(verdicts: readonly string[]): number | null {
  let best: number | null = null,
    bestV = Infinity;
  verdicts.forEach((line, i) => {
    const sv = shortVerdict(line);
    if (sv?.tone !== 'tight') return;
    const v = sv.value ?? 0;
    if (best === null || v < bestV) {
      best = i;
      bestV = v;
    }
  });
  return best;
}

/** Pure: card title for layer i of n. */
export function layerTitle(labels: readonly string[], i: number, n: number): string {
  return labels[i] || `Layer ${i + 1} of ${n}`;
}

export interface CtScannerLayer extends CtStackLayer {
  /** Hovered layer index (null = none), for checks. */
  hovered(): number | null;
}

interface Mark {
  label: HTMLDivElement;
  lines: SVGLineElement[];
  shell: { x: number; z: number };
  body: { x: number; z: number } | null;
  dir: CalloutDir;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param scene unused in v2 (kept for the factory signature CS wires).
 * @param host the panel's stage element (position: relative); pointermove is read on it.
 * @param cap CL's caps (picking, glow, layer centres).
 * @param requestRender optional: asks the panel for one redraw (after the glow changed).
 */
export function createCtScanner(
  scene: Scene,
  host: HTMLElement,
  cap: CtPickable | undefined,
  requestRender?: () => void,
): CtScannerLayer {
  void scene;
  const root = document.createElement('div');
  root.className = 'fl-ctscan';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'fl-ctscan-svg');
  const leader = document.createElementNS(SVG_NS, 'line');
  leader.setAttribute('class', 'fl-ctscan-leader');
  svg.appendChild(leader);
  const ruler = document.createElement('div');
  ruler.className = 'fl-ctscan-ruler';
  const card = document.createElement('div');
  card.className = 'fl-ctscan-card';
  const cardTitle = document.createElement('b');
  const cardVerdict = document.createElement('span');
  const cardGap = document.createElement('span');
  card.append(cardTitle, cardVerdict, cardGap);
  const legend = document.createElement('div');
  legend.className = 'fl-ctscan-legend';
  for (const [cls, text] of [
    ['body', 'body'],
    ['room', 'room'],
    ['tight', 'tight'],
    ['snug', 'snug'],
    ['ghost', 'other sizes'],
  ]) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = `fl-ctscan-sw-${cls}`;
    item.append(sw, text);
    legend.appendChild(item);
  }
  root.append(svg, ruler, legend, card);
  root.style.display = 'none';
  card.style.display = 'none';
  host.appendChild(root);

  let phase = 0;
  let stack: CtStack | null = null;
  let camera: PerspectiveCamera | null = null;
  let hover: number | null = null;
  let marks: Mark[] = [];
  let rulerEls: HTMLDivElement[] = [];
  let stackKey = '';
  let disposed = false;
  let raf = 0;
  let pointer: { x: number; y: number } | null = null;
  let pointerDirty = false;
  let camSig = '';
  const rc = new Raycaster();
  const ndc = new Vector2();
  const v = new Vector3();
  const lc = new Vector3();
  const right = new Vector3();

  // The WebGL canvas may not fill the host: project and pick in the canvas's own frame, offset
  // into host coordinates (the largest canvas under host is the renderer's).
  // mirror: the Fit Lab canvas is CSS-mirrored (transform matrix(-1,0,0,1,0,0), engine
  // mirrorDisplay), so screen x is flipped against NDC; read from the canvas each measure.
  const frame = { x: 0, y: 0, w: 1, h: 1, mirror: false };
  const measure = (): void => {
    const hr = host.getBoundingClientRect();
    let best: DOMRect | null = null;
    let bestEl: HTMLCanvasElement | null = null;
    for (const c of host.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (r.width * r.height > (best ? best.width * best.height : 0)) {
        best = r;
        bestEl = c;
      }
    }
    const r = best ?? hr;
    frame.mirror = false;
    if (bestEl) {
      const t = getComputedStyle(bestEl).transform;
      const m = /^matrix\(\s*(-?[\d.e+-]+)/.exec(t);
      frame.mirror = !!m && Number(m[1]) < 0;
    }
    frame.x = r.left - hr.left;
    frame.y = r.top - hr.top;
    frame.w = r.width || 1;
    frame.h = r.height || 1;
  };
  const project = (cam: PerspectiveCamera, x: number, y: number, z: number) => {
    v.set(x, y, z).project(cam);
    return {
      x: frame.x + (frame.mirror ? 1 - (v.x + 1) / 2 : (v.x + 1) / 2) * frame.w,
      y: frame.y + ((1 - v.y) / 2) * frame.h,
      ok: v.z < 1 && v.z > -1,
    };
  };
  const setLine = (l: SVGLineElement, a: { x: number; y: number }, b: { x: number; y: number }) => {
    l.setAttribute('x1', a.x.toFixed(1));
    l.setAttribute('y1', a.y.toFixed(1));
    l.setAttribute('x2', b.x.toFixed(1));
    l.setAttribute('y2', b.y.toFixed(1));
  };

  const clearMarks = (): void => {
    for (const m of marks) {
      m.label.remove();
      for (const l of m.lines) l.remove();
    }
    marks = [];
  };

  /** Card text + gap marks for the hovered layer (rebuilt on hover/stack change only). */
  const buildHover = (): void => {
    clearMarks();
    const s = hover != null ? stack?.slices[hover] : undefined;
    if (!stack || hover == null || !s) {
      card.style.display = 'none';
      leader.style.display = 'none';
      return;
    }
    cardTitle.textContent = layerTitle(stack.labels, hover, stack.slices.length);
    cardVerdict.textContent = stack.verdicts[hover] ?? '';
    cardVerdict.style.display = cardVerdict.textContent ? '' : 'none';
    const zone = majorityZone(s.shell);
    cardVerdict.style.color = zone != null ? verdictColor(s.toneOf(zone)) : '';
    // Truth: the LBS preview's shell-to-skin distance is a different metric from the engine's
    // ease verdict, so in preview the card shows only the label and the engine verdict line.
    // Radial cm marks and the min line appear only on the physics solver's shell.
    const min = s.solver ? torsoMinGap(s) : null;
    const minText = min ? formatGap(min.cm, true) : null;
    cardGap.textContent = min && minText ? `Solver gap min ${minText} at ${min.where}` : '';
    cardGap.style.display = cardGap.textContent ? '' : 'none';
    card.style.display = '';
    if (!s.solver) return;
    for (const pick of pickCalloutPoints(s.shell, s.centre)) {
      const text = formatGap(s.gapAt(pick.point), s.solver);
      if (text === null) continue; // no engine gap here: show nothing
      const label = document.createElement('div');
      label.className = 'fl-ctscan-label';
      const name = document.createElement('span');
      name.textContent = `${pick.dir} solver gap`;
      const val = document.createElement('b');
      val.textContent = text;
      val.style.color = calloutColor(s.toneOf(pick.zone));
      label.append(name, val);
      root.appendChild(label);
      const lines = [0, 1, 2].map(() => {
        const l = document.createElementNS(SVG_NS, 'line');
        l.setAttribute('class', 'fl-ctscan-dim');
        svg.appendChild(l);
        return l;
      });
      marks.push({
        label,
        lines,
        shell: { x: pick.point.x, z: pick.point.z },
        body: nearestBodyPoint(s.body, pick.point.x, pick.point.z),
        dir: pick.dir,
      });
    }
  };

  const buildRuler = (st: CtStack): void => {
    ruler.textContent = '';
    rulerEls = [];
    if (!st.slices.length) return;
    const bar = document.createElement('div');
    bar.className = 'fl-ctscan-bar';
    ruler.appendChild(bar);
    rulerEls.push(bar);
    const worst = worstTight(st.verdicts);
    st.slices.forEach((_, i) => {
      const el = document.createElement('div');
      const name = st.labels[i];
      el.className = name ? 'fl-ctscan-mark' : 'fl-ctscan-tick';
      const text = layerTag(name ?? '', st.verdicts[i] ?? '');
      if (text) {
        // Always-visible tag beside the disc (engine verdict word + its number only).
        const tag = document.createElement('span');
        const sv = shortVerdict(st.verdicts[i] ?? '');
        tag.className = `fl-ctscan-tag` + (sv ? ` is-${sv.tone}` : '') + (i === worst ? ' is-worst' : '');
        tag.textContent = text;
        el.appendChild(tag);
      }
      el.dataset.i = String(i);
      ruler.appendChild(el);
      rulerEls.push(el);
    });
  };

  /** Re-project the DOM for the current camera (cheap: a few points). */
  const place = (): void => {
    const cam = camera,
      st = stack;
    if (!cam || !st) return;
    const w = host.clientWidth,
      h = host.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    measure();
    // Ruler: beside the stack on the camera's right, one mark per layer at its floating centre.
    let reachM = 0;
    for (const s of st.slices)
      reachM = Math.max(reachM, reach(s.shell.length ? s.shell : s.body, s.centre));
    right.setFromMatrixColumn(cam.matrixWorld, 0).setY(0);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize().multiplyScalar(reachM * 1.3 + 0.04);
    const pts = st.slices.map((_, i) => {
      const c = cap?.layerCentre(i, lc);
      if (!c) return null;
      // On the far side of the disc from the body, kept inside the panel (labels need ~60 px).
      const s = st.slices[i];
      const away = (c.x - s.centre.x) * right.x + (c.z - s.centre.z) * right.z >= 0 ? 1 : -1;
      const q = project(cam, c.x + right.x * away, c.y, c.z + right.z * away);
      q.x = Math.max(8, Math.min(w - 170, q.x));
      return q;
    });
    const shown = pts.filter((p): p is NonNullable<typeof p> => !!p);
    for (const el of rulerEls) {
      if (el.classList.contains('fl-ctscan-bar')) {
        if (shown.length < 2) {
          el.style.display = 'none';
          continue;
        }
        const top = shown.reduce((a, b) => (b.y < a.y ? b : a));
        const bot = shown.reduce((a, b) => (b.y > a.y ? b : a));
        el.style.display = '';
        el.style.transform = `translate(${top.x.toFixed(1)}px, ${top.y.toFixed(1)}px)`;
        el.style.height = `${(bot.y - top.y).toFixed(1)}px`;
        continue;
      }
      const i = Number(el.dataset.i);
      const p = pts[i];
      el.style.display = p ? '' : 'none';
      el.classList.toggle('fl-ctscan-cur', i === hover);
      if (p) el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    }

    // Hovered layer: leader + card, and the gap marks moved with the layer's slide-out offset.
    const s = hover != null ? st.slices[hover] : undefined;
    const c = hover != null ? cap?.layerCentre(hover, lc) : null;
    if (!s || !c) {
      card.style.display = 'none';
      leader.style.display = 'none';
      for (const m of marks) {
        m.label.style.display = 'none';
        for (const l of m.lines) l.style.display = 'none';
      }
      return;
    }
    // CL slides each disc as a whole: offset = its current centre minus the cut's own centre.
    const ox = c.x - s.centre.x,
      oy = c.y - s.y,
      oz = c.z - s.centre.z;
    const cp = project(cam, c.x, c.y, c.z);
    card.style.display = '';
    const cw = card.offsetWidth || 200,
      ch = card.offsetHeight || 60;
    // Beside the disc, on the side away from the body (never over the head); flip if no room.
    const bodyX = project(cam, s.centre.x, s.y, s.centre.z).x;
    let toRight = cp.x >= bodyX;
    if (toRight && cp.x + 70 + cw > w - 8) toRight = false;
    else if (!toRight && cp.x - 70 - cw < 8) toRight = true;
    const cx = Math.max(8, Math.min(w - cw - 8, toRight ? cp.x + 70 : cp.x - 70 - cw));
    const cy = Math.max(8, Math.min(h - ch - 8, cp.y - ch / 2));
    card.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px)`;
    leader.style.display = '';
    setLine(leader, cp, { x: toRight ? cx : cx + cw, y: cy + ch / 2 });
    for (const m of marks) {
      const d = CALLOUT_DIRS[m.dir];
      const sp = project(cam, m.shell.x + ox, s.y + oy, m.shell.z + oz);
      const lp = project(cam, m.shell.x + ox + d.x * 0.05, s.y + oy, m.shell.z + oz + d.z * 0.05);
      m.label.style.display = lp.ok ? '' : 'none';
      m.label.style.transform = `translate(${lp.x.toFixed(1)}px, ${lp.y.toFixed(1)}px) translate(-50%, -50%)`;
      const vis = !!m.body && sp.ok;
      for (const l of m.lines) l.style.display = vis ? '' : 'none';
      if (!m.body || !vis) continue;
      const bp = project(cam, m.body.x + ox, s.y + oy, m.body.z + oz);
      setLine(m.lines[0], bp, sp);
      const dx = sp.x - bp.x,
        dy = sp.y - bp.y,
        len = Math.hypot(dx, dy) || 1,
        nx = (-dy / len) * 4,
        ny = (dx / len) * 4;
      setLine(m.lines[1], { x: bp.x - nx, y: bp.y - ny }, { x: bp.x + nx, y: bp.y + ny });
      setLine(m.lines[2], { x: sp.x - nx, y: sp.y - ny }, { x: sp.x + nx, y: sp.y + ny });
    }
  };

  const setHover = (i: number | null): void => {
    if (i === hover) return;
    hover = i;
    cap?.setHover(i);
    buildHover();
    place();
    requestRender?.();
  };

  const active = (): boolean => !!cap && !disposed && phase > 0.05 && !!stack && !!camera;

  // One rAF loop: pointer picking (throttled to a frame) and re-projection on camera moves (the
  // panel calls update() only on phase/stack changes; the layers keep sliding while phase < 1).
  const tick = (): void => {
    raf = 0;
    const cam = camera;
    if (!active() || !cam) return;
    if (pointerDirty) {
      pointerDirty = false;
      let i: number | null = null;
      if (pointer) {
        ndc.set(frame.mirror ? -pointer.x : pointer.x, pointer.y);
        rc.setFromCamera(ndc, cam);
        i = cap?.pick(rc) ?? null;
      }
      setHover(i);
    }
    const e = cam.matrixWorld.elements;
    const sig = `${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)},${e[8].toFixed(4)},${e[10].toFixed(4)},${host.clientWidth}x${host.clientHeight},${phase}`;
    if (sig !== camSig || phase < 1) {
      camSig = sig;
      place();
    }
    schedule();
  };
  function schedule(): void {
    if (!raf && active()) raf = requestAnimationFrame(tick);
  }

  const onMove = (ev: PointerEvent): void => {
    if (!active()) return;
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    measure();
    pointer = {
      x: ((ev.clientX - r.left - frame.x) / frame.w) * 2 - 1,
      y: -((ev.clientY - r.top - frame.y) / frame.h) * 2 + 1,
    };
    pointerDirty = true;
    schedule();
  };
  const onLeave = (): void => {
    pointer = null;
    pointerDirty = true;
    schedule();
  };
  host.addEventListener('pointermove', onMove, { passive: true });
  host.addEventListener('pointerleave', onLeave, { passive: true });

  return {
    hovered: () => hover,
    update(p, st, cam) {
      phase = p;
      stack = st;
      camera = cam;
      const show = p > 0.001 && !!st && st.slices.length > 0;
      root.style.display = show ? '' : 'none';
      root.style.opacity = String(Math.min(1, Math.max(0, p)));
      if (!show || p <= 0.05) {
        if (hover !== null) setHover(null);
      }
      if (!show || !st) return;
      const k =
        st.slices
          .map(
            (s) =>
              `${s.y.toFixed(4)}:${s.selectedSize}:${s.solver}:${s.shell.reduce((n, l) => n + l.points.length, 0)}`,
          )
          .join('|') +
        '#' +
        st.labels.join(',') +
        '#' +
        st.verdicts.join('|');
      if (k !== stackKey) {
        stackKey = k;
        buildRuler(st);
        if (hover != null && hover >= st.slices.length) {
          hover = null;
          cap?.setHover(null);
        }
        buildHover();
      }
      place();
      schedule();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      if (hover !== null) cap?.setHover(null);
      clearMarks();
      root.remove();
    },
  };
}
