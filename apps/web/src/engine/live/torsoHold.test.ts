import { describe, expect, it } from 'vitest';
import { TORSO } from './ar/config';
import { TorsoHold } from './torsoHold';

describe('TorsoHold (?f1torso=1)', () => {
  const run = (twist: (t: number) => number, ms: number) => {
    const hold = new TorsoHold();
    const out: { t: number; v: number }[] = [];
    for (let t = 0; t <= ms; t += 33) {
      const p = hold.apply(t, { trunk_twist: twist(t), trunk_flexion: 0, shoulder_L_elevation: t });
      out.push({ t, v: p.trunk_twist });
      expect(p.shoulder_L_elevation).toBe(t); // arms untouched
    }
    return out;
  };
  it('noise inside the band never reaches the jacket (exactly constant)', () => {
    const noise = (t: number) =>
      0.9 * TORSO.bandDeg.trunk_twist * Math.sin(t / 37) * Math.cos(t / 91);
    const out = run(noise, 3000);
    expect(new Set(out.map((o) => o.v)).size).toBe(1);
  });
  it('a one-frame spike beyond the band is not followed', () => {
    const out = run((t) => (t === 990 ? 30 : 0), 2000);
    expect(Math.max(...out.map((o) => Math.abs(o.v)))).toBe(0);
  });
  it('a real, sustained twist is followed and then held', () => {
    const out = run((t) => (t < 500 ? 0 : 25), 2500);
    const at = (ms: number) => out.find((o) => o.t >= ms)!.v;
    expect(at(540)).toBe(0); // still inside sustainMs
    expect(at(1000)).toBeGreaterThan(24); // glided there within ~0.5 s (glideMs time constant)
    expect(out[out.length - 1].v).toBeCloseTo(at(2300), 6); // held again
  });
});
