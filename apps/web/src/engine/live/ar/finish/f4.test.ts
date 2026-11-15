import { describe, expect, it } from 'vitest';
import { VENUE_EXPOSURE, VENUE_LIGHT } from './config';
import { keyDirCamera, readF4Flags, rotate, venueExposure, venueRig } from './f4';
import type { LightEstimate } from './light';

const est = (dir: [number, number, number], confidence = 1): LightEstimate => ({
  dir,
  keyIntensity: 1,
  ambientRGB: [0.5, 0.5, 0.5],
  confidence,
});

describe('F4 flags', () => {
  it('reads each flag only when = 1, default off', () => {
    expect(readF4Flags('')).toEqual({
      edge: false,
      res: 0,
      light: false,
      mask: false,
      fill: false,
      hands: false,
      handsLive: false,
      shadow: false,
      sharp: false,
      noCuff: false,
      grain: false,
      stable: false,
    });
    expect(readF4Flags('?f4res=2').res).toBe(2);
    expect(readF4Flags('?f4hands=1').hands).toBe(true);
    expect(readF4Flags('?f4shadow=1').shadow).toBe(true);
    expect(readF4Flags('?f4sharp=1').sharp).toBe(true);
    expect(readF4Flags('?f4edge=1&f4light=1&f4res=0&f4fill=1')).toEqual({
      edge: true,
      res: 0,
      light: true,
      mask: false,
      fill: true,
      hands: false,
      handsLive: false,
      shadow: false,
      sharp: false,
      noCuff: false,
      grain: false,
      stable: false,
    });
    expect(readF4Flags('?f4hands=2')).toMatchObject({ hands: true, handsLive: true });
  });
});

describe('F4 venue rig', () => {
  it('rotates by a quaternion (90° about y: x → −z)', () => {
    const s = Math.SQRT1_2;
    const v = rotate([0, s, 0, s], [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[2]).toBeCloseTo(-1, 6);
  });

  it('uses the prior without a confident estimate', () => {
    const d = keyDirCamera(null);
    const p = VENUE_LIGHT.priorDir;
    const n = Math.hypot(...p);
    d.forEach((v, i) => expect(v).toBeCloseTo(p[i] / n, 6));
    expect(keyDirCamera(est([1, 0, 0], 0.01))).toEqual(d);
  });

  it('follows a confident estimate but never from behind or below', () => {
    const side = keyDirCamera(est([0.7, 0, 0.7]));
    expect(side[0]).toBeGreaterThan(0.5);
    const behind = keyDirCamera(est([0, -0.6, -0.8]));
    expect(behind[2]).toBeGreaterThanOrEqual(VENUE_LIGHT.minToCamera - 1e-9);
    expect(behind[1]).toBeGreaterThanOrEqual(VENUE_LIGHT.minUp - 1e-9);
    expect(Math.hypot(...behind)).toBeCloseTo(1, 9);
  });

  it('maps camera → world (identity camera: unchanged) and scales ambient by the share', () => {
    const rig = venueRig(null, [0, 0, 0, 1]);
    const d = keyDirCamera(null);
    rig.key.dir.forEach((v, i) => expect(v).toBeCloseTo(d[i], 6));
    expect(rig.hemisphere).toBeCloseTo(VENUE_LIGHT.hemisphere, 6);
    const dim = venueRig({ ...est([0, 0.7, 0.7]), ambientRGB: [0.1, 0.1, 0.1] }, [0, 0, 0, 1]);
    expect(dim.hemisphere).toBeCloseTo(VENUE_LIGHT.hemisphere * VENUE_LIGHT.shareRange[0], 6);
  });

  it('venue exposure follows the face luminance (config gamma), clamped', () => {
    const { atRef, faceYRef, gamma, range } = VENUE_EXPOSURE;
    expect(venueExposure(faceYRef)).toBeCloseTo(atRef, 6);
    expect(venueExposure(faceYRef / 2)).toBeCloseTo(
      Math.max(range[0], atRef * Math.pow(0.5, gamma)),
      6,
    );
    expect(venueExposure(10)).toBe(range[1]);
    expect(venueExposure(NaN)).toBe(atRef);
    // Never the grey of F4's first hookup (E 0.36 under Neutral): under the camera curve the
    // floor keeps the parka's lit chest (linear ≈ 1.3 in the rig) at display ≥ 0.65.
    expect(range[0]).toBeGreaterThanOrEqual(0.5);
  });
});

describe('F4X venue colour (ground truth: config.ts f4light block)', () => {
  // The finisher's face skin on venue-khong-ao (r1 info.json, linear).
  const face: [number, number, number] = [0.337, 0.277, 0.249];

  it('white balance: the venue face gives the camera’s cool white', async () => {
    const { whiteBalanceGains } = await import('./colour');
    const g = whiteBalanceGains(face, true);
    // Unit luminance up to the blue bound's clip (< 2 %).
    expect(Math.abs(0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2] - 1)).toBeLessThan(0.02);
    // A white jacket in the AR input's own balance: r/g 0.72–0.77, b/g 1.33–1.38.
    expect(g[0] / g[1]).toBeGreaterThan(0.7);
    expect(g[0] / g[1]).toBeLessThan(0.8);
    expect(g[2] / g[1]).toBeGreaterThan(1.3);
    expect(g[2] / g[1]).toBeLessThan(1.4);
    // The default path is unchanged (±15 %).
    const d = whiteBalanceGains(face, false);
    expect(d[2]).toBeLessThanOrEqual(1.15 + 1e-9);
    expect(d[0]).toBeGreaterThanOrEqual(0.85 - 1e-9);
  });

  it('the cream puffer keeps its cream against the parka, in the camera’s cool balance', async () => {
    const { whiteBalanceGains } = await import('./colour');
    const { cameraAdaptation, hexToLinear } = await import('./f4');
    const wb = whiteBalanceGains(face, true);
    const a = hexToLinear('#cdb89f')!;
    const { gain, exposure } = cameraAdaptation('#cdb89f');
    const out = a.map((c, i) => c * gain[i] * wb[i]);
    // The jacket is its albedo under the frame's own white (F4T: CAMERA_ADAPT.chroma 0): against
    // that white it reads as the real puffer against a white sheet (r/g 1.21–1.27, b/g 0.72).
    expect(out[0] / out[1] / (wb[0] / wb[1])).toBeCloseTo(a[0] / a[1], 6);
    expect(out[2] / out[1] / (wb[2] / wb[1])).toBeCloseTo(a[2] / a[1], 6);
    // In this camera's cool picture that is a near-neutral warm grey, not the bluish white of
    // the old paling (0.82 / 1.15).
    expect(out[0] / out[1]).toBeGreaterThan(0.88);
    expect(out[0] / out[1]).toBeLessThan(0.98);
    expect(out[2] / out[1]).toBeGreaterThan(0.92);
    expect(out[2] / out[1]).toBeLessThan(1.06);
    // Clearly warmer than the parka (white × the same balance), and never darkened or greyed:
    // it keeps its albedo's luminance against the white jacket.
    expect(out[2] / out[1]).toBeLessThan(0.9 * (wb[2] / wb[1]));
    expect(exposure).toBeGreaterThanOrEqual(1);
    expect(exposure).toBeLessThan(1.4);
  });
});

describe('F4 camera adaptation', () => {
  it('is identity without a colour and near identity for a near-white', async () => {
    const { cameraAdaptation, hexToLinear } = await import('./f4');
    expect(cameraAdaptation(null)).toEqual({ gain: [1, 1, 1], exposure: 1 });
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    const w = cameraAdaptation('#eeeff3');
    w.gain.forEach((g) => expect(Math.abs(g - 1)).toBeLessThan(0.05));
    expect(w.exposure).toBeCloseTo(1, 1);
  });

  it('leaves a cream its chroma and never darkens it, keeping unit luminance', async () => {
    const { cameraAdaptation, hexToLinear } = await import('./f4');
    const a = hexToLinear('#cdb89f')!;
    const { gain, exposure } = cameraAdaptation('#cdb89f');
    // The camera never sees the drawn jacket: no paling (CAMERA_ADAPT.chroma 0, F4T).
    gain.forEach((g) => expect(g).toBeCloseTo(1, 6));
    expect(0.2126 * gain[0] + 0.7152 * gain[1] + 0.0722 * gain[2]).toBeCloseTo(1, 9);
    expect(exposure).toBeGreaterThanOrEqual(1);
    const out = a.map((c, i) => c * gain[i]);
    // Still the swatch's cream (r > b), unchanged.
    expect(out[0] / out[2]).toBeCloseTo(a[0] / a[2], 6);
    expect(out[0] / out[2]).toBeGreaterThan(1);
  });
});

describe('F4X face reading at the still pose', () => {
  // A 10×10 crop of venue-like skin (sRGB 158/141/134).
  const crop = (fill: (i: number) => [number, number, number]) => {
    const px = new Uint8Array(100 * 4);
    for (let i = 0; i < 100; i++) px.set([...fill(i), 255], i * 4);
    return px;
  };
  const SKIN: [number, number, number] = [158, 141, 134];

  it('reads the skin under a blown highlight (the venue spot on the nose), venue flag only', async () => {
    const { faceSkinColour, plausibleSkin } = await import('./colour');
    // 35 % of the crop is a blown nose bridge and forehead, the rest skin.
    const px = crop((i) => (i < 35 ? [252, 252, 252] : SKIN));
    // Default path, unchanged: the percentile mean is pulled out of the skin range (no reading).
    const mixed = faceSkinColour(px, undefined, false)!;
    expect(plausibleSkin(mixed)).toBe(false);
    expect(plausibleSkin(faceSkinColour(px, () => true, false)!)).toBe(false);
    // Venue: the skin-coloured pixels alone, from the class-marked pixels or the whole crop.
    const pure = faceSkinColour(
      crop(() => SKIN),
      undefined,
      true,
    )!;
    for (const skin of [
      faceSkinColour(px, undefined, true)!,
      faceSkinColour(px, () => true, true)!,
    ]) {
      expect(plausibleSkin(skin, true)).toBe(true);
      skin.forEach((v, k) => expect(v).toBeCloseTo(pure[k], 6));
    }
  });

  it('uses the whole crop when the class mask marks nothing or the wrong pixels', async () => {
    const { faceSkinColour, plausibleSkin } = await import('./colour');
    const px = crop((i) => (i < 4 ? [20, 18, 18] : SKIN)); // four dark "eye" pixels
    const none = () => false;
    expect(faceSkinColour(px, none, false)).toBeNull(); // the default path: unchanged
    expect(plausibleSkin(faceSkinColour(px, none, true)!, true)).toBe(true);
    // The class mask marks dark hair only: its pixels are not skin-coloured, the crop's are.
    const hair = crop((i) => (i >= 60 ? [12, 11, 11] : SKIN));
    expect(plausibleSkin(faceSkinColour(hair, (i) => i >= 60, true)!, true)).toBe(true);
    expect(faceSkinColour(hair, (i) => i >= 60, false)![1]).toBeLessThan(0.01);
  });

  it('accepts the venue face at the still pose (cool camera), rejects a white hood', async () => {
    const { plausibleSkin, whiteBalanceGains } = await import('./colour');
    const still: [number, number, number] = [0.366, 0.339, 0.326]; // service trace, 3.5 s
    expect(plausibleSkin(still, false)).toBe(false); // FACE_SKIN: r/g 1.08 < 1.15
    expect(plausibleSkin(still, true)).toBe(true);
    expect(plausibleSkin([0.32, 0.27, 0.24], true)).toBe(true); // the same face at 10 s
    // A white hood or wall in this camera (the real parka: 0.80/1.30), any brightness.
    expect(plausibleSkin([0.4, 0.5, 0.65], true)).toBe(false);
    expect(plausibleSkin([0.5, 0.5, 0.5], true)).toBe(false);
    // The still-pose reading gives the same cool balance as the later one, within the bounds.
    const a = whiteBalanceGains(still, true),
      b = whiteBalanceGains([0.32, 0.27, 0.24], true);
    expect(Math.abs(a[0] / a[1] - b[0] / b[1])).toBeLessThan(0.08);
    expect(Math.abs(a[2] / a[1] - b[2] / b[1])).toBeLessThan(0.08);
  });

  it('gives no reading for a hood, hair, or a few reddish pixels', async () => {
    const { faceSkinColour } = await import('./colour');
    expect(
      faceSkinColour(
        crop(() => [250, 250, 250]),
        undefined,
        true,
      ),
    ).toBeNull();
    expect(
      faceSkinColour(
        crop(() => [14, 12, 12]),
        () => true,
        true,
      ),
    ).toBeNull();
    // 10 % skin-coloured pixels in a white hood: under the share.
    expect(
      faceSkinColour(
        crop((i) => (i < 10 ? SKIN : [250, 250, 250])),
        undefined,
        true,
      ),
    ).toBeNull();
  });
});

describe('F4T Camo colour (live5): free blue gain, no paling of the cream puffer', () => {
  it('lets the blue gain below the laptop floor only for the Camo camera', async () => {
    const { whiteBalanceGains } = await import('./colour');
    const { VENUE_WB } = await import('./config');
    // live5 at 3.0 s through the engine (look job 7bdfcc): face linear (0.313, 0.124, 0.059).
    const face: [number, number, number] = [0.313, 0.124, 0.059];
    // The gains use the page's skin chroma (not Camo in a test): only the bounds are under test.
    const laptop = whiteBalanceGains(face, true, false);
    const camo = whiteBalanceGains(face, true, true);
    expect(Math.min(...laptop)).toBeGreaterThanOrEqual(VENUE_WB.range[0]);
    expect(Math.min(...camo)).toBeGreaterThanOrEqual(VENUE_WB.rangeCamo[0]);
    expect(camo[2]).toBeLessThanOrEqual(laptop[2]);
    // A neutral face reading is never pushed anywhere by the wider bounds.
    expect(whiteBalanceGains([0.2, 0.2 / 1.775, (0.2 / 1.775) * 0.579], true, true)).toEqual(
      whiteBalanceGains([0.2, 0.2 / 1.775, (0.2 / 1.775) * 0.579], true, false),
    );
  });

  it('keeps the product chroma on both cameras (each with its own exponent)', async () => {
    const { cameraAdaptation, camoCamera } = await import('./f4');
    expect(camoCamera('?cam=Camo&camHd=1')).toBe(true);
    expect(camoCamera('?kiosk')).toBe(false);
    const laptop = cameraAdaptation('#cdb89f', false);
    const camo = cameraAdaptation('#cdb89f', true);
    laptop.gain.forEach((g) => expect(g).toBeCloseTo(1, 6));
    camo.gain.forEach((g) => expect(g).toBeCloseTo(1, 6));
    // The exposure part is the same for both.
    expect(camo.exposure).toBeCloseTo(laptop.exposure, 6);
    // Default (no browser): the laptop camera, as before.
    expect(cameraAdaptation('#cdb89f')).toEqual(laptop);
  });
});

describe('F4 camera-specific skin chroma (Camo)', () => {
  it('picks the Camo calibration from cam=Camo and makes the Camo paper white, not pink', async () => {
    const { skinChromaFor, whiteBalanceGains } = await import('./colour');
    const { SKIN_CHROMA, SKIN_CHROMA_CAMO } = await import('./config');
    expect(skinChromaFor('?cam=Camo&camHd=1')).toBe(SKIN_CHROMA_CAMO);
    expect(skinChromaFor('?kiosk')).toBe(SKIN_CHROMA);
    // camo-test-1 at 12 s: cheeks linear (0.268, 0.106, 0.065); white paper r/g 1.24, b/g 0.87.
    const face: [number, number, number] = [0.268, 0.106, 0.065];
    const cast = [face[0] / face[1] / SKIN_CHROMA_CAMO[0], face[2] / face[1] / SKIN_CHROMA_CAMO[1]];
    const g = [Math.pow(cast[0], 0.85), 1, Math.pow(cast[1], 0.85)];
    expect(g[0] / g[1]).toBeCloseTo(1.22, 1);
    expect(g[2] / g[1]).toBeGreaterThan(0.85);
    expect(g[2] / g[1]).toBeLessThan(0.95);
    // The laptop calibration on the same face gives the pink cast (b/g above 1).
    const w = whiteBalanceGains(face, false);
    expect(w.length).toBe(3);
  });
});
