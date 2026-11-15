import type { FitResponse } from '../../api';
import type { ScanFitReport } from '../kioskApi';

export const BODY_BASIS = {
  scan: 'Your scanned body',
  'height-weight': 'Body estimated from height & weight',
} as const;
export type BodyBasis = keyof typeof BODY_BASIS;

/** Use the fitted response body, never the report's pre-scan base or warm-up body. */
export function tryOnBody(
  body: Pick<FitResponse, 'body_id'>,
  report: ScanFitReport | null,
): { bodyId: string; bodyBasis: BodyBasis } {
  return { bodyId: body.body_id, bodyBasis: report ? 'scan' : 'height-weight' };
}
