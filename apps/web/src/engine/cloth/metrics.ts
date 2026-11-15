import type { ClothAsset, SizeFit } from '../../api';

export function stretchResidual(asset: ClothAsset, positions: ArrayLike<number>) {
  let maxStrain = 0;
  let violatingEdges = 0;
  const visited = new Set<string>();
  const check = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (visited.has(key)) return;
    visited.add(key);
    const length = (p: ArrayLike<number>) => {
      const x = p[a * 3] - p[b * 3],
        y = p[a * 3 + 1] - p[b * 3 + 1],
        z = p[a * 3 + 2] - p[b * 3 + 2];
      return Math.sqrt(x * x + y * y + z * z);
    };
    const rest = length(asset.rest);
    if (rest < 1e-8) return;
    const strain = length(positions) / rest - 1;
    maxStrain = Math.max(maxStrain, strain);
    if (strain > asset.config.stretchMax - 1 + asset.config.strainAcceptanceTolerance)
      violatingEdges++;
  };
  for (let t = 0; t < asset.triangles.length; t += 3)
    for (let c = 0; c < 3; c++) check(asset.triangles[t + c], asset.triangles[t + ((c + 1) % 3)]);
  for (let w = 0; w < asset.welds.length; w += 2) check(asset.welds[w], asset.welds[w + 1]);
  return { maxStrain, violatingEdges };
}

export function settledMetrics(
  asset: ClothAsset,
  positions: Float32Array,
  analytic: SizeFit,
): SizeFit {
  const result = structuredClone(analytic);
  const point = (id: number): [number, number, number] => [
    positions[id * 3],
    positions[id * 3 + 1],
    positions[id * 3 + 2],
  ];
  const centre = (path: number[]) => {
    const ids = path.slice(0, -1),
      p: [number, number, number] = [0, 0, 0];
    for (const id of ids) for (let a = 0; a < 3; a++) p[a] += positions[id * 3 + a] / ids.length;
    return p;
  };
  const offsets: Record<string, number[]> = { shoulder: [], sleeve: [] };
  Object.assign(result.anchors, asset.body_landmarks);
  for (const side of ['L', 'R']) {
    const acro = asset.body_landmarks[`acromion_${side}`],
      wrist = asset.body_landmarks[`wrist_${side}`];
    const elbow = asset.body_landmarks[`elbow_${side}`];
    const seam = point(asset.landmarks[`seam_${side}`]);
    const cuff = centre(asset.paths[`cuff_inner_${side}`] ?? asset.paths[`cuff_${side}`]);
    result.anchors[`seam_${side}`] = seam;
    result.anchors[`cuff_${side}`] = cuff;
    const axis = wrist.map((v, k) => v - elbow[k]),
      length = Math.hypot(...axis);
    offsets.sleeve.push(
      cuff.reduce((sum, v, k) => sum + ((v - wrist[k]) * axis[k]) / length, 0) * 100,
    );
    const upper = elbow.map((v, k) => v - acro[k]),
      ul = Math.hypot(...upper);
    offsets.shoulder.push(
      seam.reduce((sum, v, k) => sum + ((v - acro[k]) * upper[k]) / ul, 0) * 100,
    );
  }
  for (const zone of ['shoulder', 'sleeve']) {
    const value = offsets[zone].reduce((a, b) => a + b, 0) / 2;
    const metric = result.zones[zone],
      raw = metric.value_cm;
    metric.value_cm = value;
    metric.metric = 'simulated_offset_cm';
    metric.estimated = true;
    metric.lower_cm = null;
    metric.upper_cm = null;
    metric.explanation =
      `Simulated ${value.toFixed(2)} cm; analytic ${raw?.toFixed(2)} cm. ` +
      (zone === 'sleeve' ? 'Verdict uses settled cuff centre, including computed stacking. ' : '') +
      (raw != null && Math.abs(raw - value) > asset.config.offsetShowBothCm
        ? `Difference exceeds ${asset.config.offsetShowBothCm} cm; drape and pose change the position. `
        : '') +
      'Material and cuff-opening assumptions still need worn validation.';
    if (zone === 'sleeve')
      metric.status =
        value > asset.config.cuffTooLongCm
          ? 'too_big'
          : value < asset.config.cuffTooShortCm
            ? 'tight'
            : 'fit';
  }
  if (Object.values(asset.cuff_colliders ?? {}).some((c) => !c.fits_minimum_section)) {
    result.zones.sleeve.status = 'unknown';
    result.zones.sleeve.explanation +=
      ' The inferred cuff opening cannot clear the smallest arm section with this layer; provide the cuff tape before trusting this verdict.';
  }
  const hem = point(asset.landmarks.hem_back),
    hip = asset.body_landmarks.hip_level;
  result.anchors.hem_back = hem;
  result.zones.hem.position_vs_hip_cm = (hem[1] - hip[1]) * 100;
  const rawHem = analytic.zones.hem.position_vs_hip_cm;
  result.zones.hem.explanation += `; simulated hem ${result.zones.hem.position_vs_hip_cm.toFixed(2)} cm vs hip; analytic ${rawHem?.toFixed(2)} cm.`;
  if (
    rawHem != null &&
    Math.abs(rawHem - result.zones.hem.position_vs_hip_cm) > asset.config.offsetShowBothCm
  )
    result.zones.hem.explanation +=
      ' Difference exceeds 1.5 cm; drape and pose change hem position.';
  result.polylines.hem = asset.paths.hem.map(point);
  const residual = stretchResidual(asset, positions);
  if (residual.violatingEdges) {
    for (const zone of ['shoulder', 'sleeve', 'hem']) {
      result.zones[zone].status = 'unknown';
      result.zones[zone].explanation +=
        ` Solver quality check failed: ${residual.violatingEdges} edges exceed the stretch bound` +
        ` (maximum ${(residual.maxStrain * 100).toFixed(1)}%). These positions are diagnostic, awaiting solver correction.`;
    }
  }
  return result;
}
