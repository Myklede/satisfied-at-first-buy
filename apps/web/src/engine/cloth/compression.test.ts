import { expect, it } from 'vitest';
import { compressionField } from './compression';

it('produces no wrinkle driver from extension and follows actual compression direction', () => {
  const out = new Float32Array(12);
  compressionField([0, 0, 0, 1.2, 0, 0, 1.2, 0.5, 0], [0, 1, 1, 2], [1, 1], out);
  expect(out[3]).toBe(0);
  expect(out[7]).toBeCloseTo(0.5);
  expect(out[11]).toBeCloseTo(0.5);
  expect(Array.from(out.slice(4, 7))).toEqual([0, 1, 0]);
  compressionField([0, 0, 0, 1, 0, 0, 1, 1, 0], [0, 1, 1, 2], [1, 1], out);
  expect(out.every((x) => x === 0)).toBe(true);
});
