import { expect, it } from 'vitest';
import { expandTable, looksLikeSizeTable } from './extract';
it('expands merged headers without shifting the printed measurements', () => {
  expect(
    expandTable([
      [
        { text: 'Size', rows: 2, cols: 1 },
        { text: 'Body cm', rows: 1, cols: 2 },
      ],
      [
        { text: 'Chest', rows: 1, cols: 1 },
        { text: 'Hip', rows: 1, cols: 1 },
      ],
    ]),
  ).toEqual([
    ['Size', 'Body cm', 'Body cm'],
    ['Size', 'Chest', 'Hip'],
  ]);
});
it('recognises the printed second header before trying to open another chart', () => {
  expect(
    looksLikeSizeTable([
      ['Size', 'Body cm', 'Body cm'],
      ['Size', 'Chest', 'Hip'],
      ['S (4-6)', '85–90', '90–95'],
      ['M', '90–95', '95–100'],
    ]),
  ).toBe(true);
});
