// Capture v1 times are video-relative milliseconds; never use browser-wall time for labels.
import { summarise, scoreboard } from './ar-eval-lib.mjs';

export function captureSteps(manifest) {
  if (
    (manifest?.format ?? manifest?.schema) !== 'satisfy-capture' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.steps)
  )
    throw new Error('Expected satisfy-capture v1 manifest with steps');
  let end = 0;
  return manifest.steps.map((s) => {
    if (
      typeof s.name !== 'string' ||
      !s.name.trim() ||
      s.name.length > 160 ||
      !Number.isFinite(s.startMs) ||
      !Number.isFinite(s.endMs) ||
      s.startMs < end ||
      s.endMs <= s.startMs
    )
      throw new Error(
        'Capture steps require nonoverlapping ordered finite startMs/endMs and a name',
      );
    end = s.endMs;
    // A turn-around routine contains transitions: only an explicitly labelled back hold can
    // certify back handling. Otherwise report the whole step without pretending it is a hold.
    const expectedBack = /^(back|back[-_ ]view|back[-_ ]hold)$/i.test(s.name.trim());
    return { name: s.name, startMs: s.startMs, endMs: s.endMs, expectedBack };
  });
}

export function perStep(frames, steps) {
  return steps.map((step) => {
    const selected = frames
      .filter((f) => f.videoMs >= step.startMs && f.videoMs < step.endMs)
      .map((f) => ({ ...f, expectedBack: step.expectedBack }));
    const summary = summarise(selected);
    return {
      ...step,
      observedFrames: selected.length,
      summary,
      scoreboard: scoreboard(summary),
      // Pose-solve residual, independently reported alongside drawn keypoint residual.
      alignment: {
        ...summary.quality.alignmentRmsPx,
        target: '< 5 px (same alignment policy as V5 keypoints)',
        pass:
          summary.quality.alignmentRmsPx.samples >= 30 &&
          summary.quality.alignmentRmsPx.p50 !== null
            ? summary.quality.alignmentRmsPx.p50 < 5
            : null,
      },
      backGroundTruth: step.expectedBack
        ? 'operator-labelled back hold'
        : 'not an isolated labelled back hold',
    };
  });
}
