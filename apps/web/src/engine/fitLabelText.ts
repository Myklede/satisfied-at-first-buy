// Text of the 3D fit labels, kept pure so the kiosk card and the 3D label can be tested to agree.
//
// One source of truth per quantity (docs/STATUS.md "Numbers on screen"):
//   - The PREDICTION is the analytic, tape-based fit engine value (GarmentFitResponse zones:
//     shoulder_offset_cm, sleeve_offset_cm). It is what the size recommendation is based on and
//     what a judge checks with a tape.
//   - The value measured on the DISPLAYED 3D shell (cloth/metrics.ts settledMetrics,
//     metric 'simulated_offset_cm') includes the hand stop and cuff stacking. It is shown only as
//     an explicitly labelled secondary number ("3D drape …"), never as the prediction.

/** Formats an absolute length, e.g. "3.6 in (9.2 cm)". The caller owns the unit choice. */
export type LengthFormat = (cm: number) => string;

/** Default (studio) format: centimetres, one decimal. */
export const centimetres: LengthFormat = (cm) => `${Math.abs(cm).toFixed(1)} cm`;

/**
 * Below this |offset| the seam is described as sitting on the shoulder bone. 0.5 cm is the
 * tape's practical reading resolution over a puffer shell (docs/MEASUREMENTS.md, worn jacket
 * validation); the kiosk reason line uses the same threshold.
 */
export const ON_BONE_CM = 0.5;

export function seamPhrase(cm: number, format: LengthFormat): string {
  if (Math.abs(cm) < ON_BONE_CM) return 'shoulder seam sits right on your shoulder bone';
  return cm > 0
    ? `shoulder seam drops ${format(cm)} past your shoulder bone`
    : `shoulder seam sits ${format(cm)} inside your shoulder bone`;
}

export interface LabelText {
  title: string;
  detail: string | null;
}

/** 3D label for the shoulder seam: prediction first, drawn-shell value as labelled detail. */
export function seamLabel(
  predictedCm: number | null,
  drawnCm: number | null,
  format: LengthFormat,
): LabelText | null {
  if (predictedCm === null) return null;
  const title =
    Math.abs(predictedCm) < ON_BONE_CM
      ? 'Seam on the shoulder bone'
      : `Seam ${predictedCm > 0 ? 'drops' : 'sits inside by'} ${format(predictedCm)}`;
  const detail =
    drawnCm === null
      ? null
      : `3D drape (settled cloth): ${drawnCm >= 0 ? '+' : '−'}${format(drawnCm)}`;
  return { title, detail };
}

/** Cuff text: the sleeve-length prediction, and where the drawn sleeve stacks at the hand. */
export function cuffText(
  predictedCm: number | null,
  drawnCm: number | null,
  format: LengthFormat,
): string | null {
  if (predictedCm === null) return null;
  const main =
    predictedCm >= 0
      ? `sleeve length ${format(predictedCm)} past your wrist`
      : `sleeve ends ${format(predictedCm)} short of your wrist`;
  if (drawnCm === null) return main;
  return `${main} · stacks at the hand to ${drawnCm >= 0 ? '+' : '−'}${format(drawnCm)} on the 3D drape`;
}
