import { afterEach, expect, it, vi } from 'vitest';
import { createBodyScanner, openCamera } from '@satisfy/vision';
import { ScanScreen } from './ScanScreen';

const hooks = vi.hoisted(() => ({ effect: undefined as (() => () => void) | undefined }));
// Exercise the screen's real effect/cleanup with deferred device/model promises; no DOM/WebGL.
vi.mock('react', () => ({
  useEffect: (effect: () => () => void) => {
    hooks.effect = effect;
  },
  useRef: (current: unknown) => ({ current }),
  useState: (initial?: unknown) => [initial, vi.fn()],
}));
vi.mock('@satisfy/vision', () => ({
  openCamera: vi.fn(),
  createBodyScanner: vi.fn(),
  CameraError: class extends Error {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  const camera = { video: { remove: vi.fn() }, close: vi.fn() };
  const scanner = { close: vi.fn(), onGuidance: vi.fn(), run: vi.fn(() => new Promise(() => {})) };
  const opened = deferred<Awaited<ReturnType<typeof openCamera>>>();
  const loaded = deferred<Awaited<ReturnType<typeof createBodyScanner>>>();
  vi.mocked(openCamera).mockReturnValue(opened.promise);
  vi.mocked(createBodyScanner).mockReturnValue(loaded.promise);
  ScanScreen({ heightCm: 172, sex: 'male', units: 'metric', onDone: vi.fn(), onStats: vi.fn() });
  const dispose = hooks.effect!();
  // Structural camera/scanner fixtures implement only members reached by these lifecycle cases.
  const open = () => opened.resolve(camera as unknown as Awaited<ReturnType<typeof openCamera>>);
  const load = () =>
    loaded.resolve(scanner as unknown as Awaited<ReturnType<typeof createBodyScanner>>);
  return { camera, scanner, dispose, open, load };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('closes a camera resolving after Skip, without starting the scanner', async () => {
  const s = setup();
  s.dispose();
  s.open();
  await Promise.resolve();
  expect(s.camera.close).toHaveBeenCalledOnce();
  expect(createBodyScanner).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('closes a scanner resolving after unmount, without subscribing or running it', async () => {
  const s = setup();
  s.open();
  await Promise.resolve();
  expect(createBodyScanner).toHaveBeenCalledOnce();
  expect(vi.mocked(createBodyScanner).mock.calls[0][1]).not.toHaveProperty('delegate', 'GPU');
  s.dispose();
  s.load();
  await Promise.resolve();
  expect(s.camera.close).toHaveBeenCalledOnce();
  expect(s.scanner.close).toHaveBeenCalledOnce();
  expect(s.scanner.onGuidance).not.toHaveBeenCalled();
  expect(s.scanner.run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('closes established scan resources and its stats interval on unmount', async () => {
  const s = setup();
  s.open();
  await Promise.resolve();
  s.load();
  await Promise.resolve();
  expect(s.scanner.run).toHaveBeenCalledOnce();
  s.dispose();
  expect(s.scanner.close).toHaveBeenCalledOnce();
  expect(s.camera.close).toHaveBeenCalledOnce();
  expect(s.camera.video.remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
