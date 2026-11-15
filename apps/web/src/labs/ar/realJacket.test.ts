import { describe, expect, it } from 'vitest';
import type { ImageLandmark } from '../../engine/live/contract';
import { chestColour, realJacketMask } from './realJacket';

const W = 60,
  H = 80;

/** A warm-white jacket (rows 10–49), skin hands (rows 50–54), grey trousers below, white wall. */
function picture() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let c = [235, 235, 238]; // white wall (outside the person)
      if (x >= 15 && x < 45) {
        if (y >= 10 && y < 50)
          c = x === 30 ? [120, 112, 100] : [232, 222, 205]; // jacket, one deep fold
        else if (y >= 50 && y < 55)
          c = [200, 150, 120]; // skin
        else if (y >= 55) c = [118, 118, 120]; // grey trousers
      }
      data.set([...c, 255], i);
    }
  return { data, width: W, height: H, colorSpace: 'srgb' } as unknown as ImageData;
}

function personMask() {
  const data = new Float32Array(W * H);
  for (let y = 5; y < H; y++) for (let x = 15; x < 45; x++) data[y * W + x] = 0.95;
  return { data, width: W, height: H };
}

function landmarks(): ImageLandmark[] {
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  l[11] = { x: 40, y: 12, visibility: 0.9 };
  l[12] = { x: 20, y: 12, visibility: 0.9 };
  l[23] = { x: 37, y: 40, visibility: 0.9 };
  l[24] = { x: 23, y: 40, visibility: 0.9 };
  return l;
}

describe('real jacket mask', () => {
  it('keeps the jacket inside the person; drops wall, skin and grey trousers', () => {
    const pixels = picture();
    const colour = chestColour(pixels, landmarks())!;
    expect(colour.r).toBe(232);
    const mask = realJacketMask(pixels, personMask(), colour);
    const at = (x: number, y: number) => mask.data[y * W + x];
    expect(at(20, 20)).toBe(1); // jacket
    expect(at(30, 30)).toBe(1); // the 1 px dark fold is filled by the majority filter
    expect(at(5, 20)).toBe(0); // white wall: not the person
    expect(at(25, 52)).toBe(0); // skin
    expect(at(25, 65)).toBe(0); // grey trousers
  });

  it('gives no colour sample when the torso landmarks are not visible', () => {
    const l = landmarks();
    l[23] = { ...l[23], visibility: 0.2 };
    expect(chestColour(picture(), l)).toBeNull();
  });
});
