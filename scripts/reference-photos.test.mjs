// node --test scripts/reference-photos.test.mjs
// The sandbox reference-photo server: listing, lookup by index/name from the listing only,
// traversal rejection, Range support, symlink/dotfile/extension filtering.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EXPECTED_FOLDERS, handleReferenceRequest, scanReferences } from './reference-photos.mjs';

let root, outside, server, base;
const JPEG = Buffer.from('ffd8ffe000104a46494600', 'hex');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'refphotos-'));
  outside = mkdtempSync(join(tmpdir(), 'refsecret-'));
  writeFileSync(join(outside, 'secret.jpg'), 'SECRET');
  const f = join(root, 'FB7675-100-parka-trang');
  mkdirSync(join(f, 'sub', 'deeper'), { recursive: true });
  writeFileSync(join(f, 'b.JPG'), JPEG);
  writeFileSync(join(f, 'a10.png'), 'png-bytes');
  writeFileSync(join(f, 'a2.png'), 'png-bytes-2');
  writeFileSync(join(f, 'notes.txt'), 'not media');
  writeFileSync(join(f, '.hidden.jpg'), 'hidden');
  writeFileSync(join(f, 'sub', 'clip.mp4'), '0123456789');
  writeFileSync(join(f, 'sub', 'deeper', 'w.webp'), 'webp');
  try {
    symlinkSync(join(outside, 'secret.jpg'), join(f, 'link.jpg'));
  } catch {
    /* symlinks need privileges on Windows; the filter is still exercised where possible */
  }
  mkdirSync(join(root, 'bad folder!'));
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!handleReferenceRequest(req, res, url, root)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const get = (path, headers) => fetch(base + path, { headers });

describe('listing', () => {
  it('lists media only, sorted naturally, with subfolders, no hidden files or symlinks', async () => {
    const { folders } = await (await get('/sandbox/refs')).json();
    const names = folders.map((x) => x.name);
    for (const expected of EXPECTED_FOLDERS) assert.ok(names.includes(expected));
    assert.ok(!names.includes('bad folder!'));
    const parka = folders.find((x) => x.name === 'FB7675-100-parka-trang');
    assert.deepEqual(
      parka.files.map((x) => x.name),
      ['a2.png', 'a10.png', 'b.JPG', 'sub/clip.mp4', 'sub/deeper/w.webp'],
    );
    assert.deepEqual(
      parka.files.map((x) => x.kind),
      ['image', 'image', 'image', 'video', 'image'],
    );
    assert.deepEqual(
      parka.files.map((x) => x.id),
      [0, 1, 2, 3, 4],
    );
    assert.ok(!JSON.stringify(parka).includes(root), 'no absolute path leaks to the client');
  });
  it('shows an empty folder for a jacket with no photos yet', async () => {
    const { folders } = await (await get('/sandbox/refs')).json();
    assert.deepEqual(folders.find((x) => x.name === 'DQ4920-206-puffer-kem').files, []);
  });
  it('lists nothing when the data folder does not exist', () => {
    const scan = scanReferences(join(root, 'nope'));
    assert.ok(scan.folders.every((x) => x.files.length === 0));
  });
});

describe('serving', () => {
  it('serves by index and by name with the right type', async () => {
    const a = await get('/sandbox/ref?folder=FB7675-100-parka-trang&i=2');
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await a.arrayBuffer()), JPEG);
    const b = await get(
      '/sandbox/ref?folder=FB7675-100-parka-trang&name=' + encodeURIComponent('sub/clip.mp4'),
    );
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('content-type'), 'video/mp4');
    assert.equal(await b.text(), '0123456789');
  });
  it('supports Range for video and answers 416 when unsatisfiable', async () => {
    const q = '/sandbox/ref?folder=FB7675-100-parka-trang&i=3';
    const r = await get(q, { Range: 'bytes=2-4' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(await r.text(), '234');
    const tail = await get(q, { Range: 'bytes=-3' });
    assert.equal(await tail.text(), '789');
    assert.equal((await get(q, { Range: 'bytes=50-60' })).status, 416);
  });
  it('rejects traversal, absolute paths, unknown folders, bad or out-of-range indexes', async () => {
    const f = 'folder=FB7675-100-parka-trang';
    const bad = [
      '/sandbox/ref?folder=..&i=0',
      '/sandbox/ref?folder=' + encodeURIComponent('../' + outside) + '&i=0',
      `/sandbox/ref?${f}&name=${encodeURIComponent('../../' + 'secret.jpg')}`,
      `/sandbox/ref?${f}&name=${encodeURIComponent(join(outside, 'secret.jpg'))}`,
      `/sandbox/ref?${f}&name=${encodeURIComponent('/etc/passwd')}`,
      `/sandbox/ref?${f}&name=${encodeURIComponent('sub\\clip.mp4')}`,
      `/sandbox/ref?${f}&name=notes.txt`,
      `/sandbox/ref?${f}&name=.hidden.jpg`,
      `/sandbox/ref?${f}&name=link.jpg`,
      `/sandbox/ref?${f}&i=99`,
      `/sandbox/ref?${f}&i=-1`,
      `/sandbox/ref?${f}&i=1.5`,
      `/sandbox/ref?${f}&i=0x1`,
      '/sandbox/ref?folder=unknown&i=0',
      '/sandbox/ref?folder=' + encodeURIComponent('bad folder!') + '&i=0',
      `/sandbox/ref?${f}`,
      '/sandbox/ref',
    ];
    for (const path of bad) assert.equal((await get(path)).status, 404, path);
  });
  it('is read only', async () => {
    const r = await fetch(base + '/sandbox/ref?folder=FB7675-100-parka-trang&i=0', {
      method: 'POST',
    });
    assert.equal(r.status, 405);
  });
  it('ignores other routes', async () => {
    assert.equal((await get('/sandbox/other')).status, 404);
  });
});
