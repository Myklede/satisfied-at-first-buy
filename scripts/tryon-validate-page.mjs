// Served only by tryon-validate-real.mjs on loopback. Public vision API only.
import { createPoseTracker } from '../packages/vision/src/index.ts';
import { measureFrame, SETTINGS } from './tryon-validate-math.mjs';

window.measureReference = async (jobs) => {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let callback, mask, raw;
  const camera = {
    video: document.createElement('video'),
    source: canvas,
    onFrame(fn) {
      callback = fn;
      return () => {
        callback = null;
      };
    },
    close() {},
    info() {
      return { width: 720, height: 1280 };
    },
  };
  const tracker = await createPoseTracker(camera, {
    model: 'heavy',
    delegate: 'CPU',
    onSegmentationMask: (m) => {
      mask = m;
    },
  });
  tracker.onRawFrame((f) => {
    raw = f;
  });
  tracker.start();
  const rows = [];
  try {
    let timestamp = 100;
    for (const job of jobs) {
      const img = new Image();
      img.src = `/frame/${job.jacket}/${job.t}`;
      await img.decode();
      ctx.drawImage(img, 0, 0);
      mask = null;
      raw = null;
      callback((timestamp += 1000));
      const landmarks = raw?.image?.map((p) => ({ x: p[0], y: p[1], z: p[2], visibility: p[3] }));
      const row = { ...job, stats: tracker.stats(), landmarks: landmarks ?? null };
      if (mask && landmarks) {
        const m = measureFrame({
          width: 720,
          height: 1280,
          rgba: ctx.getImageData(0, 0, 720, 1280).data,
          person: mask.data,
          maskWidth: mask.width,
          maskHeight: mask.height,
          landmarks,
          jacket: job.jacket,
        });
        row.hem = m.hem;
        row.hip = m.hip;
        row.cuffs = m.cuffs;
        const overlay = ctx.getImageData(0, 0, 720, 1280);
        for (let i = 0; i < m.pixels.length; i++)
          if (m.pixels[i]) {
            overlay.data[i * 4] = Math.round(overlay.data[i * 4] * 0.5);
            overlay.data[i * 4 + 1] = 255;
          }
        ctx.putImageData(overlay, 0, 0);
        for (const p of landmarks) {
          ctx.fillStyle = 'cyan';
          ctx.beginPath();
          ctx.arc(p.x * 720, p.y * 1280, 3, 0, 7);
          ctx.fill();
        }
        for (const p of [m.hem, m.hip, ...m.cuffs.map((c) => c.point)].filter(Boolean)) {
          ctx.strokeStyle = 'red';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 10, 0, 7);
          ctx.stroke();
        }
        ctx.fillStyle = 'red';
        ctx.font = '22px sans-serif';
        ctx.fillText(`${job.jacket} ${job.t}s`, 15, 30);
        await window.savePrivateOverlay({
          jacket: job.jacket,
          t: job.t,
          png: canvas.toDataURL('image/png').split(',')[1],
        });
      } else row.reason = 'no pose/person mask';
      rows.push(row);
      await window.savePrivateRow(row);
    }
    return { rows, stats: tracker.stats(), settings: SETTINGS };
  } finally {
    tracker.close();
  }
};
