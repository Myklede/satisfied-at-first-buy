import { describe, expect, it } from 'vitest';

import { BufferAttribute, BufferGeometry } from 'three';
import { heatColour, knownProduct, morphProgress } from './garmentMath';
import { sameTopology } from './GarmentLayer';
import { productSchema, garmentFitSchema } from '../api';
import first from '../../../../data/products/9ef0f7a074661932a05903d7b72c039984e95976c6286719626fa49d30e1b5be.json';
import second from '../../../../data/products/ec0e32fc0d1e9ffe73093c3d4f354d3e9d8f10eadcbad4d96af46c72bc4d176c.json';

describe('garment display contracts', () => {
  it('validates the real catalogue and matches only known URL paths without fetching them', () => {
    const products = [productSchema.parse(first), productSchema.parse(second)];
    expect(knownProduct('https://www.amazon.com/dp/B0C9TQTNYH?ref=local', products)?.style).toBe(
      'FB7675-100',
    );
    expect(knownProduct('https://www.ebay.com/itm/278055652565', products)?.style).toBe(
      'DQ4920-206',
    );
    expect(
      knownProduct('https://www.amazon.com.evil.test/dp/B0C9TQTNYH', products),
    ).toBeUndefined();
    expect(knownProduct('not a url', products)).toBeUndefined();
    expect(productSchema.safeParse({ ...products[0], private_data: true }).success).toBe(false);
    expect(garmentFitSchema.safeParse({ fit_id: 'unsafe' }).success).toBe(false);
  });
  it('clamps a smooth 400ms transition and preserves heat thresholds', () => {
    expect(morphProgress(-1)).toBe(0);
    expect(morphProgress(200)).toBe(0.5);
    expect(morphProgress(400)).toBe(1);
    expect(morphProgress(600)).toBe(1);
    expect(heatColour(0.5, 0.5, 3)).toEqual([0.95, 0.2, 0.16]);
    expect(heatColour(1.75, 0.5, 3)).toEqual([0.2, 0.8, 0.4]);
    expect(heatColour(3, 0.5, 3)).toEqual([0.2, 0.48, 0.96]);
    expect(heatColour(-5, 0.5, 3, 1)).toEqual([0.56, 0.62, 0.63]);
    expect(heatColour(8, 0.5, 3, 1)).toEqual([0.56, 0.62, 0.63]);
    expect(() => heatColour(1, 3, 0.5)).toThrow();
  });
  it('requires matching face order as well as vertex count before morphing', () => {
    const a = new BufferGeometry();
    a.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    a.setIndex([0, 1, 2]);
    const b = a.clone();
    expect(sameTopology(a, b)).toBe(true);
    b.setIndex([0, 2, 1]);
    expect(sameTopology(a, b)).toBe(false);
    a.dispose();
    b.dispose();
  });
});
