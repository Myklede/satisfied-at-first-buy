// Anonymous accuracy board (opt-in). Mirrors scripts/kiosk-server.mjs boardEntrySchema.
import { z } from 'zod';

const offset = z
  .strictObject({
    predicted_cm: z.number().finite().min(-60).max(60),
    measured_cm: z.number().finite().min(-60).max(60).nullable(),
  })
  .nullable();
export const boardEntrySchema = z.strictObject({
  version: z.literal(1),
  sex: z.enum(['female', 'male']),
  height_cm: z.number().int().min(120).max(220),
  product_style: z.string().regex(/^[A-Za-z0-9-]{1,32}$/),
  size: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/),
  scanned: z.boolean(),
  shoulder_seam: offset,
  cuff_vs_wrist: offset,
  hem_vs_hip: offset,
});
export type BoardEntry = z.infer<typeof boardEntrySchema>;
export const BOARD_METRICS = ['shoulder_seam', 'cuff_vs_wrist', 'hem_vs_hip'] as const;
export type BoardMetric = (typeof BOARD_METRICS)[number];
export const METRIC_LABELS: Record<BoardMetric, string> = {
  shoulder_seam: 'Shoulder seam',
  cuff_vs_wrist: 'Cuff vs wrist',
  hem_vs_hip: 'Hem vs hip',
};

export interface MetricSummary {
  n: number;
  /** Mean absolute error |predicted − measured| in cm; null when n = 0. */
  maeCm: number | null;
  /** Mean signed error (predicted − measured) in cm; null when n = 0. */
  biasCm: number | null;
}

/** Only pairs with both a prediction and a measurement count. */
export function summarize(entries: BoardEntry[]): Record<BoardMetric, MetricSummary> {
  const out = {} as Record<BoardMetric, MetricSummary>;
  for (const metric of BOARD_METRICS) {
    const errors = entries
      .map((entry) => entry[metric])
      .filter((pair): pair is { predicted_cm: number; measured_cm: number } =>
        Boolean(pair && pair.measured_cm !== null),
      )
      .map((pair) => pair.predicted_cm - pair.measured_cm);
    out[metric] = {
      n: errors.length,
      maeCm: errors.length ? errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length : null,
      biasCm: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : null,
    };
  }
  return out;
}

/** An entry is worth storing only if at least one measured value was entered. */
export const hasMeasurement = (entry: BoardEntry) =>
  BOARD_METRICS.some((metric) => entry[metric]?.measured_cm != null);
