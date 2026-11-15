// ScanGuidance issues (from @satisfy/vision) → one short instruction readable from 2 m.
import type { ScanGuidance, ScanIssue } from '@satisfy/vision';

// Most blocking first: framing problems make every later check meaningless.
const PRIORITY: Array<[ScanIssue, string, string?]> = [
  ['low_light', 'More light, please — the room is too dark'],
  ['no_person', 'Step into view, 2 metres (6 ft) from the screen'],
  ['multiple_people', 'Only one person in view, please'],
  ['too_close', 'Step back until your whole body is visible'],
  ['not_full_body', 'Step back until your whole body is visible'],
  ['too_far', 'Come a little closer'],
  ['arms_not_apart', 'Face the camera, arms slightly away from your body'],
  ['not_side_on', 'Turn to your left, side-on to the camera'],
  ['moving', 'Hold still'],
  ['loose_clothing_suspected', 'Loose clothing detected — please take your jacket off'],
];

export function guidanceText(guidance: ScanGuidance): string {
  for (const [issue, text] of PRIORITY) if (guidance.issues.includes(issue)) return text;
  if (guidance.stage === 'done') return 'Got it!';
  return guidance.ok
    ? 'Hold still…'
    : guidance.stage === 'side'
      ? 'Turn to your left'
      : 'Face the camera';
}

export const stageTitle = (guidance: ScanGuidance | undefined) =>
  guidance?.stage === 'side' ? 'Step 2 of 2 · side view' : 'Step 1 of 2 · front view';
