// Explicit browser job, separate from pure tests; run only with a free browser slot.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractVideo, localBrowser, OUTPUT } from './video-frames.mjs';

test('real Chrome decodes synthetic video, seeks different frames and writes a JPEG grid', async () => {
  const browser = await localBrowser();
  try {
    const page = await browser.newPage();
    const encoded = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      const done = new Promise((yes) => {
        recorder.onstop = yes;
      });
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.start();
      for (const colour of ['red', 'lime', 'blue', 'white']) {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 96, 64);
        await new Promise((r) => setTimeout(r, 350));
      }
      // Force an end frame: MediaRecorder's duration ends at the last encoded
      // frame, not at stop(), when a static canvas otherwise stops producing.
      ctx.fillRect(0, 0, 96, 64);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise((r) => setTimeout(r, 150));
      recorder.stop();
      await done;
      stream.getTracks().forEach((track) => track.stop());
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      return Array.from(bytes);
    });
    await page.close();
    mkdirSync(OUTPUT, { recursive: true });
    const dir = mkdtempSync(join(OUTPUT, 'synthetic-browser-'));
    const path = join(dir, 'synthetic.webm');
    writeFileSync(path, Buffer.from(encoded));
    const { output, index } = await extractVideo(browser, path, {
      at: [0, 0.5, 0.85, 1.2],
      contactSheet: true,
    });
    assert.equal(index.frames.length, 4);
    assert.equal(index.non_file_requests, 0);
    assert.equal(index.width, 96);
    assert.equal(index.height, 64);
    for (const frame of index.frames) {
      assert.ok(Math.abs(frame.current_time_seconds - frame.requested_seconds) < 0.001);
      if (frame.decoded_media_seconds !== null)
        assert.ok(Math.abs(frame.decoded_media_seconds - frame.requested_seconds) < 0.2);
      assert.equal(readFileSync(join(output, frame.file)).subarray(1, 4).toString(), 'PNG');
    }
    const hashes = index.frames.map((frame) =>
      readFileSync(join(output, frame.file)).toString('base64'),
    );
    assert.equal(new Set(hashes).size, 4, 'seek must decode distinct coloured frames');
    assert.equal(
      readFileSync(join(output, 'contact-sheet.jpg')).subarray(0, 2).toString('hex'),
      'ffd8',
    );
    assert.equal(JSON.parse(readFileSync(join(output, 'index.json'))).frames.length, 4);
    console.log(`Synthetic-only evidence: ${output}`);
  } finally {
    await browser.close();
  }
});
