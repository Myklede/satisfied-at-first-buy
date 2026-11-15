// Display helpers. The service computes in centimetres; inches = cm / 2.54 (exact definition).
export const IN_PER_CM = 1 / 2.54;
export const LB_PER_KG = 1 / 0.45359237; // international avoirdupois pound, exact

export function signed(value: number, digits = 1): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : text;
}

/** "+5.1 cm (+2.0 in)" */
export function cmIn(cm: number | null | undefined): string {
  if (cm === null || cm === undefined) return '—';
  return `${signed(cm)} cm (${signed(cm * IN_PER_CM)} in)`;
}

export function inToCm(inches: number): number {
  return inches * 2.54;
}

export function lbToKg(pounds: number): number {
  return pounds * 0.45359237;
}

const STATUS_WORDS: Record<string, string> = {
  fit: 'fits',
  tight: 'tight',
  relaxed: 'roomy',
  too_big: 'too big / long',
  unknown: 'not in chart',
};

export function statusWord(status: string | null | undefined): string {
  return status ? (STATUS_WORDS[status] ?? status) : '—';
}
