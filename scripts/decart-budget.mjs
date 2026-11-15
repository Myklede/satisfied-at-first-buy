// Pure budget logic for the Decart Lucy V-TON pages (scripts/decart-token-server.mjs).
// No I/O here except loadUsage/saveUsage, so the rules are unit-tested in decart-budget.test.mjs.
//
// Rules (docs/USER-RULES.md, 2026-11-15 00:18 and 00:45): free credits first, every session
// auto-stops, a hard seconds cap per day, and a hard all-time dollar cap (at most $30, the user's
// own top-up limit). Both caps are enforced on the server, not only in the page:
//   - POST /session opens a session and RESERVES its full limit (75 s trial page, 200 s Studio).
//   - ONE client token per session (POST /token), persisted (mintedAt); a second request for the
//     same session is refused, so one reservation covers exactly one provider credential.
//   - The browser's reported seconds (POST /usage) are diagnostics only once a token was minted:
//     they can never lower the reservation (security review H1). Only a session whose token was
//     never minted is released by the report (no credential existed, nothing could stream).
//   - A minted session can be settled from Decart's OWN balance (GET /v1/credits, server-side):
//     credits read just before the mint minus credits read after the session's window ended,
//     only for the most recently minted session (so the delta cannot belong to a later session)
//     and only when the balance went down (a top-up makes the delta unusable). Other usage of the
//     same account in that window is charged to the session too: conservative.
//   - A new session is refused when used + reserved + the new reservation would pass the daily
//     seconds cap, or when all days together plus the new reservation would pass the dollar cap.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Hard per-session limits in seconds: 75 s on the trial page, 200 s on the Studio page (judge
 *  rounds are 3 minutes; prompts/31). The page counts down from this, and the client token carries
 *  it as Decart's own `constraints.realtime.maxSessionDuration` backstop. */
export const SESSION_LIMITS_S = Object.freeze({ trial: 75, studio: 200 });
export const SESSION_LIMIT_S = SESSION_LIMITS_S.trial;
const MAX_SESSION_S = Math.max(...Object.values(SESSION_LIMITS_S));
/** Default daily cap when DECART_MAX_TOTAL_S is unset (900 s = $18 at list price). */
export const DEFAULT_MAX_TOTAL_S = 900;
/** Accepted range for DECART_MAX_TOTAL_S (one trial session .. 10 h). */
export const MAX_TOTAL_RANGE_S = [SESSION_LIMIT_S, 36000];
/** DECART_MAX_USD default and ceiling: the user's own top-up limit, $30 in total
 *  (USER-RULES 2026-11-15 00:45). A higher value is refused, not clamped. */
export const DEFAULT_MAX_USD = 30;
export const MAX_USD_CEILING = 30;
/** USD per streamed second for lucy-vton 3.6/3.5 at 720p, standard speed.
 *  Source: https://docs.platform.decart.ai/getting-started/pricing (read 2026-11-15). */
export const USD_PER_SECOND = 0.02;
/** A token may be minted for an open session until its limit + this many seconds after it opened
 *  (first connect + reconnects). */
export const TOKEN_GRACE_S = 15;
export const TOKEN_WINDOW_S = SESSION_LIMIT_S + TOKEN_GRACE_S;
/** The one token of a session must be minted within this many seconds of opening it. */
export const MINT_WINDOW_S = 30;
/** Reported seconds above the largest limit by more than this are rejected as invalid input. */
export const REPORT_SLACK_S = 15;
/** Settle from the provider balance only this long after a session's window ended (charges post
 *  while running; the margin covers posting delay). */
export const SETTLE_GRACE_S = 30;
/** Decart bills 2 credits per second at 720p standard (1 credit = $0.01; pricing page). */
export const CREDITS_PER_SECOND = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isSessionId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function isPage(value) {
  return typeof value === 'string' && Object.hasOwn(SESSION_LIMITS_S, value);
}

/** Local calendar day, YYYY-MM-DD ("today" in the user's timezone). */
export function localDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parses DECART_MAX_TOTAL_S; returns the default when unset, throws on garbage. */
export function parseMaxTotal(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_TOTAL_S;
  const text = String(raw).trim();
  if (!/^\d{1,6}$/.test(text))
    throw new Error(`DECART_MAX_TOTAL_S must be an integer, got "${text}"`);
  const value = Number(text);
  const [lo, hi] = MAX_TOTAL_RANGE_S;
  if (value < lo || value > hi) throw new Error(`DECART_MAX_TOTAL_S must be in ${lo}..${hi}`);
  return value;
}

/** Parses DECART_MAX_USD; default $30; refuses anything above the $30 ceiling. */
export function parseMaxUsd(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_USD;
  const text = String(raw).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text))
    throw new Error(`DECART_MAX_USD must be a dollar amount, got "${text}"`);
  const value = Number(text);
  if (value <= 0 || value > MAX_USD_CEILING)
    throw new Error(`DECART_MAX_USD must be in (0, ${MAX_USD_CEILING}] (user rule: $30 in total)`);
  return value;
}

export function emptyState() {
  return { version: 1, days: {} };
}

function dayEntry(state, day) {
  if (!state.days[day]) state.days[day] = { sessions: [] };
  return state.days[day];
}

/** Used (reported) and reserved (open, unreported) seconds for `day`. */
export function totals(state, day) {
  const sessions = state.days[day]?.sessions ?? [];
  let usedS = 0;
  let reservedS = 0;
  for (const s of sessions) {
    if (typeof s.usedS === 'number') usedS += s.usedS;
    else reservedS += s.reservedS;
  }
  const totalS = usedS + reservedS;
  return {
    usedS: round1(usedS),
    reservedS: round1(reservedS),
    totalS: round1(totalS),
    sessions: sessions.length,
    usd: round2(totalS * USD_PER_SECOND),
  };
}

/** All days together: seconds and dollars counted on this machine (reported + reserved). */
export function allTimeTotals(state) {
  let totalS = 0;
  for (const day of Object.keys(state.days)) totalS += totals(state, day).totalS;
  return { totalS: round1(totalS), usd: round2(totalS * USD_PER_SECOND) };
}

/** Opens a session; mutates `state`. Returns { ok: true, session } or { ok: false, error }. */
export function openSession(
  state,
  { id, now, maxTotalS, maxUsd = DEFAULT_MAX_USD, page = 'trial' },
) {
  if (!isSessionId(id)) return { ok: false, error: 'bad session id' };
  if (!isPage(page)) return { ok: false, error: 'bad page' };
  const limitS = SESSION_LIMITS_S[page];
  const day = localDay(now);
  const t = totals(state, day);
  if (t.totalS + limitS > maxTotalS) {
    return {
      ok: false,
      error:
        `Daily Decart budget reached: ${t.totalS} s counted today (${t.usedS} s reported + ` +
        `${t.reservedS} s reserved by unreported sessions), cap ${maxTotalS} s (DECART_MAX_TOTAL_S); ` +
        `another ${page} session would add up to ${limitS} s.`,
    };
  }
  const all = allTimeTotals(state);
  if ((all.totalS + limitS) * USD_PER_SECOND > maxUsd + 1e-9) {
    return {
      ok: false,
      error:
        `Dollar cap reached: ~$${all.usd} counted in total on this machine, cap $${maxUsd} ` +
        `(DECART_MAX_USD); another ${page} session could add $${round2(limitS * USD_PER_SECOND)}.`,
    };
  }
  const session = { id, page, openedAt: now.toISOString(), reservedS: limitS, usedS: null };
  dayEntry(state, day).sessions.push(session);
  return { ok: true, session };
}

function findSession(state, id) {
  for (const day of Object.keys(state.days)) {
    const s = state.days[day].sessions.find((x) => x.id === id);
    if (s) return { day, session: s };
  }
  return null;
}

function allSessions(state) {
  return Object.values(state.days).flatMap((d) => d.sessions);
}

/** May THE client token of this session be minted now? At most one per session, ever. */
export function canMintToken(state, { id, now }) {
  if (!isSessionId(id)) return { ok: false, error: 'bad session id' };
  const found = findSession(state, id);
  if (!found) return { ok: false, error: 'unknown session; start a new one' };
  if (found.session.mintedAt) return { ok: false, error: 'this session already has its token' };
  if (typeof found.session.usedS === 'number') return { ok: false, error: 'session already ended' };
  const ageS = (now.getTime() - Date.parse(found.session.openedAt)) / 1000;
  if (ageS < 0 || ageS > MINT_WINDOW_S) return { ok: false, error: 'session window over' };
  return { ok: true, limitS: found.session.reservedS };
}

/** Records the one mint (call only after canMintToken, before returning the token); mutates. */
export function markMinted(state, { id, now, creditsBefore }) {
  const found = findSession(state, id);
  if (!found || found.session.mintedAt) throw new Error('markMinted: not mintable');
  found.session.mintedAt = now.toISOString();
  found.session.creditsBefore = typeof creditsBefore === 'number' ? creditsBefore : null;
}

/** The session that may be settled from the provider balance now, or null: the most recently
 *  minted session, unsettled, with a credits reading from before its mint, window ended. */
export function settleCandidate(state, { now }) {
  const minted = allSessions(state).filter((s) => s.mintedAt);
  if (minted.length === 0) return null;
  const latest = minted.reduce((a, b) =>
    Date.parse(a.mintedAt) >= Date.parse(b.mintedAt) ? a : b,
  );
  if (latest.settledBy || typeof latest.creditsBefore !== 'number') return null;
  const endS = Date.parse(latest.mintedAt) / 1000 + latest.reservedS + SETTLE_GRACE_S;
  return now.getTime() / 1000 >= endS ? latest : null;
}

/** Settles `id` from the provider balance; mutates. Never below 0, never when the balance rose. */
export function settleFromCredits(state, { id, creditsNow }) {
  const found = findSession(state, id);
  if (!found || typeof found.session.creditsBefore !== 'number') return { ok: false };
  if (typeof creditsNow !== 'number' || creditsNow > found.session.creditsBefore)
    return { ok: false, error: 'balance went up (top-up?): keep the full reservation' };
  const consumedS = (found.session.creditsBefore - creditsNow) / CREDITS_PER_SECOND;
  // Consumption above the reservation is recorded as is (more conservative than the cap).
  found.session.usedS = round1(consumedS);
  found.session.settledBy = 'provider-credits';
  return { ok: true, usedS: found.session.usedS };
}

/** Validates a POST /usage body: exactly { sessionId, seconds }. */
export function validateUsageBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, error: 'body must be a JSON object' };
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== 'seconds' || keys[1] !== 'sessionId')
    return { ok: false, error: 'body must have exactly sessionId and seconds' };
  if (!isSessionId(body.sessionId)) return { ok: false, error: 'bad session id' };
  const s = body.seconds;
  const max = MAX_SESSION_S + REPORT_SLACK_S;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > max)
    return { ok: false, error: `seconds must be a number in 0..${max}` };
  return { ok: true, sessionId: body.sessionId, seconds: s };
}

/** Records the browser's report; mutates `state`. It is untrusted: after a mint it is kept as a
 *  diagnostic only and the full reservation stays. Before any mint it releases the reservation
 *  (no credential was ever issued for this session). */
export function reportUsage(state, { id, seconds }) {
  const found = findSession(state, id);
  if (!found) return { ok: false, error: 'unknown session' };
  const s = found.session;
  const clamped = round1(Math.min(Math.max(seconds, 0), s.reservedS));
  s.reportedS = Math.max(typeof s.reportedS === 'number' ? s.reportedS : 0, clamped);
  if (!s.mintedAt && typeof s.usedS !== 'number') {
    s.usedS = 0;
    s.settledBy = 'no-token';
  }
  return { ok: true, day: found.day, released: s.settledBy === 'no-token' };
}

export function loadUsage(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.days && typeof parsed.days === 'object')
      return parsed;
    throw new Error('unexpected usage file shape');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    // A corrupt file must not silently reset the counter to zero.
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function saveUsage(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
