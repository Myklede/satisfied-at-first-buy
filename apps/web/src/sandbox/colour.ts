// Colour maths for the sandbox eyedropper: sRGB hex <-> CIELAB (D65) and the CIEDE2000
// difference (Sharma, Wu & Dalal 2005, "The CIEDE2000 colour-difference formula"). Pure
// functions, no DOM. All inputs are display sRGB bytes (what a screenshot or a photo holds).

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

/** D65 reference white (CIE 1931 2 degree observer), Y = 100. */
const WHITE = [95.047, 100, 108.883] as const;

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function toHex(rgb: Rgb): string {
  return (
    '#' +
    rgb
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** sRGB transfer function (IEC 61966-2-1): byte 0..255 -> linear light 0..1. */
export function srgbToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Inverse transfer function: linear light 0..1 -> byte 0..255 (not rounded). */
export function linearToSrgb(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
}

export function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(srgbToLinear);
  // Linear sRGB -> XYZ (D65), IEC 61966-2-1 matrix.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) * 100;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) * 100;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  const fx = f(x / WHITE[0]),
    fy = f(y / WHITE[1]),
    fz = f(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** CIEDE2000 between two CIELAB colours (kL = kC = kH = 1). */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1,
    [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1),
    C2 = Math.hypot(a2, b2),
    Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1,
    a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1),
    C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) =>
    b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360;
  const h1p = hue(b1, a1p),
    h2p = hue(b2, a2p);
  const dLp = L2 - L1,
    dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbarp = (L1 + L2) / 2,
    Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp /= 2;
    else hbarp = (hbarp + (hbarp < 360 ? 360 : -360)) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export function deltaE2000Rgb(a: Rgb, b: Rgb): number {
  return deltaE2000(rgbToLab(a), rgbToLab(b));
}

/**
 * Mean of RGBA pixels (bytes) averaged in linear light, returned as an sRGB byte triple.
 * Fully transparent pixels are ignored. Throws on an empty sample.
 */
export function averageSrgb(rgba: ArrayLike<number>): Rgb {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    r += srgbToLinear(rgba[i]);
    g += srgbToLinear(rgba[i + 1]);
    b += srgbToLinear(rgba[i + 2]);
    n++;
  }
  if (!n) throw new Error('No opaque pixels to average');
  return [
    Math.round(linearToSrgb(r / n)),
    Math.round(linearToSrgb(g / n)),
    Math.round(linearToSrgb(b / n)),
  ];
}

/**
 * Where a client point lands in an image drawn with CSS `object-fit: contain` inside `box`
 * (client-space rectangle). Returns natural-pixel coordinates, or null on the letterbox bars.
 */
export function containPoint(
  box: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!(natural.width > 0 && natural.height > 0 && box.width > 0 && box.height > 0)) return null;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const drawnW = natural.width * scale,
    drawnH = natural.height * scale;
  const x = (clientX - box.left - (box.width - drawnW) / 2) / scale,
    y = (clientY - box.top - (box.height - drawnH) / 2) / scale;
  if (x < 0 || y < 0 || x >= natural.width || y >= natural.height) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}
