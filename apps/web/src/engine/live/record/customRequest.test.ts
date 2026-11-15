import { afterEach, describe, expect, it, vi } from 'vitest';
import { customMotionRequest, fetchCustomFrames } from './customRequest.ts';

afterEach(() => vi.unstubAllGlobals());

const BODY = 'b'.repeat(64);

describe('custom motion request', () => {
  it('converts ms to seconds from the first pose, drops pelvis drop and declares the rate', () => {
    const poses = Array.from({ length: 151 }, (_, i) => ({
      t: 5000 + i * 33.3,
      pose: { shoulder_R_elevation: 30 + i / 2, pelvis_drop_m: 0.01 },
    }));
    const request = customMotionRequest(poses);
    expect(request.poses[0]).toEqual({ t: 0, pose: { shoulder_R_elevation: 30 } });
    expect(request.poses[150].t).toBeCloseTo(4.995, 9);
    expect(request.fps).toBeCloseTo(1000 / 33.3, 6);
    // The service rule: at most ceil(8 s · fps) + 1 poses.
    expect(request.poses.length).toBeLessThanOrEqual(Math.ceil(8 * request.fps) + 1);
  });

  it('keeps partial poses partial (left-out DOFs are the body neutral on the service)', () => {
    const request = customMotionRequest([
      { t: 0, pose: {} },
      { t: 500, pose: { elbow_L_flexion: 40 } },
    ]);
    expect(request.poses).toEqual([
      { t: 0, pose: {} },
      { t: 0.5, pose: { elbow_L_flexion: 40 } },
    ]);
    expect(request.fps).toBe(2);
  });

  it('rejects what the service would reject, with a readable message', () => {
    const at = (t: number, pose = {}) => ({ t, pose });
    expect(() => customMotionRequest([at(0)])).toThrow(/at least two/);
    expect(() => customMotionRequest([at(0), at(0)])).toThrow(/strictly increasing/);
    expect(() => customMotionRequest([at(0), at(8001)])).toThrow(/at most 8 s/);
    expect(() => customMotionRequest([at(0), at(10, { neck_flexion: 1 })])).toThrow(/Unknown/);
    expect(() => customMotionRequest([at(0), at(10, { elbow_L_flexion: 151 })])).toThrow(/limits/);
    expect(() => customMotionRequest([at(0), at(10, { elbow_L_flexion: NaN })])).toThrow(/limits/);
    expect(() => customMotionRequest([at(0), at(NaN)])).toThrow(/finite/);
  });

  it('posts JSON to the loopback service and maps its errors', async () => {
    const fetch = vi.fn(async () => new Response(new ArrayBuffer(16), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const request = {
      fps: 30,
      poses: [
        { t: 0, pose: {} },
        { t: 0.1, pose: {} },
      ],
    };
    const buffer = await fetchCustomFrames(BODY, request);
    expect(buffer.byteLength).toBe(16);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/motion/${BODY}/custom/frames.bin`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(request);
    fetch.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(fetchCustomFrames(BODY, request)).rejects.toThrow(/expired/);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: [{ msg: 'Value error, too long' }] }), { status: 422 }),
    );
    await expect(fetchCustomFrames(BODY, request)).rejects.toThrow(/rejected: Value error/);
    await expect(fetchCustomFrames('../x', request)).rejects.toThrow(/Invalid body/);
  });
});
