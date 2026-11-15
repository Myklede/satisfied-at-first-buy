/**
 * Antialiasing of the post-processed frame (lead decision, 2026-11-12, agent L1a): render the
 * scene into a 4x multisampled render target (MSAA) instead of an SMAA pass. SMAA erased the
 * 1-2 px strokes of the embroidered chest logo at kiosk distance (A/B in docs/STATUS.md, L1a);
 * MSAA antialiases geometry edges without touching texture detail.
 *
 * Returns the sample count to use, or 0 for the SMAA fallback: when the context cannot
 * multisample 4x, or when the page asks for it with `?aa=smaa` (A/B checks and a demo-day
 * escape hatch). Pure function.
 */
export const MSAA_SAMPLES = 4;

export function msaaSamples(maxSamples: number, search = ''): number {
  const forced = new URLSearchParams(search).get('aa');
  if (forced === 'smaa') return 0;
  return maxSamples >= MSAA_SAMPLES ? MSAA_SAMPLES : 0;
}
