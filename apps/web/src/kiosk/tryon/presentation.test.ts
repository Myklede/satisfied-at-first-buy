import { describe, expect, it } from 'vitest';
import {
  BASIS,
  EMPTY_STATE,
  mockEnabled,
  personPresent,
  physicsPlayback,
  PHASE,
  cm,
} from './presentation';
describe('live screen contract presentation', () => {
  it('maps every phase into one clear state', () => {
    expect(Object.keys(PHASE)).toEqual([
      'idle',
      'starting',
      'calibrating',
      'tracking',
      'lost',
      'recording',
      'baking',
      'playback',
      'error',
    ]);
    for (const model of Object.values(PHASE)) {
      expect(model.title.length).toBeGreaterThan(5);
      expect(model.detail).toBeTruthy();
    }
  });
  it('never enables synthetic results in a normal kiosk', () => {
    for (const search of ['', '?kiosk', '?mock', '?tryonmocked', '?kiosk&mode=tryonmock'])
      expect(mockEnabled(search)).toBe(false);
    expect(mockEnabled('?kiosk&tryonmock')).toBe(true);
  });
  it('keeps data basis explicit and unknown numbers unknown', () => {
    expect(BASIS).toEqual({ 'static-fit': 'Fit', preview: 'Preview', physics: 'Physics' });
    expect(cm(null)).toBe('Not assessed');
    expect(cm(-0.01)).toBe('0.0 cm');
  });
  it('only presence, not a lost-person screen, refreshes the existing idle clock', () => {
    expect(personPresent({ ...EMPTY_STATE, phase: 'tracking', trackingQuality: 0.8 })).toBe(true);
    expect(personPresent({ ...EMPTY_STATE, phase: 'lost', trackingQuality: 0.8 })).toBe(false);
    expect(personPresent({ ...EMPTY_STATE, phase: 'tracking' })).toBe(false);
    expect(personPresent({ ...EMPTY_STATE, phase: 'error', trackingQuality: 1 })).toBe(false);
  });
});

it('never promotes a preview-only replay into physics or enables physics playback controls', () => {
  expect(physicsPlayback({ ...EMPTY_STATE, phase: 'playback' })).toBe(false);
  expect(
    physicsPlayback({
      ...EMPTY_STATE,
      phase: 'playback',
      zones: [{ zone: 'chest', valueCm: 3, status: 'fit', basis: 'preview' }],
    }),
  ).toBe(false);
  expect(
    physicsPlayback({
      ...EMPTY_STATE,
      phase: 'playback',
      zones: [{ zone: 'chest', valueCm: 3, status: 'fit', basis: 'physics' }],
    }),
  ).toBe(true);
  expect(
    physicsPlayback({
      ...EMPTY_STATE,
      phase: 'tracking',
      zones: [{ zone: 'chest', valueCm: 3, status: 'fit', basis: 'physics' }],
    }),
  ).toBe(false);
});
