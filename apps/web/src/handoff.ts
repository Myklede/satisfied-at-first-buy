import type { FitRequest, GarmentFitRequest, GarmentOptions } from './api';

type Preference = NonNullable<GarmentFitRequest['preference']>;
const PREFERENCES = ['fitted', 'regular', 'relaxed'] as const satisfies readonly Preference[];

export interface StudioHandoff {
  productId: string;
  size: string;
  body: Pick<FitRequest, 'sex' | 'height_cm' | 'weight_kg'> & { chest_cm?: number };
  /** The shopper's under-layer preset and fit preference from the Fit Agent profile. */
  layer: string;
  preference: string;
}
export interface HandoffResult {
  value?: StudioHandoff;
  error?: string;
  ignored?: boolean;
}
/** API ranges: services/body/body_service/schemas.py, FitRequest/KnownMeasurements. */
export function consumeHandoff(
  location: Pick<Location, 'hash' | 'search' | 'pathname'>,
  history: Pick<History, 'replaceState'>,
): HandoffResult {
  if (!location.hash.startsWith('#handoff=')) return {};
  const encoded = location.hash.slice(9);
  // Clear before parsing, validation, requests or any potential error logging.
  history.replaceState(null, '', location.pathname + location.search);
  const params = new URLSearchParams(location.search);
  if (params.has('kiosk')) return { ignored: true };
  try {
    if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error();
    const decoded: unknown = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw Error();
    const data = decoded as Record<string, unknown>;
    if (
      Object.keys(data).some(
        (key) =>
          !['sex', 'height_cm', 'weight_kg', 'chest_cm', 'layer', 'preference'].includes(key),
      )
    )
      throw Error();
    // Shape only here; membership in the studio's presets is checked by knownChoices().
    const name = (value: unknown): value is string =>
      typeof value === 'string' && /^[a-z][a-z-]{0,23}$/.test(value);
    if (!name(data.layer) || !name(data.preference)) throw Error();
    const range = (value: unknown, low: number, high: number): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
    if (
      (data.sex !== 'male' && data.sex !== 'female') ||
      !range(data.height_cm, 120, 220) ||
      !range(data.weight_kg, 30, 200) ||
      (data.chest_cm !== undefined && !range(data.chest_cm, 45, 200))
    )
      throw Error();
    const productId = params.get('product') ?? '',
      size = params.get('size') ?? '';
    if (!/^[a-f0-9]{64}$/.test(productId) || !/^[A-Za-z0-9 .()-]{1,24}$/.test(size)) throw Error();
    return {
      value: {
        productId,
        size,
        body: {
          sex: data.sex as FitRequest['sex'],
          height_cm: data.height_cm,
          weight_kg: data.weight_kg,
          ...(typeof data.chest_cm === 'number' ? { chest_cm: data.chest_cm } : {}),
        },
        layer: data.layer,
        preference: data.preference,
      },
    };
  } catch {
    return {
      error:
        'This body hand-off is invalid. Enter your body details to continue; no body was guessed.',
    };
  }
}

/** The hand-off's layer and preference as studio presets (GET /garment/options), or null when
 *  either is not one: the studio refuses it rather than guess or fall back to its defaults. */
export function knownChoices(
  handoff: Pick<StudioHandoff, 'layer' | 'preference'>,
  options: Pick<GarmentOptions, 'layer_presets_cm' | 'preferences'>,
): { under: string; preference: Preference } | null {
  const preference = PREFERENCES.find(
    (value) => value === handoff.preference && options.preferences.includes(value),
  );
  return Object.keys(options.layer_presets_cm).includes(handoff.layer) && preference
    ? { under: handoff.layer, preference }
    : null;
}
