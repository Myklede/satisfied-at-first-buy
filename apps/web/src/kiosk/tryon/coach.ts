import type { LiveTryOnState } from '../../engine/live/contract';

/** Prompt16a UX hold time; this is presentation hysteresis, not a tracking calibration. */
export const COACH_HOLD_MS = 1500;
export interface CoachAdvice {
  prompt: string | null;
  fadeAr: boolean;
}
const NONE: CoachAdvice = { prompt: null, fadeAr: false };

/**
 * ?f1close=1 (user U2 19:00, close-range mode with F1): the try-on works from head and shoulders,
 * so no "step back" coaching and no AR fade for hips, hands or alignment; only when nobody is
 * seen, or a SHOULDER is cut by the frame (the engine's message says so), is the person coached.
 */
export const closeRangeEnabled = (search: string) =>
  new URLSearchParams(search).get('f1close') === '1';

function closeRangeCandidate(state: LiveTryOnState, message: string): CoachAdvice {
  if (/more light|too dark|dim room|poor lighting|low light|insufficient light/.test(message))
    return { prompt: 'More light on you helps', fadeAr: false };
  if (/face the camera|back view|side-on|turn back toward/.test(message))
    return { prompt: 'Face the camera', fadeAr: false };
  if (state.phase === 'lost')
    return { prompt: 'Step into view: head and shoulders are enough', fadeAr: true };
  if (/shoulder/.test(message) && /step back|out of (?:range|view)|cut|frame/.test(message))
    return { prompt: 'Step back a little so both shoulders are in view', fadeAr: false };
  if (state.phase === 'calibrating') return { prompt: 'Hold still a moment', fadeAr: false };
  return NONE;
}

/** Only public state. Low tracking quality alone does not diagnose lighting or camera distance. */
export function coachCandidate(state: LiveTryOnState, closeRange = false): CoachAdvice {
  if (['idle', 'starting', 'error', 'baking', 'playback'].includes(state.phase)) return NONE;
  const message = state.message.toLowerCase();
  if (closeRange) return closeRangeCandidate(state, message);
  const outOfRange =
    state.phase === 'lost' ||
    /out of (?:range|view)|step (?:back|into view)|head.to.hips/.test(message) ||
    (state.phase === 'tracking' && state.arAlignment === 0);
  if (/more light|too dark|dim room|poor lighting|low light|insufficient light/.test(message))
    return { prompt: 'More light on you helps', fadeAr: outOfRange };
  if (/face the camera|back view|side-on|turn back toward/.test(message))
    return { prompt: 'Face the camera', fadeAr: outOfRange };
  if (outOfRange) return { prompt: 'Step back until your head-to-hips is in view', fadeAr: true };
  if (state.phase === 'calibrating') return { prompt: 'Hold still a moment', fadeAr: false };
  return NONE;
}

export class ArCoach {
  constructor(private readonly closeRange = false) {}
  private shown: CoachAdvice = NONE;
  private pending: CoachAdvice = NONE;
  private since = 0;

  update(state: LiveTryOnState, nowMs: number): CoachAdvice {
    const next = coachCandidate(state, this.closeRange);
    if (next.prompt !== this.pending.prompt || next.fadeAr !== this.pending.fadeAr) {
      this.pending = next;
      this.since = nowMs;
    }
    if (
      nowMs - this.since >= COACH_HOLD_MS &&
      (this.shown.prompt !== next.prompt || this.shown.fadeAr !== next.fadeAr)
    )
      this.shown = next;
    return this.shown;
  }
}
