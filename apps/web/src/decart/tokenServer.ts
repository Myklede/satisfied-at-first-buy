// Browser client of scripts/decart-token-server.mjs (127.0.0.1:5830). The secret key never comes
// here: the page gets a short-lived client token per connect, scoped to one budgeted session.

export const TOKEN_SERVER = 'http://127.0.0.1:5830';

export type DecartPage = 'trial' | 'studio';

export interface TokenStatus {
  keyPresent: boolean;
  day: string;
  usedS: number;
  reservedS: number;
  totalS: number;
  maxTotalS: number;
  usd: number;
  allTimeUsd: number;
  maxUsd: number;
}

export interface OpenedSession extends TokenStatus {
  sessionId: string;
  sessionLimitS: number;
}

export class TokenServerError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${TOKEN_SERVER}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new TokenServerError(
      'Token server not reachable on 127.0.0.1:5830: run  node scripts/decart-token-server.mjs',
      'OFFLINE',
      0,
    );
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok)
    throw new TokenServerError(
      json.error ?? `${path}: HTTP ${res.status}`,
      json.code ?? null,
      res.status,
    );
  return json as T;
}

export const tokenServer = {
  status: () => call<TokenStatus>('/status'),
  credits: () => call<{ credits: number | null; usd: number | null }>('/credits'),
  refs: async () => (await call<{ files: string[] }>('/refs')).files,
  openSession: (page: DecartPage) => call<OpenedSession>('/session', { page }),
  token: async (sessionId: string) =>
    (await call<{ apiKey: string }>('/token', { sessionId })).apiKey,
  /** Reports streamed seconds. `beacon` for page unload (text/plain keeps it a simple request). */
  async report(sessionId: string, seconds: number, beacon = false): Promise<TokenStatus | null> {
    const body = JSON.stringify({ sessionId, seconds: Math.round(seconds * 10) / 10 });
    if (beacon) {
      navigator.sendBeacon(`${TOKEN_SERVER}/usage`, new Blob([body], { type: 'text/plain' }));
      return null;
    }
    return call<TokenStatus>('/usage', JSON.parse(body));
  },
};

/** Decart bills 2 credits per second at 720p standard (1 credit = $0.01; pricing page, 2026-11-15). */
export const CREDITS_PER_SECOND = 2;

/** "Credits left: 1234 (~$12.34, ~10:17 of streaming)". */
export function creditsText(credits: number | null): string {
  if (credits === null) return 'Credits left: ?';
  const s = Math.max(0, Math.floor(credits / CREDITS_PER_SECOND));
  const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `Credits left: ${credits} (~$${(credits / 100).toFixed(2)}, ~${mmss} of streaming)`;
}

export function formatBudget(s: TokenStatus): string {
  return (
    `today ${s.totalS} s / ${s.maxTotalS} s · all time ~$${s.allTimeUsd.toFixed(2)} of ` +
    `$${s.maxUsd}${s.keyPresent ? '' : ' · NO KEY (.env DECART_API_KEY)'}`
  );
}
