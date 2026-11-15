// One number per quantity (review 03 H3/H4): the kiosk card and the 3D label must show the same
// prediction, in the same units, and the X-ray contrast must report real differences only.
import { describe, expect, it } from 'vitest';
import type { GarmentFitResponse, SizeFit } from '../api';
import { cuffText, seamLabel } from '../engine/fitLabelText';
import {
  NEAR_IDENTICAL_CM,
  contrastLine,
  contrastPick,
  cuffLine,
  cutNote,
  drawnOffsets,
  lengthFormat,
  predictions,
  reasonLine,
} from './fitSummary';
import { formatLength, type Units } from './units';

const zone = (metric: string, value_cm: number) => ({
  metric,
  value_cm,
  status: 'fit' as const,
  explanation: '',
  estimated: false,
});
const size = (
  name: string,
  v: { seam: number; sleeve: number; chest: number },
  metric = { shoulder: 'shoulder_offset_cm', sleeve: 'sleeve_offset_cm' },
): SizeFit => ({
  size: name,
  zones: {
    shoulder: zone(metric.shoulder, v.seam),
    sleeve: zone(metric.sleeve, v.sleeve),
    chest: zone('inner_ease_cm', v.chest),
  },
  score: 1,
  coverage: 1,
  estimated: true,
  geometry_available: true,
  missing_fields: [],
  anchors: {},
  polylines: {},
  warnings: [],
});
// Computed by the service for a 5'9" / 160 lb male (FB7675, 2026-11-12, this machine).
const parka = {
  recommended_size: 'L',
  sizes: {
    M: size('M', { seam: 8.17, sleeve: 2.8, chest: 4.8 }),
    L: size('L', { seam: 9.21, sleeve: 8.21, chest: 11.8 }),
    XL: size('XL', { seam: 9.66, sleeve: 11.69, chest: 20.3 }),
  },
} as unknown as GarmentFitResponse;
// The shell shown in 3D for size L (metrics.ts settledMetrics): stacking at the hand.
const shownL = size(
  'L',
  { seam: 6.8, sleeve: 2.6, chest: 11.8 },
  { shoulder: 'simulated_offset_cm', sleeve: 'simulated_offset_cm' },
);

describe('one number per quantity', () => {
  for (const units of ['imperial', 'metric'] as Units[]) {
    it(`card and 3D seam label show the same prediction (${units})`, () => {
      const predicted = predictions(parka.sizes.L).shoulder_seam!;
      const drawn = drawnOffsets(shownL).shoulder_seam;
      const card = reasonLine(parka, units);
      const label = seamLabel(predicted, drawn, lengthFormat(units))!;
      const value = formatLength(predicted, units);
      expect(card).toContain(value);
      expect(label.title).toContain(value);
      // The drawn-shell value is never shown as the prediction, only as a labelled detail.
      expect(label.title).not.toContain(formatLength(drawn!, units));
      expect(label.detail).toContain('3D drape');
      expect(label.detail).toContain(formatLength(drawn!, units));
      expect(value.startsWith(units === 'imperial' ? '3.6 in' : '9.2 cm')).toBe(true);
    });
  }
  it('names both cuff numbers explicitly', () => {
    const p = predictions(parka.sizes.L).cuff_vs_wrist;
    const d = drawnOffsets(shownL).cuff_vs_wrist;
    expect(cuffLine(p, d, 'metric')).toBe(
      'sleeve length 8.2 cm (3.2 in) past your wrist · stacks at the hand to +2.6 cm (1.0 in) on the 3D drape',
    );
    expect(cuffText(p, null, lengthFormat('imperial'))).toBe(
      'sleeve length 3.2 in (8.2 cm) past your wrist',
    );
  });
  it('never mixes analytic and drawn metrics', () => {
    expect(predictions(shownL).shoulder_seam).toBeNull();
    expect(drawnOffsets(parka.sizes.L).shoulder_seam).toBeNull();
  });
});

describe('X-ray contrast size', () => {
  it('picks the neighbour with the largest computed difference', () => {
    const pick = contrastPick(parka)!;
    expect(pick.size).toBe('XL'); // chest +8.5 cm beats M's −7.0 cm
    expect(pick.maxDeltaCm).toBeCloseTo(8.5, 5);
    expect(pick.nearIdentical).toBe(false);
    expect(contrastLine(parka, 'imperial')).toBe(
      'L vs XL: chest room +4.6 in → +8.0 in, sleeve past wrist +3.2 in → +4.6 in; shoulder seam nearly the same (+3.6 in vs +3.8 in)',
    );
  });
  it('says so honestly when every neighbour is near-identical', () => {
    const flat = {
      recommended_size: 'M',
      sizes: {
        S: size('S', { seam: 1.0, sleeve: 8.0, chest: 6.0 }),
        M: size('M', { seam: 1.15, sleeve: 8.6, chest: 6.4 }),
        L: size('L', { seam: 1.15, sleeve: 8.9, chest: 6.9 }),
      },
    } as unknown as GarmentFitResponse;
    const pick = contrastPick(flat)!;
    expect(pick.nearIdentical).toBe(true);
    expect(pick.maxDeltaCm).toBeLessThan(NEAR_IDENTICAL_CM);
    expect(contrastLine(flat, 'metric')).toMatch(/nearly identical on this body/);
  });
});

describe('cut note', () => {
  it('flags a women’s cut for a male judge without changing anything else', () => {
    const parkaTitle = { title: "Nike Sportswear Classic Puffer — Women's Therma-FIT Parka" };
    const puffer = { title: "Nike Life Therma-FIT Men's Puffer" };
    expect(cutNote(parkaTitle, 'male')).toBe("Women's cut");
    expect(cutNote(parkaTitle, 'female')).toBeNull();
    expect(cutNote(puffer, 'male')).toBeNull();
    expect(cutNote(puffer, 'female')).toBe("Men's cut");
    expect(cutNote({ title: 'Unisex shell' }, 'male')).toBeNull();
  });
});
