import { describe, expect, it } from 'vitest';
import {
  BODY_PRESETS,
  CLOSE_VIEWS,
  ORBIT_VIEWS,
  folderForStyle,
  garmentGeo,
  orbitPose,
  screenshotName,
  sortSizes,
  validBody,
  viewPose,
} from './presets';

const anchors = {
  HPS_L: [0.07, 1.47, 0],
  HPS_R: [-0.07, 1.47, 0],
  acromion_L: [0.2, 1.42, 0.02],
  hem_front: [0.02, 0.87, 0.12],
  hem_back: [0.07, 0.87, -0.09],
  cuff_L: [0.54, 1, 0.27],
};
// Tiny shell: vertices on panel 0 (front) and 6 (collar) and 4 (sleeve L).
const positions = [0.0, 1.1, 0.14, 0.01, 1.0, 0.13, 0.0, 1.5, 0.05, 0.4, 1.2, 0.1, 0.3, 1.3, 0.05];
const panels = [0, 0, 6, 4, 4];

describe('presets', () => {
  it('keeps every body preset inside the API ranges', () => {
    for (const b of BODY_PRESETS) expect(validBody(b.height_cm, b.weight_kg)).toBeNull();
    expect(validBody(100, 60)).toMatch(/Height/);
    expect(validBody(170, 250)).toMatch(/Weight/);
    expect(validBody(NaN, 60)).not.toBeNull();
    expect(new Set(BODY_PRESETS.map((b) => b.id)).size).toBe(BODY_PRESETS.length);
  });

  it('orbit poses put the camera on the right side of the wearer', () => {
    const front = viewPose('front', 1.72).position,
      left = viewPose('left', 1.72).position,
      right = viewPose('right', 1.72).position,
      back = viewPose('back', 1.72).position;
    expect(front[2]).toBeGreaterThan(2);
    expect(back[2]).toBeLessThan(-2);
    expect(left[0]).toBeGreaterThan(2);
    expect(right[0]).toBeLessThan(-2);
    expect(left[0]).toBeCloseTo(-right[0], 6);
    const d = orbitPose([0, 1, 0], 37, 11, 2);
    expect(Math.hypot(d.position[0], d.position[1] - 1, d.position[2])).toBeCloseTo(2, 9);
  });

  it('computes close-up targets from the shell and fits every view', () => {
    const geo = garmentGeo(positions, panels, anchors, 1.72);
    expect(geo.collar).toEqual([0, 1.5, 0.05]);
    expect(geo.sleeve[0]).toBeCloseTo(0.35);
    expect(geo.zipper[2]).toBeCloseTo(0.14); // frontmost shell vertex near x=0
    expect(geo.hem[1]).toBeCloseTo(0.87);
    for (const v of [...ORBIT_VIEWS, ...CLOSE_VIEWS]) {
      const pose = viewPose(v, 1.72, geo);
      for (const n of [...pose.position, ...pose.target]) expect(Number.isFinite(n)).toBe(true);
      expect(pose.position).not.toEqual(pose.target);
    }
  });

  it('falls back to anchors when a panel is missing and refuses close-ups without a jacket', () => {
    const geo = garmentGeo([], [], anchors, 1.72);
    expect(geo.collar[1]).toBeCloseTo(1.5);
    expect(geo.sleeve[1]).toBeCloseTo((1.42 + 1) / 2);
    expect(() => viewPose('cuff', 1.7)).toThrow(/jacket/);
    expect(() => garmentGeo([], [], {}, 1.7)).toThrow(/anchor/);
  });

  it('builds file names with jacket, size, body, view and lighting', () => {
    expect(
      screenshotName({
        style: 'FB7675-100',
        size: 'M',
        sex: 'female',
        height_cm: 168.4,
        weight_kg: 62,
        view: 'collar-front',
        lighting: 'kiosk',
        sideBySide: true,
      }),
    ).toBe('sandbox_FB7675-100_M_female-168cm-62kg_collar-front_kiosk_sidebyside.png');
    expect(
      screenshotName({
        style: 'a/b c',
        size: '2XL',
        sex: 'male',
        height_cm: 180,
        weight_kg: 80,
        view: 'front',
        lighting: 'studio',
        sideBySide: false,
      }),
    ).toBe('sandbox_a-b-c_2XL_male-180cm-80kg_front_studio_3d.png');
  });

  it('sorts sizes from small to large', () => {
    expect(sortSizes(['L', '2XL', 'S', 'XS', 'XL', 'M'])).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
      '2XL',
    ]);
  });

  it('maps a style to its reference folder', () => {
    const folders = ['FB7675-100-parka-trang', 'DQ4920-206-puffer-kem'];
    expect(folderForStyle('DQ4920-206', folders)).toBe('DQ4920-206-puffer-kem');
    expect(folderForStyle('XX', folders)).toBeUndefined();
  });
});
