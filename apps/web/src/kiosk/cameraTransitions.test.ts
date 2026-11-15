import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventDispatcher, PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CameraRig, presetPose } from '../engine/CameraRig';

function fixture(reduced = false) {
  const preference = { matches: reduced };
  vi.stubGlobal('matchMedia', () => preference);
  const camera = new PerspectiveCamera();
  camera.position.set(1, 2, 4);
  // CameraRig uses only the event contract and target; no DOM/WebGL is needed in this test.
  const events = new EventDispatcher<{ start: object }>();
  const controls = Object.assign(events, { target: new Vector3(0, 1, 0) });
  return {
    camera,
    controls,
    preference,
    rig: new CameraRig(camera, controls as unknown as OrbitControls),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('kiosk camera transitions', () => {
  it('eases to an exact destination independently of the frame interval', () => {
    const a = fixture();
    const b = fixture();
    a.rig.preset('shoulders');
    b.rig.preset('shoulders');
    a.rig.update(0.425);
    expect(a.camera.position.toArray()).toEqual(
      new Vector3(1, 2, 4)
        .lerp(new Vector3(...presetPose('shoulders', 1.72).position), 0.5)
        .toArray(),
    );
    for (let i = 0; i < 17; i++) b.rig.update(0.05);
    a.rig.update(0.425);
    expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-12);
    expect(a.camera.position.toArray()).toEqual(presetPose('shoulders', 1.72).position);
    const end = a.camera.position.clone();
    a.rig.update(5);
    expect(a.camera.position.equals(end)).toBe(true);
  });

  it('snaps immediately for reduced motion, including a preference changed during a move', () => {
    const a = fixture(true);
    a.rig.preset('side');
    expect(a.camera.position.toArray()).toEqual(presetPose('side', 1.72).position);
    const b = fixture();
    b.rig.preset('back');
    b.rig.update(0.1);
    b.preference.matches = true;
    b.rig.update(0);
    expect(b.camera.position.toArray()).toEqual(presetPose('back', 1.72).position);
  });

  it('dollies into the result without changing the anatomical target', () => {
    const { camera, controls, rig } = fixture(true);
    rig.height = 1.8;
    rig.enterResult();
    const pose = presetPose('front', 1.8);
    expect(camera.position.z).toBeCloseTo(pose.position[2] * 0.94);
    expect(controls.target.toArray()).toEqual(pose.target);
  });

  it('lets a user orbit cancel a move and removes its listener on disposal', () => {
    const { camera, controls, rig } = fixture();
    rig.preset('front');
    rig.update(0.2);
    controls.dispatchEvent({ type: 'start' });
    const stopped = camera.position.clone();
    rig.update(1);
    expect(camera.position.equals(stopped)).toBe(true);
    rig.dispose();
    rig.preset('back');
    controls.dispatchEvent({ type: 'start' });
    rig.update(1);
    expect(camera.position.toArray()).toEqual(presetPose('back', 1.72).position);
  });
});
