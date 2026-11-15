// Fit verdict for the Studio (contract.ts FitVerdict), built ONLY from the body service's garment
// fit (POST /fit/garment, services/body/body_service/garment/fit_math.py). Nothing here computes
// or invents a fit number: it selects the service's zones and maps its statuses to three words.
//
// Zone meanings (fit_math.py):
//   chest    'inner_ease_cm'      garment inner girth − body chest girth − 2π·layer (cm)
//   hem      'inner_ease_cm'      garment inner hem girth − body hip girth − 2π·layer (cm)
//   bicep    'inner_ease_cm'      garment bicep − body upper arm − 2π·layer (cm)
//   shoulder 'shoulder_offset_cm' seam position − acromion along the arm (+ = seam drops)
//   sleeve   'sleeve_offset_cm'   cuff edge − wrist crease along the arm (+ = past the wrist)
// The service has no waist zone for jackets; the contract carries hem (garment hem vs hip) instead.
import type { GarmentFitResponse, SizeFit } from '../../api';
import type { FitVerdict, JacketId, SizeLabel } from '../contract';
import { STUDIO_SIZES } from './config';

export type VerdictLabel = FitVerdict['sizes'][SizeLabel]['label'];
type ZoneStatus = 'tight' | 'fit' | 'relaxed' | 'too_big' | 'unknown';

export interface ZoneValue {
  /** The service's value_cm, or null when the service could not compute it. */
  valueCm: number | null;
  status: ZoneStatus;
  metric: string;
}

export interface SizeVerdict {
  chest: number;
  shoulder: number;
  sleeve: number;
  label: VerdictLabel;
  /** Extra zones the service computes (not in the contract). */
  hem: number;
  bicep: number;
  /** Per-zone status straight from the service. */
  zones: Record<'chest' | 'hem' | 'bicep' | 'shoulder' | 'sleeve', ZoneValue>;
  /** True when the service marks this size's grade as estimated (not taped). */
  estimated: boolean;
}

/** FitVerdict plus provenance; structurally a FitVerdict, so DC can use it as one. */
export interface FitLabVerdict extends FitVerdict {
  sizes: Record<SizeLabel, SizeVerdict>;
  /** The service's own recommendation (null when it had none; `recommended` is then the fallback). */
  serviceRecommended: string | null;
  /** How `recommended` was chosen, for the panel and the report. */
  recommendedBasis: 'service' | 'nearest-studio-size' | 'first-with-geometry' | 'first-size';
  fitId: string;
  bodyId: string;
  productId: string;
  layerCm: number;
  preference: string;
  heatmapTightCm: number;
  heatmapLooseCm: number;
}

const ZONES = ['chest', 'hem', 'bicep', 'shoulder', 'sleeve'] as const;
const EXPECTED_METRIC: Record<(typeof ZONES)[number], string> = {
  chest: 'inner_ease_cm',
  hem: 'inner_ease_cm',
  bicep: 'inner_ease_cm',
  shoulder: 'shoulder_offset_cm',
  sleeve: 'sleeve_offset_cm',
};

function zoneValue(size: SizeFit, zone: (typeof ZONES)[number]): ZoneValue {
  const z = size.zones[zone];
  if (!z) return { valueCm: null, status: 'unknown', metric: 'absent' };
  const value = typeof z.value_cm === 'number' && Number.isFinite(z.value_cm) ? z.value_cm : null;
  // A zone in another metric (e.g. body-chart mode) is not garment-minus-body ease: not shown.
  if (z.metric !== EXPECTED_METRIC[zone])
    return { valueCm: null, status: 'unknown', metric: z.metric };
  return { valueCm: value, status: z.status, metric: z.metric };
}

/**
 * One word per size from the service's per-zone statuses (fit_math.py ease_metric /
 * offset_metric): any zone 'tight' → tight; else any 'too_big' → loose; else (fit / relaxed)
 * good. 'relaxed' is within twice the design-ease tolerance (fit_math.py), so it counts as good.
 * Zones the service could not assess are ignored; with no assessed zone at all this returns null
 * (never a default word) and buildVerdict refuses the size.
 */
export function sizeLabel(zones: ZoneValue[]): VerdictLabel | null {
  const known = zones.filter((z) => z.status !== 'unknown');
  if (!known.length) return null;
  if (known.some((z) => z.status === 'tight')) return 'tight';
  if (known.some((z) => z.status === 'too_big')) return 'loose';
  return 'good';
}

/** Catalogue size order (the same list as kiosk/fitSummary.ts sortSizes). */
const CATALOGUE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL'];

/**
 * The Studio's one word per size, from the service's ranking AND its per-zone statuses:
 *  - the size the service recommends (best score over its comparison zones) → 'good'
 *    (the best of the sizes for this body; its zone numbers and flags stay on screen);
 *  - a size smaller than the recommendation with a zone the service flags 'tight' → 'tight';
 *  - a size larger than it with a zone flagged 'too_big' or 'relaxed' → 'loose';
 *  - otherwise, or when the service recommended nothing, the zone rule (sizeLabel).
 * Why not the zone rule alone: on these jackets the analytic cuff offset is 'too_big' for every
 * size (fit_math.py: 'stacking not yet included, unverified'), so every size would read 'loose'.
 */
export function labelFor(
  name: string,
  zones: ZoneValue[],
  serviceRecommended: string | null,
): VerdictLabel | null {
  const fallback = sizeLabel(zones);
  if (!fallback || !serviceRecommended) return fallback;
  if (name === serviceRecommended) return 'good';
  const at = CATALOGUE_ORDER.indexOf(name),
    rec = CATALOGUE_ORDER.indexOf(serviceRecommended);
  if (at < 0 || rec < 0) return fallback;
  if (at < rec && zones.some((z) => z.status === 'tight')) return 'tight';
  if (at > rec && zones.some((z) => z.status === 'too_big' || z.status === 'relaxed'))
    return 'loose';
  return fallback;
}

/**
 * The kiosk's choice (KioskApp.tsx startFitting): `fit.recommended_size ?? geometrySizes(fit)[0]`,
 * restricted to the Studio's S/M/L. When the service recommends a size outside S/M/L (e.g. XL),
 * the nearest Studio size in catalogue order (XL and up → L, XS and down → S) is shown with basis
 * 'nearest-studio-size', and the panel says which size the engine actually recommends. With no
 * service recommendation, the kiosk's fallback: the first size with geometry.
 */
export function recommendedSize(fit: GarmentFitResponse): {
  size: SizeLabel;
  basis: FitLabVerdict['recommendedBasis'];
} {
  const rec = fit.recommended_size;
  if (rec && (STUDIO_SIZES as readonly string[]).includes(rec))
    return { size: rec as SizeLabel, basis: 'service' };
  const at = rec ? CATALOGUE_ORDER.indexOf(rec) : -1;
  if (at >= 0) {
    const first = CATALOGUE_ORDER.indexOf(STUDIO_SIZES[0]);
    return {
      size: at < first ? STUDIO_SIZES[0] : STUDIO_SIZES[STUDIO_SIZES.length - 1],
      basis: 'nearest-studio-size',
    };
  }
  const withGeometry = STUDIO_SIZES.find((s) => fit.sizes[s]?.geometry_available);
  if (withGeometry) return { size: withGeometry, basis: 'first-with-geometry' };
  return { size: STUDIO_SIZES[0], basis: 'first-size' };
}

export class VerdictError extends Error {}

/** Builds the Studio verdict from the service's garment fit. Throws if S, M or L is missing. */
export function buildVerdict(
  jacket: JacketId,
  fit: GarmentFitResponse,
  request: { layerCm: number; preference: string },
): FitLabVerdict {
  const sizes = {} as Record<SizeLabel, SizeVerdict>;
  for (const name of STUDIO_SIZES) {
    const size = fit.sizes[name];
    if (!size) throw new VerdictError(`The fit service returned no size ${name} for ${jacket}.`);
    const zones = Object.fromEntries(
      ZONES.map((z) => [z, zoneValue(size, z)]),
    ) as SizeVerdict['zones'];
    const label = labelFor(name, Object.values(zones), fit.recommended_size);
    if (!label)
      throw new VerdictError(
        `The fit service could not assess any zone of ${jacket} size ${name}.`,
      );
    const n = (z: ZoneValue) => z.valueCm ?? Number.NaN;
    sizes[name] = {
      chest: n(zones.chest),
      shoulder: n(zones.shoulder),
      sleeve: n(zones.sleeve),
      hem: n(zones.hem),
      bicep: n(zones.bicep),
      label,
      zones,
      estimated: size.estimated,
    };
  }
  const { size, basis } = recommendedSize(fit);
  return {
    jacket,
    recommended: size,
    sizes,
    serviceRecommended: fit.recommended_size,
    recommendedBasis: basis,
    fitId: fit.fit_id,
    bodyId: fit.body_id,
    productId: fit.product_id,
    layerCm: request.layerCm,
    preference: request.preference,
    heatmapTightCm: fit.heatmap_tight_cm,
    heatmapLooseCm: fit.heatmap_loose_cm,
  };
}

/** "+3.4 cm" / "−1.0 cm" / "n/a". */
export function signedCm(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const r = Math.round(value * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(1)} cm`;
}

/** One line per size, e.g. "S: chest +6.2 cm, shoulder seam +3.1 cm, cuff +2.0 cm (good)". */
export function verdictLine(name: SizeLabel, v: SizeVerdict): string {
  const parts = [
    `chest ${signedCm(v.chest)}`,
    `hem ${signedCm(v.hem)}`,
    `shoulder seam ${signedCm(v.shoulder)}`,
    `cuff ${signedCm(v.sleeve)}`,
  ];
  return `${name}: ${parts.join(', ')} (${v.label}${v.estimated ? ', estimated grade' : ''})`;
}
