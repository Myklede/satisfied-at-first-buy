import { describe, expect, it } from 'vitest';
import { PANEL } from '../../garmentSurface';
import { acromionVertices, collarTargetKind, shoulderMarks, visibleCollarTop } from './anchors';

// Particles: 0 = collar top at the front (y 1.50), 1 = hood rim strip above it (y 1.58, hidden),
// 2 = collar at the back (z behind the shoulders), 3 = front torso far off the centre line.
const positions = Float32Array.from([
  0.01, 1.5, 0.08, 0.0, 1.58, 0.07, 0.0, 1.6, -0.1, 0.2, 1.52, 0.1,
]);
const panels = [PANEL.collar, PANEL.hood, PANEL.collar, PANEL.frontL];
const midShoulder = [0, 1.45, 0] as const;

describe('visibleCollarTop', () => {
  it('ignores the hidden hood panel (no collar_top path)', () => {
    const top = visibleCollarTop(positions, { panels, paths: {} }, midShoulder, 0.06);
    expect(top?.[1]).toBeCloseTo(1.5, 6);
  });

  it('uses the collar_top path when the asset has one', () => {
    const top = visibleCollarTop(
      positions,
      { panels, paths: { collar_top: [0, 2] } },
      midShoulder,
      0.06,
    );
    expect(top?.[1]).toBeCloseTo(1.5, 6); // the back one (2) is behind the shoulders
  });

  it('returns null when nothing is near the front centre line', () => {
    expect(
      visibleCollarTop(positions, { panels, paths: { collar_top: [3] } }, midShoulder, 0.06),
    ).toBeNull();
  });
});

describe('collarTargetKind', () => {
  it('puffer (removable hood = hood_zip path) aims at the lower lip, else the chin', () => {
    expect(collarTargetKind({ paths: { hood_zip: [1, 2, 3] } })).toBe('lowerLip');
    expect(collarTargetKind({ paths: { collar_top: [1] } })).toBe('chin');
    expect(collarTargetKind(undefined)).toBe('chin');
  });
});

describe('acromionVertices / shoulderMarks', () => {
  // Display body: 4 vertices; the acromions are vertices 1 (left, +x) and 3 (right, -x).
  const asset = {
    body_positions: [0, 1, 0, 0.19, 1.44, 0, 0, 0.5, 0, -0.19, 1.44, 0],
    body_landmarks: {
      acromion_L: [0.18, 1.45, 0] as [number, number, number],
      acromion_R: [-0.18, 1.45, 0] as [number, number, number],
    },
  };

  it('finds the nearest rig vertices, [] on another topology', () => {
    expect(acromionVertices(asset, 4)).toEqual([1, 3]);
    expect(acromionVertices(asset, 5)).toEqual([]);
  });

  it('blends each shoulder joint toward its acromion, pairing by distance', () => {
    // Posed body: acromions 4.4 cm above the shoulder joints.
    const body = [0, 1, 0, 0.18, 1.444, 0.01, 0, 0.5, 0, -0.18, 1.444, 0.01];
    const ls = [0.18, 1.4, 0] as const,
      rs = [-0.18, 1.4, 0] as const;
    const full = shoulderMarks(ls, rs, body, [3, 1], 1)!; // swapped ids: paired by distance
    expect(full.l[1]).toBeCloseTo(1.444, 6);
    expect(full.l[0]).toBeCloseTo(0.18, 6);
    expect(full.r[0]).toBeCloseTo(-0.18, 6);
    const half = shoulderMarks(ls, rs, body, [1, 3], 0.5)!;
    expect(half.l[1]).toBeCloseTo(1.422, 6);
    expect(shoulderMarks(ls, rs, body, [1], 1)).toBeNull();
  });
});
