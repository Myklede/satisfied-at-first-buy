// On-screen pinch feedback over the big (camera / Decart) view (agent ZB), in the Studio's calm
// retail style (agent U's ui/theme.ts tokens): a hand cursor per hand, a short hint next to the
// handle the hand is near ("Pinch the zip pull"), the zip line while it is reachable, and a
// "grabbed" label with progress. ?zbDebug=1 also draws every grab box and the body frame, for
// tuning on the real camera. Plain 2D canvas; the shell (DC) owns the canvas and its place.
import type { Landmark2D } from '../contract';
import { THEME, TONE_COLOR } from '../fitlab/ui/theme';
import { fromBody, type BodyFrame } from './bodyFrame';
import { HEM_GRAB, HOOD_GRAB, ZIP_GRAB, ZIP_LINE } from './config';
import {
  pullV,
  type GestureGrab,
  type GestureOutput,
  type GestureValues,
  type GrabKind,
} from './gesture';

export interface OverlayView {
  /** The big view shows the camera mirrored (selfie view). Default true. */
  mirrored: boolean;
  /** How the source frame is fitted into the canvas (CSS object-fit). Default 'cover'. */
  fit: 'cover' | 'contain' | 'fill';
  /** Source frame size (px): SharedCamera.width / height. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface OverlayState {
  frame: BodyFrame | null;
  hands: GestureOutput['hands'];
  grab: GestureGrab | null;
  values: GestureValues;
  /** Fit Lab physics status line, shown small at the bottom (null = hidden). */
  note?: string | null;
  /** ?zbDebug=1: draw the grab boxes and the body frame. */
  debug?: boolean;
}

/** Contract image point (0..1, not mirrored) -> canvas pixels for this view. */
export function imageToCanvas(p: Landmark2D, view: OverlayView, width: number, height: number) {
  const x = view.mirrored ? 1 - p.x : p.x;
  if (view.fit === 'fill') return { x: x * width, y: p.y * height };
  const sw = view.sourceWidth || width,
    sh = view.sourceHeight || height,
    scale =
      view.fit === 'cover' ? Math.max(width / sw, height / sh) : Math.min(width / sw, height / sh),
    w = sw * scale,
    h = sh * scale;
  return { x: (width - w) / 2 + x * w, y: (height - h) / 2 + p.y * h };
}

/** Accent per handle: the theme's deep green for the zip, amber for the hood, sage for the hem. */
const ACCENT: Record<GrabKind, string> = {
  zip: THEME.accent,
  'hood-off': TONE_COLOR.snug,
  'hood-on': TONE_COLOR.snug,
  hem: TONE_COLOR.good,
};

export function grabLabel(grab: GestureGrab): string {
  const pct = `${Math.round(grab.progress * 100)} %`;
  if (grab.kind === 'zip') return `Zip ${pct} open`;
  if (grab.kind === 'hood-off')
    return grab.committed ? 'Hood off' : `Pull back to take the hood off · ${pct}`;
  if (grab.kind === 'hood-on') return grab.committed ? 'Hood on' : `Lift over your head · ${pct}`;
  return `Feeling the hem · ${pct}`;
}

/** The hint shown when a hand is near a handle (not yet pinching). */
export function hintText(kind: GrabKind, values: GestureValues): string {
  if (kind === 'zip')
    return values.zip > 0.5 ? 'Pinch the zip pull to close' : 'Pinch the zip pull';
  if (kind === 'hood-off')
    return values.jacket === 'DQ4920-206'
      ? 'Pinch behind your head to take the hood off'
      : 'Pinch the hood to pull it back';
  if (kind === 'hood-on') return 'Pinch and lift to put the hood on';
  return 'Pinch the hem and pull down';
}

function pill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  dpr: number,
  accent: string,
  width: number,
) {
  ctx.save();
  ctx.font = `500 ${14 * dpr}px ${THEME.font}`;
  const pad = 12 * dpr,
    h = 30 * dpr,
    w = ctx.measureText(text).width + pad * 2 + 10 * dpr,
    left = Math.max(4 * dpr, Math.min(width - w - 4 * dpr, x)),
    top = y - h / 2,
    r = h / 2;
  ctx.shadowColor = 'rgba(29,29,31,0.18)';
  ctx.shadowBlur = 10 * dpr;
  ctx.shadowOffsetY = 2 * dpr;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, r);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(left + pad, y, 4 * dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = THEME.text;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + pad + 10 * dpr, y + 0.5 * dpr);
  ctx.restore();
}

function drawDebug(
  ctx: CanvasRenderingContext2D,
  state: OverlayState,
  map: (p: Landmark2D) => { x: number; y: number },
  dpr: number,
) {
  const { frame, values } = state;
  if (!frame) return;
  const line = ZIP_LINE[values.jacket],
    pv = pullV(values.jacket, values.zip);
  const box = (u0: number, u1: number, v0: number, v1: number, colour: string, label: string) => {
    const pts = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ].map(([u, v]) => map(fromBody(frame, u, v)));
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.fillText(label, Math.min(...pts.map((p) => p.x)) + 4 * dpr, pts[0].y + 14 * dpr);
  };
  ctx.save();
  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.font = `600 ${11 * dpr}px ${THEME.font}`;
  box(
    -ZIP_GRAB.halfWidth,
    ZIP_GRAB.halfWidth,
    pv - ZIP_GRAB.halfHeight,
    pv + ZIP_GRAB.halfHeight,
    '#2F4A3F',
    'zip',
  );
  if (values.hoodOn)
    box(-HOOD_GRAB.halfWidth, HOOD_GRAB.halfWidth, -1.3, HOOD_GRAB.maxV, '#E8A33D', 'hood off');
  else
    box(
      -HOOD_GRAB.onHalfWidth,
      HOOD_GRAB.onHalfWidth,
      HOOD_GRAB.onStartMinV,
      HOOD_GRAB.onStartMaxV,
      '#E8A33D',
      'hood on (lift)',
    );
  box(
    -HEM_GRAB.halfWidth,
    HEM_GRAB.halfWidth,
    line.vHem - HEM_GRAB.above,
    line.vHem + HEM_GRAB.below,
    '#3E8E6A',
    'hem',
  );
  // Body frame: shoulder line (v 0) and hip line (v 1), centre line.
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  for (const [a, b] of [
    [fromBody(frame, -0.5, 0), fromBody(frame, 0.5, 0)],
    [fromBody(frame, -0.5, 1), fromBody(frame, 0.5, 1)],
    [fromBody(frame, 0, -0.3), fromBody(frame, 0, 1.2)],
  ]) {
    const p = map(a),
      q = map(b);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  const o = map(fromBody(frame, 0.55, 0));
  ctx.fillText(
    `T ${frame.torso.toFixed(3)} ${frame.fromHips ? 'hips' : 'shoulder fallback'}`,
    o.x,
    o.y,
  );
  ctx.restore();
}

/** Draws one overlay frame into `ctx` (canvas size in device pixels, `dpr` for line widths). */
export function drawOverlayFrame(
  ctx: CanvasRenderingContext2D,
  state: OverlayState,
  view: OverlayView,
  width: number,
  height: number,
  dpr = 1,
) {
  ctx.clearRect(0, 0, width, height);
  const map = (p: Landmark2D) => imageToCanvas(p, view, width, height);
  const { frame, grab, values } = state;
  if (state.debug) drawDebug(ctx, state, map, dpr);
  const nearZip = state.hands.some((h) => h.target === 'zip');
  if (frame && (grab?.kind === 'zip' || nearZip)) {
    const line = ZIP_LINE[values.jacket],
      top = map(fromBody(frame, 0, line.vTop)),
      hem = map(fromBody(frame, 0, line.vHem)),
      zip = grab?.kind === 'zip' ? grab.progress : values.zip,
      pull = map(fromBody(frame, 0, pullV(values.jacket, zip)));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.setLineDash([2 * dpr, 6 * dpr]);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(hem.x, hem.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(29,29,31,0.35)';
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    ctx.arc(pull.x, pull.y, 8 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = THEME.accent;
    ctx.beginPath();
    ctx.arc(pull.x, pull.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const h of state.hands) {
    const p = map(h.point),
      held = grab?.hand === h.handedness,
      kind = held ? grab!.kind : h.target,
      accent = kind ? ACCENT[kind] : THEME.textSoft,
      r = (held ? 15 : 12) * dpr;
    ctx.save();
    ctx.shadowColor = 'rgba(29,29,31,0.35)';
    ctx.shadowBlur = 6 * dpr;
    // White ring, accent fill when on a handle or holding.
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (kind || h.pinching) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = held ? 0.75 : 0.45;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.stroke();
    if (held && grab) {
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 6 * dpr, -Math.PI / 2, -Math.PI / 2 + grab.progress * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    const text =
      held && grab ? grabLabel(grab) : h.target && !h.pinching ? hintText(h.target, values) : '';
    if (text) pill(ctx, text, p.x + r + 12 * dpr, p.y, dpr, accent, width);
  }
  if (state.note) {
    ctx.save();
    ctx.font = `500 ${12 * dpr}px ${THEME.font}`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textBaseline = 'bottom';
    ctx.fillText(state.note, 10 * dpr, height - 8 * dpr);
    ctx.restore();
  }
}
