import { expect, it } from 'vitest';
import { switchLiveSelection } from './selection';
it('stops the previous recorded cloth before a different size can be applied', async () => {
  let phase = 'playback',
    size = 'S';
  const engine = {
    backToLive() {
      phase = 'tracking';
    },
    async setProduct() {},
    async setSize(next: string) {
      if (phase === 'playback') throw Error('Old cloth still playing');
      size = next;
    },
  };
  await switchLiveSelection(engine, { size: 'M' });
  expect([phase, size]).toEqual(['tracking', 'M']);
});
it('loads the new product before its requested size while remaining live', async () => {
  let phase = 'playback',
    product = 'parka',
    size = 'S';
  const engine = {
    backToLive() {
      phase = 'tracking';
    },
    async setProduct(id: string) {
      expect(phase).toBe('tracking');
      product = id;
    },
    async setSize(next: string) {
      expect(product).toBe('puffer');
      size = next;
    },
  };
  await switchLiveSelection(engine, {
    size: 'L',
    product: { productId: 'puffer', fitId: 'fit-puffer' },
  });
  expect([phase, product, size]).toEqual(['tracking', 'puffer', 'L']);
});
