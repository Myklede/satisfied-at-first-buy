// Browser function: repeat identical decoded pixels through a local canvas stream.
// Encoded clip is a private reproduction aid; measurements bypass its codec entirely.
export async function frozenRuler({ warmupMs = 2500, measureMs = 4000, proofFrames = 12 } = {}) {
  const { engine, ar } = window.__arlab;
  const video = engine.currentSource.video;
  video.pause();
  await new Promise((done) => {
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = 2;
  });
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  window.__arFrozenCanvas = canvas;
  const stillPixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(30);
  const track = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((done) => (recorder.onstop = done));
  recorder.start();
  const started = performance.now();
  while (performance.now() - started < 3000) {
    canvas.getContext('2d').putImageData(stillPixels, 0, 0);
    track.requestFrame();
    await new Promise((done) => setTimeout(done, 1000 / 30));
  }
  recorder.stop();
  await stopped;
  track.stop();
  const blob = new Blob(chunks, { type: 'video/webm' });
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await window.__arFrozenClip(bytes);
  const liveStream = canvas.captureStream(30);
  const repeat = setInterval(
    () => canvas.getContext('2d').putImageData(stillPixels, 0, 0),
    1000 / 30,
  );
  video.removeAttribute('src');
  video.srcObject = liveStream;
  await video.play();
  const cases = [];
  const associations = new WeakMap();
  const off = engine.currentSource.onFrame((frame) =>
    associations.set(frame, { ...video.__arCameraFrame }),
  );
  try {
    for (const finish of [false, true])
      for (const still of [false, true]) {
        video.pause();
        window.__frozenCase = {
          finish,
          still,
          duration: video.duration,
          readyState: video.readyState,
        };
        ar.useFinisher = finish;
        ar.stillnessOn = still;
        engine.stillOn = still;
        ar.stillness.reset?.();
        ar.fallbackStillness?.reset();
        engine.sharedStillness?.reset();
        engine.stillness?.reset();
        ar.tracker.resetSmoothing();
        let last = engine.lastFrame,
          previous = null,
          previousArLayer = null,
          previousIndex = null;
        const frames = [];
        let previousLayerState = null;
        const proofPaths = [];
        let firstMediaMs = null;
        const begin = performance.now();
        await video.play();
        await new Promise((done) => setTimeout(done, warmupMs));
        const sampleStart = performance.now();
        await new Promise((done, reject) => {
          const tick = async () => {
            try {
              if (performance.now() - sampleStart >= measureMs) return done();
              const frame = engine.lastFrame;
              if (frame && frame !== last && engine.posedScene) {
                last = frame;
                const camera = associations.get(frame);
                if (camera) firstMediaMs ??= camera.mediaMs;
                const dbg = ar.debugState();
                const av = engine.posedScene;
                const layerState = {
                  jacket: Float32Array.from(av.jacketPositions()),
                  body: Float32Array.from(av.bodyArrays().positions),
                  glue: Object.fromEntries(
                    Object.entries(ar.glueRenderer?.warped ?? {}).map(([k, v]) => [k, [...v.at]]),
                  ),
                };
                let layer = null,
                  arLayer = null;
                if (ar.status === 'drawn' && dbg.fade < 0.01 && !dbg.backView) {
                  // Read the native pipeline's completed frame; never render an extra frame.
                  const mask = ar.glueMask();
                  if (mask) {
                    const alphas = new Uint8Array(mask.width * mask.height * 4);
                    for (let i = 0; i < mask.data.length; i++) alphas[4 * i + 2] = mask.data[i];
                    arLayer = {
                      width: mask.width,
                      height: mask.height,
                      scale: 1,
                      alphas,
                      colour: new Uint8Array(alphas.length),
                    };
                  }
                  layer = finish ? ar.finisher?.measureLayers(ar.renderer) : arLayer;
                }
                const prePair =
                  arLayer && previousArLayer ? window.__arRestPair(previousArLayer, arLayer) : null;
                const pair = layer && previous ? window.__arRestPair(previous, layer) : null;
                if (pair)
                  pair.cameraFrameDelta =
                    camera?.index > previousIndex ? camera.index - previousIndex : null;
                const gap = camera?.index > previousIndex ? camera.index - previousIndex : null;
                const motion =
                  previousLayerState && window.__arLayerPair
                    ? window.__arLayerPair(previousLayerState, layerState, gap)
                    : null;
                if (motion)
                  motion.arBeforeFinisherPxPerCameraFrame =
                    gap > 0 && Number.isFinite(prePair?.outlinePx) ? prePair.outlinePx / gap : null;
                if (motion && finish)
                  motion.finisherEdgePxPerCameraFrame =
                    gap > 0 && Number.isFinite(pair?.outlinePx) ? pair.outlinePx / gap : null;
                const grade =
                  finish && ar.finisher
                    ? {
                        exposure: ar.finisher.match.exposure,
                        gain: [...ar.finisher.match.gain],
                        lift: ar.finisher.match.lift,
                      }
                    : null;
                frames.push({
                  videoMs: camera ? camera.mediaMs - firstMediaMs : performance.now() - begin,
                  cameraFrameIndex: camera?.index ?? null,
                  t: frame.t,
                  status: ar.status,
                  fade: dbg.fade,
                  backView: dbg.backView,
                  depthDrawn: ar.drawnSolution?.pose.t[2] ?? null,
                  drawnRotationDeg: ar.drawnSolution
                    ? ['yaw', 'pitch', 'roll'].map(
                        (k) => (ar.drawnSolution.pose[k] * 180) / Math.PI,
                      )
                    : null,
                  lm: frame.landmarks2d?.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility })),
                  restMeasurements: [{ id: 'frozen', pair }],
                  layers: motion,
                  grade,
                  lockEngaged: dbg.stillness?.engaged ?? null,
                });
                previousArLayer = arLayer;
                previousLayerState = layerState;
                previous = layer;
                previousIndex = camera?.index;
              }
              requestAnimationFrame(tick);
            } catch (error) {
              reject(error);
            }
          };
          tick();
        });
        const measuredMs = performance.now() - sampleStart;
        // Native screenshots run AFTER the numeric pass: their stalls cannot hide jitter.
        for (let proofCount = 0; proofCount < proofFrames; proofCount++) {
          await new Promise((done) => setTimeout(done, 200));
          const camera = video.__arCameraFrame;
          if (window.__arFrozenProof)
            proofPaths.push(
              await window.__arFrozenProof({
                finish,
                still,
                index: proofCount,
                cameraFrame: camera?.index ?? null,
                videoMs: camera?.mediaMs ?? null,
              }),
            );
        }
        video.pause();
        cases.push({
          finish,
          still,
          frames,
          complete:
            measuredMs >= measureMs && proofPaths.length === proofFrames && frames.length >= 5,
          proofPaths,
          warmupMs,
          measuredMs,
          wallMs: performance.now() - begin,
        });
      }
  } finally {
    off();
    video.pause();
    clearInterval(repeat);
    for (const t of liveStream.getTracks()) t.stop();
    video.srcObject = null;
  }
  return {
    bytes,
    cases,
    method:
      'Decoded cam-parka frame at2.000s; the identical RGBA buffer is repeated via canvas.captureStream(30) for>=3s after warm-up per case, no encoder/decoder in measured input. Private VP8 clip is reproduction only. AR stillnessOn controls the shared detector when wired; legacy layers remain as configured. Detector/filter state reset between cases; finisher state warms in fixed OFF/OFF,OFF/ON,ON/OFF,ON/ON order. Native pipeline frames are read back without extra render calls;12 native screenshots are a separate post-metric pass, fps is not a kiosk benchmark.',
  };
}
