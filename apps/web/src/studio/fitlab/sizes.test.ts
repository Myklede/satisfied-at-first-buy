import { describe, expect, it } from 'vitest';
import { ZONE_INDEX } from './look/types';
import { FIT_ZONES, NO_ZONE } from './fitZones';
import { fitZoneValues, zoneAnchors } from './sizes';

describe('S/M/L shells helpers', () => {
  it('fitZone attribute values follow the contract ZONE_INDEX (-1 = none)', () => {
    FIT_ZONES.forEach((z, i) => {
      const id = z === 'sleeve' ? 'cuff' : z;
      expect(ZONE_INDEX[id]).toBe(i);
    });
    expect(Array.from(fitZoneValues(Uint8Array.from([0, 5, NO_ZONE])))).toEqual([0, 5, -1]);
  });

  it('anchors take the front half; arm zones only the wearer-left arm', () => {
    // two cuff particles, one per arm; two chest particles front/back
    const zones = Uint8Array.from([5, 5, 2, 2]);
    const rest = [0.3, 1, 0, -0.3, 1, 0, 0, 1.3, 0.1, 0, 1.3, -0.1];
    const a = zoneAnchors(zones, rest);
    expect(Array.from(a.get('sleeve')!)).toEqual([0]);
    expect(Array.from(a.get('chest')!)).toEqual([2]);
  });
});
