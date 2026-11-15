import { describe, expect, it } from 'vitest';
import {
  REC_BITS_PER_SECOND,
  buildManifest,
  formatElapsed,
  gapStats,
  recEnabled,
  recordingBase,
  recordingFiles,
  type ManifestInput,
} from './liveRecorder';

describe('liveRecorder pure parts', () => {
  it('is off unless ?rec=1', () => {
    expect(recEnabled('')).toBe(false);
    expect(recEnabled('?rec=0')).toBe(false);
    expect(recEnabled('?arfull=1&rec=1')).toBe(true);
  });
  it('names files from local time', () => {
    const base = recordingBase(new Date(2026, 10, 14, 9, 5, 7));
    expect(base).toBe('ar-live-20261114-090507');
    expect(recordingFiles(base)).toEqual({
      raw: 'ar-live-20261114-090507-raw.webm',
      ar: 'ar-live-20261114-090507-ar.webm',
      manifest: 'ar-live-20261114-090507.json',
    });
  });
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(12_900)).toBe('00:12');
    expect(formatElapsed(90_000)).toBe('01:30');
  });
  it('caps the bitrate at 6 Mbit/s', () => {
    expect(REC_BITS_PER_SECOND).toBeLessThanOrEqual(6_000_000);
  });
  it('summarises frame gaps', () => {
    expect(gapStats([])).toBeNull();
    const g = gapStats([10, 20, 30, 40, 200])!;
    expect(g.count).toBe(5);
    expect(g.meanMs).toBe(60);
    expect(g.p50Ms).toBe(30);
    expect(g.maxMs).toBe(200);
    expect(g.over100).toBe(1);
  });
  it('builds a manifest with computed summaries', () => {
    const input: ManifestInput = {
      base: 'ar-live-20261114-090507',
      startedAt: new Date('2026-11-14T09:05:07.000Z'),
      stoppedAt: new Date('2026-11-14T09:05:19.400Z'),
      stopReason: 'user',
      product: { productId: 'p1', fitId: 'f1', size: 'M' },
      search: '?rec=1',
      canvas: { width: 1040, height: 586, cssWidth: 520, cssHeight: 293 },
      devicePixelRatio: 2,
      cameraSettings: { width: 1280, height: 720, frameRate: 30 },
      userAgent: 'UA',
      webglRenderer: 'GPU',
      mimeType: 'video/webm;codecs=vp9',
      bitsPerSecond: { raw: 6e6, ar: 6e6 },
      arSource: 'top canvas',
      arMirroredOnScreen: true,
      samples: [
        {
          t: 1,
          arFps: 20,
          arRenderMs: 8,
          arDisplayMs: 30,
          arTotalMs: 60,
          trackerMs: 30,
          sourceFps: 25,
          mirrorFps: 30,
        },
        {
          t: 2,
          arFps: 14,
          arRenderMs: 9,
          arDisplayMs: 40,
          arTotalMs: null,
          trackerMs: null,
          sourceFps: 25,
          mirrorFps: 30,
        },
      ],
      gaps: [50, 70],
      errors: [],
    };
    const m = buildManifest(input);
    expect(m.files.raw).toBe('ar-live-20261114-090507-raw.webm');
    expect(m.durationS).toBe(12.4);
    expect(m.summary.arFpsMean).toBe(17);
    expect(m.summary.arFpsMin).toBe(14);
    expect(m.summary.arTotalMsMean).toBe(60);
    expect(m.summary.arDisplayMsMean).toBe(35);
    expect(m.summary.frameGaps?.count).toBe(2);
    expect(m.notes.arMirroredOnScreen).toMatch(/NOT flipped/);
    expect(JSON.parse(JSON.stringify(m)).search).toBe('?rec=1');
  });
});
