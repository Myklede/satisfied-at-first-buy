import { describe, expect, it } from 'vitest';
import { CAMERA_STORAGE_KEY, cameraChoice, findCamera, poseInputSize } from './cameraChoice';

describe('cameraChoice', () => {
  it('reads ?cam, ?camCrop and ?camHd; the URL wins over the stored picker choice', () => {
    const store = { getItem: (k: string) => (k === CAMERA_STORAGE_KEY ? 'iPhone' : null) };
    expect(cameraChoice('', store)).toEqual({ label: 'iPhone', crop: null, hd: false });
    expect(cameraChoice('?cam=ZED&camCrop=left&camHd=1', store)).toEqual({
      label: 'ZED',
      crop: 'left',
      hd: true,
    });
    expect(cameraChoice('', null)).toEqual({ label: null, crop: null, hd: false });
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(cameraChoice('?cam=Integrated', blocked).label).toBe('Integrated');
  });

  it('finds a video input by label substring, case-insensitive', () => {
    const devices = [
      { kind: 'audioinput', label: 'ZED 2 mic', deviceId: 'a' },
      { kind: 'videoinput', label: 'Integrated Camera (04f2:b725)', deviceId: 'b' },
      { kind: 'videoinput', label: 'ZED 2', deviceId: 'c' },
    ] as Pick<MediaDeviceInfo, 'kind' | 'label' | 'deviceId'>[];
    expect(findCamera(devices, 'zed')).toBe('c');
    expect(findCamera(devices, 'integrated')).toBe('b');
    expect(findCamera(devices, 'iphone')).toBeNull();
  });

  it('downsizes the pose input to the longest side, never upscales, keeps the aspect', () => {
    expect(poseInputSize(1920, 1080, 960)).toEqual({ width: 960, height: 540, scaled: true });
    expect(poseInputSize(1080, 1920, 960)).toEqual({ width: 540, height: 960, scaled: true });
    expect(poseInputSize(960, 540, 960)).toEqual({ width: 960, height: 540, scaled: false });
    expect(poseInputSize(640, 480, 960).scaled).toBe(false);
  });
});
