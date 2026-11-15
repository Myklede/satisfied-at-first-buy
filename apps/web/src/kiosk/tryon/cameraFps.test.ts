import { describe, expect, it } from 'vitest';
import { CameraFpsMonitor, trackFrameCount } from './cameraFps';

describe('CameraFpsMonitor', () => {
  it('measures the delivered rate from a frame counter and shows the hint after 2 s below 24', () => {
    const m = new CameraFpsMonitor();
    let frames = 0;
    for (let t = 0; t <= 4000; t += 500) {
      m.sample(t, frames, null);
      frames += 7.5; // 15 fps
    }
    expect(m.fps).toBeCloseTo(15, 5);
    expect(m.low).toBe(true);
  });

  it('does not flicker: clears only after 2 s at >= 26 fps, ignores 24-26', () => {
    const m = new CameraFpsMonitor();
    for (let t = 0; t <= 2500; t += 500) m.sample(t, null, 15);
    expect(m.low).toBe(true);
    for (let t = 3000; t <= 8000; t += 500) m.sample(t, null, 25);
    expect(m.low).toBe(true);
    for (let t = 8500; t <= 10000; t += 500) m.sample(t, null, 30);
    expect(m.low).toBe(true);
    m.sample(10600, null, 30);
    expect(m.low).toBe(false);
  });

  it('a short dip does not show the hint; 30 fps never does', () => {
    const m = new CameraFpsMonitor();
    m.sample(0, null, 30);
    m.sample(500, null, 12);
    m.sample(1000, null, 30);
    m.sample(1500, null, 30);
    expect(m.low).toBe(false);
  });
});

describe('trackFrameCount', () => {
  it('reads track.stats totalFrames or delivered + discarded, else null', () => {
    expect(trackFrameCount({ stats: { totalFrames: 90 } } as unknown as MediaStreamTrack)).toBe(90);
    expect(
      trackFrameCount({
        stats: { deliveredFrames: 80, discardedFrames: 10 },
      } as unknown as MediaStreamTrack),
    ).toBe(90);
    expect(trackFrameCount({} as MediaStreamTrack)).toBeNull();
    expect(trackFrameCount(undefined)).toBeNull();
  });
});
