import { describe, expect, it } from 'vitest';
import { isAllowedUrl } from './networkGuard';

const base = 'http://127.0.0.1:5711/hands.html';

describe('network guard', () => {
  it('blocks the MediaPipe usage logger and any other remote host', () => {
    expect(isAllowedUrl('https://odml.pa.googleapis.com/v1/log', base)).toBe(false);
    expect(isAllowedUrl('https://cdn.jsdelivr.net/npm/x', base)).toBe(false);
    expect(isAllowedUrl('//example.com/a', base)).toBe(false);
  });
  it('allows same-origin, loopback and in-memory URLs', () => {
    expect(isAllowedUrl('/models/hand_landmarker.task', base)).toBe(true);
    expect(isAllowedUrl('http://127.0.0.1:8001/health', base)).toBe(true);
    expect(isAllowedUrl('http://localhost:5710/', base)).toBe(true);
    expect(isAllowedUrl('blob:http://127.0.0.1:5711/abc', base)).toBe(true);
    expect(isAllowedUrl('data:,', base)).toBe(true);
  });
});
