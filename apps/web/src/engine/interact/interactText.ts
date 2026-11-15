// Texts of the interactive zip and hood (agent Z): short, readable from an arm's length.
// Pure (unit tested); the Feel screen shows them.
import type { InteractUiState } from './InteractController';

/** Shown in place of any fit number while the jacket on screen is opened. */
export const NOT_MEASURED = 'open, not measured';

/** One status line for the zip and the hood. */
export function interactStatus(s: InteractUiState | undefined): string {
  if (s?.error) return 'Zip and hood unavailable on this jacket';
  if (!s?.ready) return 'Getting the zip ready…';
  const parts: string[] = [];
  const pct = Math.round(s.zipOpen * 100);
  parts.push(pct <= 0 ? 'Zip closed' : pct >= 100 ? 'Zip open to the hem' : `Zip ${pct} % open`);
  if (s.hasHood && s.hood) {
    parts.push(
      s.hood === 'attached'
        ? 'hood on'
        : s.hood === 'detached'
          ? 'hood off'
          : s.hood === 'detaching'
            ? 'hood unzipping'
            : 'hood zipping on',
    );
  }
  if (s.open) parts.push(NOT_MEASURED);
  return parts.join(' · ');
}

/** What the judge can do next (hint under the status). */
export function interactHint(s: InteractUiState | undefined): string {
  if (s?.error) return s.error;
  if (!s?.ready) return '';
  if (s.dragging === 'pull') return 'Drag along the zip: down opens, up closes';
  if (s.dragging === 'hood')
    return s.hood === 'detached' || s.hood === 'attaching'
      ? 'Bring the hood back to the collar to zip it on'
      : 'Pull the hood away to unzip it from the collar';
  if (s.dragging === 'fabric') return 'Let go and the front falls back under its own weight';
  if (s.hover === 'pull') return 'Grab the zip pull';
  if (s.hover === 'hood') return 'Grab the hood';
  if (s.hood === 'detached') return 'Hood off · drag it back to the collar to zip it on';
  if (s.zipOpen > 0)
    return 'Drag the zip pull up to close it · or grab the open front and pull it aside';
  const zip = 'Grab the zip pull and drag it down to open the jacket';
  if (s.hasHood) return `${zip} · or grab the hood (Hood view)`;
  return zip;
}
