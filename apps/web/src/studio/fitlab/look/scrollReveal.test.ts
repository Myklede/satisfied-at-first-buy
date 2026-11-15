import { describe, expect, it } from 'vitest';
import { CT_STAGE, ctPolarStep, easeCt, notchedGoal, splitStage } from './scrollReveal';

describe('CT stage (CS)', () => {
  it('splits the wheel value into reveal then ctPhase', () => {
    expect(splitStage(0.4)).toEqual({ reveal: 0.4, ct: 0 });
    expect(splitStage(1.5)).toEqual({ reveal: 1, ct: 0.5 });
    expect(splitStage(3)).toEqual({ reveal: 1, ct: 1 });
    expect(splitStage(-1)).toEqual({ reveal: 0, ct: 0 });
  });
  it('eases with exact ends', () => {
    expect(easeCt(0)).toBe(0);
    expect(easeCt(1)).toBe(1);
    expect(easeCt(0.5)).toBeCloseTo(0.5);
  });
  it('tilts to the CT polar and back to the base exactly', () => {
    const base = Math.PI / 2;
    let polar = base;
    let p = 0;
    for (const next of [0.2, 0.5, 0.8, 1]) {
      polar = ctPolarStep(polar, base, p, next);
      p = next;
    }
    expect(polar).toBe(CT_STAGE.polar);
    const mid = ctPolarStep(polar, base, 1, 0.5);
    expect(mid).toBeGreaterThan(CT_STAGE.polar);
    expect(mid).toBeLessThan(base);
    expect(ctPolarStep(mid, base, 0.5, 0)).toBe(base);
  });
  it('keeps a drag made inside the CT stage (no jump when the phase does not change)', () => {
    expect(ctPolarStep(0.9, Math.PI / 2, 0.6, 0.6)).toBe(0.9);
  });
});

describe('notched wheel (user 06:25: 3 notches per stage, detent at see-through)', () => {
  it('takes exactly 3 notches from the Look to the see-through and 3 more into the CT stage', () => {
    let g = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) seen.push((g = notchedGoal(g, 1, 2)));
    expect(seen.map((v) => Math.round(v * 3))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(notchedGoal(2, 1, 2)).toBe(2);
    expect(notchedGoal(0, -1, 2)).toBe(0);
  });
  it('never crosses the see-through in one notch', () => {
    expect(notchedGoal(0.9, 1, 2)).toBe(1);
    expect(notchedGoal(1.1, -1, 2)).toBe(1);
  });
});
