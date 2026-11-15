// CT cap (agent CL, 2026-11-15): the 3D cut drawn like a CT scan, just under the slice plane so
// the global clipping (everything above slice.y removed) keeps it. Layers: body cap (clay fill,
// darker rim), air gap (translucent blue-grey ring between shell and body cut, coral where the
// engine's zone tone is tight / snug), shell cut (crisp ribbon, coral on tight / snug segments),
// ghost sizes (faint dashed lines with a tiny size tag). Geometry is rebuilt only when the slice
// changes (signature); phase only fades opacity. No number is invented here: the shapes are the
// engine's cut loops and the tints are the engine's own zone tones (CtSlice.toneOf).
import {
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  type Raycaster,
  type Material,
  type Object3D,
  type Scene,
} from 'three';
import { THEME, TONE_COLOR } from '../ui/theme';
import type { CtPickable, CtSlice, CtStack, CtStackLayer, CtTone } from './ctTypes';
import type { Loop } from './crossSection';

/** Visual constants of the cap (display only; nothing here affects a fit number). */
export const CT_CAP = {
  /** Offsets under the plane (m), stacked so layers never z-fight; all stay below slice.y. */
  yBody: -0.0009,
  yGap: -0.0007,
  yLine: -0.0005,
  yGhost: -0.0004,
  /** Darker, more saturated than the see-through clay so discs stand out (user 06:25). */
  clay: '#8f949b',
  clayRim: '#5f646b',
  /** Rim ribbon width (m). */
  rimWidth: 0.003,
  gap: '#7f9bb8',
  gapOpacity: 0.55,
  tight: TONE_COLOR.tight,
  snug: '#F2A3A5',
  tintOpacity: 0.62,
  /** Dark graphite shell cut. */
  shell: '#2b2f36',
  /** Shell ribbon width (m): about 2-3 px at the oblique CT framing. */
  shellWidth: 0.005,
  ghost: '#6E6E73',
  ghostOpacity: 0.3,
  ghostDash: 0.006,
  ghostGap: 0.005,
} as const;

/** Loop -> 2D shape points for ShapeGeometry: (x, -z), so rotation.x = -PI/2 maps back to world (x, 0, z). */
export function loopToShapePoints(loop: Loop): Vector2[] {
  const pts = loop.points.map((p) => new Vector2(p.x, -p.z));
  if (pts.length > 1) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (a.distanceTo(b) < 1e-7) pts.pop();
  }
  return pts;
}

/** Number of segments of a loop (closed loops include the closing segment). */
export function segmentCount(loop: Loop): number {
  const n = loop.points.length;
  if (n < 2) return 0;
  return loop.closed ? n : n - 1;
}

/** Engine tone per segment of a loop (only tight / snug; null otherwise). */
export function segmentTones(loop: Loop, toneOf: (zone: number) => CtTone): CtTone[] {
  const out: CtTone[] = [];
  for (let i = 0; i < segmentCount(loop); i++) {
    const zone = loop.zones[i] ?? -1;
    out.push(zone >= 0 ? toneOf(zone) : null);
  }
  return out;
}

/** Nearest body point (over all body loops) to (x, z); null when there is no body point. */
export function nearestBodyPoint(
  x: number,
  z: number,
  body: readonly Loop[],
): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (const loop of body) {
    for (const p of loop.points) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: p.x, z: p.z };
      }
    }
  }
  return best;
}

/** One quad of the air-gap ring: shell edge s0 -> s1 matched to body points b0, b1, and its tone. */
export interface RingQuad {
  s0: { x: number; z: number };
  s1: { x: number; z: number };
  b0: { x: number; z: number };
  b1: { x: number; z: number };
  tone: CtTone;
}

/**
 * Air-gap ring as a strip of quads, one per existing shell segment, each matched to the nearest
 * body points. An open "C" shell yields quads only where the shell exists (no invented closure).
 */
export function ringQuads(
  shell: readonly Loop[],
  body: readonly Loop[],
  toneOf: (zone: number) => CtTone,
): RingQuad[] {
  const quads: RingQuad[] = [];
  for (const loop of shell) {
    const n = loop.points.length;
    const tones = segmentTones(loop, toneOf);
    const matched = loop.points.map((p) => nearestBodyPoint(p.x, p.z, body));
    for (let i = 0; i < tones.length; i++) {
      const j = (i + 1) % n;
      const a = loop.points[i]!;
      const b = loop.points[j]!;
      const ma = matched[i];
      const mb = matched[j];
      if (!ma || !mb) continue;
      quads.push({ s0: { x: a.x, z: a.z }, s1: { x: b.x, z: b.z }, b0: ma, b1: mb, tone: tones[i] ?? null });
    }
  }
  return quads;
}

/** Ribbon (flat strip in x-z, width w) along a loop's segments; per-segment colour via tone. */
export function ribbonTriangles(
  loop: Loop,
  width: number,
): { quads: { a: [number, number]; b: [number, number]; c: [number, number]; d: [number, number] }[] } {
  const quads: { a: [number, number]; b: [number, number]; c: [number, number]; d: [number, number] }[] = [];
  const n = loop.points.length;
  const h = width / 2;
  for (let i = 0; i < segmentCount(loop); i++) {
    const p = loop.points[i]!;
    const q = loop.points[(i + 1) % n]!;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) {
      quads.push({ a: [p.x, p.z], b: [p.x, p.z], c: [q.x, q.z], d: [q.x, q.z] });
      continue;
    }
    // Perpendicular, and extend each end by h along the segment so joins close without gaps.
    const nx = (-dz / len) * h;
    const nz = (dx / len) * h;
    const ex = (dx / len) * h * 0.5;
    const ez = (dz / len) * h * 0.5;
    quads.push({
      a: [p.x - ex + nx, p.z - ez + nz],
      b: [p.x - ex - nx, p.z - ez - nz],
      c: [q.x + ex - nx, q.z + ez - nz],
      d: [q.x + ex + nx, q.z + ez + nz],
    });
  }
  return { quads };
}

/** Signature of a slice's geometry: rebuild only when it changes. */
export function sliceSignature(slice: CtSlice): string {
  const loopSig = (loops: readonly Loop[]) =>
    loops
      .map((l) => {
        const f = l.points[0];
        const m = l.points[l.points.length >> 1];
        return `${l.points.length}${l.closed ? 'c' : 'o'}:${f ? f.x.toFixed(4) + ',' + f.z.toFixed(4) : ''}:${m ? m.x.toFixed(4) + ',' + m.z.toFixed(4) : ''}:${l.zones.join('.')}`;
      })
      .join('|');
  return [
    slice.y.toFixed(4),
    slice.selectedSize,
    loopSig(slice.body),
    loopSig(slice.shell),
    slice.ghosts.map((g) => `${g.size}=${loopSig(g.loops)}`).join(';'),
  ].join('#');
}

function toneColour(tone: CtTone): string | null {
  if (tone === 'tight') return CT_CAP.tight;
  if (tone === 'snug') return CT_CAP.snug;
  return null;
}

interface Faded {
  material: Material & { opacity: number };
  base: number;
}

function ribbonGeometry(loop: Loop, width: number, y: number, colours: (Color | null)[], fallback: Color): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const { quads } = ribbonTriangles(loop, width);
  quads.forEach((q, i) => {
    const c = colours[i] ?? fallback;
    for (const v of [q.a, q.b, q.c, q.a, q.c, q.d]) {
      pos.push(v[0], y, v[1]);
      col.push(c.r, c.g, c.b);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

function tagSprite(text: string): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '600 40px -apple-system, Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = CT_CAP.ghost;
    ctx.fillText(text, 32, 34);
  }
  const tex = new CanvasTexture(canvas);
  const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(0.014, 0.014, 1);
  return sprite;
}

/** v2 stack motion (display only). */
export const CT_STACK = {
  /** Horizontal slide out of the body along the camera's flat right vector (m). */
  slide: 0.4,
  /** Vertical fan about the stack's middle at full progress (lead 06:20: no overlap at 20 deg). */
  fan: 1.8,
  /** Display scale of each disc about its own centre at full progress (shape stays true). */
  scale: 1.25,
  /** Stagger between layers (bottom first). */
  stagger: 0.08,
  /** Hover rim: the calm theme accent (a white rim vanished on the light Fit Lab background). */
  hoverRim: THEME.accent,
  hoverRimOpacity: 0.85,
  hoverRimWidth: 0.007,
  /** Clay brightening on hover (lerp to white). */
  hoverLift: 0.35,
  /** Under-plate: a slightly larger very faint dark disc 1 cm below each layer. */
  plateDrop: 0.01,
  plateGrow: 0.012,
  plateOpacity: 0.12,
  plate: '#1d1d1f',
  /** Front notch (+Z of the body) on each disc. */
  notchLength: 0.018,
  notchWidth: 0.004,
  /** Hovered layer moves this far toward the camera (m). */
  hoverToward: 0.03,
} as const;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Layer i's progress: clamp((phase - i*s) / (1 - (n-1)*s)), bottom (i = 0) first. */
export function layerProgress(i: number, n: number, phase: number, s: number = CT_STACK.stagger): number {
  const span = 1 - Math.max(0, n - 1) * s;
  if (span <= 1e-6) return phase >= 1 ? 1 : clamp01(phase - i * s);
  return clamp01((phase - i * s) / span);
}

/** Smooth ease for the slide (cubic in-out). */
export function easeInOut(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Fanned height of a layer at y about the stack middle, blended by progress e. With `lift`, the
 * stack's middle moves to that height (the chest) as it fans out.
 */
export function fanY(y: number, mid: number, e: number, fan: number = CT_STACK.fan, lift: number = mid): number {
  return y + (lift + (y - mid) * fan - y) * e;
}

/** Height the stack's middle moves to: the layer labelled Chest, else the stack's middle. */
export function liftHeight(ys: readonly number[], labels: readonly string[]): number {
  const i = labels.indexOf('Chest');
  if (i >= 0 && ys[i] !== undefined) return ys[i]!;
  if (ys.length === 0) return 0;
  return (Math.min(...ys) + Math.max(...ys)) / 2;
}

/** Shoelace area of a loop in x-z (m^2, absolute). */
export function loopArea(loop: Loop): number {
  const pts = loop.points;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/**
 * Torso-only view of a slice: the largest closed body loop, and the shell / ghost loops whose
 * point-average lies inside the torso's x-z bounding box (an open "C" around the torso stays;
 * arm, hand and sleeve loops beside it go). With no closed body loop, the slice is unchanged.
 */
export function torsoOnly(slice: CtSlice): CtSlice {
  let torso: Loop | null = null;
  let best = 0;
  for (const l of slice.body) {
    if (!l.closed || l.points.length < 3) continue;
    const a = loopArea(l);
    if (a > best) {
      best = a;
      torso = l;
    }
  }
  if (!torso) return slice;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of torso.points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const around = (l: Loop) => {
    if (l.points.length === 0) return false;
    let x = 0;
    let z = 0;
    for (const p of l.points) {
      x += p.x;
      z += p.z;
    }
    x /= l.points.length;
    z /= l.points.length;
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
  };
  return {
    ...slice,
    body: [torso],
    shell: slice.shell.filter(around),
    ghosts: slice.ghosts.map((g) => ({ size: g.size, loops: g.loops.filter(around) })),
  };
}

/** Signature of a whole stack. */
export function stackSignature(stack: CtStack): string {
  return stack.slices.map(sliceSignature).join('§');
}

interface Disc {
  group: Group;
  faded: Faded[];
  pickDisc: Mesh;
  hoverRim: Group;
  ghosts: Group;
  clay: MeshBasicMaterial;
  y: number;
  /** Placed position without the hover offset. */
  base: Vector3;
  cx: number;
  cz: number;
  progress: number;
}

function disposeTree(root: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      (mat as SpriteMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

/** One slice as a disc in local coordinates: origin = (slice centre x, slice.y, centre z). */
function buildDisc(full: CtSlice): Disc {
  const slice = torsoOnly(full);
  const group = new Group();
  const faded: Faded[] = [];
  const fade = <M extends Material & { opacity: number }>(m: M): M => {
    faded.push({ material: m, base: m.opacity });
    m.transparent = true;
    m.depthWrite = false;
    return m;
  };
  const cx = slice.centre.x;
  const cz = slice.centre.z;
  const loc = (l: Loop): Loop => ({
    ...l,
    points: l.points.map((p) => ({ ...p, x: p.x - cx, z: p.z - cz })),
  });
  const body = slice.body.map(loc);
  const shell = slice.shell.map(loc);
  const Y_BODY = 0;
  const Y_GAP = 0.0006;
  const Y_LINE = 0.0012;
  const Y_RIM = 0.0016;

  // Body cap: clay fill per closed body loop, darker rim.
  const clay = fade(new MeshBasicMaterial({ color: CT_CAP.clay, side: DoubleSide, opacity: 1 }));
  const rimMat = fade(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, opacity: 1 }));
  const rimColour = new Color(CT_CAP.clayRim);
  let radius = 0;
  for (const loop of [...body, ...shell])
    for (const p of loop.points) radius = Math.max(radius, Math.hypot(p.x, p.z));
  for (const loop of body) {
    const pts = loopToShapePoints(loop);
    if (loop.closed && pts.length >= 3) {
      const mesh = new Mesh(new ShapeGeometry(new Shape(pts)), clay);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = Y_BODY;
      mesh.renderOrder = 10;
      group.add(mesh);
    }
    const rim = new Mesh(ribbonGeometry(loop, CT_CAP.rimWidth, Y_BODY + 0.0003, [], rimColour), rimMat);
    rim.renderOrder = 11;
    group.add(rim);
  }

  // Under-plate: torso outline grown outward, 1 cm below, very faint.
  const torso = body.find((l) => l.closed && l.points.length >= 3);
  if (torso) {
    const grown = torso.points.map((p) => {
      const r = Math.hypot(p.x, p.z) || 1;
      const k = (r + CT_STACK.plateGrow + (shell.length ? 0.02 : 0)) / r;
      return new Vector2(p.x * k, -p.z * k);
    });
    const plate = new Mesh(
      new ShapeGeometry(new Shape(grown)),
      fade(new MeshBasicMaterial({ color: CT_STACK.plate, side: DoubleSide, opacity: CT_STACK.plateOpacity })),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -CT_STACK.plateDrop;
    plate.renderOrder = 9;
    group.add(plate);
    // Front notch: a short dark tick outward from the frontmost (+Z) point of the outer loop.
    let front = torso.points[0]!;
    for (const l of shell.length ? shell : body) for (const p of l.points) if (p.z > front.z) front = p;
    const L = CT_STACK.notchLength;
    const w = CT_STACK.notchWidth / 2;
    const ng = new BufferGeometry();
    const z0 = front.z + 0.002;
    const z1 = z0 + L;
    ng.setAttribute(
      'position',
      new Float32BufferAttribute(
        [front.x - w, Y_RIM, z0, front.x + w, Y_RIM, z0, front.x, Y_RIM, z1],
        3,
      ),
    );
    const notch = new Mesh(ng, fade(new MeshBasicMaterial({ color: CT_CAP.shell, side: DoubleSide, opacity: 0.9 })));
    notch.renderOrder = 18;
    group.add(notch);
  }

  // Air gap ring + tight / snug tint (open "C" shells fill only where they exist).
  const quads = ringQuads(shell, body, slice.toneOf);
  if (quads.length > 0) {
    const base: number[] = [];
    const tintPos: number[] = [];
    const tintCol: number[] = [];
    for (const q of quads) {
      const tri = [q.s0, q.s1, q.b1, q.s0, q.b1, q.b0];
      for (const v of tri) base.push(v.x, Y_GAP, v.z);
      const tc = toneColour(q.tone);
      if (tc) {
        const c = new Color(tc);
        for (const v of tri) {
          tintPos.push(v.x, Y_GAP + 0.0002, v.z);
          tintCol.push(c.r, c.g, c.b);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(base, 3));
    const gapMesh = new Mesh(
      g,
      fade(new MeshBasicMaterial({ color: CT_CAP.gap, side: DoubleSide, opacity: CT_CAP.gapOpacity })),
    );
    gapMesh.renderOrder = 12;
    group.add(gapMesh);
    if (tintPos.length > 0) {
      const tg = new BufferGeometry();
      tg.setAttribute('position', new Float32BufferAttribute(tintPos, 3));
      tg.setAttribute('color', new Float32BufferAttribute(tintCol, 3));
      const tint = new Mesh(
        tg,
        fade(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, opacity: CT_CAP.tintOpacity })),
      );
      tint.renderOrder = 13;
      group.add(tint);
    }
  }

  // Shell ribbon: neutral, coral on tight / snug segments.
  const shellMat = fade(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, opacity: 1 }));
  const shellColour = new Color(CT_CAP.shell);
  for (const loop of shell) {
    const colours = segmentTones(loop, slice.toneOf).map((t) => {
      const c = toneColour(t);
      return c ? new Color(c) : null;
    });
    const m = new Mesh(ribbonGeometry(loop, CT_CAP.shellWidth, Y_LINE, colours, shellColour), shellMat);
    m.renderOrder = 14;
    group.add(m);
  }

  // Ghost sizes: dashed and faint, shown only on the hovered layer.
  const ghostGroup = new Group();
  ghostGroup.visible = false;
  group.add(ghostGroup);
  for (const ghost of slice.ghosts) {
    const mat = fade(
      new LineDashedMaterial({
        color: CT_CAP.ghost,
        dashSize: CT_CAP.ghostDash,
        gapSize: CT_CAP.ghostGap,
        opacity: CT_CAP.ghostOpacity,
      }),
    );
    let tagAt: { x: number; z: number } | null = null;
    let tagD = -Infinity;
    for (const raw of ghost.loops) {
      const loop = loc(raw);
      if (loop.points.length < 2) continue;
      const pos: number[] = [];
      for (const p of loop.points) {
        pos.push(p.x, Y_LINE, p.z);
        const d = p.x + p.z;
        if (d > tagD) {
          tagD = d;
          tagAt = { x: p.x, z: p.z };
        }
      }
      if (loop.closed) pos.push(loop.points[0]!.x, Y_LINE, loop.points[0]!.z);
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      const line = new Line(g, mat);
      line.computeLineDistances();
      line.renderOrder = 15;
      ghostGroup.add(line);
    }
    if (tagAt) {
      const sprite = tagSprite(ghost.size);
      fade(sprite.material);
      sprite.position.set(tagAt.x + 0.008, Y_LINE, tagAt.z + 0.008);
      sprite.renderOrder = 16;
      ghostGroup.add(sprite);
    }
  }

  // Hover rim: thin light ribbon around the outermost loops (shell, else body); hidden by default.
  const hoverRim = new Group();
  const hoverMat = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    opacity: CT_STACK.hoverRimOpacity,
  });
  const white = new Color(CT_STACK.hoverRim);
  for (const loop of shell.length ? shell : body) {
    const m = new Mesh(ribbonGeometry(loop, CT_STACK.hoverRimWidth, Y_RIM, [], white), hoverMat);
    m.renderOrder = 17;
    hoverRim.add(m);
  }
  hoverRim.visible = false;
  group.add(hoverRim);

  // Invisible flat disc for picking.
  const pickDisc = new Mesh(
    new CircleGeometry(Math.max(0.05, radius + 0.01), 32),
    new MeshBasicMaterial({ visible: false, side: DoubleSide }),
  );
  pickDisc.rotation.x = -Math.PI / 2;
  group.add(pickDisc);

  return { group, faded, pickDisc, hoverRim, ghosts: ghostGroup, clay, y: slice.y, base: new Vector3(cx, slice.y, cz), cx, cz, progress: 0 };
}

/**
 * The CT cap stack (v2). One disc per slice slides out of the body along the camera's flat right
 * vector, bottom first, and fans out in y. CS drives update(phase, stack, camera); VX uses
 * pick / setHover / layerCentre.
 */
export function createCtCap(scene: Scene): CtStackLayer & CtPickable {
  const root = new Group();
  root.name = 'ct-cap';
  root.visible = false;
  scene.add(root);
  let discs: Disc[] = [];
  let builtStack: CtStack | null = null;
  let builtSig = '';
  let lift = 0;
  let hover: number | null = null;
  const right = new Vector3();
  const camPos = new Vector3();
  const toward = new Vector3();
  let haveCam = false;
  const clayBase = new Color(CT_CAP.clay);
  const clayLift = new Color(CT_CAP.clay).lerp(new Color('#ffffff'), CT_STACK.hoverLift);

  const clear = () => {
    for (const d of discs) {
      disposeTree(d.group);
      root.remove(d.group);
    }
    discs = [];
    builtStack = null;
    builtSig = '';
  };

  const applyHover = () => {
    discs.forEach((d, i) => {
      const on = i === hover && d.progress > 0.01;
      d.hoverRim.visible = on;
      d.ghosts.visible = on;
      d.clay.color.copy(on ? clayLift : clayBase);
      d.group.position.copy(d.base);
      if (on && haveCam) {
        toward.subVectors(camPos, d.base);
        if (toward.lengthSq() > 1e-8) d.group.position.addScaledVector(toward.normalize(), CT_STACK.hoverToward);
      }
    });
  };

  return {
    update(phase, stack, camera) {
      const p = clamp01(phase);
      if (!stack || stack.slices.length === 0 || p <= 0.001) {
        root.visible = false;
        for (const d of discs) d.progress = 0;
        return;
      }
      if (stack !== builtStack) {
        const sig = stackSignature(stack);
        if (sig !== builtSig) {
          clear();
          discs = stack.slices.map((s) => buildDisc(s));
          for (const d of discs) root.add(d.group);
          builtSig = sig;
          lift = liftHeight(
            discs.map((d) => d.y),
            stack.labels,
          );
        }
        builtStack = stack;
      }
      root.visible = true;
      // The camera's right vector, flattened to the floor.
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      haveCam = true;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      right.y = 0;
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      right.normalize();
      const n = discs.length;
      let lo = Infinity;
      let hi = -Infinity;
      for (const d of discs) {
        lo = Math.min(lo, d.y);
        hi = Math.max(hi, d.y);
      }
      const mid = (lo + hi) / 2;
      discs.forEach((d, i) => {
        const t = layerProgress(i, n, p);
        d.progress = t;
        const e = easeInOut(t);
        d.group.visible = t > 0.001;
        d.base.set(
          d.cx + right.x * CT_STACK.slide * e,
          fanY(d.y, mid, e, CT_STACK.fan, lift),
          d.cz + right.z * CT_STACK.slide * e,
        );
        d.group.scale.setScalar(1 + (CT_STACK.scale - 1) * e);
        const a = Math.min(1, t * 2.5);
        for (const f of d.faded) f.material.opacity = f.base * a;
      });
      applyHover();
    },
    pick(raycaster: Raycaster) {
      if (!root.visible) return null;
      root.updateMatrixWorld(true);
      let best: number | null = null;
      let bestD = Infinity;
      discs.forEach((d, i) => {
        if (!d.group.visible || d.progress < 0.2) return;
        const hit = raycaster.intersectObject(d.pickDisc, false)[0];
        if (hit && hit.distance < bestD) {
          bestD = hit.distance;
          best = i;
        }
      });
      return best;
    },
    setHover(index: number | null) {
      hover = index;
      applyHover();
    },
    layerCentre(i: number, out: Vector3) {
      const d = discs[i];
      if (!root.visible || !d || !d.group.visible) return null;
      // World centre of the drawn disc (same object as the pick disc), whatever the parents are.
      d.group.updateMatrixWorld(true);
      return d.group.getWorldPosition(out);
    },
    dispose() {
      clear();
      scene.remove(root);
    },
  };
}
