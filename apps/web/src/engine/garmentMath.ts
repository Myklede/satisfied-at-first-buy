import type { GarmentSpec } from '../api';

export type GarmentMode = 'normal' | 'xray' | 'heatmap' | 'tension';
export function morphProgress(elapsedMs: number) {
  const t = Math.max(0, Math.min(1, elapsedMs / 400));
  return t * t * (3 - 2 * t);
}
export function heatColour(gapCm: number, tightCm: number, looseCm: number, elastic = 0) {
  if (!(looseCm > tightCm)) throw new Error('Heatmap thresholds must increase');
  if (elastic >= 0.5) return [0.56, 0.62, 0.63];
  if (gapCm <= tightCm) return [0.95, 0.2, 0.16];
  if (gapCm >= looseCm) return [0.2, 0.48, 0.96];
  const t = (gapCm - tightCm) / (looseCm - tightCm);
  return t < 0.5
    ? [0.95 * (1 - t * 2) + 0.2 * t * 2, 0.2 + 0.6 * t * 2, 0.16 + 0.24 * t * 2]
    : [0.2, 0.8 - 0.32 * (t * 2 - 1), 0.4 + 0.56 * (t * 2 - 1)];
}
export function knownProduct(url: string, products: GarmentSpec[]) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return undefined;
    const key = (value: URL) =>
      `${value.hostname.toLowerCase()}${value.pathname.replace(/\/$/, '')}`;
    return products.find((product) =>
      [product.url, ...(product.url_aliases ?? [])].some(
        (alias) => key(new URL(alias)) === key(target),
      ),
    );
  } catch {
    return undefined;
  }
}
