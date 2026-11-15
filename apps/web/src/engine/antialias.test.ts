import { describe, expect, it } from 'vitest';
import { MSAA_SAMPLES, msaaSamples } from './antialias';

describe('msaaSamples', () => {
  it('uses 4x MSAA when the context supports it', () => {
    expect(msaaSamples(4)).toBe(MSAA_SAMPLES);
    expect(msaaSamples(16, '?kiosk')).toBe(4);
  });
  it('falls back to SMAA (0) without 4x multisampling or when asked', () => {
    expect(msaaSamples(0)).toBe(0);
    expect(msaaSamples(2)).toBe(0);
    expect(msaaSamples(16, '?kiosk&aa=smaa')).toBe(0);
    expect(msaaSamples(16, '?aa=msaa')).toBe(4);
  });
});
