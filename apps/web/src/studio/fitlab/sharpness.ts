// Crisp Fit Lab rendering (agent FL, lead 04:00): render above the device pixel ratio
// (supersampling on 1x screens), MSAA from the Viewer's composer, max anisotropic filtering on the
// jacket's textures, and an adaptive step: while the camera moves (scroll reveal) a fast pixel
// ratio without AO; once it has been still for STILL_MS, the full ratio with AO (Look only: AO
// would darken the see-through glass). Display only: no fit number depends on any of this.
import { Quaternion, Texture, Vector3, type Material, type Object3D } from 'three';

export const SHARP = {
  /** Pixel ratio while the camera moves (lead: at least 1.5). */
  fastRatio: 1.5,
  /** Pixel ratio when still (lead: up to 2 on this laptop). */
  fullRatio: 2,
  /** Camera still this long → full quality (lead: 300 ms). */
  stillMs: 300,
  /** AO only while the jacket is mostly opaque (R fades the film from reveal 0.25). */
  aoMaxReveal: 0.25,
} as const;

/** The render pixel ratio of a mode (above the device ratio on 1x screens = supersampling). */
export function renderRatio(mode: 'fast' | 'full'): number {
  return mode === 'full' ? SHARP.fullRatio : SHARP.fastRatio;
}

/** Tracks camera motion; reports 'fast' while it moved within STILL_MS, else 'full'. */
export class StillDetector {
  private pos = new Vector3(Infinity, 0, 0);
  private quat = new Quaternion();
  private lastMove = -Infinity;
  update(position: Vector3, quaternion: Quaternion, now: number): 'fast' | 'full' {
    if (
      position.distanceToSquared(this.pos) > 1e-10 ||
      1 - Math.abs(quaternion.dot(this.quat)) > 1e-10
    ) {
      this.pos.copy(position);
      this.quat.copy(quaternion);
      this.lastMove = now;
    }
    return now - this.lastMove >= SHARP.stillMs ? 'full' : 'fast';
  }
  /** Something else moved the view (a wheel step): count it as motion. */
  touch(now: number) {
    this.lastMove = now;
  }
}

function texturesOf(material: Material): Texture[] {
  const out: Texture[] = [];
  for (const value of Object.values(material)) if (value instanceof Texture) out.push(value);
  const uniforms = (material as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
  if (uniforms)
    for (const u of Object.values(uniforms)) if (u?.value instanceof Texture) out.push(u.value);
  return out;
}

/** Sets every texture reachable from the objects' materials (and `extra` uniforms) to `max`. */
export function maxAnisotropy(
  roots: Object3D[],
  max: number,
  extra: Record<string, { value?: unknown }>[] = [],
): number {
  const seen = new Set<Texture>();
  const set = (t: Texture) => {
    if (seen.has(t)) return;
    seen.add(t);
    if (t.anisotropy !== max) {
      t.anisotropy = max;
      t.needsUpdate = true;
    }
  };
  for (const root of roots)
    root.traverse((o) => {
      const m = (o as { material?: Material | Material[] }).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) texturesOf(mat).forEach(set);
    });
  for (const uniforms of extra)
    for (const u of Object.values(uniforms)) if (u?.value instanceof Texture) set(u.value);
  return seen.size;
}
