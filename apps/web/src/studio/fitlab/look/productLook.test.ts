import { MeshPhysicalMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { AR_LOOK } from '../../../engine/live/ar/finish/config';
import { applyArMaterial, readProductLookFlags } from './productLook';

describe('productLook', () => {
  it('reads the A/B flag: default on, 0 off, one part off', () => {
    expect(readProductLookFlags('')).toEqual({
      on: true,
      fabric: true,
      material: true,
      hood: true,
    });
    expect(readProductLookFlags('?productlook=0').on).toBe(false);
    expect(readProductLookFlags('?productlook=0').fabric).toBe(false);
    const f = readProductLookFlags('?productlook=nofabric');
    expect(f).toEqual({ on: true, fabric: false, material: true, hood: true });
  });

  it('sets the AR material response absolutely (applying twice changes nothing)', () => {
    const m = new MeshPhysicalMaterial({ sheen: 1 });
    applyArMaterial(m, { finish: 'glossy_ripstop' });
    const once = [m.roughness, m.specularIntensity, m.envMapIntensity, m.sheenRoughness];
    applyArMaterial(m, { finish: 'glossy_ripstop' });
    expect([m.roughness, m.specularIntensity, m.envMapIntensity, m.sheenRoughness]).toEqual(once);
    expect(m.roughness).toBe(AR_LOOK.glossy_ripstop.roughness);
    applyArMaterial(m, { finish: 'satin_matte' });
    expect(m.roughness).toBe(AR_LOOK.satin_matte.roughness);
  });
});
