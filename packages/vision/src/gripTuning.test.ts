import { describe, expect, it } from 'vitest';
import { HAND_RECORDING_FORMAT } from './handRecording';
import type { HandRecording, PoseTag, Triple } from './handRecording';
import { defaultGrid, poseTable, preferred, scoreRecording, tune } from './gripTuning';
import { DEFAULT_PINCH_TUNING } from './pinch';
import { synthHandNormalized } from './syntheticHand';

const W = 1280;
const H = 720;
const FRAME_MS = 1000 / 30;

/** Labelled synthetic recording: open, closed (tip pinch) for `closedFrames`, open again. */
function labelled(pose: PoseTag, closedFrames: number): HandRecording {
  const ratios = [
    ...new Array<number>(30).fill(0.9),
    ...new Array<number>(closedFrames).fill(0.1),
    ...new Array<number>(40).fill(0.9),
  ];
  const lag = 6; // ~200 ms key-press reaction
  return {
    format: HAND_RECORDING_FORMAT,
    version: 1,
    createdAt: '',
    swapHandedness: false,
    source: { camera: 'synthetic', width: W, height: H, fps: 30, delegate: 'none' },
    meta: { expectedHand: 'right', pose },
    frames: ratios.map((r, i) => ({
      t: i * FRAME_MS,
      width: W,
      height: H,
      grab: (ratios[i - lag] ?? 0.9) < 0.25,
      hands: [
        {
          label: 'Right',
          score: 0.95,
          landmarks: synthHandNormalized(
            { u: 0.9, v: 0.5, scale: 0.15, curl: 0.05, thumb: { kind: 'tip', gap: r } },
            W / H,
          ).map((l): Triple => [l.x, l.y, l.z]),
        },
      ],
    })),
  };
}

describe('grip tuning', () => {
  it('a clean labelled grab scores ~0; a tuning that never grabs pays for the miss', () => {
    const rec = labelled('tip-pinch', 45);
    expect(scoreRecording(rec, {}).cost).toBeLessThan(1);
    const never = scoreRecording(rec, { enterRatio: 0.01, exitRatio: 0.4 });
    expect(never.evaluation?.missed).toBe(1);
    expect(never.cost).toBeGreaterThanOrEqual(20);
  });

  it('tune picks the candidate that grabs, also in every leave-one-out fold', () => {
    const recs = [
      { name: 'a', rec: labelled('tip-pinch', 45) },
      { name: 'b', rec: labelled('tip-pinch', 60) },
    ];
    const grid = [{ enterRatio: 0.01, exitRatio: 0.4 }, {}];
    const report = tune(recs, grid);
    expect(report.best.index).toBe(1);
    expect(report.leaveOneOut.map((l) => l.chosen)).toEqual([1, 1]);
    expect(report.cost).toHaveLength(2);
  });

  it('poseTable groups labelled recordings by pose', () => {
    const table = poseTable(
      [
        { name: 'a', rec: labelled('tip-pinch', 45) },
        { name: 'b', rec: labelled('key-grip', 45) },
      ],
      {},
    );
    expect(Object.keys(table).sort()).toEqual(['key-grip', 'tip-pinch']);
    expect(table['tip-pinch']?.episodes).toBe(1);
    expect(table['tip-pinch']?.frames.tp).toBeGreaterThan(20); // ±300 ms edges unscored
  });

  it('tie-break prefers the stricter clear class, then the shorter dwell', () => {
    const g = (gap: number, dwellMs: number) => ({
      dwellMs,
      grabModel: { ...DEFAULT_PINCH_TUNING.grabModel, clearContactGap: gap },
    });
    expect(preferred(g(0.25, 1600), g(0.3, 400))).toBe(true);
    expect(preferred(g(0.25, 1400), g(0.25, 1600))).toBe(true);
    expect(defaultGrid().length).toBeGreaterThan(10);
  });
});
