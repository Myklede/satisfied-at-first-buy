import type { LiveBasis, LivePhase, LiveTryOnState } from '../../engine/live/contract';

export const BASIS: Record<LiveBasis, string> = {
  'static-fit': 'Fit',
  preview: 'Preview',
  physics: 'Physics',
};
export const PHASE: Record<LivePhase, { title: string; detail: string }> = {
  idle: { title: 'Ready when you are', detail: 'Choose a jacket, then start your camera.' },
  starting: {
    title: 'Opening your camera',
    detail: 'Allow camera access. Your image stays on this laptop.',
  },
  calibrating: {
    title: 'Stand straight, arms relaxed',
    detail: 'Keep your head and hips in view, about an arm and a half away.',
  },
  tracking: {
    title: 'Move naturally',
    detail: 'Live skinned preview. Record a move to compute real cloth physics.',
  },
  lost: { title: 'Step back into view', detail: 'Keep your head and hips inside the guide.' },
  recording: {
    title: 'Make your move',
    detail: 'Move your arms: reach up, cross your arms, then relax.',
  },
  baking: {
    title: 'Computing real cloth physics on your body',
    detail: 'Estimate: about 10-15 s; may take longer. Actual progress is shown below.',
  },
  playback: {
    title: 'Your move, with physics',
    detail: 'Hem exposure and sleeve ride-up come from the cloth bake.',
  },
  error: {
    title: 'Let us try again',
    detail: 'Check camera access, then retry or return to your sizes.',
  },
};
/** ?f1close=1: the phase texts ask for head and shoulders, never head to hips. */
export const CLOSE_RANGE_PHASE: Partial<Record<LivePhase, { title: string; detail: string }>> = {
  calibrating: {
    title: 'Stand straight, arms relaxed',
    detail: 'Head and shoulders in view is enough; come as close as you like.',
  },
  lost: { title: 'Step into view', detail: 'Head and shoulders in view is enough.' },
};
export const EMPTY_STATE: LiveTryOnState = {
  phase: 'starting',
  message: '',
  trackingQuality: 0,
  arAlignment: null,
  zones: [],
  progress: null,
  exposureCm: null,
  sleeveRideUpCm: null,
};
export const mockEnabled = (search: string) => new URLSearchParams(search).has('tryonmock');
export const personPresent = (s: LiveTryOnState) =>
  ['tracking', 'calibrating', 'recording'].includes(s.phase) && s.trackingQuality > 0;
export const cm = (n: number | null) =>
  n === null || !Number.isFinite(n)
    ? 'Not assessed'
    : `${Object.is(Number(n.toFixed(1)), -0) ? '0.0' : n.toFixed(1)} cm`;

export const physicsPlayback = (state: LiveTryOnState) =>
  state.phase === 'playback' &&
  (state.zones.some((z) => z.basis === 'physics') ||
    state.exposureCm !== null ||
    state.sleeveRideUpCm !== null);
