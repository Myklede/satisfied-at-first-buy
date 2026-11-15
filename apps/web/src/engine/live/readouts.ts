// Live zone readouts. Every number carries its basis (contract.ts):
//   static-fit: the garment fit of this body and size (/fit/garment), unchanged by the pose;
//   preview:    the static value minus how far the SKINNED (not simulated) jacket is stretched
//               along that zone's tape path, compared with the neutral pose. An estimate from the
//               body's skin deformation, never physics. Physics numbers come only from a baked move.
import type { LiveStatus, LiveZone, ZoneReadout } from './contract.ts';

/** The static-fit zone record of one size (GarmentFitResponse.sizes[size].zones[zone]). */
export type StaticZone = { value_cm?: number | null; status: LiveStatus };

/** Zones of the live readout, in display order, with the cloth tape paths that measure them. */
export const ZONE_PATHS: Record<LiveZone, { paths: string[]; closed: boolean }> = {
  shoulder: { paths: [], closed: false }, // seam_L ↔ seam_R landmark distance
  chest: { paths: ['chest'], closed: true },
  bicep: { paths: ['bicep_L', 'bicep_R'], closed: true },
  sleeve: { paths: ['sleeve_L', 'sleeve_R'], closed: false },
  hem: { paths: ['hem'], closed: true },
  collar: { paths: ['neckline'], closed: true },
};
export const LIVE_ZONES = Object.keys(ZONE_PATHS) as LiveZone[];

export function staticReadouts(zones: Record<string, StaticZone> | undefined): ZoneReadout[] {
  const out: ZoneReadout[] = [];
  for (const zone of LIVE_ZONES) {
    const z = zones?.[zone];
    if (!z) continue;
    out.push({
      zone,
      valueCm: z.value_cm ?? null,
      status: z.status,
      basis: 'static-fit',
    });
  }
  return out;
}

/** Length of a particle path in positions (N·3), metres. */
export function pathLength(positions: ArrayLike<number>, path: ArrayLike<number>, closed: boolean) {
  let total = 0;
  const count = path.length;
  const last = closed ? count : count - 1;
  for (let i = 0; i < last; i++) {
    const a = path[i] * 3,
      b = path[(i + 1) % count] * 3;
    total += Math.hypot(
      positions[a] - positions[b],
      positions[a + 1] - positions[b + 1],
      positions[a + 2] - positions[b + 2],
    );
  }
  return total;
}

export type PreviewTapes = {
  paths: Record<string, ArrayLike<number>>;
  /** Particle ids of the shoulder seam points (asset.landmarks.seam_L / seam_R), when present. */
  seams: [number, number] | null;
};

/** Per-zone stretch in cm of the skinned jacket vs the neutral pose (max over L/R paths). */
export function zoneStretchCm(
  tapes: PreviewTapes,
  neutral: ArrayLike<number>,
  posed: ArrayLike<number>,
): Partial<Record<LiveZone, number>> {
  const out: Partial<Record<LiveZone, number>> = {};
  for (const zone of LIVE_ZONES) {
    const spec = ZONE_PATHS[zone];
    let best: number | undefined;
    if (zone === 'shoulder') {
      if (!tapes.seams) continue;
      const [a, b] = tapes.seams;
      const d = (p: ArrayLike<number>) =>
        Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
      best = (d(posed) - d(neutral)) * 100;
    } else
      for (const name of spec.paths) {
        const path = tapes.paths[name];
        if (!path || path.length < 2) continue;
        const delta =
          (pathLength(posed, path, spec.closed) - pathLength(neutral, path, spec.closed)) * 100;
        best = best === undefined ? delta : Math.max(best, delta);
      }
    if (best !== undefined) out[zone] = best;
  }
  return out;
}

/**
 * Preview readouts: static value − stretch (a stretched tape eats ease). A zone with no static
 * value or no tape path stays unknown. Status: 'tight' once the preview ease is negative,
 * otherwise the static status.
 */
export function previewReadouts(
  zones: Record<string, StaticZone> | undefined,
  stretch: Partial<Record<LiveZone, number>>,
): ZoneReadout[] {
  const out: ZoneReadout[] = [];
  for (const zone of LIVE_ZONES) {
    const z = zones?.[zone];
    if (!z) continue;
    const s = stretch[zone];
    const base = z.value_cm;
    if (s === undefined || base == null) {
      out.push({ zone, valueCm: null, status: 'unknown', basis: 'preview' });
      continue;
    }
    const value = base - Math.max(0, s);
    out.push({
      zone,
      valueCm: value,
      status: value < 0 ? 'tight' : z.status,
      basis: 'preview',
    });
  }
  return out;
}
