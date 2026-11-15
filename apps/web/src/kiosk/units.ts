// Kiosk unit handling. The API is always centimetres / kilograms (AGENTS.md §5);
// imperial is display/input only. Exact definitions: 1 in = 2.54 cm, 1 lb = 0.45359237 kg.
export type Units = 'imperial' | 'metric';

export const CM_PER_IN = 2.54;
export const KG_PER_LB = 0.45359237;
/** Physical ranges enforced by the body service (schemas.py FitRequest). */
export const HEIGHT_RANGE_CM = [120, 220] as const;
export const WEIGHT_RANGE_KG = [30, 200] as const;

export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const inToCm = (inches: number) => inches * CM_PER_IN;
export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const lbToKg = (lb: number) => lb * KG_PER_LB;

/** Whole feet + inches rounded to the nearest 0.5 in (display / input defaults). */
export function cmToFtIn(cm: number): { ft: number; inches: number } {
  const total = Math.round(cmToIn(cm) * 2) / 2;
  const ft = Math.floor(total / 12);
  return { ft, inches: total - ft * 12 };
}
export const ftInToCm = (ft: number, inches: number) => inToCm(ft * 12 + inches);

const fixed = (value: number, digits = 1) => value.toFixed(digits).replace(/^-0\.0$/, '0.0');

/** "6.9 cm (2.7 in)" or "2.7 in (6.9 cm)"; absolute value, sign handled by the caller. */
export function formatLength(cm: number, units: Units): string {
  const metric = `${fixed(Math.abs(cm))} cm`;
  const imperial = `${fixed(Math.abs(cmToIn(cm)))} in`;
  return units === 'imperial' ? `${imperial} (${metric})` : `${metric} (${imperial})`;
}

/** Signed short form for tables: "+2.7 in" / "−6.9 cm". */
export function formatSigned(cm: number, units: Units): string {
  const value = units === 'imperial' ? cmToIn(cm) : cm;
  const sign = value > 0.04 ? '+' : value < -0.04 ? '−' : '';
  return `${sign}${fixed(Math.abs(value))} ${units === 'imperial' ? 'in' : 'cm'}`;
}

/** "5 ft 9 in (175 cm)" or "175 cm (5 ft 9 in)". */
export function formatHeight(cm: number, units: Units): string {
  const { ft, inches } = cmToFtIn(cm);
  const imperial = `${ft} ft ${inches % 1 ? inches.toFixed(1) : inches} in`;
  const metric = `${Math.round(cm)} cm`;
  return units === 'imperial' ? `${imperial} (${metric})` : `${metric} (${imperial})`;
}

/** Value ± sigma in the chosen unit, e.g. "38.4 ± 1.2 in". */
export function formatPlusMinus(cm: number, sigmaCm: number, units: Units): string {
  const k = units === 'imperial' ? 1 / CM_PER_IN : 1;
  return `${fixed(cm * k)} ± ${fixed(sigmaCm * k)} ${units === 'imperial' ? 'in' : 'cm'}`;
}

export interface YouInput {
  units: Units;
  /** metric */
  heightCm: string;
  weightKg: string;
  /** imperial */
  heightFt: string;
  heightIn: string;
  weightLb: string;
}

export type YouResult =
  | { ok: true; height_cm: number; weight_kg: number }
  | { ok: false; height?: string; weight?: string };

const num = (text: string) => (text.trim() === '' ? NaN : Number(text));

/** Parses the "You" form into API units with friendly range messages in the chosen units. */
export function parseYou(input: YouInput): YouResult {
  const [hLo, hHi] = HEIGHT_RANGE_CM;
  const [wLo, wHi] = WEIGHT_RANGE_KG;
  let height: number;
  let weight: number;
  if (input.units === 'metric') {
    height = num(input.heightCm);
    weight = num(input.weightKg);
  } else {
    const ft = num(input.heightFt);
    const inches = input.heightIn.trim() === '' ? 0 : num(input.heightIn);
    height = Number.isFinite(ft) && inches >= 0 && inches < 12 ? ftInToCm(ft, inches) : NaN;
    weight = lbToKg(num(input.weightLb));
  }
  const errors: { height?: string; weight?: string } = {};
  if (!(height >= hLo && height <= hHi))
    errors.height =
      input.units === 'metric'
        ? `Please enter a height between ${hLo} and ${hHi} cm.`
        : `Please enter a height between ${formatFtIn(hLo, 'up')} and ${formatFtIn(hHi, 'down')}.`;
  if (!(weight >= wLo && weight <= wHi))
    errors.weight =
      input.units === 'metric'
        ? `Please enter a weight between ${wLo} and ${wHi} kg.`
        : `Please enter a weight between ${Math.ceil(kgToLb(wLo))} and ${Math.floor(kgToLb(wHi))} lb.`;
  if (errors.height || errors.weight) return { ok: false, ...errors };
  return {
    ok: true,
    height_cm: Math.round(height * 10) / 10,
    weight_kg: Math.round(weight * 10) / 10,
  };
}

function formatFtIn(cm: number, round: 'up' | 'down'): string {
  const total = round === 'up' ? Math.ceil(cmToIn(cm)) : Math.floor(cmToIn(cm));
  return `${Math.floor(total / 12)} ft ${total % 12} in`;
}
