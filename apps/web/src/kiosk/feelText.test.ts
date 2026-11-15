import { describe, expect, it } from 'vitest';
import { cameraMessage, FEEL_TEXT, feelHint } from './feelText';

describe('feel the fabric texts', () => {
  it('maps camera errors to friendly text that keeps the kiosk usable', () => {
    expect(cameraMessage('permission_denied')).toMatch(/blocked.*go back/);
    expect(cameraMessage('no_camera')).toMatch(/No camera/);
    expect(cameraMessage('unknown')).toMatch(/could not start/);
  });
  it('hint follows the cursor state', () => {
    expect(feelHint(undefined)).toBe(FEEL_TEXT.hint);
    expect(feelHint('grabbing')).toBe(FEEL_TEXT.hint);
    expect(feelHint('missed')).toBe(FEEL_TEXT.missed);
    expect(feelHint('resisting')).toBe(FEEL_TEXT.resisting);
  });
});
