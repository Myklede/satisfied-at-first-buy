import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial, Quaternion, Texture, Vector3 } from 'three';
import { maxAnisotropy, renderRatio, SHARP, StillDetector } from './sharpness';

describe('Fit Lab sharpness', () => {
  it('fast while the camera moved within 300 ms, full once still', () => {
    const d = new StillDetector();
    const p = new Vector3(0, 1, 3),
      q = new Quaternion();
    expect(d.update(p, q, 0)).toBe('fast');
    expect(d.update(p, q, 200)).toBe('fast');
    expect(d.update(p, q, 300)).toBe('full');
    p.z = 2.5;
    expect(d.update(p, q, 400)).toBe('fast');
    d.touch(900);
    expect(d.update(p, q, 1000)).toBe('fast');
    expect(d.update(p, q, 1250)).toBe('full');
    expect(renderRatio('fast')).toBe(SHARP.fastRatio);
    expect(renderRatio('full')).toBe(SHARP.fullRatio);
  });
  it('sets every reachable texture to the max anisotropy once', () => {
    const map = new Texture(),
      normal = new Texture(),
      decal = new Texture();
    const mesh = new Mesh(undefined, new MeshStandardMaterial({ map, normalMap: normal }));
    expect(maxAnisotropy([mesh], 16, [{ d: { value: decal } }])).toBe(3);
    expect([map.anisotropy, normal.anisotropy, decal.anisotropy]).toEqual([16, 16, 16]);
  });
});
