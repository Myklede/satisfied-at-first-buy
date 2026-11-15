import type { Recommendation, ZoneView } from './types';

export function roomValue(zone: ZoneView): number | null {
  return zone.value_cm === null
    ? null
    : zone.metric === 'body_chart_distance_cm'
      ? -zone.value_cm
      : zone.value_cm;
}
export function zoneStatus(zone: ZoneView): string {
  const status = zone.adjusted_status ?? zone.status;
  return {
    fit: 'fits',
    relaxed: 'roomy',
    tight: zone.zone === 'sleeve' ? 'too short' : 'tight',
    too_big: zone.zone === 'sleeve' ? 'too long' : 'too roomy',
    unknown: 'not in chart',
  }[status];
}
/** Three engine tolerance widths each side; this changes display scale, never fit thresholds. */
export function barPosition(zone: ZoneView): number | null {
  const delta = zone.display_delta_cm,
    scale = zone.display_scale_cm;
  return delta == null || scale == null || scale <= 0
    ? null
    : 50 + Math.max(-1, Math.min(1, delta / (3 * scale))) * 45;
}

/** Preserve the service's reason when a chart value cannot determine inner fit. */
export function unknownReason(zone?: ZoneView): string {
  if (
    !zone ||
    !zone.text ||
    zone.text === 'Required garment measurement is absent' ||
    /not measured for this size/.test(zone.text)
  )
    return 'not in chart';
  return zone.text;
}

/** Set by the service when a tape-measured catalogue jacket is ranked by the full engine. */
export function rankingBasis(result: Pick<Recommendation, 'three_d'>): string | undefined {
  return result.three_d?.basis || undefined;
}
