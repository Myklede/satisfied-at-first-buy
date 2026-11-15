// Pure P32 Fit Lab adapter: safe in Node or a browser; no filesystem or network.
// Source: services/body/body_service/{schemas,scan_config}.py, 2026-11-15.
const RANGES = {
  chest_cm: [45, 200],
  waist_cm: [40, 200],
  hip_cm: [50, 200],
  shoulder_width_cm: [20, 65],
  arm_length_cm: [30, 100],
};
const finite = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

/** buildBodyFitRequest(person, measurements) -> the service's FitRequest.
 * measurements[name] needs {value_cm,sigma_cm,method}; spread/other audit fields
 * from the offline result are deliberately not sent across the API boundary.
 */
export function buildBodyFitRequest(person, measurements) {
  if (
    !person ||
    Object.keys(person).some((k) => !['height_cm', 'weight_kg', 'sex'].includes(k)) ||
    !finite(person.height_cm, 120, 220) ||
    !finite(person.weight_kg, 30, 200) ||
    !['male', 'female'].includes(person.sex)
  )
    throw new TypeError('Invalid person; supply height_cm, weight_kg and sex in service ranges');
  if (
    !measurements ||
    typeof measurements !== 'object' ||
    Array.isArray(measurements) ||
    Object.keys(measurements).some((k) => !Object.hasOwn(RANGES, k))
  )
    throw new TypeError('Unknown scan measurement');
  const scan_measurements = { calibration: 'uncalibrated' };
  for (const [name, m] of Object.entries(measurements)) {
    const [lo, hi] = RANGES[name];
    if (
      !m ||
      !finite(m.value_cm, lo, hi) ||
      !finite(m.sigma_cm, 0.1, 1e5) ||
      typeof m.method !== 'string' ||
      m.method.length > 400
    )
      throw new TypeError('Invalid scan entry: ' + name);
    scan_measurements[name] = { value_cm: m.value_cm, sigma_cm: m.sigma_cm, method: m.method };
  }
  if (Object.keys(scan_measurements).length === 1)
    throw new TypeError('No usable scan measurements');
  return { ...person, known_measurements: {}, scan_measurements };
}
