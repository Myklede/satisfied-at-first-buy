import { describe, expect, it } from 'vitest';
import type { CutPoint, Loop } from './crossSection';
import {
  calloutColor,
  formatGap,
  layerTag,
  layerTitle,
  shortVerdict,
  worstTight,
  majorityZone,
  verdictColor,
  torsoMinGap,
  nearestBodyPoint,
  pickCalloutPoints,
  reach,
  rulerTicks,
} from './ctScanner';
import { THEME, TONE_COLOR } from '../ui/theme';

const pt = (x: number, z: number, a = 0): CutPoint => ({ x, z, a, b: a + 1, t: 0.5 });

/** Closed circle loop, one zone id per segment (zone = segment index). */
function ring(r: number, n: number, cx = 0, cz = 0): Loop {
  const points: CutPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push(pt(cx + Math.cos(a) * r, cz + Math.sin(a) * r, i));
  }
  return { points, zones: points.map((_, i) => i), closed: true };
}

describe('pickCalloutPoints', () => {
  it('picks the shell point on each axis with its segment zone', () => {
    const picks = pickCalloutPoints([ring(0.2, 8)], { x: 0, z: 0 });
    const by = Object.fromEntries(picks.map((p) => [p.dir, p]));
    expect(Object.keys(by).sort()).toEqual(['back', 'front', 'left', 'right']);
    expect(by.left.point.x).toBeCloseTo(0.2); // angle 0 -> +X
    expect(by.left.zone).toBe(0);
    expect(by.front.point.z).toBeCloseTo(0.2); // angle 90deg -> +Z
    expect(by.front.zone).toBe(2);
    expect(by.right.point.x).toBeCloseTo(-0.2);
    expect(by.back.point.z).toBeCloseTo(-0.2);
  });

  it('works around an off-origin centre', () => {
    const picks = pickCalloutPoints([ring(0.15, 16, 0.3, -0.1)], { x: 0.3, z: -0.1 });
    const front = picks.find((p) => p.dir === 'front')!;
    expect(front.point.x).toBeCloseTo(0.3);
    expect(front.point.z).toBeCloseTo(0.05);
  });

  it('skips a direction with no shell (open zip at the front)', () => {
    const full = ring(0.2, 36);
    const open: Loop = {
      points: full.points.filter((p) => !(p.z > 0 && Math.abs(p.x) < 0.17)),
      zones: [],
      closed: false,
    };
    open.zones = open.points.slice(1).map(() => 5);
    const dirs = pickCalloutPoints([open], { x: 0, z: 0 }).map((p) => p.dir);
    expect(dirs).not.toContain('front');
    expect(dirs).toContain('back');
  });

  it('returns nothing for an empty shell', () => {
    expect(pickCalloutPoints([], { x: 0, z: 0 })).toEqual([]);
  });
});

describe('formatGap', () => {
  it('formats signed cm with a true minus sign', () => {
    expect(formatGap(3.24, true)).toBe('+3.2 cm');
    expect(formatGap(-1.46, true)).toBe('−1.5 cm');
    expect(formatGap(0, true)).toBe('+0.0 cm');
  });
  it('adds the preview suffix off the solver', () => {
    expect(formatGap(2, false)).toBe('+2.0 cm preview');
  });
  it('skips missing values', () => {
    expect(formatGap(null, true)).toBeNull();
    expect(formatGap(Number.NaN, true)).toBeNull();
  });
});

describe('helpers', () => {
  it('colours only tight/snug coral', () => {
    expect(calloutColor('tight')).toBe(TONE_COLOR.tight);
    expect(calloutColor('snug')).toBe(TONE_COLOR.tight);
    expect(calloutColor(null)).toBe(THEME.text);
  });
  it('finds the nearest body point', () => {
    expect(nearestBodyPoint([ring(0.1, 4)], 0.3, 0.01)).toEqual({ x: 0.1, z: 0 });
    expect(nearestBodyPoint([], 0, 0)).toBeNull();
  });
  it('measures reach and ticks', () => {
    expect(reach([ring(0.2, 8)], { x: 0, z: 0 })).toBeCloseTo(0.2);
    const t = rulerTicks(0.98, 1.21);
    expect(t.length).toBe(5);
    expect(t[0]).toBeCloseTo(1.0);
    expect(t[4]).toBeCloseTo(1.2);
    expect(rulerTicks(1, 1)).toEqual([]);
  });
});

describe('v2 card helpers', () => {
  it('takes the torso min gap over the majority zone with its side', () => {
    const shell = ring(0.2, 8);
    shell.zones = shell.zones.map(() => 3);
    const gaps = new Map<number, number>([[2, 1.4], [6, -0.8], [0, 2.0]]);
    const min = torsoMinGap({ shell: [shell], centre: { x: 0, z: 0 }, gapAt: (p) => gaps.get(p.a) ?? null });
    expect(min).toEqual({ cm: -0.8, where: 'back' });
    expect(torsoMinGap({ shell: [shell], centre: { x: 0, z: 0 }, gapAt: () => null })).toBeNull();
  });
  it('titles a layer by its zone label or its index', () => {
    expect(layerTitle(['Hem', '', 'Chest'], 0, 3)).toBe('Hem');
    expect(layerTitle(['Hem', '', 'Chest'], 1, 3)).toBe('Layer 2 of 3');
  });
});

describe('preview truth helpers', () => {
  it('finds the majority zone and colours the verdict coral only when tight/snug', () => {
    const a = ring(0.2, 4);
    a.zones = [2, 2, 5, -1];
    expect(majorityZone([a])).toBe(2);
    expect(majorityZone([])).toBeNull();
    expect(verdictColor('snug')).toBe(TONE_COLOR.tight);
    expect(verdictColor(null)).toBe(THEME.textSoft);
  });
});

describe('layer tags', () => {
  it('shortens engine verdict lines without inventing numbers', () => {
    expect(layerTag('Collar', 'Collar tight zipped: 35.0 vs neck ~36.5 cm (−1.5 cm)')).toBe(
      'Collar · tight −1.5 cm',
    );
    expect(layerTag('Chest', 'Chest snug: ease +1.5 cm')).toBe('Chest · snug +1.5 cm');
    expect(layerTag('', 'Bicep tight: ease −0.2 cm')).toBe('tight −0.2 cm');
    expect(layerTag('Hem', '')).toBe('Hem');
    expect(layerTag('', '')).toBe('');
    expect(shortVerdict('no fit word here 3 cm')).toBeNull();
  });
  it('marks the worst tight layer', () => {
    expect(worstTight(['Hem/hip tight: ease −2.7 cm', '', 'Collar tight zipped: (−1.5 cm)'])).toBe(0);
    expect(worstTight(['Chest snug: ease +1.5 cm', ''])).toBeNull();
  });
});
