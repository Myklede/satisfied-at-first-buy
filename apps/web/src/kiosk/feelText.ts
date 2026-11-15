// "Feel the fabric" texts (prompts/05): short, readable from an arm's length.
import type { CameraErrorCode } from '@satisfy/vision';
import type { CursorState } from '../engine/hand/mapping';

export const FEEL_TEXT = {
  stepCloser: 'Step closer (about an arm’s length)',
  hint: 'Close your hand on the jacket to grab · open to let go',
  preparing: 'Getting the fabric ready…',
  missed: 'Move your hand over the jacket, then close it',
  resisting: 'That’s as far as this fabric stretches',
} as const;

const CAMERA_REASON: Record<CameraErrorCode, string> = {
  no_camera: 'No camera was found.',
  permission_denied: 'Camera access was blocked.',
  device_busy: 'The camera is busy in another app.',
  resolution_too_low: 'The camera resolution is too low.',
  unknown: 'The camera could not start.',
};

/** Friendly camera failure text (error code only, never frames). */
export function cameraMessage(code: CameraErrorCode) {
  return `${CAMERA_REASON[code] ?? CAMERA_REASON.unknown} You can still turn the 3D jacket — or go back.`;
}

/** The one-line hint under the jacket for the current cursor state. */
export function feelHint(cursor: CursorState | undefined) {
  if (cursor === 'missed') return FEEL_TEXT.missed;
  if (cursor === 'resisting') return FEEL_TEXT.resisting;
  return FEEL_TEXT.hint;
}
