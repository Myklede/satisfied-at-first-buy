import { expect, it } from 'vitest';
import type { ClothAsset, SizeFit } from '../../api';
import { settledMetrics, stretchResidual } from './metrics';

function fixture(): { asset: ClothAsset; analytic: SizeFit; positions: Float32Array } {
  const rest = [0, 1, 0, 0.1, 1, 0, 0, 0.5, 0];
  const asset: ClothAsset = {
    key: 'synthetic',
    pose: 'synthetic',
    fabric_surface: 'outer',
    maximum_loft_m: 0,
    rest,
    initial: rest,
    triangles: [0, 1, 2],
    panels: [0, 0, 0],
    elastic: [0, 0, 0],
    stitch: [0, 0, 0],
    loft: [0, 0, 0],
    welds: [],
    paths: { cuff_L: [1, 1], cuff_R: [1, 1], hem: [2, 2] },
    landmarks: { seam_L: 0, seam_R: 0, hem_back: 2 },
    body_landmarks: {
      acromion_L: [0, 1, 0],
      acromion_R: [0, 1, 0],
      elbow_L: [0, 0.8, 0],
      elbow_R: [0, 0.8, 0],
      wrist_L: [0, 0.7, 0],
      wrist_R: [0, 0.7, 0],
      hip_level: [0, 0.4, 0],
    },
    body_positions: [],
    body_triangles: [],
    sdf: {
      sdf_id: '0'.repeat(64),
      origin: [0, 0, 0],
      dimensions: [2, 2, 2],
      spacing: 0.007,
      byte_length: 32,
      distance_bias_m: 0,
    },
    config: {
      stretchMax: 1.03,
      strainAcceptanceTolerance: 0.005,
      offsetShowBothCm: 1.5,
      cuffTooLongCm: 2,
      cuffTooShortCm: -1.5,
    },
    rest_measurements_cm: {},
    colour: '#fff',
    finish: 'synthetic',
    layer_m: 0,
    stretch_max_source: 'test',
    build_ms: 0,
  };
  const zone = {
    metric: 'analytic',
    value_cm: 4,
    status: 'fit' as const,
    explanation: '',
    estimated: false,
  };
  const analytic: SizeFit = {
    size: 'S',
    zones: { shoulder: { ...zone }, sleeve: { ...zone }, hem: { ...zone, position_vs_hip_cm: -4 } },
    score: 0,
    coverage: 1,
    estimated: false,
    geometry_available: true,
    missing_fields: [],
    anchors: {},
    polylines: {},
    warnings: [],
  };
  return { asset, analytic, positions: new Float32Array(rest) };
}
it('measures signed posed cuff and hem offsets without altering analytic predictions', () => {
  const { asset, analytic, positions } = fixture();
  const result = settledMetrics(asset, positions, analytic);
  expect(result.zones.sleeve.value_cm).toBeCloseTo(-30);
  expect(result.zones.sleeve.status).toBe('tight');
  expect(result.zones.hem.position_vs_hip_cm).toBeCloseTo(10);
  expect(result.zones.sleeve.explanation).toContain('Difference exceeds');
  expect(analytic.zones.sleeve.value_cm).toBe(4);
  expect(result.zones.sleeve.lower_cm).toBeNull();
});
it('reports a failed stretch solve and suppresses a confident cuff verdict', () => {
  const { asset, analytic, positions } = fixture();
  positions[3] = 0.2;
  const residual = stretchResidual(asset, positions);
  expect(residual.maxStrain).toBeCloseTo(1);
  expect(residual.violatingEdges).toBeGreaterThan(0);
  const result = settledMetrics(asset, positions, analytic);
  expect(result.zones.sleeve.status).toBe('unknown');
  expect(result.zones.sleeve.explanation).toContain('Solver quality check failed');
});
