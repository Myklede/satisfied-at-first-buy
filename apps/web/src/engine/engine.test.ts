import { describe, expect, it } from 'vitest';
import { cmToMetres, metresToCm } from './units';
import { presetPose } from './CameraRig';

describe('centimetres at the API, metres in the scene', () => {
  it('round-trips without a scale change', () => {
    expect(cmToMetres(172)).toBe(1.72);
    expect(metresToCm(1.72)).toBe(172);
    expect(cmToMetres(metresToCm(0.45))).toBe(0.45);
  });
});
describe('camera presets', () => {
  it('front looks toward -Z and back toward +Z', () => {
    expect(presetPose('front', 1.7).position[2]).toBeGreaterThan(0);
    expect(presetPose('back', 1.7).position[2]).toBeLessThan(0);
    expect(presetPose('front', 1.7).target).toEqual(presetPose('back', 1.7).target);
  });
  it('side looks from +X and shoulder is a closer upper body view', () => {
    const side = presetPose('side', 1.7);
    const shoulder = presetPose('shoulder', 1.7);
    expect(side.position[2]).toBe(0);
    expect(side.position[0]).toBeGreaterThan(0);
    expect(shoulder.target[1]).toBeGreaterThan(side.target[1]);
    expect(shoulder.position[2]).toBeLessThan(presetPose('front', 1.7).position[2]);
  });
  it('scales with body stature', () => {
    expect(presetPose('front', 2).position[2]).toBe(presetPose('front', 1).position[2] * 2);
  });
  it('frames both shoulders from the back on the centreline', () => {
    const pose = presetPose('shoulders', 1.7);
    expect(pose.position[0]).toBe(0);
    expect(pose.position[2]).toBeLessThan(0);
    expect(pose.target[1]).toBeGreaterThan(presetPose('front', 1.7).target[1]);
  });
});
