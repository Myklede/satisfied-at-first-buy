// Size labels → canonical names. Same table as the service (body_service/agent/rules.py:
// canonical_size), so chart rows and the page's size selector match the same way.
const SIZE_WORDS: [RegExp, string][] = [
  [/^(?:xxxxx-?large|5x-?large|5xl|5x)$/, '5XL'],
  [/^(?:xxxx-?large|4x-?large|4xl|4x)$/, '4XL'],
  [/^(?:xxx-?large|3x-?large|3xl|3x|xxxl)$/, '3XL'],
  [/^(?:xx-?large|2x-?large|2xl|2x|xxl)$/, '2XL'],
  [/^(?:x-?large|extra[- ]large|xl)$/, 'XL'],
  [/^(?:large|l|lg)$/, 'L'],
  [/^(?:medium|m|md|med)$/, 'M'],
  [/^(?:small|s|sm)$/, 'S'],
  [/^(?:x-?small|extra[- ]small|xs)$/, 'XS'],
  [/^(?:xx-?small|2x-?small|xxs|2xs)$/, 'XXS'],
];

export function canonicalSize(label: string): string | null {
  let text = label.replace(/\s+/g, ' ').trim().toLowerCase();
  text = text.replace(/\s*\(.*?\)\s*/g, '');
  text = text.replace(/\b(?:us|uk|eu|size)\b[: ]*/g, '').trim();
  for (const [pattern, name] of SIZE_WORDS) if (pattern.test(text)) return name;
  if (/^\d{1,2}(?:\.\d)?$/.test(text)) return text;
  return null;
}

/** Index of the label that names `size` (canonical comparison), or -1. */
export function matchSize(labels: string[], size: string): number {
  const wanted = canonicalSize(size) ?? size;
  return labels.findIndex((label) => canonicalSize(label) === wanted);
}
