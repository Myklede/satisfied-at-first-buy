import { describe, expect, it } from 'vitest';
import parka from '../../../../data/products/9ef0f7a074661932a05903d7b72c039984e95976c6286719626fa49d30e1b5be.json';
import puffer from '../../../../data/products/ec0e32fc0d1e9ffe73093c3d4f354d3e9d8f10eadcbad4d96af46c72bc4d176c.json';
import {
  JACKET_CARDS,
  cardImageCandidates,
  cardPhotoCandidates,
  decartControls,
} from './jacketCards';

describe('jacket cards', () => {
  it('text matches the product data (title, colourway, style)', () => {
    const products = [parka, puffer];
    for (const card of JACKET_CARDS) {
      const p = products.find((x) => x.style === card.id);
      expect(p, card.id).toBeDefined();
      expect(card.title).toBe(p?.title);
      expect(card.colourway).toBe(p?.colourway);
    }
  });

  it('image candidates use the decartViewMap slug, closed state, hood first', () => {
    const c = cardImageCandidates('DQ4920-206');
    expect(c[0]).toBe('/local-textures/decart/puffer-closed.png');
    expect(c).toContain('/local-textures/decart/puffer-closed.jpg');
    expect(c.indexOf('/local-textures/decart/puffer-closed.webp')).toBeLessThan(
      c.indexOf('/local-textures/decart/puffer-closed-nohood.png'),
    );
    expect(cardImageCandidates('FB7675-100')[1]).toBe('/local-textures/decart/parka-closed.jpg');
  });

  it('card photo prefers the studio product photo, then the Decart references', () => {
    const c = cardPhotoCandidates('FB7675-100');
    expect(c[0]).toBe('/local-textures/cards/parka.jpg');
    expect(c.slice(1)).toEqual(cardImageCandidates('FB7675-100'));
  });

  it('Decart buttons: Start needs a pick and idle; Stop only while active; restart after stop', () => {
    expect(decartControls(false, false)).toEqual({
      startDisabled: true,
      stopDisabled: true,
      startTitle: 'Pick a jacket first',
    });
    expect(decartControls(true, false).startDisabled).toBe(false);
    expect(decartControls(true, true)).toMatchObject({ startDisabled: true, stopDisabled: false });
    // After Stop the view reports idle again (active=false): Start is available again.
    expect(decartControls(true, false)).toMatchObject({ startDisabled: false, stopDisabled: true });
  });
});
