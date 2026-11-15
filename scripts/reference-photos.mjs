// Read-only server for the jacket sandbox's reference photos (data/reference-photos/<folder>/...).
// Used by the Vite dev server (apps/web/vite.config.ts) and by scripts/sandbox.mjs; loopback only
// (the callers bind 127.0.0.1 and check the Host header).
//
//   GET /sandbox/refs                          -> { folders: [{ name, files: [{ id, name, kind, bytes }] }] }
//   GET /sandbox/ref?folder=F&i=N              -> the Nth file of folder F, exactly as listed
//   GET /sandbox/ref?folder=F&name=sub/a.jpg   -> the listed file with exactly that name
//
// No file path is ever built from the request. Every request re-scans the directory and the
// requested folder/index/name is looked up in that scan; the file served is the scan's own absolute
// path. `..`, absolute paths, backslashes and drive letters are rejected up front (they could never
// match a listed name anyway). Symlinks and dotfiles are never listed. Only .jpg/.jpeg/.png/.webp
// images and .mp4/.mov videos are served, GET/HEAD only, with Range support for <video>.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

export const DEFAULT_ROOT = resolve(import.meta.dirname, '..', 'data', 'reference-photos');
/** One folder per jacket; always listed (empty when nothing was dropped in yet). */
export const EXPECTED_FOLDERS = ['FB7675-100-parka-trang', 'DQ4920-206-puffer-kem'];

const TYPES = {
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.png': ['image', 'image/png'],
  '.webp': ['image', 'image/webp'],
  '.mp4': ['video', 'video/mp4'],
  '.mov': ['video', 'video/quicktime'],
};
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_DEPTH = 4;
const MAX_FILES_PER_FOLDER = 400;
const MAX_ENTRIES_SCANNED = 5000;

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Scans `root`. Internal result keeps absolute paths; use publicListing() for the client. */
export function scanReferences(root = DEFAULT_ROOT) {
  const names = new Set(EXPECTED_FOLDERS);
  for (const entry of safeReaddir(root))
    if (entry.isDirectory() && !entry.isSymbolicLink() && FOLDER_NAME.test(entry.name))
      names.add(entry.name);
  let scanned = 0;
  const folders = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const files = [];
      const walk = (dir, prefix, depth) => {
        for (const entry of safeReaddir(dir)) {
          if (++scanned > MAX_ENTRIES_SCANNED || files.length >= MAX_FILES_PER_FOLDER) return;
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < MAX_DEPTH) walk(full, `${prefix}${entry.name}/`, depth + 1);
          } else if (entry.isFile()) {
            const type = TYPES[extname(entry.name).toLowerCase()];
            if (!type) continue;
            let bytes;
            try {
              bytes = statSync(full).size;
            } catch {
              continue;
            }
            files.push({
              name: `${prefix}${entry.name}`,
              kind: type[0],
              mime: type[1],
              bytes,
              path: full,
            });
          }
        }
      };
      walk(join(root, name), '', 0);
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { name, files: files.map((file, id) => ({ id, ...file })) };
    });
  return { folders };
}

export function publicListing(scan) {
  return {
    folders: scan.folders.map((folder) => ({
      name: folder.name,
      files: folder.files.map(({ id, name, kind, bytes }) => ({ id, name, kind, bytes })),
    })),
  };
}

const forbidden = (text) =>
  text.includes('..') || text.includes('\\') || text.includes(':') || text.startsWith('/');

/** Looks a requested file up in the scan. Returns the scan's own entry, or null. */
export function resolveReference(scan, query) {
  const { folder, i, name } = query;
  if (typeof folder !== 'string' || forbidden(folder)) return null;
  const entry = scan.folders.find((f) => f.name === folder);
  if (!entry) return null;
  if (typeof i === 'string' && /^\d{1,6}$/.test(i)) return entry.files[Number(i)] ?? null;
  if (typeof name === 'string' && !forbidden(name))
    return entry.files.find((f) => f.name === name) ?? null;
  return null;
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/**
 * Handles /sandbox/refs and /sandbox/ref. Returns true when the request was one of them (and has
 * been answered), false for anything else so the caller continues with its own routing.
 */
export function handleReferenceRequest(req, res, url, root = DEFAULT_ROOT) {
  const path = url.pathname;
  if (path !== '/sandbox/refs' && path !== '/sandbox/ref') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { detail: 'Read only' });
    return true;
  }
  const scan = scanReferences(root);
  if (path === '/sandbox/refs') {
    send(res, 200, publicListing(scan));
    return true;
  }
  const file = resolveReference(scan, {
    folder: url.searchParams.get('folder') ?? undefined,
    i: url.searchParams.get('i') ?? undefined,
    name: url.searchParams.get('name') ?? undefined,
  });
  if (!file) {
    send(res, 404, { detail: 'No such reference file' });
    return true;
  }
  let size;
  try {
    size = statSync(file.path).size;
  } catch {
    send(res, 404, { detail: 'No such reference file' });
    return true;
  }
  let start = 0,
    end = size - 1,
    status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return true;
      }
      status = 206;
    }
  }
  const headers = {
    'Content-Type': file.mime,
    'Content-Length': size === 0 ? 0 : end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) res.end();
  else {
    const stream = createReadStream(file.path, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  return true;
}
