// Supplemental directly visible front exposure: manual edge observations stay private.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, PRIVATE, privateGuard } from './tryon-validate-real.mjs';
import { summary } from './tryon-validate-math.mjs';

export function exposure(observed, pxPerCm, scaleFraction) {
  if (!(pxPerCm > 0) || !(scaleFraction >= 0) || !observed.observations.length)
    throw new Error('Missing scale or observations');
  const gaps = observed.observations.map((s) => {
    if (![s.t, s.hemY, s.waistbandY].every(Number.isFinite) || s.waistbandY < s.hemY)
      throw new Error('Invalid visible edge observation');
    return s.waistbandY - s.hemY;
  });
  const s = summary(gaps),
    valueCm = s.median / pxPerCm;
  const componentsCm = {
    frameSpread: (s.max - s.min) / (2 * pxPerCm),
    scale: valueCm * scaleFraction,
    pixel: (2 * observed.pixelErrorPerEdge) / pxPerCm,
    timestamp: null,
  };
  return {
    jacket: observed.jacket,
    move: observed.move,
    windowSeconds: observed.windowSeconds,
    metric: 'visible front hem-to-top-of-waistband gap, including underlayer and skin',
    valueCm,
    uncertaintyCm: null,
    partialSensitivityCm: componentsCm.frameSpread + componentsCm.scale + componentsCm.pixel,
    componentsCm,
    n: s.n,
    rangeCm: [s.min / pxPerCm, s.max / pxPerCm],
    frameSeconds: observed.observations.map((s) => s.t),
    unavailableTimestampFrames: observed.unavailableTimestampFrames,
    method: observed.method,
    scalePxPerCm: pxPerCm,
    scaleFraction,
    uncertaintyKind:
      'partial additive sensitivity, not a complete uncertainty bound or confidence interval',
    limitations: [
      '+/-1s endpoints hide the waistband; temporal uncertainty is unestablished, not zero',
      'projected image vertical distance; camera depth/plane, posture and true 3D waistband level are uncalibrated',
      'manual edge pixel sensitivity is an operator assumption; no pose estimate used in this supplemental measurement',
    ],
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  privateGuard();
  const obs = JSON.parse(readFileSync(join(PRIVATE, 'exposure-private.json'), 'utf8'));
  const scales = JSON.parse(readFileSync(join(PRIVATE, 'scale-private-series.json'), 'utf8'));
  const pxPerCm = scales.heightPxPerCm.puffer;
  // Sensitivity scenario spanning paper/height disagreement; not a calibrated puffer depth bound.
  const fraction =
    Math.max(...scales.paperRangePxPerCm.map((x) => Math.abs(x - scales.paperMedianPxPerCm))) /
    scales.paperMedianPxPerCm;
  const result = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    status: 'supplemental; full pose/silhouette T1 pending',
    scaleSource:
      'puffer full-height frame 16; local reference height used in memory; paper sensitivity from parka 19-21s',
    observation: exposure(obs, pxPerCm, fraction),
  };
  writeFileSync(
    join(ROOT, 'docs/validation/tryon-real-exposure.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
}
