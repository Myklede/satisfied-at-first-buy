// Constants of the padded hood layer (agent H). Hood dimensions themselves are baked into the GLBs
// by scripts/blender/hood_config.py (every value there carries its photo source and uncertainty).

export const HOOD = {
  /**
   * Baked GLBs (apps/web/public/assets/hoods, built by scripts/blender/hood_build.py) per
   * render_details.hood_kind: 1 = sewn-in (parka FB7675-100), 2 = removable (puffer DQ4920-206).
   * The cloth asset carries no product id, so a future product of the same hood kind would get
   * the same baked hood until it has its own bake (STATUS known gap).
   * `?v=` is the first 8 hex of the GLB's SHA-256 (agent H2): the kiosk server serves /assets/
   * as immutable for 7 days and these names carry no hash, so a re-bake would otherwise stay
   * hidden behind the kiosk Chrome's cache. hoodSweep.test.ts fails until it matches the file.
   */
  assets: {
    1: '/assets/hoods/parka.glb?v=54793fa5',
    2: '/assets/hoods/puffer.glb?v=e09f4dc8',
  } as Record<number, string>,
  /**
   * Shell seam on the displayed surface: the shader pushes the collar out along its normal by up
   * to the loft; the hood's seam is centred half-way (same as hood_config.SEAM_LOFT_FRACTION).
   */
  seamLoftFraction: 0.5,
  /** Seam-fit scale bounds: a hood is graded with its jacket, never squashed or blown up. */
  minScale: 0.85,
  maxScale: 1.2,
  /** Peel frontier width (fraction of the zip), same as hood_config "peel_width". */
  peelWidth: 0.35,
  /** Positions of the baked detach keys (down, peel25, peel50, peel75, detached). */
  keyNames: ['peel25', 'peel50', 'peel75', 'detached'] as const,
  keyPositions: [0, 0.25, 0.5, 0.75, 1] as const,
  /**
   * Lining and trim colours (spec docs/look/jacket-reference-spec.md): parka lining white smooth
   * taffeta, black binding round the face opening; puffer lining the same beige (null = shell
   * colour), self-colour binding; black velcro; silver/gunmetal zip tape.
   */
  trim: {
    'FB7675-100': { lining: '#f1f1ef', binding: '#121212' },
    'DQ4920-206': { lining: null, binding: null },
  } as Record<string, { lining: string | null; binding: string | null }>,
  velcro: '#151515',
  zip: '#8c8f94',
  /** Stitch thread: half-width (m) of a drawn line and how much it darkens (look values). */
  stitchHalfWidthM: 0.0012,
  stitchDarken: 0.12,
  /** Valley shading either side of a panel seam (material m) and its depth (look values). */
  seamValleyM: 0.012,
  seamValleyDarken: 0.12,
  /**
   * Crinkle gain over the jacket's crinkleStrength (the hood has no chamber relief to break the
   * highlight) and a soft larger wrinkle (normal tilt). Look values, judged in the sandbox.
   */
  crinkleGain: 1.5,
  wrinkle: 1.2,
} as const;
