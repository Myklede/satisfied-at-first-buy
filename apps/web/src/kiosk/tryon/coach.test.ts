import { expect, it } from 'vitest';
import { ArCoach, coachCandidate } from './coach';
import { EMPTY_STATE } from './presentation';
import type { LiveTryOnState } from '../../engine/live/contract';

const state = (change: Partial<LiveTryOnState>): LiveTryOnState => ({
  ...EMPTY_STATE,
  phase: 'tracking',
  trackingQuality: 0.9,
  arAlignment: 0.9,
  ...change,
});
it('holds each candidate at least 1.5s and rejects transient state flashes', () => {
  const coach = new ArCoach();
  const lost = state({ phase: 'lost' });
  expect(coach.update(lost, 0).prompt).toBeNull();
  expect(coach.update(lost, 1499).fadeAr).toBe(false);
  const framing = coach.update(lost, 1500);
  expect(framing.prompt).toBe('Step back until your head-to-hips is in view');
  expect(framing.fadeAr).toBe(true);
  coach.update(state({ message: 'Face the camera' }), 1600);
  expect(coach.update(lost, 2000)).toBe(framing);
  expect(coach.update(state({}), 2100)).toBe(framing);
  expect(coach.update(state({}), 3599)).toBe(framing);
  expect(coach.update(state({}), 3600)).toEqual({ prompt: null, fadeAr: false });
});
it('uses explicit public messages for facing/light instead of inferring their cause', () => {
  expect(coachCandidate(state({ trackingQuality: 0.1 })).prompt).toBeNull();
  expect(
    coachCandidate(state({ message: 'Tracking slightly unstable; lighting is good' })).prompt,
  ).toBeNull();
  expect(coachCandidate(state({ message: 'Frontal view tracked' })).prompt).toBeNull();
  expect(coachCandidate(state({ message: 'More light needed' })).prompt).toBe(
    'More light on you helps',
  );
  expect(coachCandidate(state({ message: 'Back view: face the camera' })).prompt).toBe(
    'Face the camera',
  );
  expect(coachCandidate(state({ phase: 'calibrating' })).prompt).toBe('Hold still a moment');
});
it('fades only for explicit loss/out-of-range/zero alignment and leaves physics playback alone', () => {
  expect(coachCandidate(state({ arAlignment: null })).fadeAr).toBe(false);
  expect(coachCandidate(state({ arAlignment: 0 })).fadeAr).toBe(true);
  expect(coachCandidate(state({ message: 'Out of range' })).fadeAr).toBe(true);
  expect(coachCandidate(state({ phase: 'calibrating', message: 'Step into view' })).fadeAr).toBe(
    true,
  );
  expect(coachCandidate(state({ phase: 'playback', arAlignment: 0 })).fadeAr).toBe(false);
});
it('close range (?f1close=1): no head-to-hips coaching or AR fade; only lost / shoulders cut', () => {
  const close = (s: Partial<LiveTryOnState>) => coachCandidate(state(s), true);
  expect(close({ message: 'Step back a little so your hands stay in view' })).toEqual({
    prompt: null,
    fadeAr: false,
  });
  expect(close({ arAlignment: 0 })).toEqual({ prompt: null, fadeAr: false });
  expect(close({ message: 'Step into view: head to hips in the frame' }).fadeAr).toBe(false);
  expect(close({ phase: 'lost' })).toEqual({
    prompt: 'Step into view: head and shoulders are enough',
    fadeAr: true,
  });
  expect(close({ message: 'Step back: a shoulder is out of the frame' })).toEqual({
    prompt: 'Step back a little so both shoulders are in view',
    fadeAr: false,
  });
  // The default kiosk keeps its old behaviour.
  expect(coachCandidate(state({ arAlignment: 0 })).fadeAr).toBe(true);
});
