// Pure helpers turning the service's computed garment fit into kiosk text.
// Every number shown comes from GarmentFitResponse; nothing here invents a value.
import type { GarmentFitResponse, GarmentSpec, SizeFit } from '../api';
import { cuffText, seamPhrase } from '../engine/fitLabelText';
import { formatLength, formatSigned, type Units } from './units';

export interface Predictions {
  /** Shoulder seam offset from the acromion along the arm; + = seam drops down the arm. */
  shoulder_seam: number | null;
  /** Cuff edge vs wrist crease along the arm; + = beyond the wrist toward the hand. */
  cuff_vs_wrist: number | null;
  /** Hem height minus hip height; + = hem above the hip (docs/MEASUREMENTS.md). */
  hem_vs_hip: number | null;
}

const finite = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function predictions(size: SizeFit | undefined): Predictions {
  const zones = size?.zones ?? {};
  return {
    shoulder_seam:
      zones.shoulder?.metric === 'shoulder_offset_cm' ? finite(zones.shoulder.value_cm) : null,
    cuff_vs_wrist:
      zones.sleeve?.metric === 'sleeve_offset_cm' ? finite(zones.sleeve.value_cm) : null,
    hem_vs_hip: finite(zones.hem?.position_vs_hip_cm),
  };
}

/**
 * Offsets measured on the DISPLAYED 3D shell (cloth/metrics.ts, metric 'simulated_offset_cm').
 * Secondary numbers only: they include the hand stop and cuff stacking (engine/fitLabelText.ts).
 */
export function drawnOffsets(shown: SizeFit | undefined): {
  shoulder_seam: number | null;
  cuff_vs_wrist: number | null;
} {
  const z = shown?.zones ?? {};
  return {
    shoulder_seam:
      z.shoulder?.metric === 'simulated_offset_cm' ? finite(z.shoulder.value_cm) : null,
    cuff_vs_wrist: z.sleeve?.metric === 'simulated_offset_cm' ? finite(z.sleeve.value_cm) : null,
  };
}

/** The kiosk's length format for labels: same text as the card (e.g. "3.6 in (9.2 cm)"). */
export const lengthFormat = (units: Units) => (cm: number) => formatLength(cm, units);

/** Try-it-on cuff line: the prediction, plus where the drawn sleeve stacks at the hand. */
export function cuffLine(predicted: number | null, drawn: number | null, units: Units) {
  return cuffText(predicted, drawn, lengthFormat(units));
}

/** One line per jacket, e.g. "M: shoulder seam drops 3.4 in (8.8 cm) past your shoulder bone". */
export function reasonLine(fit: GarmentFitResponse, units: Units): string {
  const name = fit.recommended_size;
  if (!name) return 'No size could be recommended: the measured evidence does not cover this body.';
  const size = fit.sizes[name];
  const p = predictions(size);
  const estimated = size?.estimated ? ' (estimated size grade)' : '';
  if (p.shoulder_seam !== null)
    return `${name}: ${seamPhrase(p.shoulder_seam, lengthFormat(units))}${estimated}`;
  const chest = size?.zones.chest;
  if (chest?.value_cm != null)
    return `${name}: ${formatLength(chest.value_cm, units)} ${chest.value_cm >= 0 ? 'of room' : 'too tight'} at the chest${estimated}`;
  return `${name}: best score on the measured zones${estimated}`;
}

/** The API owns collar classification/calibration. Never infer it again from an ease cutoff. */
export function collarLine(size: SizeFit | undefined, units: Units): string | null {
  const zone = size?.zones.collar;
  if (!zone) return null;
  if (zone.metric !== 'collar_inner_ease_cm') return 'Collar: estimate unavailable.';
  const clause = zone.explanation
    .split(';')[0]
    .trim()
    .replace(/^Collar:\s*/i, '');
  if (zone.status === 'unknown') return clause ? `Collar: ${clause}.` : 'Collar: not assessed.';
  const ease = finite(zone.value_cm);
  if (ease === null || !clause) return 'Collar: estimate unavailable.';
  const neckNote = /estimated neck/i.test(clause) ? '' : '; estimated neck';
  return `Collar: ${clause} (${formatSigned(ease, units)} ease${neckNote}). One collar measured; other sizes not measured; thresholds uncalibrated.`;
}

/** Sizes in catalogue order that have 3D geometry. */
export function geometrySizes(fit: GarmentFitResponse): string[] {
  return Object.entries(fit.sizes)
    .filter(([, value]) => value.geometry_available)
    .map(([name]) => name);
}

const ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL'];
export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  return sizes.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Two sizes count as "near-identical" in a zone when they differ by less than this. 1.0 cm is
 * twice the tape's reading resolution over a puffer shell (0.5 cm, engine/fitLabelText.ts
 * ON_BONE_CM): a smaller difference cannot be seen or checked by a judge with a tape.
 */
export const NEAR_IDENTICAL_CM = 1.0;

const CONTRAST_ZONES = [
  ['shoulder', 'shoulder seam'],
  ['sleeve', 'sleeve past wrist'],
  ['chest', 'chest room'],
] as const;

export interface ZoneDelta {
  zone: (typeof CONTRAST_ZONES)[number][0];
  label: string;
  recommendedCm: number;
  contrastCm: number;
  deltaCm: number;
}

export interface ContrastPick {
  size: string;
  /** Zones in CONTRAST_ZONES order, with the computed values of both sizes. */
  deltas: ZoneDelta[];
  /** Largest |delta| over the zones. */
  maxDeltaCm: number;
  /** Every neighbour differs by less than NEAR_IDENTICAL_CM in every zone. */
  nearIdentical: boolean;
}

function zoneValue(size: SizeFit | undefined, zone: ZoneDelta['zone']): number | null {
  const z = size?.zones[zone];
  if (!z) return null;
  if (zone === 'shoulder') return z.metric === 'shoulder_offset_cm' ? finite(z.value_cm) : null;
  if (zone === 'sleeve') return z.metric === 'sleeve_offset_cm' ? finite(z.value_cm) : null;
  return finite(z.value_cm);
}

/**
 * The size to contrast with the recommendation in the X-ray money shot: of the two neighbouring
 * sizes (with 3D geometry), the one whose computed zones differ most from the recommendation.
 * Ties within 0.1 cm go to the larger size (the usual wrong pick for a roomy jacket).
 */
export function contrastPick(fit: GarmentFitResponse): ContrastPick | null {
  const sizes = sortSizes(geometrySizes(fit));
  const rec = fit.recommended_size;
  const at = rec ? sizes.indexOf(rec) : -1;
  if (!rec || at < 0) return null;
  const picks = [sizes[at + 1], sizes[at - 1]]
    .filter((s): s is string => !!s)
    .map((size) => {
      const deltas: ZoneDelta[] = [];
      for (const [zone, label] of CONTRAST_ZONES) {
        const a = zoneValue(fit.sizes[rec], zone),
          b = zoneValue(fit.sizes[size], zone);
        if (a !== null && b !== null)
          deltas.push({ zone, label, recommendedCm: a, contrastCm: b, deltaCm: b - a });
      }
      const maxDeltaCm = Math.max(0, ...deltas.map((d) => Math.abs(d.deltaCm)));
      return { size, deltas, maxDeltaCm };
    });
  if (!picks.length) return null;
  const best = picks.reduce((a, b) => (b.maxDeltaCm > a.maxDeltaCm + 0.1 ? b : a));
  return { ...best, nearIdentical: picks.every((p) => p.maxDeltaCm < NEAR_IDENTICAL_CM) };
}

/** The contrast size alone (kept for callers that only need the name). */
export function contrastSize(fit: GarmentFitResponse): string | null {
  return contrastPick(fit)?.size ?? null;
}

/**
 * The card's X-ray comparison line, from the computed zones only, e.g.
 * "vs XL: chest room +4.6 in → +8.0 in, sleeve past wrist +3.2 in → +4.6 in; shoulder seam
 * nearly the same (+3.6 in vs +3.8 in)".
 */
export function contrastLine(fit: GarmentFitResponse, units: Units): string | null {
  const pick = contrastPick(fit);
  const rec = fit.recommended_size;
  if (!pick || !rec || !pick.deltas.length) return null;
  const f = (cm: number) => formatSigned(cm, units);
  if (pick.nearIdentical)
    return `${rec} and its neighbouring sizes are nearly identical on this body (every zone within ${formatSigned(NEAR_IDENTICAL_CM, units).replace('+', '')}): the size grades are estimated.`;
  const differ = pick.deltas
    .filter((d) => Math.abs(d.deltaCm) >= NEAR_IDENTICAL_CM)
    .sort((a, b) => Math.abs(b.deltaCm) - Math.abs(a.deltaCm));
  const same = pick.deltas.filter((d) => Math.abs(d.deltaCm) < NEAR_IDENTICAL_CM);
  const parts = differ.map((d) => `${d.label} ${f(d.recommendedCm)} → ${f(d.contrastCm)}`);
  const tail = same.length
    ? `; ${same.map((d) => `${d.label} nearly the same (${f(d.recommendedCm)} vs ${f(d.contrastCm)})`).join(', ')}`
    : '';
  return `${rec} vs ${pick.size}: ${parts.join(', ')}${tail}`;
}

/** "women" / "men" when the catalogue title names the cut, else null (never guessed). */
export function productCut(product: Pick<GarmentSpec, 'title'>): 'women' | 'men' | null {
  if (/\bwomen'?s\b/i.test(product.title)) return 'women';
  if (/\bmen'?s\b/i.test(product.title)) return 'men';
  return null;
}

/**
 * A note when the jacket's cut differs from the judge's chosen body shape. The recommendation
 * is unchanged: it is computed from the garment's own measurements on the judge's body.
 */
export function cutNote(
  product: Pick<GarmentSpec, 'title'>,
  sex: 'female' | 'male',
): string | null {
  const cut = productCut(product);
  if (cut === 'women' && sex === 'male') return "Women's cut";
  if (cut === 'men' && sex === 'female') return "Men's cut";
  return null;
}

export interface StoreLink {
  store: string;
  isAmazon: boolean;
  label: string;
  note: string;
}

const STORES: Array<[RegExp, string]> = [
  [/(^|\.)amazon\.com$/, 'Amazon'],
  [/(^|\.)ebay\.com$/, 'eBay'],
  [/(^|\.)nike\.com$/, 'Nike'],
];

/**
 * Button text for "act on the recommendation". The catalogue holds one product URL, never a
 * size-specific one, so the judge is told which size to choose on the page.
 */
export function storeLink(product: GarmentSpec, size: string | null): StoreLink | null {
  let host: string;
  try {
    const url = new URL(product.url);
    if (url.protocol !== 'https:') return null;
    host = url.hostname;
  } catch {
    return null;
  }
  const store = STORES.find(([pattern]) => pattern.test(host))?.[1];
  if (!store) return null;
  const isAmazon = store === 'Amazon';
  return {
    store,
    isAmazon,
    label: isAmazon
      ? `Open on Amazon${size ? ` in size ${size}` : ''}`
      : `Open store page (${store})`,
    note: size ? `Choose size ${size} on the page.` : 'Choose your size on the page.',
  };
}
