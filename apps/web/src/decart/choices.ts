// Pure choice helpers and presets for the Decart V-TON trial page.

export const PROMPT_PRESETS = {
  replace: 'Replace the top with the jacket in the image.',
  polish:
    'Make the jacket photorealistic. Keep its exact shape, size, length and zipper position; ' +
    'do not change the fit.',
} as const;

export type ZipState = 'closed' | 'half' | 'open';

export interface CameraLike {
  deviceId: string;
  label: string;
}

/** Default camera: the first whose label contains "Camo" (iPhone as webcam), else the first one. */
export function pickDefaultCamera(cameras: readonly CameraLike[]): string | null {
  const camo = cameras.find((c) => /camo/i.test(c.label));
  return (camo ?? cameras[0])?.deviceId ?? null;
}

const VARIANT = /^(.+)-(closed|half|open)\.(png|jpe?g|webp)$/i;

/** Reference images follow `<jacket>-<closed|half|open>.<ext>`; returns the file for the
 *  requested zip state of the currently selected jacket, or null when there is none. */
export function variantName(
  files: readonly string[],
  selected: string,
  zip: ZipState,
): string | null {
  const m = VARIANT.exec(selected);
  if (!m) return null;
  const prefix = `${m[1]}-${zip}.`.toLowerCase();
  return files.find((f) => f.toLowerCase().startsWith(prefix) && VARIANT.test(f)) ?? null;
}
