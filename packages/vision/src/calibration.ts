// Per-measurement linear calibration of raw silhouette values against tape:
//   value = a·raw + b,   σ² = sigma_cm² + (sigma_rel·value)² + (a·scan_spread)²
// The committed set lives in packages/vision/calibration/current.json and is produced by
// scripts/fit-calibration.mjs from paired records (see CALIBRATION.md).
//
// Only erasable TypeScript syntax is used here, so Node can import this file directly
// (type stripping) from scripts/fit-calibration.mjs.

import type { ScanMeasurementName } from './types';

export const SCAN_MEASUREMENT_NAMES: readonly ScanMeasurementName[] = [
  'shoulder_width_cm',
  'chest_cm',
  'waist_cm',
  'hip_cm',
  'arm_length_cm',
];

export interface CalibrationEntry {
  a: number;
  b: number;
  /** Absolute 1-σ residual (cm). */
  sigma_cm: number;
  /** Relative 1-σ residual (fraction of the calibrated value). */
  sigma_rel: number;
  /** Paired (scan, tape) points used; 0 = not fitted. */
  n_points: number;
  /** Distinct people among the points. */
  n_persons: number;
  /** How a, b and sigma were obtained, with sources. */
  source: string;
}

export interface CalibrationSet {
  /** 'uncalibrated' or a fitted id such as 'fit-20261114-n3'. */
  id: string;
  created: string;
  notes: string;
  entries: Record<ScanMeasurementName, CalibrationEntry>;
}

/**
 * Literature-based relative σ for girths when no tape calibration exists.
 * Basis: prompts/vision-research.md reports photo-based girth errors of about 5 % (waist)
 * and 4.6 % (hip); no primary URL was recorded for that figure in the note. For context,
 * the learned two-view BodyM/BMnet model (https://arxiv.org/abs/2210.05667) reports MAE
 * chest 1.6 cm, waist 1.5 cm, hip 1.0 cm under tight clothing — a far stronger method than
 * ours. Treating 5 % as a mean absolute error, σ ≈ 1.25 × MAE ≈ 6.3 % for normal errors;
 * rounded up to 8 % because a plain width/depth ellipse is known to be cruder than the
 * methods behind the 5 % figure (same note: "not accurate enough alone"). Conservative
 * heuristic, to be replaced by fitted residuals.
 */
export const UNCALIBRATED_GIRTH_SIGMA_REL = 0.08;

/**
 * Shoulder width without calibration: no published MediaPipe/silhouette → acromion error
 * exists (vision-research.md: landmarks 11/12 are joint centres ~4–5 cm below the acromion;
 * no offset published). 3 cm ≈ 7.5 % of a typical 40 cm biacromial breadth, in line with the
 * girth rule above. Heuristic.
 */
export const UNCALIBRATED_SHOULDER_SIGMA_CM = 3;

/**
 * Arm length without calibration: 2D projection of a corner→elbow→wrist polyline through
 * joint-centre landmarks; no published error for this exact method. 3 cm ≈ 5 % of a ~60 cm
 * arm (BodyM reports 1.0 cm MAE for its learned model, https://arxiv.org/abs/2210.05667).
 * Heuristic.
 */
export const UNCALIBRATED_ARM_SIGMA_CM = 3;

/** Lower bound on any reported σ (the contract says σ is never 0); 1 mm tape resolution. */
export const MIN_SIGMA_CM = 0.1;

/** Fit a slope only with at least this many distinct people (2 parameters + ≥3 dof). Heuristic. */
export const MIN_PERSONS_FOR_SLOPE = 5;

/** Plausibility bounds when loading a calibration file. */
const A_RANGE: readonly [number, number] = [0.5, 1.5];
const B_LIMIT_CM = 30;

const LITERATURE_SOURCE =
  'uncalibrated: a=1, b=0; σ from literature/heuristic (see calibration.ts constants)';

function uncalibratedEntry(name: ScanMeasurementName): CalibrationEntry {
  const girth = name === 'chest_cm' || name === 'waist_cm' || name === 'hip_cm';
  return {
    a: 1,
    b: 0,
    sigma_cm: girth
      ? 0
      : name === 'shoulder_width_cm'
        ? UNCALIBRATED_SHOULDER_SIGMA_CM
        : UNCALIBRATED_ARM_SIGMA_CM,
    sigma_rel: girth ? UNCALIBRATED_GIRTH_SIGMA_REL : 0,
    n_points: 0,
    n_persons: 0,
    source: LITERATURE_SOURCE,
  };
}

export const UNCALIBRATED: CalibrationSet = {
  id: 'uncalibrated',
  created: '2026-11-11',
  notes: 'Raw silhouette geometry, not validated against tape for this setup.',
  entries: {
    shoulder_width_cm: uncalibratedEntry('shoulder_width_cm'),
    chest_cm: uncalibratedEntry('chest_cm'),
    waist_cm: uncalibratedEntry('waist_cm'),
    hip_cm: uncalibratedEntry('hip_cm'),
    arm_length_cm: uncalibratedEntry('arm_length_cm'),
  },
};

export function uncalibratedEntryFor(name: ScanMeasurementName): CalibrationEntry {
  return { ...UNCALIBRATED.entries[name] };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PERSON_RE = /^[A-Za-z0-9_-]{1,32}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, what: string, lo = -Infinity, hi = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw new TypeError(`${what} must be a finite number in [${lo}, ${hi}]`);
  return v;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) throw new TypeError(`${what}: unknown field "${k}"`);
}

export function parseCalibrationEntry(v: unknown, what: string): CalibrationEntry {
  if (!isRecord(v)) throw new TypeError(`${what} must be an object`);
  onlyKeys(v, ['a', 'b', 'sigma_cm', 'sigma_rel', 'n_points', 'n_persons', 'source'], what);
  const entry: CalibrationEntry = {
    a: num(v.a, `${what}.a`, A_RANGE[0], A_RANGE[1]),
    b: num(v.b, `${what}.b`, -B_LIMIT_CM, B_LIMIT_CM),
    sigma_cm: num(v.sigma_cm, `${what}.sigma_cm`, 0, 50),
    sigma_rel: num(v.sigma_rel, `${what}.sigma_rel`, 0, 1),
    n_points: num(v.n_points, `${what}.n_points`, 0, 1e6),
    n_persons: num(v.n_persons, `${what}.n_persons`, 0, 1e6),
    source: typeof v.source === 'string' ? v.source : '',
  };
  if (entry.sigma_cm === 0 && entry.sigma_rel === 0)
    throw new TypeError(`${what}: sigma_cm and sigma_rel cannot both be 0`);
  return entry;
}

/** Validates a calibration JSON (e.g. calibration/current.json). Unknown fields are rejected. */
export function parseCalibrationSet(json: unknown): CalibrationSet {
  if (!isRecord(json)) throw new TypeError('calibration must be an object');
  onlyKeys(json, ['id', 'created', 'notes', 'entries'], 'calibration');
  if (typeof json.id !== 'string' || !ID_RE.test(json.id))
    throw new TypeError('calibration.id must match ' + ID_RE.source);
  if (!isRecord(json.entries)) throw new TypeError('calibration.entries must be an object');
  onlyKeys(json.entries, SCAN_MEASUREMENT_NAMES, 'calibration.entries');
  const entries = {} as Record<ScanMeasurementName, CalibrationEntry>;
  for (const name of SCAN_MEASUREMENT_NAMES) {
    const raw = json.entries[name];
    entries[name] =
      raw === undefined
        ? uncalibratedEntryFor(name)
        : parseCalibrationEntry(raw, `entries.${name}`);
  }
  return {
    id: json.id,
    created: typeof json.created === 'string' ? json.created : '',
    notes: typeof json.notes === 'string' ? json.notes : '',
    entries,
  };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export interface CalibratedValue {
  value_cm: number;
  sigma_cm: number;
  /** True when a, b and σ came from tape-paired points for this measurement. */
  calibrated: boolean;
}

/** Applies the calibration and combines calibration σ with the per-scan spread. */
export function applyCalibration(
  set: CalibrationSet,
  name: ScanMeasurementName,
  raw: number,
  scanSpreadCm: number,
): CalibratedValue {
  const e = set.entries[name];
  const value = e.a * raw + e.b;
  const spread = Number.isFinite(scanSpreadCm) ? e.a * scanSpreadCm : 0;
  const sigma = Math.sqrt(e.sigma_cm ** 2 + (e.sigma_rel * value) ** 2 + spread ** 2);
  return {
    value_cm: value,
    sigma_cm: Math.max(MIN_SIGMA_CM, sigma),
    calibrated: set.id !== 'uncalibrated' && e.n_points > 0,
  };
}

// ---------------------------------------------------------------------------
// Fitting (used by scripts/fit-calibration.mjs)
// ---------------------------------------------------------------------------

export interface CalibrationPoint {
  person_id: string;
  raw: number;
  tape: number;
}

/**
 * Least-squares calibration for one measurement.
 * - ≥ MIN_PERSONS_FOR_SLOPE distinct people: ordinary least squares for a and b;
 *   σ = √(SSR/(n−2)); sigma_rel = 0.
 * - fewer people: a = 1 (a slope from 1–4 bodies is not identifiable), b = mean(tape − raw);
 *   the prior σ (sigma_cm and sigma_rel) is kept, because so few people cannot establish
 *   error across body sizes, and the residual SD is added to sigma_cm in quadrature.
 * - no points: the prior is returned unchanged.
 */
export function fitCalibrationEntry(
  points: readonly CalibrationPoint[],
  prior: CalibrationEntry,
): CalibrationEntry {
  const pts = points.filter((p) => Number.isFinite(p.raw) && Number.isFinite(p.tape));
  const n = pts.length;
  if (n === 0) return { ...prior };
  const persons = new Set(pts.map((p) => p.person_id)).size;
  const meanRaw = pts.reduce((s, p) => s + p.raw, 0) / n;
  const meanTape = pts.reduce((s, p) => s + p.tape, 0) / n;

  if (persons >= MIN_PERSONS_FOR_SLOPE && n >= 3) {
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p.raw - meanRaw) ** 2;
      sxy += (p.raw - meanRaw) * (p.tape - meanTape);
    }
    if (sxx > 0) {
      const a = sxy / sxx;
      const b = meanTape - a * meanRaw;
      const ssr = pts.reduce((s, p) => s + (p.tape - (a * p.raw + b)) ** 2, 0);
      return {
        a,
        b,
        sigma_cm: Math.max(MIN_SIGMA_CM, Math.sqrt(ssr / (n - 2))),
        sigma_rel: 0,
        n_points: n,
        n_persons: persons,
        source: `least squares a,b on ${n} points / ${persons} people; σ = √(SSR/(n−2))`,
      };
    }
  }

  const b = meanTape - meanRaw;
  const residuals = pts.map((p) => p.tape - (p.raw + b));
  const sd = n > 1 ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / (n - 1)) : 0;
  return {
    a: 1,
    b,
    // Few people: the prior σ (person-to-person error) is kept; the residual SD of the
    // points (mostly scan repeatability) is added in quadrature.
    sigma_cm: Math.hypot(prior.sigma_cm, sd),
    sigma_rel: prior.sigma_rel,
    n_points: n,
    n_persons: persons,
    source:
      `offset only (a=1; ${persons} ${persons === 1 ? 'person' : 'people'} < ${MIN_PERSONS_FOR_SLOPE} ` +
      `for a slope), b = mean(tape − raw) over ${n} point(s); prior σ kept, residual SD ` +
      `${sd.toFixed(2)} cm added in quadrature`,
  };
}

// ---------------------------------------------------------------------------
// Pair records (personal data; stored only in the gitignored calibration/pairs/)
// ---------------------------------------------------------------------------

export const PAIR_SCHEMA = 'satisfy.vision.calibration-pair/1';

export interface CalibrationPair {
  schema: typeof PAIR_SCHEMA;
  person_id: string;
  captured_at: string;
  height_cm: number;
  sex: 'female' | 'male';
  /** Calibration set active during the scan (raw values do not depend on it). */
  calibration_used: string;
  setup: Record<string, string | number | boolean>;
  frames: { front: number; side: number };
  /** Raw (pre-calibration) scan values. */
  raw: Partial<Record<ScanMeasurementName, number>>;
  /** Per-scan spread of the raw values (cm). */
  raw_spread: Partial<Record<ScanMeasurementName, number>>;
  /** Tape readings (cm), filled in by hand; null until measured. */
  tape: Partial<Record<ScanMeasurementName, number | null>>;
  notes: string;
}

function measurementMap(
  v: unknown,
  what: string,
  allowNull: boolean,
): Partial<Record<ScanMeasurementName, number | null>> {
  if (!isRecord(v)) throw new TypeError(`${what} must be an object`);
  onlyKeys(v, SCAN_MEASUREMENT_NAMES, what);
  const out: Partial<Record<ScanMeasurementName, number | null>> = {};
  for (const name of SCAN_MEASUREMENT_NAMES) {
    const x = v[name];
    if (x === undefined) continue;
    if (x === null && allowNull) out[name] = null;
    else out[name] = num(x, `${what}.${name}`, 0, 300);
  }
  return out;
}

/** Validates one pair record (unknown fields rejected; physical ranges enforced). */
export function parseCalibrationPair(json: unknown): CalibrationPair {
  if (!isRecord(json)) throw new TypeError('pair must be an object');
  onlyKeys(
    json,
    [
      'schema',
      'person_id',
      'captured_at',
      'height_cm',
      'sex',
      'calibration_used',
      'setup',
      'frames',
      'raw',
      'raw_spread',
      'tape',
      'notes',
    ],
    'pair',
  );
  if (json.schema !== PAIR_SCHEMA) throw new TypeError(`pair.schema must be "${PAIR_SCHEMA}"`);
  if (typeof json.person_id !== 'string' || !PERSON_RE.test(json.person_id))
    throw new TypeError('pair.person_id must match ' + PERSON_RE.source);
  if (json.sex !== 'female' && json.sex !== 'male') throw new TypeError('pair.sex invalid');
  const frames = isRecord(json.frames) ? json.frames : {};
  const setup: Record<string, string | number | boolean> = {};
  if (isRecord(json.setup))
    for (const [k, v] of Object.entries(json.setup))
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') setup[k] = v;
  return {
    schema: PAIR_SCHEMA,
    person_id: json.person_id,
    captured_at: typeof json.captured_at === 'string' ? json.captured_at : '',
    height_cm: num(json.height_cm, 'pair.height_cm', 120, 220),
    sex: json.sex,
    calibration_used: typeof json.calibration_used === 'string' ? json.calibration_used : '',
    setup,
    frames: {
      front: num(frames.front ?? 0, 'pair.frames.front', 0, 1e6),
      side: num(frames.side ?? 0, 'pair.frames.side', 0, 1e6),
    },
    raw: measurementMap(json.raw, 'pair.raw', false) as Partial<
      Record<ScanMeasurementName, number>
    >,
    raw_spread: measurementMap(json.raw_spread ?? {}, 'pair.raw_spread', false) as Partial<
      Record<ScanMeasurementName, number>
    >,
    tape: measurementMap(json.tape, 'pair.tape', true),
    notes: typeof json.notes === 'string' ? json.notes : '',
  };
}

/** Fits every measurement from pair records; measurements without tape keep the prior. */
export function fitCalibrationSet(
  pairs: readonly CalibrationPair[],
  id: string,
  created: string,
  prior: CalibrationSet = UNCALIBRATED,
): CalibrationSet {
  if (!ID_RE.test(id)) throw new TypeError('id must match ' + ID_RE.source);
  const entries = {} as Record<ScanMeasurementName, CalibrationEntry>;
  for (const name of SCAN_MEASUREMENT_NAMES) {
    const points: CalibrationPoint[] = [];
    for (const p of pairs) {
      const raw = p.raw[name];
      const tape = p.tape[name];
      if (typeof raw === 'number' && typeof tape === 'number')
        points.push({ person_id: p.person_id, raw, tape });
    }
    entries[name] = fitCalibrationEntry(points, prior.entries[name]);
  }
  const persons = new Set(pairs.map((p) => p.person_id)).size;
  return {
    id,
    created,
    notes: `Fitted from ${pairs.length} pair file(s), ${persons} person(s). See CALIBRATION.md.`,
    entries,
  };
}
