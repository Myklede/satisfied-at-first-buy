// Fit Lab / Studio palette (agent U, prompts/33). Calm retail look: warm neutrals, near-black text,
// four restrained fit tones. The CSS mirrors these values as custom properties on .fl-root and
// :root of studio.html; keep the two in sync.
export type Tone = 'tight' | 'snug' | 'good' | 'loose' | 'info';

export const THEME = {
  bg: '#F5F3EF',
  bgDeep: '#ECE9E3',
  card: '#FFFFFF',
  line: 'rgba(29, 29, 31, 0.10)',
  text: '#1D1D1F',
  textSoft: '#6E6E73',
  accent: '#2F4A3F',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
} as const;

/** Fit tones, used sparingly (a dot, a word, a leader line). */
export const TONE_COLOR: Record<Tone, string> = {
  tight: '#E5484D', // soft coral
  snug: '#E8A33D', // amber
  good: '#3E8E6A', // sage
  loose: '#5B7BA6', // slate blue
  info: '#6E6E73',
};
