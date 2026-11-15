// Service worker: the only part of the extension that talks to the local service.
// - Content scripts (on amazon.com) may only ask for product work and feedback; they never see
//   body data. Profile reads/writes come only from the extension's own profile page.
// - A session body (not remembered) lives in chrome.storage.session: memory only, gone when the
//   browser closes, and not readable by content scripts.
import { API_BASE, WEB_ORIGIN } from './config';
import type { Choices, FitRequest, Message, Reply } from './types';
import { handoffUrl } from './handoff';

const CONTENT_OPS = new Set([
  'status',
  'recommend',
  'compare',
  'learning',
  'purchase',
  'feedback',
  'open3d',
  'openProfile',
]);
const ID = /^[a-f0-9]{32}$/;
const ASIN = /^[A-Z0-9]{10}$/;

export interface Plan {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

type Body = { mode: 'profile' } | { mode: 'session'; fit_request: FitRequest };

/** Map a message to one fixed API call. Unknown or malformed requests return null. */
export function plan(message: Message, body: Body, choices: Choices): Plan | null {
  switch (message.op) {
    case 'status':
      return { method: 'GET', path: '/agent/status' };
    case 'recommend':
      return {
        method: 'POST',
        path: '/agent/recommend',
        body: {
          page: message.page,
          body,
          ...choices,
          ...(message.chart_type_override
            ? { chart_type_override: message.chart_type_override }
            : {}),
        },
      };
    case 'compare':
      if (message.asins.length !== 2 || !message.asins.every((a) => ASIN.test(a))) return null;
      return {
        method: 'POST',
        path: '/agent/compare',
        body: { asins: message.asins, body, ...choices },
      };
    case 'learning':
      return { method: 'GET', path: '/agent/learning' };
    case 'purchase':
      if (!ASIN.test(message.asin)) return null;
      return {
        method: 'POST',
        path: '/agent/purchases',
        body: { asin: message.asin, size: message.size, title: message.title.slice(0, 400) },
      };
    case 'feedback':
      if (!ID.test(message.purchase_id)) return null;
      return {
        method: 'POST',
        path: '/agent/feedback',
        body: { purchase_id: message.purchase_id, answers: message.answers },
      };
    case 'undo':
      return ID.test(message.purchase_id)
        ? { method: 'DELETE', path: `/agent/learning/${message.purchase_id}` }
        : null;
    case 'resetLearning':
      return { method: 'DELETE', path: '/agent/learning' };
    case 'getProfile':
      return { method: 'GET', path: '/agent/profile' };
    case 'deleteProfile':
      return { method: 'DELETE', path: '/agent/profile' };
    default:
      return null;
  }
}

async function call<T>(target: Plan): Promise<Reply<T>> {
  try {
    const response = await fetch(`${API_BASE}${target.path}`, {
      method: target.method,
      headers: target.body ? { 'Content-Type': 'application/json' } : undefined,
      body: target.body ? JSON.stringify(target.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
    });
    const data = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail = (data as { detail?: unknown } | null)?.detail;
      const text =
        typeof detail === 'string'
          ? detail
          : ((detail as { message?: string } | undefined)?.message ?? response.statusText);
      return { ok: false, error: { error: text, status: response.status, detail } };
    }
    return { ok: true, data: data as T };
  } catch {
    return {
      ok: false,
      error: { error: `Local Fit Agent service is not running at ${API_BASE}`, status: 0 },
    };
  }
}

async function currentBody(): Promise<Body> {
  const { sessionBody } = await chrome.storage.session.get('sessionBody');
  return sessionBody
    ? { mode: 'session', fit_request: sessionBody as FitRequest }
    : { mode: 'profile' };
}

async function currentChoices(): Promise<Choices> {
  const { choices } = await chrome.storage.local.get('choices');
  return (choices as Choices | undefined) ?? { preference: 'regular', layer: 't-shirt' };
}

async function handle(message: Message, fromExtensionPage: boolean): Promise<Reply<unknown>> {
  if (!fromExtensionPage && !CONTENT_OPS.has(message.op)) {
    return { ok: false, error: { error: 'Not allowed from a web page', status: 403 } };
  }
  if (message.op === 'open3d') {
    if (!message.url.startsWith(`${WEB_ORIGIN}/`)) {
      return { ok: false, error: { error: 'Only the local web app may be opened', status: 400 } };
    }
    const body = await currentBody();
    let request: FitRequest | undefined = body.mode === 'session' ? body.fit_request : undefined;
    if (!request) {
      const saved = await call<{ profile?: { fit_request: FitRequest } }>({
        method: 'GET',
        path: '/agent/profile',
      });
      if (saved.ok) request = saved.data.profile?.fit_request;
    }
    if (!request)
      return {
        ok: false,
        error: { error: 'Set up a body before opening the studio', status: 400 },
      };
    let destination: string;
    try {
      // The same stored choices the panel's /agent/recommend used (plan → currentChoices).
      destination = handoffUrl(message.url, WEB_ORIGIN, request, await currentChoices());
    } catch {
      return { ok: false, error: { error: 'Invalid catalogue hand-off', status: 400 } };
    }
    await chrome.tabs.create({ url: destination });
    return { ok: true, data: null };
  }
  if (message.op === 'openProfile') {
    await chrome.runtime.openOptionsPage();
    return { ok: true, data: null };
  }
  if (message.op === 'saveProfile') {
    await chrome.storage.local.set({ choices: message.choices });
    if (!message.remember) {
      // Session only: memory, never on disk, never sent except inside a local fit request.
      await chrome.storage.session.set({ sessionBody: message.fit_request });
      if (message.entry) await chrome.storage.session.set({ bodyEntry: message.entry });
      return { ok: true, data: { saved: false, session: true } };
    }
    await chrome.storage.session.remove('sessionBody');
    const saved = await call({
      method: 'PUT',
      path: '/agent/profile',
      body: { consent: true, fit_request: message.fit_request, choices: message.choices },
    });
    if (saved.ok && message.entry) await chrome.storage.local.set({ bodyEntry: message.entry });
    if (saved.ok) await chrome.storage.session.remove('bodyEntry');
    return saved;
  }
  if (message.op === 'deleteProfile') {
    await chrome.storage.session.remove(['sessionBody', 'bodyEntry']);
  }
  const target = plan(message, await currentBody(), await currentChoices());
  if (!target) return { ok: false, error: { error: 'Malformed request', status: 400 } };
  const reply = await call<Record<string, unknown>>(target);
  if (message.op === 'deleteProfile' && reply.ok)
    await chrome.storage.local.remove(['choices', 'compare', 'bodyEntry']);
  if (message.op === 'getProfile' && reply.ok && !reply.data.kiosk_mode) {
    const session = await chrome.storage.session.get('bodyEntry');
    const local = await chrome.storage.local.get('bodyEntry');
    reply.data.entry = session.bodyEntry ?? local.bodyEntry;
    // Show the stored choices on the profile page, so a re-save never silently resets them.
    const { choices } = await chrome.storage.local.get('choices');
    if (choices) reply.data.choices = choices;
  }
  if (message.op === 'status' && reply.ok) {
    const { sessionBody } = await chrome.storage.session.get('sessionBody');
    reply.data.session_body = Boolean(sessionBody);
    const saved = sessionBody
      ? null
      : await call<{ profile?: { fit_request?: { sex?: string } } }>({
          method: 'GET',
          path: '/agent/profile',
        });
    const sex = sessionBody
      ? (sessionBody as FitRequest).sex
      : saved?.ok
        ? saved.data.profile?.fit_request?.sex
        : undefined;
    // Only a generic illustration choice reaches the panel; body measurements remain private.
    reply.data.illustration = sex === 'male' || sex === 'female' ? sex : 'neutral';
  }
  return reply;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    // Extension pages (the profile page, even in a tab) have a chrome-extension:// URL;
    // content scripts report the web page's URL.
    const fromExtensionPage = (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
    void handle(message as Message, fromExtensionPage).then(sendResponse);
    return true; // async response
  });
}
