import { describe, expect, it, vi } from 'vitest';
import type { CameraHandle } from '@satisfy/vision';
import { CameraRelay } from './cameraRelay';

/** A camera whose frames the test triggers. */
function fakeCamera(id: string) {
  const listeners = new Set<(t: number) => void>();
  const source = { width: 640, height: 480, id } as unknown as HTMLCanvasElement;
  const camera: CameraHandle = {
    video: { id } as unknown as HTMLVideoElement,
    source,
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    info: () => ({ deviceId: id, label: id, width: 640, height: 480, fps: 30, portrait: false }),
    close: vi.fn(),
  };
  return { camera, frame: (t: number) => listeners.forEach((l) => l(t)), listeners };
}

describe('CameraRelay', () => {
  it('forwards the attached camera frames to listeners registered before the attach', () => {
    const relay = new CameraRelay();
    const seen: number[] = [];
    relay.onFrame((t) => seen.push(t)); // what tracker.start() does, possibly before Feel opens
    const a = fakeCamera('a');
    relay.attach(a.camera);
    a.frame(1);
    a.frame(2);
    expect(seen).toEqual([1, 2]);
    expect(relay.source).toBe(a.camera.source);
    expect(relay.info().deviceId).toBe('a');
  });

  it('detach stops forwarding, leaves the camera open, and a new camera takes over', () => {
    const relay = new CameraRelay();
    const seen: string[] = [];
    relay.onFrame((t) => seen.push(String(t)));
    const a = fakeCamera('a'),
      b = fakeCamera('b');
    relay.attach(a.camera);
    relay.detach();
    a.frame(1);
    expect(seen).toEqual([]);
    expect(a.listeners.size).toBe(0);
    expect(a.camera.close).not.toHaveBeenCalled();
    relay.attach(b.camera);
    b.frame(3);
    expect(seen).toEqual(['3']);
    relay.attach(a.camera); // re-attach replaces b
    b.frame(4);
    a.frame(5);
    expect(seen).toEqual(['3', '5']);
    expect(b.listeners.size).toBe(0);
  });

  it("a listener's unsubscribe removes it; close only detaches", () => {
    const relay = new CameraRelay();
    const listener = vi.fn();
    const off = relay.onFrame(listener);
    const a = fakeCamera('a');
    relay.attach(a.camera);
    off();
    a.frame(1);
    expect(listener).not.toHaveBeenCalled();
    relay.close();
    expect(relay.attached).toBe(false);
    expect(a.camera.close).not.toHaveBeenCalled();
    expect(relay.info().deviceId).toBe('detached');
  });
});
