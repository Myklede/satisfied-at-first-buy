import { expect, it } from 'vitest';
import { attachAccessories, frameOffset } from './frames';

it('transports sewn hardware under a rigid rotation and translation', () => {
  const p = new Float64Array([2, 3, 4, 2, 4, 4, 1, 3, 4, 0, 0, 0]);
  attachAccessories(p, [3, 0, 1, 2], [0.02, 0.03, 0.01]);
  expect(Array.from(p.slice(9))).toEqual([1.97, 3.02, 4.01]);
  const vector = new Float32Array(3);
  frameOffset(p, 0, 1, 2, [0.02, 0.03, 0.01], 0, vector, 0, false);
  expect(vector[0]).toBeCloseTo(-0.03);
  expect(vector[1]).toBeCloseTo(0.02);
  expect(vector[2]).toBeCloseTo(0.01);
});
