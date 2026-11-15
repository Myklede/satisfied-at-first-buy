import type { Choices, FitRequest } from './types';
/** Only the private worker calls this; content scripts never receive body parameters.
 *  The shopper's under-layer and fit preference travel with the body, so the studio computes
 *  "Best available" with the same layer_cm and preference the panel's pick used. */
export function handoffUrl(
  url: string,
  origin: string,
  request: FitRequest,
  choices: Choices,
): string {
  const parsed = new URL(url);
  if (
    parsed.origin !== new URL(origin).origin ||
    parsed.pathname !== '/' ||
    !/^[a-f0-9]{64}$/.test(parsed.searchParams.get('product') ?? '') ||
    !/^[A-Za-z0-9 .()-]{1,24}$/.test(parsed.searchParams.get('size') ?? '')
  )
    throw new Error('Invalid studio destination');
  const body = {
    sex: request.sex,
    height_cm: request.height_cm,
    weight_kg: request.weight_kg,
    ...(request.known_measurements?.chest_cm
      ? { chest_cm: request.known_measurements.chest_cm }
      : {}),
    layer: choices.layer,
    preference: choices.preference,
  };
  parsed.hash =
    'handoff=' +
    btoa(JSON.stringify(body)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return parsed.href;
}
