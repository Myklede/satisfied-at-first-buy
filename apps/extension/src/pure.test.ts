import { describe, expect, it } from 'vitest';
import { plan } from './background';
import { asinFromUrl, cleanBrand, looksLikeSizeTable } from './extract';
import { toFitRequest } from './profile';
import { canonicalSize, matchSize } from './sizes';
import type { PageContent } from './types';
import { cmIn, signed, statusWord } from './units';

describe('sizes (same table as rules.py canonical_size)', () => {
  it.each([
    ['X-Large', 'XL'],
    ['XX-Large', '2XL'],
    ['Small', 'S'],
    ['M', 'M'],
    ['3X', '3XL'],
    ['Medium (38-40)', 'M'],
    ['10', '10'],
    ['Chest', null],
  ])('%s → %s', (label, name) => expect(canonicalSize(label)).toBe(name));

  it('matches a recommended size to the page selector labels', () => {
    expect(matchSize(['Small', 'Medium', 'Large'], 'M')).toBe(1);
    expect(matchSize(['Small', 'Medium'], 'XL')).toBe(-1);
  });
});

describe('units', () => {
  it('shows cm and inches with signs', () => {
    expect(cmIn(5.08)).toBe('+5.1 cm (+2.0 in)');
    expect(cmIn(-2.54)).toBe('-2.5 cm (-1.0 in)');
    expect(cmIn(0)).toBe('0.0 cm (0.0 in)');
    expect(cmIn(null)).toBe('—');
    expect(signed(-0.04)).toBe('0.0');
    expect(statusWord('too_big')).toBe('too big / long');
  });

  it('converts the profile form to API units exactly', () => {
    expect(toFitRequest(true, 70, 160, 'male', 40)).toEqual({
      height_cm: 177.8,
      weight_kg: 72.6,
      sex: 'male',
      known_measurements: { chest_cm: 101.6 },
    });
    expect(toFitRequest(false, 170, 65, 'female', null)).toEqual({
      height_cm: 170,
      weight_kg: 65,
      sex: 'female',
    });
  });
});

describe('page reading helpers', () => {
  it('finds the ASIN in Amazon product URLs', () => {
    expect(asinFromUrl('https://www.amazon.com/Some-Jacket/dp/B0C9TQTNYH?th=1')).toBe('B0C9TQTNYH');
    expect(asinFromUrl('https://www.amazon.com/gp/product/B0C9TQTNYH/')).toBe('B0C9TQTNYH');
    expect(asinFromUrl('https://www.amazon.com/s?k=jacket')).toBeNull();
  });

  it('cleans the byline', () => {
    expect(cleanBrand('Visit the Nike Store')).toBe('Nike');
    expect(cleanBrand('Brand: Fixture')).toBe('Fixture');
  });

  it('recognises size tables in both orientations', () => {
    expect(
      looksLikeSizeTable([
        ['Size', 'Chest'],
        ['S', '38'],
        ['M', '40'],
      ]),
    ).toBe(true);
    expect(
      looksLikeSizeTable([
        ['', 'S', 'M'],
        ['Chest', '38', '40'],
      ]),
    ).toBe(true);
    expect(
      looksLikeSizeTable([
        ['Colour', 'Price'],
        ['Red', '20'],
      ]),
    ).toBe(false);
  });
});

describe('background request plan', () => {
  const page: PageContent = {
    asin: 'B0PARSER01',
    url: 'https://www.amazon.com/dp/B0PARSER01',
    title: 't',
    brand: '',
    bullets: [],
    description: '',
    size_options: [],
    tables: [],
    chart_origin: 'in_dom',
  };
  const choices = { preference: 'regular', layer: 't-shirt' } as const;

  it('sends product content plus the body choice to one fixed path', () => {
    const target = plan({ op: 'recommend', page }, { mode: 'profile' }, choices);
    expect(target?.path).toBe('/agent/recommend');
    expect(target?.body).toEqual({ page, body: { mode: 'profile' }, ...choices });
  });

  it('rejects malformed ids and ASINs', () => {
    expect(
      plan({ op: 'undo', purchase_id: '../profile' }, { mode: 'profile' }, choices),
    ).toBeNull();
    expect(plan({ op: 'compare', asins: ['B0PARSER01'] }, { mode: 'profile' }, choices)).toBeNull();
    expect(
      plan({ op: 'purchase', asin: 'x', size: 'M', title: '' }, { mode: 'profile' }, choices),
    ).toBeNull();
  });
});
