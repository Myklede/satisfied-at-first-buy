// F4X (prompt 23, the jacket's look in AR): URL flags. Pure: reads the URL once, no DOM, no GL.
// Every F4X change is behind a flag, default OFF, until the judge's A/B and the lead's "OK flip".
//   ?f4xwarm=1  cold start (ArKioskJacket, ArCompositor): the kiosk-look jacket is requested at
//               the first AR frame (before a person is tracked), its offscreen programs are
//               compiled first, and while it loads NO jacket is drawn (never the avatar's plain,
//               untextured one)
//   ?f4xlook=1  the shell's material in AR (finish/config.ts AR_LOOK): matte like the real jackets
//               filmed at the venue
// The venue light, exposure and white balance stay under ?f4light=1 (finish/f4.ts).
//
// Calibration only (the render service takes URL flags, not code): ?f4xset<n>=TABLE.path:number
// overrides one numeric constant of the look tables below for that page load, e.g.
// ?f4xset1=E.atRef:1.05&f4xset2=G.roughness:0.8 (tables: TUNABLE below). A winning
// value is then written into finish/config.ts; nothing ships set this way.
import { AR_LOOK, CAMERA_ADAPT, VENUE_EXPOSURE, VENUE_LIGHT, VENUE_WB } from './finish/config';

export type F4xFlags = {
  warm: boolean;
  look: boolean;
};

const pageSearch = () =>
  typeof location !== 'undefined' && location?.search ? location.search : '';

/** The F4X flags from a query string (default: the page's own; none outside a browser). */
export function readF4xFlags(search?: string): F4xFlags {
  const p = new URLSearchParams(search ?? pageSearch());
  const on = (k: string) => p.get(k) === '1';
  return { warm: on('f4xwarm'), look: on('f4xlook') };
}

/**
 * The tables ?f4xset may touch (numeric leaves and numeric array items only), under short names
 * (the render service caps a flag value at 32 characters): E exposure, L light rig, W white
 * balance, C camera adaptation, G / S the AR material of the glossy / satin finish.
 */
const TUNABLE: Record<string, object> = {
  E: VENUE_EXPOSURE,
  L: VENUE_LIGHT,
  W: VENUE_WB,
  C: CAMERA_ADAPT,
  G: AR_LOOK.glossy_ripstop,
  S: AR_LOOK.satin_matte,
};

/**
 * Applies the ?f4xset<n>=TABLE.path:number overrides of a query string to `tables` (default: the
 * look tables of finish/config.ts). Only an existing own numeric leaf is set, to a finite number;
 * anything else is ignored. Returns what was applied, e.g. ["E.atRef=1.05"].
 */
export function applyF4xOverrides(search: string, tables: Record<string, object> = TUNABLE) {
  const applied: string[] = [];
  for (const [key, raw] of new URLSearchParams(search)) {
    if (!/^f4xset\d*$/.test(key)) continue;
    const at = raw.lastIndexOf(':');
    const value = Number(raw.slice(at + 1));
    const path = raw.slice(0, at).split('.');
    if (at < 1 || !Number.isFinite(value) || path.length < 2) continue;
    let node: unknown = Object.hasOwn(tables, path[0]) ? tables[path[0]] : undefined;
    for (const part of path.slice(1, -1))
      node =
        node && typeof node === 'object' && Object.hasOwn(node, part)
          ? (node as Record<string, unknown>)[part]
          : undefined;
    const leaf = path[path.length - 1];
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, leaf)) continue;
    const target = node as Record<string, unknown>;
    if (typeof target[leaf] !== 'number') continue;
    target[leaf] = value;
    applied.push(`${path.join('.')}=${value}`);
  }
  return applied;
}

/** The page's own overrides, applied once when this module loads (before any frame is drawn). */
export const f4xOverrides = applyF4xOverrides(pageSearch());
