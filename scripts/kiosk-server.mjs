// Kiosk static server (Node built-ins + zod). Loopback only.
// - Serves the production build (apps/web/dist) from a whitelist built at startup:
//   no file path is ever built from a request URL.
// - Proxies /api/* to the body service on loopback (prefix stripped), like Vite in dev.
// - /kiosk/status   GET  : service watchdog state ("up" | "restarting").
// - /kiosk/board    GET  : anonymous accuracy-board entries (opt-in only).
// - /kiosk/board    POST : append one validated anonymous entry.
// - /kiosk/quit     POST : operator Ctrl+Shift+Q, stops browser, service and server.
// The accuracy board is data/accuracy/board.json (gitignored). It stores only numbers:
// predicted vs measured offsets, height and sex. No name, no image, no timestamp.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '..');
export const BOARD_FILE = join(root, 'data/accuracy/board.json');
const MAX_BOARD_ENTRIES = 5000;
const MAX_BODY_BYTES = 16 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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

export function readBoard() {
  if (!existsSync(BOARD_FILE)) return [];
  const parsed = z.array(boardEntrySchema).safeParse(JSON.parse(readFileSync(BOARD_FILE, 'utf8')));
  if (!parsed.success) throw new Error('data/accuracy/board.json is not a valid board file');
  return parsed.data;
}

function appendBoard(entry) {
  const entries = readBoard();
  if (entries.length >= MAX_BOARD_ENTRIES) throw new Error('Board is full');
  entries.push(entry);
  mkdirSync(join(BOARD_FILE, '..'), { recursive: true });
  const temp = `${BOARD_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(entries, null, 1));
  renameSync(temp, BOARD_FILE);
  return entries.length;
}

// "Act on the recommendation": the store page opens in the operator's DEFAULT browser,
// not in the kiosk window. The kiosk Chrome profile auto-accepts camera prompts
// (--use-fake-ui-for-media-stream), so a third-party page must never load there.
// Only the catalogue's own product URL is opened (looked up server-side by product id;
// the client never supplies a URL). The data holds no size-specific URLs, so none is made.
const STORE_HOSTS = ['amazon.com', 'ebay.com', 'nike.com'];
function storeUrls() {
  const dir = join(root, 'data/products');
  const map = new Map();
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/, '');
    if (!/^[a-f0-9]{64}$/.test(id)) continue;
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')).url;
    const url = typeof raw === 'string' ? new URL(raw) : null;
    if (
      url?.protocol === 'https:' &&
      STORE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    )
      map.set(id, url.href);
  }
  return map;
}
function openInDefaultBrowser(url) {
  // No shell: url.dll's handler (Windows), open (macOS), xdg-open (Linux).
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

function whitelist(dist) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set('/' + relative(dist, full).split(sep).join('/'), full);
    }
  };
  walk(dist);
  return files;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * `extraRoute(req, res, url)` is an optional hook tried before the static files; it returns true
 * when it answered the request (scripts/sandbox.mjs mounts the read-only reference photos with it;
 * the real kiosk passes none).
 * @param {{ dist: string, port: number, apiPort: number,
 *   status: () => object, quit: () => void, log?: (m: string) => void,
 *   extraRoute?: (req: object, res: object, url: URL) => boolean }} options
 */
export function startKioskServer({
  dist,
  port,
  apiPort,
  status,
  quit,
  log = console.log,
  extraRoute,
}) {
  const files = whitelist(dist);
  const stores = storeUrls();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only loopback host headers are served.
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 400, { detail: 'Bad host' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, '')))
          return send(res, 403, { detail: 'Cross-origin request refused' });
      }
      if (path.startsWith('/api/')) return proxy(req, res, path.slice(4) + url.search);
      if (extraRoute?.(req, res, url)) return;
      if (path === '/kiosk/status' && req.method === 'GET') return send(res, 200, status());
      if (path === '/kiosk/board' && req.method === 'GET') return send(res, 200, readBoard());
      if (path === '/kiosk/board' && req.method === 'POST') {
        const parsed = boardEntrySchema.safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) return send(res, 422, { detail: 'Invalid board entry' });
        return send(res, 200, { count: appendBoard(parsed.data) });
      }
      if (path === '/kiosk/open-store' && req.method === 'POST') {
        const parsed = z
          .strictObject({ product_id: z.string().regex(/^[a-f0-9]{64}$/) })
          .safeParse(JSON.parse(await readBody(req)));
        const url = parsed.success ? stores.get(parsed.data.product_id) : undefined;
        if (!url) return send(res, 404, { detail: 'Unknown product' });
        if (process.env.SATISFY_KIOSK_DRY_OPEN === '1')
          return send(res, 200, { opened: false, dry_run: true, url });
        openInDefaultBrowser(url);
        return send(res, 200, { opened: true, url });
      }
      if (path === '/kiosk/quit' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setTimeout(quit, 50);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { detail: 'No' });
      const file = files.get(path) ?? files.get('/index.html');
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      // Vision models and hashed bundles are immutable; the HTML shell is not cached.
      const immutable = path.startsWith('/vision/') || path.startsWith('/assets/');
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': immutable ? 'public, max-age=604800, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    } catch (error) {
      log(`[kiosk] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, { detail: 'Kiosk server error' });
    }
  });

  function proxy(req, res, target) {
    const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` };
    delete headers.origin; // same-origin through this proxy; the service CORS list is for dev
    const upstream = httpRequest(
      { host: '127.0.0.1', port: apiPort, path: target, method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      // Service down or restarting: the web app shows "Reconnecting…", never a stack trace.
      if (!res.headersSent) send(res, 503, { detail: 'Body service reconnecting' });
      else res.destroy();
    });
    req.pipe(upstream);
  }

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}
