// Fit X-ray zones (agent FL): where each zone of our fit engine sits on the jacket shell, its state
// from the engine (POST /fit/garment zones, never computed here), and the ranked fit notes.
//
// Region mapping (display only, never a fit number): shell panel labels from the server
// (services/body/body_service/garment/shell.py: FRONT_L 0, FRONT_R 1, BACK 2, YOKE 3, SLEEVE 4/5,
// COLLAR 6, HOOD 7) plus height bands on the asset's own body landmarks (asset.body_landmarks)
// and the asset's particle landmarks/paths (cuff_L/R, bicep_L/R).
import type { ClothAsset, GarmentSpec, SizeFit } from '../../api';

export type FitZone = 'collar' | 'shoulder' | 'chest' | 'hem' | 'bicep' | 'sleeve';
export const FIT_ZONES: readonly FitZone[] = [
  'collar',
  'shoulder',
  'chest',
  'hem',
  'bicep',
  'sleeve',
];
/** Zone id per particle; 255 = no zone. */
export const NO_ZONE = 255;

/** Display bands (m): how far from a landmark a particle is painted as that zone. */
export const ZONE_BANDS_M = {
  /** Chest: ±7 cm about the bust landmarks' height (front/back panels). */
  chestHalfHeight: 0.07,
  /** Hem/hip: front/back panels below the hip landmark + 4 cm. */
  hemAboveHip: 0.04,
  /** Hem/hip on a jacket ending above the hip: its lowest 7 cm of front/back panels. */
  hemLowestBand: 0.07,
  /** Cuff: sleeve particles within 9 cm of the cuff landmark particle. */
  cuffRadius: 0.09,
  /** Bicep: sleeve particles within 6 cm of the bicep path. */
  bicepRadius: 0.06,
} as const;

const PANEL = {
  frontL: 0,
  frontR: 1,
  back: 2,
  yoke: 3,
  sleeveL: 4,
  sleeveR: 5,
  collar: 6,
} as const;

type AssetLike = Pick<ClothAsset, 'initial' | 'panels' | 'landmarks' | 'paths' | 'body_landmarks'>;

/** Zone index (into FIT_ZONES) of every particle, from the asset's rest shell. */
export function assignZones(asset: AssetLike): Uint8Array {
  const n = asset.panels.length;
  const out = new Uint8Array(n).fill(NO_ZONE);
  const p = asset.initial;
  const bl = asset.body_landmarks;
  const bustY =
    bl.bust_L && bl.bust_R ? (bl.bust_L[1] + bl.bust_R[1]) / 2 : (bl.bust_L ?? bl.bust_R)?.[1];
  const hipY = bl.hip_level?.[1];
  // Bicep = the upper sleeve, armhole to elbow (asset elbow landmarks; arms hang at rest).
  const elbowY =
    bl.elbow_L && bl.elbow_R
      ? (bl.elbow_L[1] + bl.elbow_R[1]) / 2
      : (bl.elbow_L ?? bl.elbow_R)?.[1];
  const at = (i: number): [number, number, number] => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const cuff = [asset.landmarks.cuff_L, asset.landmarks.cuff_R]
    .filter((i): i is number => i !== undefined)
    .map(at);
  const bicep = [...(asset.paths.bicep_L ?? []), ...(asset.paths.bicep_R ?? [])].map(at);
  const near = (q: [number, number, number], pts: [number, number, number][], r: number) =>
    pts.some((s) => Math.hypot(s[0] - q[0], s[1] - q[1], s[2] - q[2]) <= r);
  const idx = (z: FitZone) => FIT_ZONES.indexOf(z);
  // Hem/hip: below the hip landmark + band; a short jacket whose hem sits above that line gets its
  // lowest torso band instead (the hem is compared with the hip by the engine either way).
  let minY = Infinity;
  for (let i = 0; i < n; i++)
    if (asset.panels[i] <= PANEL.back) minY = Math.min(minY, p[i * 3 + 1]);
  const hemTop = Math.max(
    hipY !== undefined ? hipY + ZONE_BANDS_M.hemAboveHip : -Infinity,
    minY + ZONE_BANDS_M.hemLowestBand,
  );
  for (let i = 0; i < n; i++) {
    const panel = asset.panels[i];
    const q = at(i);
    if (panel === PANEL.collar) out[i] = idx('collar');
    else if (panel === PANEL.yoke) out[i] = idx('shoulder');
    else if (panel === PANEL.sleeveL || panel === PANEL.sleeveR) {
      if (near(q, cuff, ZONE_BANDS_M.cuffRadius)) out[i] = idx('sleeve');
      else if (elbowY !== undefined ? q[1] >= elbowY : near(q, bicep, ZONE_BANDS_M.bicepRadius))
        out[i] = idx('bicep');
    } else if (panel === PANEL.frontL || panel === PANEL.frontR || panel === PANEL.back) {
      if (bustY !== undefined && Math.abs(q[1] - bustY) <= ZONE_BANDS_M.chestHalfHeight)
        out[i] = idx('chest');
      else if (q[1] <= hemTop) out[i] = idx('hem');
    }
  }
  return out;
}

/** The bus zip is "closed to the top" at or below this (lead, prompt 31 demo: ≤ 0.03). */
export const ZIP_TOP_MAX = 0.03;

export type ZoneTone = 'tight' | 'snug' | 'loose' | 'none';

export interface ZoneState {
  zone: FitZone;
  /** The engine's value (cm) or null. */
  valueCm: number | null;
  status: 'tight' | 'fit' | 'relaxed' | 'too_big' | 'unknown';
  tone: ZoneTone;
  /** Higher = worse; ranks the fit notes. */
  severity: number;
  note: string;
  /** Short callout text over the 3D view. */
  callout: string;
}

const LABEL: Record<FitZone, string> = {
  collar: 'Collar',
  shoulder: 'Shoulders',
  chest: 'Chest',
  hem: 'Hem/hip',
  bicep: 'Bicep',
  sleeve: 'Sleeve/cuff',
};

const cm = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} cm`;
const abs = (v: number) => `${Math.abs(v).toFixed(1)} cm`;

/**
 * Each zone's state for one size, from the engine's zones only. The collar constraint exists only
 * when the zip is closed to the top; open, the collar is neutral ("collar open").
 */
export function zoneStates(
  size: SizeFit,
  product: Pick<GarmentSpec, 'sizes'>,
  sizeName: string,
  zipClosed: boolean,
): ZoneState[] {
  const out: ZoneState[] = [];
  for (const zone of FIT_ZONES) {
    const z = size.zones[zone];
    const value =
      typeof z?.value_cm === 'number' && Number.isFinite(z.value_cm) ? z.value_cm : null;
    const status = z?.status ?? 'unknown';
    let tone: ZoneTone = 'none',
      severity = 0,
      note = '',
      callout = '';
    if (zone === 'collar') {
      const inner = product.sizes[sizeName]?.collar_inner?.value_cm ?? null;
      if (status === 'unknown' || value === null || inner == null) {
        note = 'Collar: not measured for this size (no neck-fit claim).';
        severity = -1;
      } else if (!zipClosed) {
        note = 'Collar open: no neck constraint (zip it to the top to check the neck).';
        severity = -0.5;
      } else {
        // The engine's ease is collar inner tape − estimated neck (fit_math.py collar_ease_metric).
        const neck = inner - value;
        const word =
          value <= 0
            ? 'tight'
            : status === 'tight'
              ? 'snug'
              : status === 'fit'
                ? 'regular'
                : 'roomy';
        tone = value <= 0 ? 'tight' : status === 'tight' ? 'snug' : 'none';
        severity = value <= 0 ? 4 + -value / 10 : status === 'tight' ? 3.5 : 0.2;
        note = `Collar ${word} when fully zipped: collar ${inner.toFixed(1)} cm vs your neck ~${neck.toFixed(1)} cm (ease ${cm(value)}).`;
        callout = `Collar ${word} zipped: ${inner.toFixed(1)} vs neck ~${neck.toFixed(1)} cm (${cm(value)})`;
      }
    } else if (value === null || status === 'unknown') {
      note = `${LABEL[zone]}: not assessed.`;
      severity = -1;
    } else if (zone === 'shoulder' || zone === 'sleeve') {
      const what =
        zone === 'shoulder'
          ? value >= 0
            ? `seam drops ${abs(value)} past your shoulder`
            : `seam sits ${abs(value)} inside your shoulder`
          : value >= 0
            ? `cuff ${abs(value)} past the wrist (flat length, stacking not included)`
            : `cuff ${abs(value)} short of the wrist`;
      if (status === 'tight') {
        tone = 'tight';
        severity = 3 + Math.min(1, Math.abs(value) / 5);
      } else if (status === 'too_big') {
        tone = 'loose';
        severity = 2 + Math.min(1, Math.abs(value) / 20);
      } else severity = status === 'relaxed' ? 0.5 : 0;
      note = `${LABEL[zone]}: ${what} (${status === 'too_big' ? 'too long/big' : status}).`;
      callout = `${LABEL[zone]}: ${what.split(' (')[0]}`;
    } else {
      const design = size.zones[zone]?.design_ease_cm;
      const ref = typeof design === 'number' ? `; design ease ${design.toFixed(1)} cm` : '';
      if (status === 'tight') {
        tone = value <= 0 ? 'tight' : 'snug';
        severity = value <= 0 ? 4 + -value / 10 : 3;
      } else if (status === 'too_big') {
        tone = 'loose';
        severity = 2;
      } else severity = status === 'relaxed' ? 0.5 : 0;
      const word =
        status === 'tight'
          ? value <= 0
            ? 'tight'
            : 'snug'
          : status === 'too_big'
            ? 'loose'
            : status === 'relaxed'
              ? 'relaxed'
              : 'good';
      note = `${LABEL[zone]} ${word}: ease ${cm(value)}${ref}.`;
      callout = `${LABEL[zone]} ${word}: ease ${cm(value)}`;
    }
    out.push({ zone, valueCm: value, status, tone, severity, note, callout });
  }
  return out;
}

/** Worst first; zones with nothing to say last. */
export function rankNotes(states: ZoneState[]): ZoneState[] {
  return states.slice().sort((a, b) => b.severity - a.severity);
}

/** RGBA tint per tone (display): problem zones strong, clearly loose faint blue, good none. */
export const TONE_RGBA: Record<ZoneTone, [number, number, number, number]> = {
  tight: [0.95, 0.16, 0.12, 0.7],
  snug: [1.0, 0.55, 0.1, 0.6],
  loose: [0.3, 0.55, 1.0, 0.22],
  none: [0, 0, 0, 0],
};

/** The one-word verdict and one line for the SELECTED size (prompt 33), from engine numbers only. */
export interface SelectedVerdict {
  word: 'Good' | 'Snug' | 'Tight' | 'Loose';
  tone: 'good' | 'snug' | 'tight' | 'loose';
  line: string;
}

const ZONE_SHORT: Record<FitZone, string> = {
  collar: 'collar zipped',
  shoulder: 'shoulder seam',
  chest: 'chest',
  hem: 'hem/hip',
  bicep: 'bicep',
  sleeve: 'cuff',
};

/**
 * `sizeWord` is the size's word from the engine's ranking (verdict.ts labelFor: tight/good/loose).
 * Tight with only positive-ease problems reads 'Snug'; a 'good' size with a flagged zone (e.g. the
 * zipped collar) reads 'Snug'. The line names where, with the engine's numbers.
 */
export function selectedVerdict(
  sizeWord: 'tight' | 'good' | 'loose',
  states: ZoneState[],
): SelectedVerdict {
  const problems = rankNotes(states).filter((s) => s.tone === 'tight' || s.tone === 'snug');
  const value = (s: ZoneState) => (s.valueCm === null ? '' : ` ${cm(s.valueCm)}`);
  const where = (list: ZoneState[]) =>
    list
      .slice(0, 2)
      .map((s) => `${ZONE_SHORT[s.zone]}${value(s)}`)
      .join(', ');
  const byZone = new Map(states.map((s) => [s.zone, s]));
  const cuff = byZone.get('sleeve');
  const cuffNote =
    cuff && cuff.status === 'too_big' && cuff.valueCm !== null
      ? `; cuff ${abs(cuff.valueCm)} past the wrist`
      : '';
  const tight = problems.filter((p) => p.tone === 'tight');
  if (tight.length) {
    // A size can be tight somewhere and roomy elsewhere (mixed): both are said.
    const roomy = states.filter(
      (s) =>
        (s.status === 'too_big' || s.status === 'relaxed') &&
        s.zone !== 'sleeve' &&
        s.valueCm !== null,
    );
    const also = sizeWord === 'loose' && roomy.length ? `; roomy at ${where(roomy)}` : '';
    return { word: 'Tight', tone: 'tight', line: `Tight at ${where(problems)}${also}` };
  }
  if (sizeWord === 'loose') {
    const roomy = states
      .filter(
        (s) =>
          (s.zone === 'chest' || s.zone === 'hem' || s.zone === 'shoulder' || s.zone === 'bicep') &&
          (s.status === 'too_big' || s.status === 'relaxed') &&
          s.valueCm !== null,
      )
      .sort((a, b) => (b.valueCm ?? 0) - (a.valueCm ?? 0));
    return {
      word: 'Loose',
      tone: 'loose',
      line: roomy.length
        ? `Roomy at ${where(roomy)}${cuffNote}`
        : `Larger than our pick${cuffNote}`,
    };
  }
  if (problems.length) {
    // Only snug problems remain here (positive ease the engine still flags).
    return { word: 'Snug', tone: 'snug', line: `Snug at ${where(problems)}` };
  }
  if (sizeWord === 'tight') return { word: 'Tight', tone: 'tight', line: 'Smaller than our pick' };
  const fits = (['chest', 'hem', 'shoulder'] as const)
    .map((z) => byZone.get(z))
    .filter((s): s is ZoneState => !!s && s.valueCm !== null);
  return {
    word: 'Good',
    tone: 'good',
    line: `${fits.map((s) => `${ZONE_SHORT[s.zone]}${value(s)}`).join(', ')}${cuffNote}`,
  };
}
