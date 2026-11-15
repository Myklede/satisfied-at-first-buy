// CT slice view (agent CT, 2026-11-15): a small cross-section card in the see-through, a scan
// line in the 3D view, a draggable height handle at the panel edge and Collar · Chest · Hem chips.
// Everything drawn is the meshes on screen cut at one height (look/crossSection.ts); the coral
// arcs are the zones the engine marks tight/snug (the same zones R's see-through tints); numbers
// are the solver's `_inner_gap_cm` (physics shell) or the preview's shell-to-skin distance, plus
// the engine's zone verdict text.
import {
  BufferGeometry,
  type BufferAttribute,
  type BufferGeometry as Geometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Vector3,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import type { SizeLabel } from '../../contract';
import { FIT_ZONES, rankNotes, type FitZone, type ZoneState } from '../fitZones';
import {
  centre,
  cutMesh,
  cutMeshAt,
  interpolate,
  loopPerimeter,
  side,
  signedDistance,
  weldRepresentatives,
  yRange,
  type CutPoint,
  type Loop,
  type MeshCut,
} from '../look/crossSection';
import { SEE_THROUGH } from '../look/seeThrough';
import type { CtSlice, CtStack, CtTone } from '../look/ctTypes';
import { FIT_ZONE_ATTRIBUTE } from '../look/types';
import { THEME, TONE_COLOR } from './theme';

/** What the panel hands the slice (all live getters; nothing cached across sizes). */
export interface SliceSource {
  scene: Object3D;
  camera: PerspectiveCamera;
  /** Element whose rect is the 3D canvas (for the handle's screen position). */
  canvas: HTMLCanvasElement;
  reveal(): number;
  /** The shown jacket mesh; solver = its `_inner_gap_cm` is the cloth solver's (physics). */
  selected(): { mesh: Mesh; solver: boolean; welds?: ArrayLike<number> } | null;
  ghosts(): { size: SizeLabel; mesh: Mesh; welds?: ArrayLike<number> }[];
  size(): SizeLabel;
  body(): Mesh | null;
  states(): readonly ZoneState[];
  anchorY(zone: FitZone): number | null;
  mirrored(): boolean;
  /** Ask the view for one redraw (the panel's 3D draws on change). */
  redraw(): void;
}

const CHIPS: readonly FitZone[] = ['collar', 'chest', 'hem'];
const CHIP_LABEL: Record<FitZone, string> = {
  collar: 'Collar',
  shoulder: 'Shoulders',
  chest: 'Chest',
  hem: 'Hem',
  bicep: 'Bicep',
  sleeve: 'Sleeve',
};
/** Re-slice at most this often (ms): ~10 Hz. */
const SLICE_INTERVAL_MS = 100;
const COLLAR_INDEX = FIT_ZONES.indexOf('collar');
const posVersion = (m: Mesh) =>
  (m.geometry.getAttribute('position') as BufferAttribute | undefined)?.version ?? 0;

/** Card fade from the reveal: hidden in the Look, in from 0.4, full at 0.6 (display only). */
export function sliceVisibility(reveal: number) {
  return Math.min(1, Math.max(0, (reveal - 0.4) / 0.2));
}

/** Sleeve zones (bicep, cuff): left out of the preview gap, which measures the torso only. */
const SLEEVE_ZONES = new Set([FIT_ZONES.indexOf('bicep'), FIT_ZONES.indexOf('sleeve')]);

/**
 * Gap (cm) at a shell cut point. Solver: the mesh's `_inner_gap_cm` interpolated on the cut edge.
 * Preview (the LBS shell's attribute is not solved): torso only, i.e. the 2D distance from the
 * shell cut to the torso body loop (the longest closed body loop; the arms are left out), null on
 * sleeve / bicep points. Negative = the preview shell is inside the torso cut.
 */
export function gapFunction(
  geometry: Geometry | undefined,
  solver: boolean,
  body: readonly Loop[],
): (p: CutPoint) => number | null {
  const gapAttr = geometry?.getAttribute('_inner_gap_cm');
  if (solver && gapAttr) {
    const gaps = gapAttr.array as ArrayLike<number>;
    return (p) => interpolate(gaps, p);
  }
  const zones = geometry?.getAttribute(FIT_ZONE_ATTRIBUTE)?.array as ArrayLike<number> | undefined;
  let torso: Loop | null = null;
  for (const l of body)
    if (l.closed && (!torso || loopPerimeter(l) > loopPerimeter(torso))) torso = l;
  if (!torso) return () => null;
  const ring = [torso];
  return (p) => {
    if (zones && (SLEEVE_ZONES.has(zones[p.a]) || SLEEVE_ZONES.has(zones[p.b]))) return null;
    const g = signedDistance(p.x, p.z, ring) * 100;
    return Number.isFinite(g) ? g : null;
  };
}

/** Stack: a snapshot that does not follow the live pose. A call after this long without one
 *  counts as entering the CT stage again and rebuilds (display only). */
const STACK_REENTER_MS = 1000;

/** Fit zone (FIT_ZONES index) most of the shell cut's segments carry, if any. */
function majorityZone(loops: readonly Loop[]): number | undefined {
  const count = new Map<number, number>();
  for (const l of loops) for (const z of l.zones) if (z >= 0) count.set(z, (count.get(z) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const toneFor =
  (states: readonly ZoneState[]) =>
  (zone: number): CtTone => {
    const z = FIT_ZONES[zone];
    const s = z ? states.find((st) => st.zone === z) : undefined;
    return s && (s.tone === 'tight' || s.tone === 'snug') ? s.tone : null;
  };

export class SliceView {
  private root: HTMLDivElement;
  private card: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private caption: HTMLDivElement;
  private title: HTMLSpanElement;
  private track: HTMLDivElement;
  private handle: HTMLDivElement;
  private chips = new Map<FitZone, HTMLButtonElement>();
  private group = new Group();
  private lines: LineSegments;
  private coral: LineSegments;
  /** Slice height: a zone anchor (follows the size) or a dragged world y. */
  private at: { zone: FitZone } | { y: number } | null = null;
  private lastSig = '';
  private lastSlice = 0;
  private range: [number, number] = [0, 2];
  private rangeKey = '';
  private y = 1;
  private v = new Vector3();
  /** Mean / last slice cost (ms), for the report. */
  stats = { last: 0, mean: 0, count: 0 };
  private current: CtSlice | null = null;
  private sliceListeners = new Set<() => void>();

  /**
   * The current slice for the CT stage (lead's ctTypes.ts contract), or null before the first
   * slice. gapAt: physics = the solver's `_inner_gap_cm` interpolated on the cut edge; preview
   * (solver false) = the same shell-to-skin distance the card shows, label it "preview".
   */
  snapshot(): CtSlice | null {
    return this.current;
  }

  /** Fires after every re-slice; returns the unsubscribe. */
  onSlice(cb: () => void): () => void {
    this.sliceListeners.add(cb);
    return () => this.sliceListeners.delete(cb);
  }

  constructor(
    host: HTMLElement,
    private src: SliceSource,
  ) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') => {
      const e = document.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    this.root = el('div', 'fl-ct');
    this.card = el('div', 'fl-ct-card');
    const head = el('div', 'fl-ct-head');
    this.title = el('span', 'fl-ct-title', 'Slice');
    const chipRow = el('div', 'fl-ct-chips');
    for (const z of CHIPS) {
      const b = el('button', 'fl-ct-chip', CHIP_LABEL[z]);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.at = { zone: z };
        this.lastSig = '';
      });
      this.chips.set(z, b);
      chipRow.append(b);
    }
    head.append(this.title, chipRow);
    this.canvas = el('canvas', 'fl-ct-canvas');
    this.caption = el('div', 'fl-ct-caption');
    this.card.append(head, this.canvas, this.caption);
    this.track = el('div', 'fl-ct-track');
    this.handle = el('div', 'fl-ct-handle');
    this.handle.title = 'Drag to move the cross-section';
    this.track.append(this.handle);
    this.root.append(this.card, this.track);
    host.append(this.root);
    for (const e of [this.card, this.handle])
      for (const type of ['wheel', 'dblclick', 'pointerdown'] as const)
        e.addEventListener(type, (ev) => ev.stopPropagation());
    this.handle.addEventListener('pointerdown', (ev) => {
      this.handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    this.handle.addEventListener('pointermove', (ev) => {
      if (!this.handle.hasPointerCapture(ev.pointerId)) return;
      const y = this.worldYAt(ev.clientY);
      if (y != null) {
        this.at = { y };
        this.lastSig = '';
      }
    });
    const line = (color: string, opacity: number) =>
      new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    this.lines = new LineSegments(new BufferGeometry(), line(THEME.accent, 0.9));
    this.coral = new LineSegments(new BufferGeometry(), line(TONE_COLOR.tight, 1));
    for (const l of [this.lines, this.coral]) {
      l.renderOrder = 10;
      l.frustumCulled = false;
      this.group.add(l);
    }
    this.group.visible = false;
    src.scene.add(this.group);
  }

  /** Called every frame by the panel; re-slices only on change, at most ~10 Hz. */
  tick(now: number) {
    const vis = sliceVisibility(this.src.reveal());
    // The card, chips and handle also fade out as the CT stage takes over (gone at ctFade 0.5);
    // visibility hidden = no pointer events. Slicing continues for the stage.
    const ui = vis * Math.max(0, 1 - this.ctFade / 0.5);
    this.root.style.opacity = String(ui);
    this.root.style.visibility = ui > 0.01 ? 'visible' : 'hidden';
    const was = this.group.visible;
    this.group.visible = vis > 0.01;
    if (was !== this.group.visible) this.src.redraw();
    if (vis <= 0.01) return;
    this.placeHandle();
    if (now - this.lastSlice < SLICE_INTERVAL_MS) return;
    const sel = this.src.selected();
    const body = this.src.body();
    if (!sel || !body) return;
    const ver = (m: Mesh | null) => (m ? `${m.uuid}:${posVersion(m)}` : '-');
    const states = this.src.states();
    const y = this.targetY(sel.mesh, states);
    if (y == null) return;
    const sig = [
      y.toFixed(4),
      this.src.size(),
      sel.solver,
      ver(sel.mesh),
      ver(body),
      this.src
        .ghosts()
        .map((g) => ver(g.mesh))
        .join(','),
      states.map((s) => `${s.zone}${s.tone}${s.valueCm}`).join(','),
      this.src.mirrored(),
      vis > 0.5,
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.lastSlice = now;
    this.y = y;
    this.slice(sel, body, states);
  }

  /** The slice height: a dragged y, a chip's zone anchor, else the tightest zone (or chest). */
  private targetY(mesh: Mesh, states: readonly ZoneState[]): number | null {
    const key = `${mesh.uuid}:${posVersion(mesh)}`;
    if (key !== this.rangeKey) {
      const all = yRange(mesh);
      const collar = yRange(mesh, new Set([COLLAR_INDEX]));
      if (all) this.range = [all[0], collar ? collar[1] : all[1]];
      this.rangeKey = key;
    }
    const [lo, hi] = this.range;
    let zone: FitZone = 'chest';
    if (this.at && 'y' in this.at) return Math.min(hi, Math.max(lo, this.at.y));
    if (this.at) zone = this.at.zone;
    else {
      const worst = rankNotes([...states]).find((s) => s.tone === 'tight' || s.tone === 'snug');
      if (worst) zone = worst.zone;
    }
    for (const [z, b] of this.chips)
      b.classList.toggle('on', !!this.at && 'zone' in this.at && z === zone);
    const y = this.src.anchorY(zone);
    return y == null ? null : Math.min(hi, Math.max(lo, y));
  }

  private slice(
    sel: { mesh: Mesh; solver: boolean; welds?: ArrayLike<number> },
    body: Mesh,
    states: readonly ZoneState[],
  ) {
    const t0 = performance.now();
    const y = this.y;
    const bodyCut = this.cut(body, y);
    const selCut = this.cut(sel.mesh, y, sel.welds);
    const ghosts = this.src
      .ghosts()
      .filter((g) => g.mesh !== sel.mesh && g.size !== this.src.size())
      .map((g) => ({ size: g.size, cut: this.cut(g.mesh, y, g.welds) }));
    const ms = performance.now() - t0;
    this.stats.last = ms;
    this.stats.count++;
    this.stats.mean += (ms - this.stats.mean) / this.stats.count;
    const toneOf = toneFor(states);
    const bodyLoops = bodyCut?.loops ?? [];
    const gapAt = gapFunction(selCut?.geometry, sel.solver, bodyLoops);
    this.current = {
      y: this.y,
      centre: centre(bodyLoops),
      body: bodyLoops,
      shell: selCut?.loops ?? [],
      ghosts: ghosts.map((g) => ({ size: g.size, loops: g.cut?.loops ?? [] })),
      gapAt,
      toneOf,
      solver: sel.solver,
      selectedSize: this.src.size(),
    };
    this.update3d(selCut, toneOf);
    this.draw(bodyCut, selCut, ghosts, toneOf);
    this.writeCaption(bodyCut, selCut, sel.solver, states);
    this.src.redraw();
    for (const cb of this.sliceListeners) cb();
  }

  private stackCache: CtStack | null = null;
  private stackKey = '';
  private stackAt = -Infinity;
  /** Cost of the last stack build (ms). */
  stackMs = 0;

  /**
   * CT stage v2: n slices from the Hem anchor up to the Collar anchor (both included); the layer
   * nearest each of FL's zone anchors (Collar, Chest, Hem) snaps onto it and carries its word.
   * A frozen snapshot: rebuilt only on a size / jacket / zip (zone states) / physics change, or on
   * the first call after entering the stage (no call for STACK_REENTER_MS). Pose motion does not
   * rebuild it, so a moving person never causes the ~30 ms rebuild while the stage is shown.
   */
  stack(n = 7): CtStack | null {
    const now = performance.now();
    const reentered = now - this.stackAt > STACK_REENTER_MS;
    this.stackAt = now;
    const sel = this.src.selected();
    const body = this.src.body();
    if (!sel || !body) return this.stackCache;
    const states = this.src.states();
    const ghostList = this.src
      .ghosts()
      .filter((g) => g.mesh !== sel.mesh && g.size !== this.src.size());
    const key = [
      n,
      sel.mesh.uuid,
      sel.solver,
      this.src.size(),
      ghostList.map((g) => g.mesh.uuid).join(','),
      states.map((s) => `${s.zone}${s.tone}${s.valueCm}`).join(','),
    ].join('|');
    if (this.stackCache && key === this.stackKey && !reentered) return this.stackCache;
    const anchors = (['hem', 'chest', 'collar'] as const).map((z) => ({
      z,
      y: this.src.anchorY(z),
    }));
    const hem = anchors[0].y,
      collar = anchors[2].y;
    if (hem == null || collar == null || n < 2) return this.stackCache;
    const t0 = performance.now();
    const heights = Array.from({ length: n }, (_, i) => hem + ((collar - hem) * i) / (n - 1));
    const labels: string[] = new Array<string>(n).fill('');
    for (const a of anchors) {
      if (a.y == null) continue;
      let best = 0;
      for (let i = 1; i < n; i++)
        if (Math.abs(heights[i] - a.y) < Math.abs(heights[best] - a.y)) best = i;
      heights[best] = a.y;
      labels[best] = CHIP_LABEL[a.z];
    }
    const toneOf = toneFor(states);
    const repOf = (mesh: Mesh, welds?: ArrayLike<number>) => {
      if (!welds) return undefined;
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      let rep = this.reps.get(welds);
      if (!rep || rep.length !== count) {
        rep = weldRepresentatives(count, welds);
        this.reps.set(welds, rep);
      }
      return rep;
    };
    const selRep = repOf(sel.mesh, sel.welds);
    const ghostReps = ghostList.map((g) => repOf(g.mesh, g.welds));
    const verdicts: string[] = [];
    // One pass per mesh for all heights (each triangle meets only the heights in its y-range).
    const bodyCuts = cutMeshAt(body, heights);
    const selCuts = cutMeshAt(sel.mesh, heights, selRep);
    const ghostCuts = ghostList.map((g, k) => cutMeshAt(g.mesh, heights, ghostReps[k]));
    const slices: CtSlice[] = heights.map((y, i) => {
      const bodyLoops = bodyCuts[i]?.loops ?? [];
      const selCut = selCuts[i];
      const shell = selCut?.loops ?? [];
      const zi = majorityZone(shell);
      const zone = zi != null ? FIT_ZONES[zi] : undefined;
      const state = zone ? states.find((s) => s.zone === zone) : undefined;
      verdicts.push(state ? state.callout || state.note : '');
      return {
        y,
        centre: centre(bodyLoops),
        body: bodyLoops,
        shell,
        ghosts: ghostList.map((g, k) => ({
          size: g.size,
          loops: ghostCuts[k][i]?.loops ?? [],
        })),
        gapAt: gapFunction(selCut?.geometry, sel.solver, bodyLoops),
        toneOf,
        solver: sel.solver,
        selectedSize: this.src.size(),
      };
    });
    this.stackMs = performance.now() - t0;
    this.stackCache = { slices, labels, verdicts };
    this.stackKey = key;
    return this.stackCache;
  }

  private ctFade = 0;

  /** CS: fades the 3D scan lines out as the CT stage takes over (0 = full lines, 1 = none). */
  setCtFade(t: number) {
    this.ctFade = Math.min(1, Math.max(0, t));
    const k = 1 - this.ctFade;
    (this.lines.material as LineBasicMaterial).opacity = 0.9 * k;
    (this.coral.material as LineBasicMaterial).opacity = k;
    this.lines.visible = this.coral.visible = k > 0.01;
    this.src.redraw();
  }

  /** Cut cache: a hidden ghost size does not move, so its cut is reused until y or it changes. */
  private cuts = new Map<string, { key: string; cut: MeshCut | null }>();
  private reps = new WeakMap<ArrayLike<number>, Int32Array>();
  private cut(mesh: Mesh, y: number, welds?: ArrayLike<number>): MeshCut | null {
    const key = `${posVersion(mesh)}|${y}`;
    const hit = this.cuts.get(mesh.uuid);
    if (hit && hit.key === key) return hit.cut;
    let rep: Int32Array | undefined;
    if (welds) {
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      rep = this.reps.get(welds);
      if (!rep || rep.length !== count) {
        rep = weldRepresentatives(count, welds);
        this.reps.set(welds, rep);
      }
    }
    const cut = cutMesh(mesh, y, rep);
    this.cuts.set(mesh.uuid, { key, cut });
    if (this.cuts.size > 12) this.cuts.delete(this.cuts.keys().next().value!);
    return cut;
  }

  private update3d(cut: MeshCut | null, toneOf: (z: number) => string | null) {
    const plain: number[] = [],
      hot: number[] = [];
    const y = this.y + 0.001;
    const mirror = 1; // the 3D group is drawn in world space; a CSS mirror flips it with the image
    for (const loop of cut?.loops ?? []) {
      const p = loop.points,
        n = p.length,
        m = loop.closed ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const a = p[i],
          b = p[(i + 1) % n];
        (toneOf(loop.zones[i] ?? -1) ? hot : plain).push(
          a.x * mirror,
          y,
          a.z,
          b.x * mirror,
          y,
          b.z,
        );
      }
    }
    const set = (l: LineSegments, arr: number[]) => {
      l.geometry.dispose();
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(arr, 3));
      l.geometry = g;
    };
    set(this.lines, plain);
    set(this.coral, hot);
  }

  private draw(
    bodyCut: MeshCut | null,
    selCut: MeshCut | null,
    ghosts: { size: SizeLabel; cut: MeshCut | null }[],
    toneOf: (z: number) => string | null,
  ) {
    const css = 180;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== css * dpr) {
      this.canvas.width = css * dpr;
      this.canvas.height = css * dpr;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    // Frame on the torso: the longest body loop and each jacket's longest loop (arms or hands
    // cut lengthwise at this height may fall outside the card; the canvas clips them).
    const longest = (ls: readonly Loop[] | undefined) =>
      (ls ?? []).reduce<Loop | null>(
        (b, l) => (!b || loopPerimeter(l) > loopPerimeter(b) ? l : b),
        null,
      );
    const all = [
      longest(bodyCut?.loops),
      longest(selCut?.loops),
      ...ghosts.map((g) => longest(g.cut?.loops)),
    ].filter((l): l is Loop => !!l);
    if (!all.length) return;
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const l of all)
      for (const p of l.points) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z);
        z1 = Math.max(z1, p.z);
      }
    const pad = 14;
    const k = (css - pad * 2) / Math.max(x1 - x0, z1 - z0, 0.05);
    const mx = (x0 + x1) / 2,
      mz = (z0 + z1) / 2;
    const flip = this.src.mirrored() ? -1 : 1;
    // Top-down, the body's front (+Z) up; x follows the image (mirrored when the panel mirrors).
    const sx = (x: number) => css / 2 + (x - mx) * k * flip;
    const sy = (z: number) => css / 2 - (z - mz) * k;
    const path = (l: Loop) => {
      ctx.beginPath();
      l.points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.z)) : ctx.moveTo(sx(p.x), sy(p.z))));
      if (l.closed) ctx.closePath();
    };
    // Front marker.
    ctx.fillStyle = THEME.textSoft;
    ctx.font = `9px ${THEME.font}`;
    ctx.textAlign = 'center';
    ctx.fillText('front', css / 2, 9);
    // Body: clay, as R's see-through body.
    ctx.fillStyle = SEE_THROUGH.clay;
    ctx.strokeStyle = 'rgba(29,29,31,0.25)';
    ctx.lineWidth = 1;
    for (const l of bodyCut?.loops ?? []) {
      path(l);
      if (l.closed) ctx.fill();
      ctx.stroke();
    }
    // Ghost sizes: faint, tagged.
    ctx.textAlign = 'left';
    for (const g of ghosts) {
      ctx.strokeStyle = 'rgba(29,29,31,0.2)';
      ctx.setLineDash([3, 3]);
      let tag: { x: number; z: number } | null = null;
      for (const l of g.cut?.loops ?? []) {
        path(l);
        ctx.stroke();
        for (const p of l.points) if (!tag || p.x * flip > tag.x * flip) tag = p;
      }
      ctx.setLineDash([]);
      if (tag) {
        ctx.fillStyle = 'rgba(29,29,31,0.45)';
        ctx.fillText(g.size, Math.min(css - 9, sx(tag.x) + 2), sy(tag.z) + 3);
      }
    }
    // Selected size: solid, coral arcs on the engine's tight / snug zones.
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = THEME.text;
    for (const l of selCut?.loops ?? []) {
      path(l);
      ctx.stroke();
    }
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const l of selCut?.loops ?? []) {
      const p = l.points,
        n = p.length,
        m = l.closed ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const tone = toneOf(l.zones[i] ?? -1);
        if (!tone) continue;
        ctx.strokeStyle = tone === 'tight' ? TONE_COLOR.tight : 'rgba(229,72,77,0.55)';
        ctx.beginPath();
        ctx.moveTo(sx(p[i].x), sy(p[i].z));
        ctx.lineTo(sx(p[(i + 1) % n].x), sy(p[(i + 1) % n].z));
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }

  private writeCaption(
    bodyCut: MeshCut | null,
    selCut: MeshCut | null,
    solver: boolean,
    states: readonly ZoneState[],
  ) {
    const loops = selCut?.loops ?? [];
    const bodyLoops = bodyCut?.loops ?? [];
    const isSolver = solver && !!selCut?.geometry.getAttribute('_inner_gap_cm');
    const gapAt = gapFunction(selCut?.geometry, solver, bodyLoops);
    const c = centre(bodyLoops);
    let min = Infinity,
      where = '';
    const zoneIdx = majorityZone(loops);
    // Min gap over the cut of that zone (all points when no zone is painted at this height).
    for (const l of loops)
      l.points.forEach((p, i) => {
        const z = l.zones[i] ?? l.zones[i - 1];
        if (zoneIdx != null && z !== zoneIdx && l.zones[i - 1] !== zoneIdx) return;
        const g = gapAt(p);
        if (g != null && g < min) {
          min = g;
          where = side(p.x, p.z, c.x, c.z);
        }
      });
    const zone = zoneIdx != null ? FIT_ZONES[zoneIdx] : undefined;
    const state = zone ? states.find((s) => s.zone === zone) : undefined;
    // Open = the jacket's main ring at this height is not closed (an opened zip: a "C").
    const ring = loops.reduce<Loop | null>(
      (b, l) => (!b || loopPerimeter(l) > loopPerimeter(b) ? l : b),
      null,
    );
    const open = !!ring && !ring.closed;
    const cm = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} cm`;
    this.title.textContent = `Slice${zone ? ` · ${CHIP_LABEL[zone]}` : ''}`;
    const verdict = state ? state.callout || state.note : '';
    // Solver: the solver's gap at this cut, then the engine verdict. Preview: the engine verdict
    // only (the preview's shell-to-skin distance is a different metric from the zone ease).
    const line1 = !loops.length
      ? 'No jacket at this height'
      : isSolver && Number.isFinite(min)
        ? `Solver gap: min ${cm(min)} at ${where}${open ? ' · open' : ''}`
        : open
          ? 'Open at this height'
          : '';
    this.caption.textContent = '';
    if (line1) {
      const a = document.createElement('div');
      a.textContent = line1;
      this.caption.append(a);
    }
    if (verdict) {
      const b = document.createElement('div');
      b.className = `fl-ct-verdict ${state && state.tone !== 'none' ? state.tone : ''}`;
      b.textContent = verdict;
      this.caption.append(b);
    }
  }

  /** Keeps the handle at the slice's screen height. */
  private placeHandle() {
    const sy = this.screenY(this.y);
    if (sy == null) return;
    const r = this.track.getBoundingClientRect();
    this.handle.style.transform = `translateY(${Math.round(sy - r.top - 7)}px)`;
  }

  private screenY(y: number): number | null {
    const cam = this.src.camera;
    const r = this.src.canvas.getBoundingClientRect();
    if (!r.height) return null;
    this.v.set(0, y, 0).project(cam);
    return r.top + ((1 - this.v.y) / 2) * r.height;
  }

  /** World y whose projection is at clientY (bisection: projection is monotonic in y here). */
  private worldYAt(clientY: number): number | null {
    let [lo, hi] = this.range;
    const slo = this.screenY(lo),
      shi = this.screenY(hi);
    if (slo == null || shi == null) return null;
    if (clientY >= slo) return lo;
    if (clientY <= shi) return hi;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if ((this.screenY(mid) ?? 0) > clientY) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  dispose() {
    this.sliceListeners.clear();
    this.current = null;
    this.group.removeFromParent();
    this.lines.geometry.dispose();
    this.coral.geometry.dispose();
    (this.lines.material as LineBasicMaterial).dispose();
    (this.coral.material as LineBasicMaterial).dispose();
    this.root.remove();
  }
}
