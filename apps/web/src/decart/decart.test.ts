import { describe, expect, it } from 'vitest';
import { SessionClock, formatCountdown, usdFor, SESSION_LIMIT_S } from './session-timer';
import { ChangeDetector, meanAbsLumaDiff } from './change-detect';
import { pickDefaultCamera, variantName } from './choices';

function fakeClock(startMs = 1000) {
  let t = startMs;
  return { now: () => t, advance: (s: number) => (t += s * 1000) };
}

describe('SessionClock', () => {
  it('counts down from the limit and expires exactly at it', () => {
    const c = fakeClock();
    const clock = new SessionClock(SESSION_LIMIT_S, c.now);
    expect(clock.remainingS()).toBe(75);
    clock.start();
    c.advance(30);
    expect(clock.remainingS()).toBe(45);
    expect(clock.expired()).toBe(false);
    c.advance(45);
    expect(clock.expired()).toBe(true);
    expect(clock.remainingS()).toBe(0);
  });

  it('stop() reports once and freezes elapsed time', () => {
    const c = fakeClock();
    const clock = new SessionClock(75, c.now);
    expect(clock.stop()).toBeNull();
    clock.start();
    c.advance(12.5);
    expect(clock.stop()).toBe(12.5);
    c.advance(10);
    expect(clock.elapsedS()).toBe(12.5);
    expect(clock.stop()).toBeNull();
    expect(clock.running).toBe(false);
  });

  it('cannot start twice and rejects a non-positive limit', () => {
    const clock = new SessionClock(75, fakeClock().now);
    clock.start();
    expect(() => clock.start()).toThrow();
    expect(() => new SessionClock(0)).toThrow();
  });
});

describe('formatting', () => {
  it('formats the countdown, rounding up', () => {
    expect(formatCountdown(75)).toBe('1:15');
    expect(formatCountdown(9.2)).toBe('0:10');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3)).toBe('0:00');
  });
  it('estimates dollars at $0.02/s', () => {
    expect(usdFor(75)).toBe(1.5);
    expect(usdFor(900)).toBe(18);
    expect(usdFor(-1)).toBe(0);
  });
});

describe('change detection', () => {
  const frame = (v: number, n = 16) => {
    const a = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < a.length; i += 4) a.set([v, v, v, 255], i);
    return a;
  };

  it('measures mean luma difference', () => {
    expect(meanAbsLumaDiff(frame(10), frame(10))).toBe(0);
    expect(meanAbsLumaDiff(frame(10), frame(40))).toBeCloseTo(30, 5);
    expect(() => meanAbsLumaDiff(frame(1, 4), frame(1, 5))).toThrow();
  });

  it('ignores noise and reports the first frame of a sustained change', () => {
    const d = new ChangeDetector([1, 2, 1.5, 2.5], { sustain: 3 });
    expect(d.threshold).toBeGreaterThanOrEqual(6);
    expect(d.feed(100, 3)).toBeNull();
    expect(d.feed(133, 20)).toBeNull(); // single spike
    expect(d.feed(166, 2)).toBeNull();
    expect(d.feed(200, 25)).toBeNull();
    expect(d.feed(233, 30)).toBeNull();
    expect(d.feed(266, 28)).toBe(200);
    expect(d.feed(300, 0)).toBe(200);
  });

  it('raises the threshold when the scene is noisy', () => {
    const d = new ChangeDetector([10, 20, 10, 20]);
    expect(d.threshold).toBeCloseTo(15 + 4 * 5, 5);
  });
});

describe('choices', () => {
  it('defaults to the Camo camera, else the first', () => {
    const cams = [
      { deviceId: 'a', label: 'Integrated Webcam' },
      { deviceId: 'b', label: 'Camo' },
    ];
    expect(pickDefaultCamera(cams)).toBe('b');
    expect(pickDefaultCamera([cams[0]])).toBe('a');
    expect(pickDefaultCamera([])).toBeNull();
  });

  it('finds the zip variant of the selected jacket', () => {
    const files = ['parka-closed.jpg', 'parka-half.jpg', 'parka-open.jpg', 'puffer-closed.jpg'];
    expect(variantName(files, 'parka-closed.jpg', 'open')).toBe('parka-open.jpg');
    expect(variantName(files, 'parka-open.jpg', 'half')).toBe('parka-half.jpg');
    expect(variantName(files, 'puffer-closed.jpg', 'open')).toBeNull();
    expect(variantName(files, 'my-upload.png', 'closed')).toBeNull();
  });
});
