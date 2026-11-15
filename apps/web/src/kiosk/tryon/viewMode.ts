import type { LiveTryOnState } from '../../engine/live/contract';
import { physicsPlayback } from './presentation';

export const VIEW_MODES = [
  { value: 'split', label: 'Split', accessible: 'Split view', hint: 'Both views and fit readouts' },
  {
    value: 'ar-focus',
    label: 'AR focus',
    accessible: 'AR focus',
    hint: 'Larger camera view with fit readouts',
  },
  {
    value: 'ar-full',
    label: 'Full AR',
    accessible: 'Full-screen AR',
    hint: 'AR fills the view with a mirror inset. Split view restores fit readouts.',
  },
] as const;
export type ViewMode = (typeof VIEW_MODES)[number]['value'];

export function viewBasis(state: LiveTryOnState): string {
  if (physicsPlayback(state)) return 'Physics (recorded move)';
  return state.phase === 'playback' ? 'Preview (recorded move)' : 'Preview (live)';
}

/**
 * ?arfull=1 (user decision 2026-11-14 16:20): the demo opens in full-screen AR (the AR is drawn
 * at about 995 CSS px there vs about 459 in Split) and one clear button switches to Split (the 3D
 * mirror and fit readouts) and back. The choice is kept for the browser session.
 */
export const ARFULL_VIEW_KEY = 'satisfy.tryon.view';

export function arFullEnabled(search: string): boolean {
  return new URLSearchParams(search).get('arfull') === '1';
}

/** The view to open with: Split without the flag; with it the stored choice, else Full AR. */
export function initialView(search: string, stored: string | null): ViewMode {
  if (!arFullEnabled(search)) return 'split';
  return stored === 'split' || stored === 'ar-full' ? stored : 'ar-full';
}

/** The toggle: Full AR ⇄ Split. */
export function toggledView(view: ViewMode): ViewMode {
  return view === 'ar-full' ? 'split' : 'ar-full';
}

/** The toggle button's label for the current view. */
export function toggleLabel(view: ViewMode): string {
  return view === 'ar-full' ? 'Show 3D mirror and fit' : 'Back to full-screen AR';
}
