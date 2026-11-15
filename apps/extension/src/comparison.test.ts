import { expect, it } from 'vitest';
import { neighbouringSizes } from './comparison';

it('compares adjacent printed sizes without inventing neighbours at chart boundaries', () => {
  const sizes = ['XS', 'S', 'M', 'L', 'XL'].map((size) => ({ size }));
  expect(neighbouringSizes(sizes, 'L').map((s) => s.size)).toEqual(['M', 'L', 'XL']);
  expect(neighbouringSizes(sizes, 'XS').map((s) => s.size)).toEqual(['XS', 'S']);
  expect(neighbouringSizes(sizes, 'XL').map((s) => s.size)).toEqual(['L', 'XL']);
  expect(neighbouringSizes([], 'M')).toEqual([]);
});
