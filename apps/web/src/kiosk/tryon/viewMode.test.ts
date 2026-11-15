import { expect, it } from 'vitest';
import { EMPTY_STATE } from './presentation';
import { viewBasis } from './viewMode';

it('distinguishes live preview, recorded preview and actual physics basis', () => {
  expect(viewBasis({ ...EMPTY_STATE, phase: 'tracking' })).toBe('Preview (live)');
  expect(viewBasis({ ...EMPTY_STATE, phase: 'playback' })).toBe('Preview (recorded move)');
  expect(
    viewBasis({
      ...EMPTY_STATE,
      phase: 'playback',
      zones: [{ zone: 'hem', basis: 'physics', status: 'unknown', valueCm: null }],
    }),
  ).toBe('Physics (recorded move)');
  expect(
    viewBasis({
      ...EMPTY_STATE,
      phase: 'tracking',
      zones: [{ zone: 'hem', basis: 'physics', status: 'unknown', valueCm: null }],
    }),
  ).toBe('Preview (live)');
});

it('?arfull=1 opens in full-screen AR, keeps the stored choice, toggles Full AR and Split', async () => {
  const { arFullEnabled, initialView, toggledView, toggleLabel } = await import('./viewMode');
  expect(arFullEnabled('')).toBe(false);
  expect(arFullEnabled('?arfull=1&x=2')).toBe(true);
  expect(initialView('', 'ar-full')).toBe('split'); // no flag: unchanged default
  expect(initialView('?arfull=1', null)).toBe('ar-full');
  expect(initialView('?arfull=1', 'split')).toBe('split');
  expect(initialView('?arfull=1', 'bogus')).toBe('ar-full');
  expect(toggledView('ar-full')).toBe('split');
  expect(toggledView('split')).toBe('ar-full');
  expect(toggledView('ar-focus')).toBe('ar-full');
  expect(toggleLabel('ar-full')).toMatch(/mirror/);
  expect(toggleLabel('split')).toMatch(/full-screen AR/);
});
