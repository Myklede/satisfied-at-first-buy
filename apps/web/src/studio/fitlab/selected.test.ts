import { describe, expect, it } from 'vitest';
import type { ZoneState } from './fitZones';
import { selectedVerdict } from './fitZones';
import { annotationVisibility, tightSeverity } from './FitLabPanel';

const st = (
  zone: ZoneState['zone'],
  valueCm: number | null,
  status: ZoneState['status'],
  tone: ZoneState['tone'],
  severity: number,
): ZoneState => ({
  zone,
  valueCm,
  status,
  tone,
  severity,
  note: '',
  callout: '',
});

describe('selected-size verdict (engine numbers)', () => {
  it('tight size names where, worst first', () => {
    const v = selectedVerdict('tight', [
      st('hem', -2.7, 'tight', 'tight', 4.27),
      st('collar', -1.5, 'tight', 'tight', 4.15),
      st('chest', 1.5, 'tight', 'snug', 3),
    ]);
    expect(v).toEqual({
      word: 'Tight',
      tone: 'tight',
      line: 'Tight at hem/hip −2.7 cm, collar zipped −1.5 cm',
    });
  });
  it('good size with numbers; a flagged zipped collar makes it snug', () => {
    const good = selectedVerdict('good', [
      st('chest', 9.1, 'fit', 'none', 0),
      st('hem', 4.8, 'fit', 'none', 0),
      st('shoulder', 1.7, 'relaxed', 'none', 0.5),
      st('sleeve', 10.4, 'too_big', 'loose', 2.5),
    ]);
    expect(good.word).toBe('Good');
    expect(good.line).toBe(
      'chest +9.1 cm, hem/hip +4.8 cm, shoulder seam +1.7 cm; cuff 10.4 cm past the wrist',
    );
    expect(selectedVerdict('good', [st('collar', 2, 'tight', 'snug', 3.5)]).word).toBe('Snug');
  });
  it('loose size names the roomiest zones', () => {
    const v = selectedVerdict('loose', [
      st('chest', 17.4, 'relaxed', 'none', 0.5),
      st('hem', 13.1, 'relaxed', 'none', 0.5),
    ]);
    expect(v.line).toBe('Roomy at chest +17.4 cm, hem/hip +13.1 cm');
  });
  it('tint severity and annotation fade', () => {
    expect(tightSeverity(st('collar', 2, 'tight', 'snug', 3.5))).toBe(0.35);
    expect(tightSeverity(st('collar', -1.5, 'tight', 'tight', 4))).toBeCloseTo(0.7375);
    expect(tightSeverity(st('hem', -19, 'tight', 'tight', 6))).toBe(1);
    expect(annotationVisibility(0)).toBe(0);
    expect(annotationVisibility(1)).toBe(1);
    expect(annotationVisibility(0.475)).toBeCloseTo(0.5);
  });
});
