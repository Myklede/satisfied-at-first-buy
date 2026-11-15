// Pure mapping from the Studio garment state to what Decart can show: one reference image plus a
// prompt. Decart only takes discrete states (no mask/pose/garment-state input), so the continuous
// zip goes through zipStage() with hysteresis, and set() calls are throttled.
import type { JacketId, SizeLabel, ZipStage } from './contract';

/** File-name slug per jacket: references are `<slug>-<closed|half|open>[-nohood].<png|jpg|webp>`
 *  in apps/web/public/local-textures/decart/ (gitignored). */
export const JACKET_SLUG: Record<JacketId, 'parka' | 'puffer'> = {
  'FB7675-100': 'parka',
  'DQ4920-206': 'puffer',
};

/** Short garment descriptions for the prompt (Decart's docs: be specific, ~20-30 words). From the
 *  product pages and the user's own photos of the two jackets. */
export const JACKET_TEXT: Record<JacketId, string> = {
  'FB7675-100':
    'long white quilted Nike Therma-FIT parka with horizontal quilting, a black front zipper and black zip pockets',
  'DQ4920-206':
    'cream light-beige boxy Nike down puffer jacket with wide baffles, a funnel collar and small black tabs along the front placket',
};

const ZIP_TEXT: Record<ZipStage, string> = {
  closed: 'zipped all the way up to the collar',
  half: 'unzipped halfway, open from the chest up',
  open: 'fully unzipped and hanging open, showing the top underneath',
};

/** Closed-state wording per jacket: the puffer's tall funnel collar zips up to the chin (the demo:
 *  the judge zips it fully and our Fit Lab shows the collar tight at the neck). */
const CLOSED_TEXT: Record<JacketId, string> = {
  'FB7675-100': ZIP_TEXT.closed,
  'DQ4920-206':
    'zipped all the way up, the tall funnel collar closed snugly around the neck up to the chin',
};

function zipText(jacket: JacketId, stage: ZipStage): string {
  return stage === 'closed' ? CLOSED_TEXT[jacket] : ZIP_TEXT[stage];
}

const FIT_TEXT = {
  tight: 'fitting snugly, slightly tight across the chest and shoulders',
  good: 'with a regular, comfortable fit',
  loose: 'fitting loosely, roomy and oversized on the body',
} as const;
export type FitLabel = keyof typeof FIT_TEXT;

export interface RefChoice {
  file: string;
  /** What the chosen image actually shows (may differ from the request when a file is missing). */
  stage: ZipStage;
  hoodOn: boolean;
  exact: boolean;
}

const STAGE_ORDER: Record<ZipStage, ZipStage[]> = {
  closed: ['closed', 'half', 'open'],
  half: ['half', 'closed', 'open'],
  open: ['open', 'half', 'closed'],
};
const EXT_ORDER = ['png', 'jpg', 'jpeg', 'webp'];

/** Best available reference for the requested state: exact first, then the same zip stage with the
 *  other hood state, then the nearest zip stage. Null when the jacket has no reference at all. */
export function chooseReference(
  files: readonly string[],
  jacket: JacketId,
  stage: ZipStage,
  hoodOn: boolean,
): RefChoice | null {
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const slug = JACKET_SLUG[jacket];
  for (const s of STAGE_ORDER[stage]) {
    for (const h of [hoodOn, !hoodOn]) {
      for (const ext of EXT_ORDER) {
        const name = `${slug}-${s}${h ? '' : '-nohood'}.${ext}`;
        const file = lower.get(name);
        if (file) return { file, stage: s, hoodOn: h, exact: s === stage && h === hoodOn };
      }
    }
  }
  return null;
}

/** The prompt for the state Decart is asked to show. `fit` comes only from our engine's verdict
 *  (FitLabPanel.verdict) for the selected size; it is omitted when there is none. */
export function buildPrompt(
  jacket: JacketId,
  stage: ZipStage,
  hoodOn: boolean,
  size: SizeLabel,
  fit: FitLabel | null,
): string {
  const hood = hoodOn
    ? 'with its hood attached, resting behind the neck'
    : 'shown as the same jacket with its hood detached and removed; only the tall funnel collar ' +
      'remains, no hood behind the head';
  const fitText = fit ? `, size ${size}, ${FIT_TEXT[fit]}` : '';
  return (
    `Replace the top with the ${JACKET_TEXT[jacket]} from the image, ${zipText(jacket, stage)}, ` +
    `${hood}${fitText}. Keep the person, face, hands and background unchanged.`
  );
}

/** Throttle for set(): at most one call per `minGapMs`, always ending on the latest request, and
 *  no call when the request equals what was last applied. Pure; the view owns the timer. */
export class SetThrottle {
  private lastKey: string | null = null;
  private lastFireAt = Number.NEGATIVE_INFINITY;
  private pendingKey: string | null = null;

  constructor(readonly minGapMs = 400) {}

  /** Ms to wait before calling take() (0 = now), or null when nothing needs to be sent. */
  request(key: string, now: number): number | null {
    if (key === this.lastKey) {
      this.pendingKey = null;
      return null;
    }
    this.pendingKey = key;
    return Math.max(0, this.lastFireAt + this.minGapMs - now);
  }

  /** The key to apply now (marks it applied), or null when the request was withdrawn. */
  take(now: number): string | null {
    const key = this.pendingKey;
    if (key === null) return null;
    this.pendingKey = null;
    this.lastKey = key;
    this.lastFireAt = now;
    return key;
  }

  /** Forget what was applied (new session: the first state must be sent again). */
  reset(): void {
    this.lastKey = null;
    this.pendingKey = null;
    this.lastFireAt = Number.NEGATIVE_INFINITY;
  }
}
