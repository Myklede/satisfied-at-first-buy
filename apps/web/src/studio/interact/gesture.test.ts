import { describe, expect, it } from 'vitest';
import { bodyFrameFromPose, fromBody } from './bodyFrame';
import { standingPose } from './testPose';
import { applyTuning, HEM_GRAB, HOOD_GRAB, ZIP_GRAB, ZIP_LINE } from './config';
import {
  GestureMachine,
  GRAB_LOST_MS,
  gestureProgress,
  hitTest,
  pullV,
  snapZip,
  zipFromPull,
  type GestureValues,
  type HandInput,
} from './gesture';
import { hemDisplacement, hoodDisplacement } from './fitLabPhysics';
import { hintText, imageToCanvas } from './overlay';

const PARKA: GestureValues = { jacket: 'FB7675-100', zip: 0, hoodOn: true, hemPull: 0 };

describe('hit tests (body units)', () => {
  it('finds the zip pull where it is now', () => {
    const top = pullV('FB7675-100', 0);
    expect(hitTest(0, top, PARKA)).toBe('zip');
    expect(hitTest(ZIP_GRAB.halfWidth * 0.9, top + 0.1, PARKA)).toBe('zip');
    expect(hitTest(ZIP_GRAB.halfWidth * 1.5, 0.5, PARKA)).toBeNull();
    // Half open: the pull moved down the line; the collar is no longer the zip.
    const half = { ...PARKA, zip: 0.5 };
    expect(hitTest(0, pullV('FB7675-100', 0.5), half)).toBe('zip');
    expect(hitTest(0, 0.1, half)).toBeNull();
  });

  it('hood round the head when on, beside the neck when off, hem at the hem', () => {
    expect(hitTest(0.3, -0.6, PARKA)).toBe('hood-off');
    expect(hitTest(0.3, -0.6, { ...PARKA, hoodOn: false })).toBeNull();
    expect(hitTest(0.5, 0, { ...PARKA, hoodOn: false })).toBe('hood-on');
    expect(hitTest(0.3, ZIP_LINE['FB7675-100'].vHem, PARKA)).toBe('hem');
    expect(hitTest(0.3, ZIP_LINE['FB7675-100'].vHem + HEM_GRAB.below + 0.05, PARKA)).toBeNull();
    expect(hitTest(NaN, 0, PARKA)).toBeNull();
  });
});

describe('pull mapping', () => {
  it('maps hand travel down the body to the zip, relative to the grab', () => {
    const line = ZIP_LINE['FB7675-100'],
      span = line.vHem - line.vTop;
    expect(zipFromPull('FB7675-100', 0, 0.1, 0.1)).toBe(0);
    expect(zipFromPull('FB7675-100', 0, 0.1, 0.1 + span / 2)).toBeCloseTo(0.5, 9);
    expect(zipFromPull('FB7675-100', 0.3, 0.2, 0.2 + span)).toBe(1);
    expect(zipFromPull('FB7675-100', 0.3, 0.2, -5)).toBe(0);
    expect(snapZip(0.03)).toBe(0);
    expect(snapZip(0.97)).toBe(1);
    expect(snapZip(0.5)).toBe(0.5);
  });

  it('hood/hem progress from travel', () => {
    expect(gestureProgress('hood-off', 0, HOOD_GRAB.offTravel)).toBe(1);
    expect(gestureProgress('hood-off', HOOD_GRAB.offTravel / 2, 0)).toBeCloseTo(0.5, 9);
    expect(gestureProgress('hood-on', 0, -HOOD_GRAB.onTravel / 2)).toBeCloseTo(0.5, 9);
    expect(gestureProgress('hood-on', 0, 0.3)).toBe(0);
    expect(gestureProgress('hem', 0, HEM_GRAB.travel)).toBe(1);
    expect(gestureProgress('hem', 0, -0.2)).toBe(0);
  });

  it('hood displacement passes the solver detach distance at full travel', () => {
    const d = hoodDisplacement('hood-off', 1, 0, 0.45, [0, 0, 0]);
    expect(Math.hypot(...d)).toBeGreaterThan(0.18);
    expect(d[1]).toBeLessThan(0); // down
    expect(d[2]).toBeLessThan(0); // behind
    expect(hoodDisplacement('hood-on', 1, 0, 0, [0.1, -0.5, 0.2])).toEqual([-0.1, 0.5, -0.2]);
  });
});

describe('overlay mapping', () => {
  it('maps image to canvas with cover fit and mirroring', () => {
    const view = { mirrored: true, fit: 'cover' as const, sourceWidth: 1280, sourceHeight: 720 };
    // 16:9 source into a 4:3 canvas: cover crops the sides.
    const c = imageToCanvas({ x: 0.5, y: 0.5 }, view, 800, 600);
    expect(c.x).toBeCloseTo(400, 6);
    expect(c.y).toBeCloseTo(300, 6);
    const left = imageToCanvas({ x: 0, y: 0 }, view, 800, 600);
    // Mirrored: image x 0 is drawn at the right edge of the scaled frame (1066.7 px wide).
    expect(left.x).toBeCloseTo((800 - 1066.6667) / 2 + 1066.6667, 3);
    expect(
      imageToCanvas({ x: 0.25, y: 1 }, { ...view, mirrored: false, fit: 'fill' }, 800, 600),
    ).toEqual({ x: 200, y: 600 });
  });
});

describe('GestureMachine', () => {
  const frame = bodyFrameFromPose(standingPose(), 16 / 9)!;
  const at = (u: number, v: number) => fromBody(frame, u, v);
  const hand = (
    pinching: boolean,
    u: number,
    v: number,
    handedness: 'Left' | 'Right' = 'Right',
  ): HandInput => ({
    handedness,
    pinching,
    pinchPoint: at(u, v),
  });

  it('grabs the zip at the collar and opens it continuously, snapping at the hem', () => {
    const m = new GestureMachine();
    let state = { ...PARKA };
    const top = pullV('FB7675-100', 0);
    expect(m.update(0, frame, [hand(false, 0, top)], state).hands[0].target).toBe('zip');
    const zips: number[] = [];
    for (let i = 0; i <= 30; i++) {
      const out = m.update(33 * (i + 1), frame, [hand(true, 0.02, top + (i / 30) * 1.33)], state);
      if (i === 0) expect(out.events[0]).toMatchObject({ phase: 'start', kind: 'zip' });
      if (out.patch?.zip !== undefined) {
        zips.push(out.patch.zip);
        state = { ...state, zip: out.patch.zip };
      }
    }
    // Monotonic, continuous (no step > 1/20 of the travel), ends near fully open.
    for (let i = 1; i < zips.length; i++) {
      expect(zips[i]).toBeGreaterThanOrEqual(zips[i - 1]);
      expect(zips[i] - zips[i - 1]).toBeLessThan(0.06);
    }
    expect(zips.length).toBeGreaterThan(20);
    expect(state.zip).toBeGreaterThan(0.95);
    const end = m.update(2000, frame, [hand(false, 0, 1.13)], state);
    expect(end.patch?.zip).toBe(1);
    expect(end.events.at(-1)).toMatchObject({ phase: 'end', kind: 'zip' });
    expect(m.current).toBeNull();
  });

  it('a pinch held since before does not grab; a pinch off the handles grabs nothing', () => {
    const m = new GestureMachine();
    // Pinching already while out of the body frame (no frame), then moved onto the zip.
    m.update(0, null, [hand(true, 0, -0.2)], PARKA);
    expect(m.update(33, frame, [hand(true, 0, -0.2)], PARKA).grab).toBeNull();
    const n = new GestureMachine();
    n.update(0, frame, [hand(false, 0.5, 0.5)], PARKA);
    expect(n.update(33, frame, [hand(true, 0.5, 0.5)], PARKA).grab).toBeNull();
  });

  it('takes the hood off when pulled back far enough, snaps back on when let go early', () => {
    const m = new GestureMachine();
    m.update(0, frame, [hand(false, 0.2, -0.7)], PARKA);
    expect(m.update(33, frame, [hand(true, 0.2, -0.7)], PARKA).grab?.kind).toBe('hood-off');
    // Only 0.2 T travel, then let go: no change.
    m.update(66, frame, [hand(true, 0.2, -0.5)], PARKA);
    const early = m.update(99, frame, [hand(false, 0.2, -0.5)], PARKA);
    expect(early.patch).toBeNull();
    // Again, the full travel: hoodOn false at the threshold (before the release).
    m.update(132, frame, [hand(true, 0.2, -0.7)], PARKA);
    let off = null;
    for (let i = 1; i <= 10 && !off; i++)
      off = m.update(132 + 33 * i, frame, [hand(true, 0.2, -0.7 + i * 0.06)], PARKA).patch;
    expect(off).toEqual({ hoodOn: false });
  });

  it('puts the hood back on with a lift from the shoulder', () => {
    const m = new GestureMachine();
    const off = { ...PARKA, hoodOn: false };
    m.update(0, frame, [hand(false, 0.5, 0.1, 'Left')], off);
    expect(m.update(33, frame, [hand(true, 0.5, 0.1, 'Left')], off).grab?.kind).toBe('hood-on');
    let patch = null;
    for (let i = 1; i <= 12 && !patch; i++)
      patch = m.update(33 + 33 * i, frame, [hand(true, 0.5, 0.1 - i * 0.05, 'Left')], off).patch;
    expect(patch).toEqual({ hoodOn: true });
  });

  it('hem pull follows the hand and springs back on release', () => {
    const m = new GestureMachine();
    const vHem = ZIP_LINE['FB7675-100'].vHem;
    m.update(0, frame, [hand(false, 0.4, vHem)], PARKA);
    expect(m.update(33, frame, [hand(true, 0.4, vHem)], PARKA).grab?.kind).toBe('hem');
    const mid = m.update(66, frame, [hand(true, 0.4, vHem + HEM_GRAB.travel / 2)], PARKA);
    expect(mid.patch?.hemPull).toBeCloseTo(0.5, 6);
    expect(m.update(99, frame, [hand(false, 0.4, vHem + 0.1)], PARKA).patch).toEqual({
      hemPull: 0,
    });
  });

  it('lets go when the grabbing hand disappears for longer than the grace', () => {
    const m = new GestureMachine();
    const top = pullV('FB7675-100', 0);
    m.update(0, frame, [hand(false, 0, top)], PARKA);
    m.update(33, frame, [hand(true, 0, top)], PARKA);
    expect(m.update(33 + GRAB_LOST_MS - 10, frame, [], PARKA).grab).not.toBeNull();
    expect(m.update(33 + GRAB_LOST_MS + 50, frame, [], PARKA).grab).toBeNull();
  });

  it('one grab at a time: the other hand cannot grab while one holds', () => {
    const m = new GestureMachine();
    const top = pullV('FB7675-100', 0);
    m.update(0, frame, [hand(false, 0, top), hand(false, 0.2, -0.7, 'Left')], PARKA);
    m.update(33, frame, [hand(true, 0, top), hand(false, 0.2, -0.7, 'Left')], PARKA);
    const out = m.update(
      66,
      frame,
      [hand(true, 0, top + 0.1), hand(true, 0.2, -0.7, 'Left')],
      PARKA,
    );
    expect(out.grab?.kind).toBe('zip');
    expect(out.events.some((e) => e.phase === 'start')).toBe(false);
  });
});

describe('hem pull, tuning, hints (ZB round 3)', () => {
  it('hem displacement goes down and out only, capped by HEM_GRAB.maxPullM', () => {
    const d = hemDisplacement(0, 0.2);
    expect(d.y).toBeCloseTo(-0.1, 9);
    expect(d.x).toBe(0);
    expect(hemDisplacement(0, -0.3).y).toBeCloseTo(0, 9); // pushing up does not lift the hem
    expect(hemDisplacement(0.1, 5).length()).toBeCloseTo(HEM_GRAB.maxPullM, 9);
  });

  it('applies ?zbTune overrides to existing numeric fields only', () => {
    const before = ZIP_GRAB.halfWidth;
    const applied = applyTuning('?zbTune=zip.halfWidth:0.33,zip.nope:1,hood.maxV:abc');
    expect(applied).toEqual(['zip.halfWidth=0.33']);
    expect(ZIP_GRAB.halfWidth).toBe(0.33);
    ZIP_GRAB.halfWidth = before;
    expect(applyTuning('')).toEqual([]);
  });

  it('hints name the gesture; the hood hint for the puffer says behind the head', () => {
    expect(hintText('zip', PARKA)).toBe('Pinch the zip pull');
    expect(hintText('hood-off', { ...PARKA, jacket: 'DQ4920-206' })).toBe(
      'Pinch behind your head to take the hood off',
    );
    expect(hintText('hem', PARKA)).toMatch(/hem/);
  });
});
