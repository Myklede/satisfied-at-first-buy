// Kiosk-only HTTP calls. Body/garment calls reuse ../api; this adds the scan-aware fit,
// the reset (DELETE) and the kiosk server endpoints (/kiosk/*, served by scripts/kiosk-server.mjs).
import { z } from 'zod';
import type { components } from '@satisfy/api-types';
import { fitSchema, type FitRequest, type FitResponse } from '../api';
import { boardEntrySchema, type BoardEntry } from './board';

export type ScanFitReport = components['schemas']['ScanFitReport'];
export type ScanMeasurementsRequest = components['schemas']['ScanMeasurements'];

const finite = z.number().finite();
const scanReportSchema: z.ZodType<ScanFitReport> = z.strictObject({
  source: z.literal('webcam_scan'),
  calibration: z.string(),
  weighting: z.string(),
  entries: z.record(
    z.string(),
    z.strictObject({
      value_cm: finite,
      sigma_cm: finite.positive(),
      fitted_cm: finite,
      residual_cm: finite,
      method: z.string(),
    }),
  ),
  overridden_by_tape: z.array(z.string()),
  base_body_id: z.string().regex(/^[a-f0-9]{64}$/),
});

export class ServiceUnavailable extends Error {}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    throw new ServiceUnavailable('Reconnecting…');
  }
  if (response.status === 502 || response.status === 503)
    throw new ServiceUnavailable('Reconnecting…');
  if (response.status === 422)
    throw new Error('These numbers could not produce a reliable body. Please check them.');
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

/** POST /body/fit with optional scan; validates the regular response and the scan report. */
export async function fitBody(
  request: FitRequest,
  signal?: AbortSignal,
): Promise<{ body: FitResponse; scan: ScanFitReport | null }> {
  const data = await call('/api/body/fit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!data || typeof data !== 'object') throw new Error('Invalid body response');
  const { scan, ...rest } = data as Record<string, unknown>;
  const body = fitSchema.safeParse(rest);
  if (!body.success) throw new Error('The body service returned an invalid response.');
  if (scan === undefined || scan === null) return { body: body.data, scan: null };
  const report = scanReportSchema.safeParse(scan);
  if (!report.success) throw new Error('The body service returned an invalid scan report.');
  return { body: body.data, scan: report.data };
}

/** Kiosk reset: ask the service to forget a body (and its scan base) now. */
export async function forgetBody(bodyId: string) {
  if (!/^[a-f0-9]{64}$/.test(bodyId)) return;
  await fetch(`/api/body/${bodyId}`, { method: 'DELETE', cache: 'no-store' }).catch(() => {});
}

/** A deadline is inconclusive: the browser can queue this behind asset downloads. */
export async function serviceHealthy(): Promise<boolean | null> {
  const signal = AbortSignal.timeout(2500);
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { model_loaded?: unknown };
    return data.model_loaded === true;
  } catch {
    return signal.aborted ? null : false;
  }
}

const supervisorSchema = z.strictObject({
  service: z.enum(['starting', 'up', 'restarting']),
  restarts: z.number().int().nonnegative(),
});

/** Optional outside the kiosk launcher (Vite serves HTML here). No body data. */
export async function serviceRestarts(): Promise<number | null> {
  try {
    const response = await fetch('/kiosk/status', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return null;
    const parsed = supervisorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.restarts : null;
  } catch {
    return null;
  }
}

/** The kiosk server endpoints exist only under `npm run kiosk`, not under Vite dev. */
export async function readBoard(): Promise<BoardEntry[] | 'unavailable'> {
  try {
    const response = await fetch('/kiosk/board', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('json'))
      return 'unavailable';
    const parsed = z.array(boardEntrySchema).safeParse(await response.json());
    return parsed.success ? parsed.data : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function addToBoard(entry: BoardEntry): Promise<boolean> {
  const parsed = boardEntrySchema.safeParse(entry);
  if (!parsed.success) return false;
  try {
    const response = await fetch('/kiosk/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Opens the catalogue store page in the operator's default browser (never the kiosk window). */
export async function openStore(productId: string): Promise<'opened' | 'dry_run' | 'unavailable'> {
  try {
    const response = await fetch('/kiosk/open-store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId }),
    });
    if (!response.ok) return 'unavailable';
    const data = (await response.json()) as { opened?: boolean; dry_run?: boolean };
    return data.opened ? 'opened' : data.dry_run ? 'dry_run' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function quitKiosk() {
  await fetch('/kiosk/quit', { method: 'POST' }).catch(() => {});
}
