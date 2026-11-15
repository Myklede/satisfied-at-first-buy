// A separate proof pass. Canvas captureStream observes native draws before GL
// clears its buffer; it never re-solves or changes the garment for a screenshot.
export async function recordVisual({ samples, maxSeconds = 90, untilSeconds = null }) {
  const h = window.__arlab,
    video = h.engine.currentSource.video;
  const canvases = { raw: video, ar: h.ar.renderer.domElement, mirror: h.engine.mirrorCanvas };
  const sources = [],
    recorders = [];
  video.pause();
  video.loop = false;
  await new Promise((done) => {
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = 0;
    if (!video.seeking) done();
  });
  h.ar.tracker.resetSmoothing();
  for (const [name, canvas] of Object.entries(canvases)) {
    if (!canvas) continue;
    const original = canvas.captureStream(30);
    const stream = new MediaStream(original.getVideoTracks());
    sources.push(stream);
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: 2500000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((done) => (recorder.onstop = done));
    recorder.start();
    recorders.push({ name, recorder, chunks, stopped });
  }
  const begin = performance.now();
  await video.play();
  while (
    !video.ended &&
    !(untilSeconds !== null && video.currentTime >= untilSeconds) &&
    performance.now() - begin < maxSeconds * 1000
  )
    await new Promise((done) => setTimeout(done, 100));
  video.pause();
  for (const r of recorders) r.recorder.stop();
  await Promise.all(recorders.map((r) => r.stopped));
  for (const s of sources) for (const t of s.getTracks()) t.stop();
  const proofs = [];
  for (const r of recorders) {
    const blob = new Blob(r.chunks, { type: 'video/webm' });
    if (window.__arStockVideo)
      await window.__arStockVideo(r.name, Array.from(new Uint8Array(await blob.arrayBuffer())));
    const decoded = document.createElement('video');
    decoded.muted = true;
    decoded.preload = 'auto';
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((done, reject) => {
        decoded.onloadeddata = done;
        decoded.onerror = () => reject(new Error('Proof stream decode failed'));
        decoded.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = decoded.videoWidth;
      canvas.height = decoded.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (const sample of samples) {
        await new Promise((done) => {
          decoded.addEventListener('seeked', done, { once: true });
          decoded.currentTime = sample.timeMs / 1000;
          if (!decoded.seeking) done();
        });
        ctx.drawImage(decoded, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] || pixels[i + 1] || pixels[i + 2]) lit++;
        const path = await window.__arStockProof({
          key: sample.key,
          kind: sample.kind,
          timeMs: sample.timeMs,
          channel: r.name,
          actualRecordedMs: decoded.currentTime * 1000,
          nonblackPixels: lit,
          image: canvas.toDataURL('image/png'),
        });
        proofs.push({
          ...sample,
          channel: r.name,
          path,
          actualRecordedMs: decoded.currentTime * 1000,
          nonblackPixels: lit,
        });
      }
    } finally {
      decoded.removeAttribute('src');
      decoded.load();
      URL.revokeObjectURL(url);
    }
  }
  return {
    complete: video.ended || (untilSeconds !== null && video.currentTime >= untilSeconds),
    seconds: (performance.now() - begin) / 1000,
    proofs,
    method:
      'Separate native raw/AR/mirror MediaStreams recorded as VP8; independent first-frame timestamps may differ. Decoded at recording elapsed times, not used to measure latency or fps. All pixels private. Zero-lit images are invalid evidence.',
  };
}
export function proofSamples(segments, qualified = []) {
  const samples = segments.map((s, i) => ({
    key: `segment-${i}`,
    kind: s.name,
    timeMs: (s.startMs + s.endMs) / 2,
  }));
  const still = qualified.find((w) => w.qualified) ?? segments.find((s) => s.name === 'still');
  if (still) {
    const start = Math.max(500, still.startMs),
      end = Math.min(still.endMs - 100, start + 3000);
    for (let i = 0; i < 12; i++)
      samples.push({
        key: `still-${String(i).padStart(2, '0')}`,
        kind: 'still-strip',
        timeMs: start + ((end - start) * i) / 11,
      });
  }
  return samples;
}
