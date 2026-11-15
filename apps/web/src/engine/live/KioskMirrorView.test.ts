import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { LiveAvatar } from './LiveAvatar';
import { KioskMirrorView } from './KioskMirrorView';

describe('kiosk mirror geometry reuse', () => {
  it('copies exact avatar bounds once and skips unchanged body on a jacket-only revision', () => {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(6), 3);
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(6), 3));
    const bounds = new Sphere(new Vector3(0.5, 1, 0), 2);
    const arrays = {
      positions: new Float32Array([0, 1, 0, 1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      bounds,
    };
    const bodyArrays = vi.fn(() => arrays);
    const source = {
      version: 1,
      bodyVersion: 1,
      bodyArrays,
      jacketPositions: () => null,
    };
    // Exercise the update path without creating a WebGL renderer or browser.
    const view = Object.create(KioskMirrorView.prototype) as KioskMirrorView;
    Object.assign(view, { bodyGeometry: geometry, bodyVersion: -1, updatedVersion: -1 });
    const avatar = source as unknown as LiveAvatar;
    view.update(avatar);
    expect(geometry.getAttribute('position').array).toEqual(arrays.positions);
    expect(geometry.getAttribute('normal').array).toEqual(arrays.normals);
    expect(geometry.boundingSphere).toEqual(bounds);
    expect(geometry.boundingSphere).not.toBe(bounds);
    const uploads = position.version;
    view.update(avatar);
    source.version++;
    view.update(avatar);
    expect(bodyArrays).toHaveBeenCalledTimes(1);
    expect(position.version).toBe(uploads);
    source.bodyVersion++;
    source.version++;
    view.update(avatar);
    expect(bodyArrays).toHaveBeenCalledTimes(2);
    geometry.dispose();
  });
});

describe('kiosk mirror skips while hidden (?mirrorSkip=1)', () => {
  it('copies nothing while off screen and the latest pose as soon as it is shown', () => {
    let report: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal('location', { search: '?mirrorSkip=1' });
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
      const source = {
        version: 1,
        bodyVersion: 1,
        bodyArrays: () => ({
          positions: new Float32Array([source.bodyVersion, 0, 0]),
          normals: new Float32Array(3),
          bounds: null,
        }),
        jacketPositions: () => null,
      };
      const view = Object.create(KioskMirrorView.prototype) as KioskMirrorView;
      Object.assign(view, { bodyGeometry: geometry, bodyVersion: -1, updatedVersion: -1 });
      (view as unknown as { watchVisibility(c: unknown): void }).watchVisibility({});
      const avatar = source as unknown as LiveAvatar;
      const shown = () => geometry.getAttribute('position').array[0];
      view.update(avatar);
      expect(shown()).toBe(1);
      report?.([{ isIntersecting: false }]);
      source.version++;
      source.bodyVersion++;
      view.update(avatar); // hidden: skipped
      expect(shown()).toBe(1);
      report?.([{ isIntersecting: true }]);
      expect(shown()).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
