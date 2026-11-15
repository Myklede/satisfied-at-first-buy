import {
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  type ShaderMaterial,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createSeeThrough, glassDefines, revealCurves, SEE_THROUGH, zoneTint } from './seeThrough';
import { framingAt, wheelStep } from './scrollReveal';
import { Vector3 } from 'three';

describe('revealCurves', () => {
  it('is the untouched look at 0 and full glass at 1', () => {
    const a = revealCurves(0);
    expect(a.glass).toBe(0);
    expect(a.film).toBe(1);
    expect(a.tint).toBe(0);
    const b = revealCurves(1);
    expect(b.glass).toBe(1);
    expect(b.film).toBeCloseTo(SEE_THROUGH.film);
    expect(b.tint).toBe(1);
  });
  it('fades the jacket mostly between 0.3 and 0.5, monotonically', () => {
    let prev = -1;
    for (let r = 0; r <= 1.0001; r += 0.05) {
      const g = revealCurves(r).glass;
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(revealCurves(0.3).glass).toBeLessThan(0.2);
    expect(revealCurves(0.5).glass).toBeGreaterThan(0.8);
    // The tint appears only near the end.
    expect(revealCurves(0.5).tint).toBe(0);
  });
  it('clamps junk input', () => {
    expect(revealCurves(Number.NaN).glass).toBe(0);
    expect(revealCurves(7).glass).toBe(1);
  });
});

describe('zoneTint', () => {
  it('tints only the listed zones, by severity, strongest entry wins', () => {
    const t = zoneTint([
      { zone: 'collar', severity: 1 },
      { zone: 'chest', severity: 0 },
      { zone: 'collar', severity: 0.2 },
    ]);
    expect(t[0]).toBeCloseTo(SEE_THROUGH.tintMax);
    expect(t[2]).toBeCloseTo(SEE_THROUGH.tintMin);
    expect([t[1], t[3], t[4], t[5]]).toEqual([0, 0, 0, 0]);
    expect(zoneTint([]).every((v) => v === 0)).toBe(true);
    expect(zoneTint([{ zone: 'hem', severity: Number.NaN }])[3]).toBe(0);
  });
});

describe('scroll reveal math', () => {
  it('wheel forward (negative deltaY) reveals; pinch is stronger; lines are scaled', () => {
    expect(wheelStep({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeGreaterThan(0);
    expect(wheelStep({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeLessThan(0);
    expect(Math.abs(wheelStep({ deltaY: -10, deltaMode: 0, ctrlKey: true }))).toBeGreaterThan(
      Math.abs(wheelStep({ deltaY: -10, deltaMode: 0, ctrlKey: false })),
    );
    expect(wheelStep({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(
      wheelStep({ deltaY: -48, deltaMode: 0, ctrlKey: false }),
    );
  });
  it('frames full body at 0 and close at 1', () => {
    const f = {
      fullBodyCenter: new Vector3(0, 0.95, 0),
      fullBodyDistance: 4,
      closeCenter: new Vector3(0, 1.4, 0),
      closeDistance: 1,
    };
    expect(framingAt(0, f).distance).toBeCloseTo(4);
    expect(framingAt(1, f).distance).toBeCloseTo(1);
    expect(framingAt(0.5, f).distance).toBeCloseTo(2); // log-space midpoint
    expect(framingAt(1, f).center.y).toBeCloseTo(1.4);
    expect(framingAt(-1, f).center.y).toBeCloseTo(0.95);
  });
});

/** Stands in for engine GarmentLayer (duck-typed by seeThrough: programStandIns + finishShown). */
class FakeGarmentLayer extends Group {
  finishShown = undefined;
  programStandIns() {}
}

describe('createSeeThrough', () => {
  function scene() {
    const layer = new FakeGarmentLayer();
    const geometry = new BoxGeometry(0.4, 0.6, 0.3);
    const n = geometry.getAttribute('position').count;
    geometry.setAttribute('_quilt_uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
    geometry.setAttribute('fitZone', new Float32BufferAttribute(new Float32Array(n).fill(-1), 1));
    const shellMaterial = new MeshPhysicalMaterial();
    const shell = new Mesh(geometry, shellMaterial);
    shell.castShadow = true;
    layer.add(shell);
    const body = new Group();
    const bodyMaterial = new MeshPhysicalMaterial({ color: 0xc4bfb6, roughness: 0.6 });
    body.add(new Mesh(new BoxGeometry(0.3, 0.5, 0.2), bodyMaterial));
    return { layer, shell, shellMaterial, body, bodyMaterial };
  }
  const viewer = () => ({ prewarm: vi.fn(() => Promise.resolve()) });

  it('leaves the look untouched at 0, adds glass and fades the film at 1, restores on dispose', async () => {
    const s = scene();
    const v = viewer();
    const see = createSeeThrough(v);
    const before = s.bodyMaterial.color.getHex();
    see.setParts({ shells: [s.layer], body: [s.body] });
    see.setReveal(0);
    expect(s.shellMaterial.transparent).toBe(false);
    expect(s.shellMaterial.opacity).toBe(1);
    const glass = s.shell.children.filter((c) => c.userData.fitlabGlass);
    expect(glass).toHaveLength(2);
    // In the scene from the start (programs compile before the first scroll), but drawn at 0.
    expect(glass.every((g) => g.visible)).toBe(true);
    expect(
      glass.every(
        (g) => (g as Mesh<BoxGeometry, ShaderMaterial>).material.uniforms.uStrength.value === 0,
      ),
    ).toBe(true);
    expect(s.bodyMaterial.color.getHex()).toBe(before);

    see.setReveal(1);
    // No finish shown on this test layer: nothing to prewarm, the film may go transparent.
    expect(s.shellMaterial.transparent).toBe(true);
    expect(s.shellMaterial.depthWrite).toBe(false);
    expect(s.shellMaterial.opacity).toBeCloseTo(SEE_THROUGH.film);
    expect(s.shell.castShadow).toBe(false);
    expect(glass.every((g) => g.visible)).toBe(true);
    // Glass order around the shell: back faces before, front faces after.
    const orders = glass.map((g) => g.renderOrder).sort();
    expect(orders[0]).toBeLessThan(s.shell.renderOrder);
    expect(orders[1]).toBeGreaterThan(s.shell.renderOrder);
    expect(s.bodyMaterial.color.getHex()).not.toBe(before);
    expect(s.bodyMaterial.roughness).toBeCloseTo(SEE_THROUGH.clayRoughness);

    see.setTightZones([{ zone: 'collar', severity: 1 }]);
    see.dispose();
    expect(s.shell.children.some((c) => c.userData.fitlabGlass)).toBe(false);
    expect(s.shellMaterial.transparent).toBe(false);
    expect(s.shellMaterial.opacity).toBe(1);
    expect(s.shellMaterial.depthWrite).toBe(true);
    expect(s.shell.castShadow).toBe(true);
    expect(s.bodyMaterial.color.getHex()).toBe(before);
    expect(s.bodyMaterial.roughness).toBeCloseTo(0.6);
  });

  it('enables the quilt / tint / zone shader paths only for geometries that carry them', () => {
    const g = new BoxGeometry();
    expect(glassDefines(g)).toEqual({});
    const n = g.getAttribute('position').count;
    g.setAttribute('fitZone', new Float32BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('_quilt_uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
    g.setAttribute('_quilt_params', new Float32BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('_g_seam', new Float32BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3), 3));
    expect(Object.keys(glassDefines(g)).sort()).toEqual(['HAS_FITZONE', 'HAS_QUILT', 'HAS_TINT']);
  });

  it('drops meshes that left the parts and styles new ones', () => {
    const s = scene();
    const see = createSeeThrough(viewer());
    see.setParts({ shells: [s.layer], body: [s.body] });
    see.setReveal(1);
    const replacement = new Mesh(s.shell.geometry, s.shellMaterial);
    s.layer.remove(s.shell);
    s.layer.add(replacement);
    see.setReveal(0.9);
    expect(s.shell.children.some((c) => c.userData.fitlabGlass)).toBe(false);
    expect(replacement.children.filter((c) => c.userData.fitlabGlass)).toHaveLength(2);
    expect(s.shellMaterial.transparent).toBe(true);
    see.dispose();
  });
});
