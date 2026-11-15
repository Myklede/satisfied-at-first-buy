import { expect, it } from 'vitest';
import { silhouette } from './bodyDiagram';
it('provides illustrative sex-specific outlines without using body dimensions', () => {
  expect(silhouette('male')).not.toBe(silhouette('female'));
  expect(silhouette('neutral')).toBe(silhouette('male'));
  expect(silhouette('female')).toContain('C174 153');
});
