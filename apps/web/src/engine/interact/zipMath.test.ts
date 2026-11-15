import { describe, expect, it } from 'vitest';
import { INTERACT } from './config';
import { interactHint, interactStatus, NOT_MEASURED } from './interactText';
import {
  approach,
  clampSlider,
  hoodFreeWeight,
  hoodFrontier,
  hoodProgressFromDistance,
  nextHoodState,
  sliderFromCursor,
  snapSlider,
  teethForProgress,
  teethForSlider,
  zipFullyOpen,
  type HoodState,
} from './zipMath';

describe('slider → teeth', () => {
  const arc = [0, 0.1, 0.2, 0.3];
  it('closed at the top, opens the pairs above the slider, all open past the hem', () => {
    const out = new Uint8Array(4);
    expect(teethForSlider(arc, 0, out)).toBe(0);
    expect(Array.from(out)).toEqual([1, 1, 1, 1]);
    expect(teethForSlider(arc, 0.15, out)).toBe(2);
    expect(Array.from(out)).toEqual([0, 0, 1, 1]);
    expect(teethForSlider(arc, 0.3, out)).toBe(3);
    expect(teethForSlider(arc, 0.3 + INTERACT.zipEndM, out)).toBe(4);
    expect(zipFullyOpen(0.3 + INTERACT.zipEndM, 0.3)).toBe(true);
    expect(zipFullyOpen(0.3, 0.3)).toBe(false);
  });
  it('hood frontier follows H’s peel (front = p (1 + w), half-lifted at front - w / 2)', () => {
    const w = INTERACT.hoodPeelWidth;
    expect(hoodFrontier(0, 1)).toBe(0);
    expect(hoodFrontier(0.5, 1)).toBeCloseTo(0.5 * (1 + w) - w / 2, 12);
    expect(hoodFrontier(1, 1)).toBe(Infinity);
    expect(hoodFreeWeight(0.5)).toBe(0);
    expect(hoodFreeWeight(1)).toBe(1);
  });
  it('hood progress opens a fraction of the line; 1 opens every pair', () => {
    const out = new Uint8Array(4);
    expect(teethForProgress(arc, 0.3, 0, out)).toBe(0);
    expect(teethForProgress(arc, 0.3, 0.5, out)).toBe(2);
    expect(teethForProgress(arc, 0.3, 1, out)).toBe(4);
  });
  it('snaps a let-go slider near either stop to the stop', () => {
    expect(snapSlider(0.01, 0.6)).toBe(0);
    expect(snapSlider(0.3, 0.6)).toBe(0.3);
    expect(snapSlider(0.59, 0.6)).toBe(0.6 + INTERACT.zipEndM);
  });
  it('clamps and rate-limits the slider', () => {
    expect(clampSlider(-1, 0.3)).toBe(0);
    expect(clampSlider(5, 0.3)).toBe(0.3 + INTERACT.zipEndM);
    expect(approach(0, 1, 0.02)).toBe(0.02);
    expect(approach(0.5, 0.49, 0.02)).toBe(0.49);
    expect(approach(1, 0, 0.25)).toBe(0.75);
  });
});

describe('cursor → slider on the projected zip track', () => {
  // A vertical zip on screen: pairs every 100 px from y = 100 (top) to 400 (hem), x = 500.
  const track = [500, 100, 500, 200, 500, 300, 500, 400],
    arc = [0, 0.1, 0.2, 0.3];
  it('projects the cursor on the nearest segment', () => {
    expect(sliderFromCursor(track, arc, { x: 510, y: 250 }, 0.1, 1)).toBeCloseTo(0.15, 12);
    expect(sliderFromCursor(track, arc, { x: 480, y: 100 }, 0.1, 1)).toBeCloseTo(0, 12);
  });
  it('a drag above the collar end closes the zip, even when the collar folds on screen', () => {
    expect(sliderFromCursor(track, arc, { x: 500, y: 60 }, 0.08, 0.25)).toBe(0);
    // Folded collar: the first pair projects below the second; the zip's highest screen point is
    // pair 1. A cursor above it closes; a cursor at the first pair does not jump to "closed".
    const folded = [500, 140, 500, 100, 500, 200, 500, 400];
    expect(sliderFromCursor(folded, arc, { x: 500, y: 70 }, 0.1, 0.25)).toBe(0);
    expect(sliderFromCursor(folded, arc, { x: 500, y: 300 }, 0.1, 0.25)).toBeGreaterThan(0.15);
  });
  it('a drag below the hem end opens through the hem', () => {
    expect(sliderFromCursor(track, arc, { x: 500, y: 460 }, 0.28, 1)).toBeCloseTo(
      0.3 + INTERACT.zipEndM,
      12,
    );
  });
  it('never jumps outside the window round the current slider', () => {
    // Cursor at the hem but the slider at the top with a 0.1 m window: stays within reach.
    const s = sliderFromCursor(track, arc, { x: 500, y: 400 }, 0, 0.1);
    expect(s).toBeLessThanOrEqual(0.2 + 1e-12);
  });
});

describe('hood state machine', () => {
  it('maps hand distance to unzip progress with slack', () => {
    expect(hoodProgressFromDistance(0)).toBe(0);
    expect(hoodProgressFromDistance(INTERACT.hoodSlackM)).toBe(0);
    expect(hoodProgressFromDistance(INTERACT.hoodSlackM + INTERACT.hoodTravelM / 2)).toBeCloseTo(
      0.5,
      12,
    );
    expect(hoodProgressFromDistance(1)).toBe(1);
  });
  it('detach, release (hooked), bring back, re-attach', () => {
    let s: HoodState = 'attached';
    s = nextHoodState(s, 0, true);
    expect(s).toBe('attached');
    s = nextHoodState(s, 0.3, true);
    expect(s).toBe('detaching');
    s = nextHoodState(s, 0.2, false); // let go half way: still detaching (hangs)
    expect(s).toBe('detaching');
    s = nextHoodState(s, 1, true);
    expect(s).toBe('detached');
    s = nextHoodState(s, 1, false);
    expect(s).toBe('detached');
    s = nextHoodState(s, 0.6, true);
    expect(s).toBe('attaching');
    s = nextHoodState(s, 1, true);
    expect(s).toBe('detached');
    s = nextHoodState(s, 0.4, true);
    expect(s).toBe('attaching');
    s = nextHoodState(s, 0, true);
    expect(s).toBe('attached');
  });
  it('a partly unzipped hood let go at 0 is attached again', () => {
    expect(nextHoodState('detaching', 0, false)).toBe('attached');
    expect(nextHoodState('detaching', 0, true)).toBe('detaching');
  });
});

describe('interaction texts', () => {
  const base = {
    ready: true,
    hasHood: true,
    zipOpen: 0,
    hood: 'attached' as HoodState,
    hooked: false,
    open: false,
    hover: null,
    dragging: null,
    error: null,
    hoodView: false,
    hoodProgress: 0,
  };
  it('says "open, not measured" whenever the opened jacket is shown', () => {
    expect(interactStatus(base)).toBe('Zip closed · hood on');
    expect(interactStatus({ ...base, zipOpen: 0.5, open: true })).toBe(
      `Zip 50 % open · hood on · ${NOT_MEASURED}`,
    );
    expect(
      interactStatus({ ...base, zipOpen: 1, open: true, hood: 'detached', hooked: true }),
    ).toContain('hood off');
    expect(interactHint({ ...base, hood: 'detached', open: true })).toBe(
      'Hood off · drag it back to the collar to zip it on',
    );
    expect(interactStatus({ ...base, ready: false })).toMatch(/ready/);
  });
  it('hints the next action', () => {
    expect(interactHint(base)).toMatch(/zip pull/);
    expect(interactHint({ ...base, dragging: 'pull' })).toMatch(/down opens/);
    expect(interactHint({ ...base, dragging: 'hood', hood: 'detached' })).toMatch(
      /back to the collar/,
    );
    expect(interactHint({ ...base, hasHood: false })).not.toMatch(/hood/);
  });
});
