// Sandbox presets: bodies, camera views, lighting looks, screenshot file names. Pure data and
// pure functions (no three.js, no DOM) so they are unit-testable.

export type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------- bodies
export interface BodyPreset {
  id: string;
  label: string;
  sex: 'female' | 'male';
  height_cm: number;
  weight_kg: number;
}
/**
 * Demo bodies of different heights and weights. Inputs to the real body service, not data about
 * any person. 'male-172-65' is the kiosk's attract/reference body (KioskApp REFERENCE).
 */
export const BODY_PRESETS: readonly BodyPreset[] = [
  {
    id: 'female-160-52',
    label: 'Female 160 cm / 52 kg',
    sex: 'female',
    height_cm: 160,
    weight_kg: 52,
  },
  {
    id: 'female-168-62',
    label: 'Female 168 cm / 62 kg',
    sex: 'female',
    height_cm: 168,
    weight_kg: 62,
  },
  {
    id: 'female-175-75',
    label: 'Female 175 cm / 75 kg',
    sex: 'female',
    height_cm: 175,
    weight_kg: 75,
  },
  { id: 'male-165-58', label: 'Male 165 cm / 58 kg', sex: 'male', height_cm: 165, weight_kg: 58 },
  {
    id: 'male-172-65',
    label: 'Male 172 cm / 65 kg (kiosk reference)',
    sex: 'male',
    height_cm: 172,
    weight_kg: 65,
  },
  { id: 'male-180-80', label: 'Male 180 cm / 80 kg', sex: 'male', height_cm: 180, weight_kg: 80 },
  { id: 'male-188-98', label: 'Male 188 cm / 98 kg', sex: 'male', height_cm: 188, weight_kg: 98 },
];
/** API ranges (services/body schemas.FitRequest). */
export const HEIGHT_RANGE_CM = [120, 220] as const;
export const WEIGHT_RANGE_KG = [30, 200] as const;

export function validBody(height: number, weight: number): string | null {
  if (!Number.isFinite(height) || height < HEIGHT_RANGE_CM[0] || height > HEIGHT_RANGE_CM[1])
    return `Height must be ${HEIGHT_RANGE_CM[0]}-${HEIGHT_RANGE_CM[1]} cm`;
  if (!Number.isFinite(weight) || weight < WEIGHT_RANGE_KG[0] || weight > WEIGHT_RANGE_KG[1])
    return `Weight must be ${WEIGHT_RANGE_KG[0]}-${WEIGHT_RANGE_KG[1]} kg`;
  return null;
}

// ---------------------------------------------------------------- lighting
export type LightingId = 'kiosk' | 'studio' | 'daylight';
export interface LightSpec {
  colour: number;
  intensity: number;
  position: Vec3;
}
export interface LightingLook {
  label: string;
  background: string;
  ground: number;
  exposure: number;
  environment: number;
  hemisphere: { sky: number; ground: number; intensity: number };
  /** Key, fill, rim (same order as Viewer's three directional lights). */
  lights: readonly [LightSpec, LightSpec, LightSpec];
}
/**
 * Non-kiosk looks. 'kiosk' is not listed here: it is captured from the live Viewer at start-up so
 * it can never drift from the real demo. These two are look conventions for judging colour under
 * a different light, not calibrated illuminants.
 */
export const ALT_LIGHTING: Record<Exclude<LightingId, 'kiosk'>, LightingLook> = {
  studio: {
    label: 'Neutral studio (grey sweep, soft 3-point, D65-ish white)',
    background: '#9a9a9a',
    ground: 0x8c8c8c,
    exposure: 1.0,
    environment: 0.85,
    hemisphere: { sky: 0xffffff, ground: 0x9a9a9a, intensity: 0.3 },
    lights: [
      { colour: 0xffffff, intensity: 1.9, position: [-2.2, 3, 3.2] },
      { colour: 0xffffff, intensity: 1.0, position: [3, 1.6, 2] },
      { colour: 0xffffff, intensity: 0.7, position: [0, 3, -3] },
    ],
  },
  daylight: {
    label: 'Daylight (overcast sky + low sun, warm key / cool fill)',
    background: '#cfdce8',
    ground: 0xb8b4a6,
    exposure: 1.05,
    environment: 1.0,
    hemisphere: { sky: 0xd6e4ff, ground: 0xa49f90, intensity: 0.55 },
    lights: [
      { colour: 0xfff0d9, intensity: 2.8, position: [2.5, 4.5, 2.2] },
      { colour: 0xcfe0ff, intensity: 0.9, position: [-3, 2, 1.5] },
      { colour: 0xffffff, intensity: 0.5, position: [0, 3, -3] },
    ],
  },
};
export const LIGHTING_LABELS: Record<LightingId, string> = {
  kiosk: 'Kiosk (as the real demo)',
  studio: ALT_LIGHTING.studio.label,
  daylight: ALT_LIGHTING.daylight.label,
};

// ---------------------------------------------------------------- views
export type OrbitViewId = 'front' | 'back' | 'left' | 'right' | 'front34' | 'back34';
export type CloseViewId =
  | 'collar-front'
  | 'collar-back'
  | 'sleeve'
  | 'cuff'
  | 'hem'
  | 'zipper'
  | 'logo';
export type ViewId = OrbitViewId | CloseViewId;
export const VIEW_LABELS: Record<ViewId, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left (wearer)',
  right: 'Right (wearer)',
  front34: '3/4 front',
  back34: '3/4 back',
  'collar-front': 'Collar / hood junction (front)',
  'collar-back': 'Collar / hood junction (back)',
  sleeve: 'Sleeve baffles (side)',
  cuff: 'Cuff',
  hem: 'Hem',
  zipper: 'Zipper',
  logo: 'Chest logo area',
};
export const ORBIT_VIEWS: OrbitViewId[] = ['front', 'back', 'left', 'right', 'front34', 'back34'];
export const CLOSE_VIEWS: CloseViewId[] = [
  'collar-front',
  'collar-back',
  'sleeve',
  'cuff',
  'hem',
  'zipper',
  'logo',
];

/**
 * Scene frame: metres, Y-up, +Z = body front, +X = the wearer's left (the A-pose anchors
 * acromion_L etc. are at +X). Azimuth 0 = camera in front, 90 = on the wearer's left.
 */
export function orbitPose(
  target: Vec3,
  azimuthDeg: number,
  elevationDeg: number,
  distance: number,
) {
  const az = (azimuthDeg * Math.PI) / 180,
    el = (elevationDeg * Math.PI) / 180;
  const position: Vec3 = [
    target[0] + distance * Math.sin(az) * Math.cos(el),
    target[1] + distance * Math.sin(el),
    target[2] + distance * Math.cos(az) * Math.cos(el),
  ];
  return { position, target };
}

/** Points on the shown garment that the close-up views aim at (see garmentGeo). */
export interface GarmentGeo {
  height: number;
  hpsY: number;
  hemY: number;
  collar: Vec3;
  sleeve: Vec3;
  cuff: Vec3;
  hem: Vec3;
  zipper: Vec3;
  logo: Vec3;
}

type Anchors = Record<string, readonly number[]>;
const mean = (...v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/**
 * Close-up targets from the shown shell. `positions` = 3 floats per vertex, `panels` = shell
 * panel id per vertex (garmentSurface.ts PANEL), `anchors` = the fit response anchors (metres).
 * Falls back to anchor-only estimates when a panel is absent (e.g. no hood), never to made-up numbers.
 */
export function garmentGeo(
  positions: ArrayLike<number>,
  panels: ArrayLike<number>,
  anchors: Anchors,
  height: number,
): GarmentGeo {
  const need = (name: string): Vec3 => {
    const a = anchors[name];
    if (!a || a.length < 3) throw new Error(`Garment anchor missing: ${name}`);
    return [a[0], a[1], a[2]];
  };
  const hpsL = need('HPS_L'),
    hpsR = need('HPS_R'),
    hemF = need('hem_front'),
    hemB = need('hem_back'),
    cuffL = need('cuff_L'),
    acromion = need('acromion_L');
  const hpsY = mean(hpsL[1], hpsR[1]),
    hemY = mean(hemF[1], hemB[1]);
  const centroid = (panel: number): Vec3 | null => {
    let x = 0,
      y = 0,
      z = 0,
      n = 0;
    for (let i = 0; i < panels.length; i++)
      if (panels[i] === panel) {
        x += positions[i * 3];
        y += positions[i * 3 + 1];
        z += positions[i * 3 + 2];
        n++;
      }
    return n ? [x / n, y / n, z / n] : null;
  };
  /** Frontmost z of the shell near (x, y); anchors' hem z when nothing is there. */
  const frontZ = (x: number, y: number, fallback: number) => {
    let best = -Infinity;
    for (let i = 0; i < panels.length; i++)
      if (
        Math.abs(positions[i * 3] - x) < 0.04 &&
        Math.abs(positions[i * 3 + 1] - y) < 0.04 &&
        positions[i * 3 + 2] > best
      )
        best = positions[i * 3 + 2];
    return Number.isFinite(best) ? best : fallback;
  };
  const zipY = hpsY - 0.55 * (hpsY - hemY),
    logoY = hpsY - 0.14;
  return {
    height,
    hpsY,
    hemY,
    collar: centroid(6) ?? [0, hpsY + 0.03, mean(hpsL[2], hpsR[2])],
    sleeve: centroid(4) ?? [
      mean(acromion[0], cuffL[0]),
      mean(acromion[1], cuffL[1]),
      mean(acromion[2], cuffL[2]),
    ],
    cuff: cuffL,
    hem: [0, hemY, mean(hemF[2], hemB[2])],
    zipper: [0, zipY, frontZ(0, zipY, hemF[2])],
    logo: [0.1, logoY, frontZ(0.1, logoY, hemF[2])],
  };
}

/** Camera position/target for any view. `geo` is only needed for the close-ups. */
export function viewPose(view: ViewId, height: number, geo?: GarmentGeo) {
  const body: Vec3 = [0, 0.52 * height, 0];
  const far = 1.85 * height;
  switch (view) {
    case 'front':
      return orbitPose(body, 0, 3, far);
    case 'back':
      return orbitPose(body, 180, 3, far);
    case 'left':
      return orbitPose(body, 90, 3, far);
    case 'right':
      return orbitPose(body, -90, 3, far);
    case 'front34':
      return orbitPose(body, 40, 8, far);
    case 'back34':
      return orbitPose(body, 140, 8, far);
  }
  if (!geo) throw new Error('Load a jacket before using a close-up view');
  switch (view) {
    case 'collar-front':
      return orbitPose(geo.collar, 25, 10, 0.55);
    case 'collar-back':
      return orbitPose(geo.collar, 155, 12, 0.6);
    case 'sleeve':
      return orbitPose(geo.sleeve, 90, 4, 1.15);
    case 'cuff':
      return orbitPose(geo.cuff, 65, 8, 0.4);
    case 'hem':
      return orbitPose(geo.hem, 20, 14, 0.7);
    case 'zipper':
      return orbitPose(geo.zipper, 0, 4, 0.6);
    case 'logo':
      return orbitPose(geo.logo, 0, 2, 0.45);
  }
}

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL'];
export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => (SIZE_ORDER.includes(s) ? SIZE_ORDER.indexOf(s) : SIZE_ORDER.length);
  return sizes.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------- files
const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export function screenshotName(p: {
  style: string;
  size: string;
  sex: string;
  height_cm: number;
  weight_kg: number;
  view: string;
  lighting: string;
  sideBySide: boolean;
}): string {
  return (
    [
      'sandbox',
      p.style,
      p.size,
      `${p.sex}-${Math.round(p.height_cm)}cm-${Math.round(p.weight_kg)}kg`,
      p.view,
      p.lighting,
      p.sideBySide ? 'sidebyside' : '3d',
    ]
      .map(clean)
      .join('_') + '.png'
  );
}

/** Reference-photo folder of a style: the listed folder named `<style>-...`. */
export function folderForStyle(style: string, folders: readonly string[]): string | undefined {
  return folders.find((name) => name === style || name.startsWith(`${style}-`));
}
