/**
 * Look-dev configuration for the garment renderer (agent L). RENDERING ONLY: nothing here moves
 * the tape-derived inner (fit) surface. Relief is drawn outward from that surface, inside the
 * product's taped loft; detail meshes are render-only and bound to garment triangles.
 *
 * Two kinds of numbers live here:
 * - `photo_estimate`: measured by Claude on the retailer product photos (analysis only, never
 *   copied into the repo), scaled to centimetres by a sourced length. Approximate; the user may
 *   override them with a tape. Method is written next to each value.
 * - look conventions: unmeasured shading parameters (roughness, wrinkle amplitude, ...). They
 *   change how a sourced feature looks, never where it is or how big it is.
 */

export type Finish = 'glossy_ripstop' | 'satin_matte';

/** Photo estimates for features the product `visual` schema has no field for. */
export const detailEstimates = {
  /**
   * DQ4920-206 angled welt pocket: horizontal position and slant. photo_estimate, approximate.
   * Method: front catalogue photo (dq_grid, Cave Purple colourway of the same pattern), scale from
   * the sourced 14.5 cm chamber pitch (130 px between stitch lines -> 0.1115 cm/px). Upper end of
   * the welt sits 140 px (15.6 cm projected, ~17 cm arc) from the centre-front line; the welt
   * runs 125 px down and 50-75 px outward (26 deg from vertical). Its top lands on the second
   * chamber stitch line, 35.7 cm below HPS, agreeing with the sourced pocket_top 37 +- 2 cm.
   */
  puffer: {
    pocketArcFromCfM: 0.17,
    pocketArcUncertaintyM: 0.02,
    pocketSlantDeg: 26,
    pocketSlantUncertaintyDeg: 6,
  },
  /**
   * FB7675-100 slanted zip pocket: horizontal position and slant of its top end.
   * photo_estimate, approximate. Method (agent L1a): the user's own worn-front photo Parka1,
   * 0.203 cm/px (74 px stitch pitch = 15 cm). The slit's top end sits 92 px from the zip
   * (18.7 cm projected, ~19 cm arc); a line fitted to the black tape over its length leans
   * 12 deg from vertical (11.9 and 12.5 deg on the two sides), lower end outward. (Earlier
   * retailer-photo estimate: 16 cm, vertical.) Top and length are in the product `visual` block.
   * Agent L2: Parka1 rescaled to 0.135 cm/px (74 px stitch pitch = 10 cm, measured against a US
   * Letter sheet in parka-a4-1/3; the 15 cm pitch behind 0.203 cm/px was an assumed scale):
   * 92 px -> 12.4 cm.
   */
  parka: {
    pocketArcFromCfM: 0.125,
    pocketArcUncertaintyM: 0.02,
    pocketSlantDeg: 12,
    pocketSlantUncertaintyDeg: 3,
  },
  /**
   * FB7675-100 hood drawcord exits/toggles: +-3 cm either side of the zip at the top of the
   * collar (p10: toggles at x = 442 / 480 px around the zip at 465 px, 0.1515 cm/px).
   * photo_estimate, approximate. Toggle size is a look convention (no tape).
   */
  parkaToggleArcFromCfM: 0.03,
  /**
   * FB7675-100 logos (agent L1a, from the user's own photos in data/reference-photos, local only).
   * photo_estimate, approximate. Vertical position is not a number here: in Parka1 (worn front)
   * and Parka2 (worn back) both the chest logo and the back swoosh sit centred in the first
   * quilting chamber below the yoke stitch line, so they follow the product's yoke_depth and
   * chamber_height.
   * - Agent L2, US Letter flat-lays (parka-a4-1 front, 36.6 px/cm; parka-a4-3 back, 28.3 px/cm at
   *   display size): chest logo 230 px wide -> 6.3 cm, its centre 310 px (8.5 cm) from the zip
   *   centre, mid-way between the yoke stitch and the next; back swoosh 765 px -> 27 cm. Parka1
   *   rescaled to the 10 cm pitch agrees (45-48 px x 0.135 = 6.1-6.5 cm). The values below the
   *   original notes are these; the notes are kept for the record.
   * - Chest NIKE wordmark + swoosh, wearer's left: Parka1 scale 0.203 cm/px (74 px stitch pitch =
   *   15 cm chamber_height): logo 45-48 px wide -> 9.1-9.7 cm. Its centre sits mid-chest, 0.54
   *   of the way from the zip (x 286) to the sleeve seam (x 410) in Parka1. The real jacket's
   *   dropped shoulder puts that seam ~25 cm out, so the logo centre is ~13.5 cm from the zip
   *   there; the shown shell's set-in armhole is nearer (0.19-0.22 m from CF at the logo's top
   *   edge on S/M and a 155 cm body, 0.27 m on XL; measured on the shown shells by agent L1a),
   *   and 13.5-14.5 cm put the logo on the sleeve seam. Kept mid-chest in metres: centre 11 cm
   *   from CF (0.51-0.55 of the way on S/M, 0.41 on XL). +-1.5 cm.
   * - Back printed swoosh, centred on CB: Parka2 (straight-on back view) 482 px wide; scale
   *   0.083 cm/px from both the 180 px stitch pitch (15 cm) and the 720 px shoulder width
   *   (taped 60 cm) -> 40 cm. +-3 cm. (The spec's "40 % of the back width" guess is superseded.)
   * - "THERMA-FIT" embroidery on the left forearm, back-outer side, reading cuff -> shoulder with
   *   the letter tops toward the outer line (Parka2, Parka6): starts ~8 cm above the cuff edge;
   *   cap height ~0.95 cm (Parka5 close-up: 65 px caps on a 760 px line ≈ 11.7 cap heights,
   *   about 11 cm); centred ~2.5 cm behind the outer line. +-2 cm on position, +-0.2 cm on size.
   */
  parkaLogos: {
    chestLogoArcFromCfM: 0.085,
    chestLogoWidthM: 0.063,
    backSwooshWidthM: 0.27,
    sleeveLetteringFromCuffM: 0.08,
    sleeveLetteringCapM: 0.0095,
    sleeveLetteringBehindOuterM: 0.025,
  },
  /**
   * DQ4920-206 tonal embroidered swoosh, wearer's left chest (Puffer2, Nike studio photo):
   * scale 0.0644 cm/px (225 px stitch pitch = 14.5 cm chamber_height; the 6.5 cm placket reads
   * 6.1 cm at this scale). Swoosh 75 px wide -> 4.8 cm; centre 157 px from the placket centre
   * -> 10.1 cm projected (~10.5 cm arc); 44 % of the way down the first chamber below the yoke.
   * photo_estimate, approximate (+-1 cm).
   */
  pufferLogos: {
    chestSwooshArcFromCfM: 0.105,
    chestSwooshWidthM: 0.048,
    chestSwooshChamberFraction: 0.44,
  },
  /**
   * DQ4920-206 main zip and pull (agent L3, the user's photos; photo_estimate, approximate).
   * - Pull: a gunmetal plate, tapered, with a debossed swoosh at its wide end, on a gunmetal
   *   slider (puffer-a4-1, the same pull on the hood zip at the collar side; puffer-a4-4, on the
   *   open main zip). On puffer-a4-1 at the sheet's ~43 px/cm (the collar stands above the sheet
   *   plane, so +-30 %): plate ~124 px long, 37 px wide at its narrow end -> 2.7 x 0.8 cm, ~1.2 cm
   *   at the swoosh end; slider ~60 px -> 1.4 cm.
   * - Where the closed zip shows: the metal zip runs under the storm placket and shows only as a
   *   dark slit at the placket's free edge (wearer's right), over its last ~5 cm above the hem
   *   (Puffer2: 74 px at ~0.06 cm/px -> 4.4 cm) and at the collar top (Puffer2, video t 16 s).
   */
  pufferZip: {
    pullLengthM: 0.027,
    pullWidthM: 0.012,
    pullNarrowM: 0.008,
    sliderLengthM: 0.014,
    showAboveHemM: 0.045,
    showBelowCollarTopM: 0.025,
  },
};

/** Shading conventions per finish (unmeasured look parameters). */
export const look = {
  /** Half-width of a pinched quilting stitch valley. */
  grooveHalfWidthM: { glossy_ripstop: 0.004, satin_matte: 0.0045 },
  /**
   * Chamber cross-section (agent L1b, matched by eye to the user's photos in
   * data/reference-photos; look conventions, no tape): at material distance d from the nearest
   * stitch line, h = valley + (1 - valley) * sin(pi/2 * min(d / dip, 1))^exponent, where dip =
   * `chamberDipWidthM` (0 = half the pitch: a full round tube).
   * - glossy_ripstop = DQ4920-206 (Puffer1-3): high loft, big smooth baffles with broad crowns and
   *   soft valleys (agent L2): valley 0.55, dip 5 cm, exponent 1. Puffer3 (studio back) read down
   *   the centre back: crowns ~205/255, a gradual fall to ~0.83 of the crown over the last ~5 cm
   *   above each stitch, then a narrow dip; L1b's full-pitch round tube (valley 0.22, exponent
   *   0.65) drew pillows with deep valleys under the kiosk key light.
   * - satin_matte = FB7675-100 (Parka1-7): low loft, nearly flat between the stitch lines with a
   *   gentle dip about 2 cm wide at each. Parka1 (worn front, 0.203 cm/px): the wearer's right
   *   sleeve outline runs straight to within 1-2 px (<= 0.2-0.4 cm) across its stitch lines, so
   *   on the 1 cm loft the valley is >= ~0.65; 0.75 matched Parka2's calm back by eye under the
   *   kiosk light (L2; L1b's 0.3 / 3 cm read as pillows).
   */
  chamberValley: { glossy_ripstop: 0.55, satin_matte: 0.75 },
  chamberDipWidthM: { glossy_ripstop: 0.05, satin_matte: 0.02 },
  chamberExponent: { glossy_ripstop: 1, satin_matte: 1 },
  /**
   * Sleeve (and hood) chamber cross-section, same formula (agent L2). A sleeve is a closed tube:
   * hoop tension in the outer shell pulls its stitch valleys shallow, so its silhouette is
   * nearly straight. Measured on Puffer2 (Nike studio front, 0.0644 cm/px from the 14.5 cm body
   * pitch): the wearer's left sleeve outline dips 6-10 px (0.4-0.65 cm) at each of its stitch
   * lines, pitch 160 px (10.3 cm, = the 10.5 cm sleeve_chamber_height). On the 2.75 cm loft that
   * is a valley of 1 - 0.55 / 2.75 = 0.8 (0.76-0.85). The dip is a soft crease ~3.5 cm wide;
   * the crown between is broad and flat. Parka: Parka1's sleeve outline (above) gives >= 0.65;
   * 0.78 on the sleeve (by eye against Parka2/Parka5).
   * Agent L3, puffer: at 0.8 / 3.5 cm the sleeves still read as a stack of rings at kiosk
   * distance. Cause, by A/B in the sandbox: not the GTAO pass, the shadows, the crevice AO or the
   * gloss (each off/changed alone left the rings), but the shading slope of the broad valley under
   * the high key light; a narrow crease (0.82 / 1.2-2 cm) drew sharp dark rings instead. 0.9 /
   * 2.5 cm reads as Puffer2's relaxed tube with soft lines. Its outline dips 0.28 cm per stitch,
   * below the 0.4-0.65 cm read on Puffer2 above: a look trade-off, said so in docs/STATUS.md (L3).
   */
  sleeveValley: { glossy_ripstop: 0.92, satin_matte: 0.78 },
  /**
   * Sleeve valley of the displaced geometry (outline, shadows, screen-space AO), separate from the
   * shading valley above (L3, lead's idea): the outline keeps the measured dip, 1 - 0.82 = 0.18 of
   * the 2.75 cm loft = 0.50 cm per stitch (Puffer2: 0.4-0.65 cm), while the shading slope comes
   * from the shallower profile that does not band under the key light.
   */
  sleeveGeomValley: { glossy_ripstop: 0.82, satin_matte: 0.78 },
  sleeveDipWidthM: { glossy_ripstop: 0.025, satin_matte: 0.02 },
  sleeveExponent: { glossy_ripstop: 1, satin_matte: 1 },
  /**
   * Sleeve shading (agent L3; look conventions, tuned by eye against Puffer2 and the user's video
   * at kiosk distance). The sleeve's stitch lines are soft creases on a relaxed tube: its crevice
   * occlusion, thread line and stitch pinches are scaled by these factors (1 = the torso's), the
   * stitch lines wander by `sleeveWander` of the pitch (sewn straight on the flat pattern, they
   * bend round the worn tube) and gentle folds `sleeveFold` (fraction of the loft, noise of
   * wavelength `sleeveFoldScaleM`) break the regular stack of rings.
   */
  sleeveCreaseAO: { glossy_ripstop: 0.3, satin_matte: 1 },
  sleeveThread: { glossy_ripstop: 0.3, satin_matte: 1 },
  sleevePinch: { glossy_ripstop: 0.4, satin_matte: 1 },
  sleeveWander: { glossy_ripstop: 0.15, satin_matte: 0 },
  sleeveFold: { glossy_ripstop: 0.3, satin_matte: 0 },
  sleeveFoldScaleM: 0.11,
  /**
   * Relative chamber-to-chamber loft irregularity (filling is never perfectly even). Small: in the
   * photos neighbouring tubes are the same size; 0.12/0.08 read as uneven lumps (user, L1b).
   */
  chamberIrregularity: { glossy_ripstop: 0.04, satin_matte: 0.03 },
  /**
   * Pinch wrinkles fanning out of the stitch valleys: reach, wavelength, amplitude/loft. The
   * shader scales the amplitude by the valley depth (1 - valley): the parka's 0.4 keeps its
   * stitch-line puckers (Parka3/7) visible on its shallow 0.75 valley (L2).
   */
  pinchReachM: { glossy_ripstop: 0.022, satin_matte: 0.02 },
  pinchWavelengthM: { glossy_ripstop: 0.026, satin_matte: 0.032 },
  pinchAmplitude: { glossy_ripstop: 0.2, satin_matte: 0.4 },
  /** Fine crinkle of the shell fabric (breaks the specular into shards); normal tilt. */
  crinkleScaleM: { glossy_ripstop: 0.045, satin_matte: 0.05 },
  crinkleStrength: { glossy_ripstop: 0.16, satin_matte: 0.05 },
  /**
   * Stacking-fold wavelength (uncalibrated; grows with padding stiffness). Plain (unquilted)
   * fabric only: on quilted panels the chambers themselves take the stacking (their phase runs on
   * the material arc); a second fold wave there beat against the chambers (L1b).
   */
  foldWavelengthM: { glossy_ripstop: 0.06, satin_matte: 0.045 },
  /** Elastic gathers: mean period of the bunched puckers. */
  gatherPeriodM: 0.02,
  /**
   * Elastic-gather relief (fraction of the loft). The DQ4920-206 banded hem and cuffs read smooth
   * in Puffer1-3 (no visible gathers; 0.19 drew a ruffle, the "frayed" hem); the FB7675-100's
   * shirred inner hem is shaded in the colour pass. Look convention (L1b).
   */
  elasticGatherAmplitude: { glossy_ripstop: 0.03, satin_matte: 0.19 },
  /**
   * Side-seam dent (fraction of the relief removed at the seam). The puffer's baffles wrap round
   * the side (Puffer2/3); the parka shows side panel seams (Parka2/6). Look convention (L1b).
   */
  sideSeamDepth: { glossy_ripstop: 0.12, satin_matte: 0.55 },
  /**
   * Relief (fraction of the loft) on a construction seam between charts (armhole, hood root),
   * blended in over 3 cm. 0.3 drew a flat 3 cm ring round the armhole, read as a padded
   * "epaulette" block on each shoulder from the front; Puffer2's dropped shoulder seam is barely
   * visible (look convention, L2).
   */
  seamRelief: 0.6,
  /** Inner-elastic cuff: length of the gathered zone at the sleeve end (parka, photo look). */
  innerCuffGatherM: 0.045,
  /** Ripstop grid / weave micro-normal tile (canvas tile in metres; ripstop cell = tile / 8). */
  weaveTileM: 0.04,
  /**
   * Hook-and-loop tab width round the cuff, as seen on the outside (Puffer2: 45 px at the
   * 0.056-0.062 cm/px of the 12.6-13.9 cm front channel pitch -> 2.5-2.8 cm; L3). The shader
   * converts it to the inner-surface arc it is charted on (L3: drawn on the lofted surface, the
   * inner arc read ~1.5x wider: a 4 cm black block).
   */
  cuffTabArcM: 0.026,
  /** Its length up the sleeve from the cuff edge (Puffer2: >= 49 px, cut by the frame; L1b 3.5 cm). */
  cuffTabLengthM: 0.035,
  /** Relief height of the tab (fraction of the loft), also used to convert its width. */
  cuffTabRelief: 0.7,
  /** Welt / zip-pocket construction (look conventions). */
  weltWidthM: 0.012,
  /** Parka hood centre panel width (look convention: no tape; reads in the back photos). */
  hoodCentrePanelM: 0.12,
  /**
   * Parka hood worn down: the padded face-opening edges stand round the neck (render-only
   * proxy until the shell builds the hood's front; look conventions, uncalibrated): no edge
   * within `hoodRimOpeningM` of the zip; each edge runs `hoodRimLengthM` of collar arc to where
   * the folded hood starts, rising to `hoodRimRiseM` above the collar over `hoodRimRampM`,
   * padded edge radius `hoodRimRadiusM`, standing `hoodRimGapM` off the collar.
   */
  hoodRimOpeningM: 0.02,
  hoodRimLengthM: 0.13,
  hoodRimRampM: 0.045,
  hoodRimRiseM: 0.008,
  hoodRimRadiusM: 0.013,
  hoodRimGapM: 0.002,
  /**
   * Specular anti-aliasing strength (screen-space normal variance -> roughness, Tokuyoshi &
   * Kaplanyan 2019; 1 = the paper's sigma^2 = 0.5 filter). Look convention.
   */
  specularAntiAliasing: 1,
  /** Inside of the shell (lining) is darker: it is never lit from inside. */
  liningShade: 0.38,
};

/**
 * Physically based material parameters per finish (look conventions, tuned on renders).
 * Glossy ripstop (agent L2, matched to the DQ4920 catalogue photos, analysis only): satin
 * nylon is rough enough (0.4) for one broad highlight per chamber crown. No anisotropy: three
 * builds its tangent from screen derivatives of the uv, constant per triangle, which stretched
 * the highlight into streaks and shards along the stitch rows. No clearcoat (a second sharp
 * lobe read as cling film). A faint sheen only; envMapIntensity < 1.3 keeps the colour from
 * washing to cream.
 */
export const materials = {
  glossy_ripstop: {
    // L2: the user's flat-lays (puffer-a4-1..4) show semi-gloss crinkled nylon with sharp-ish
    // crown highlights and fine wrinkles into each stitch (lead's spec update): roughness 0.4 -> 0.3,
    // sheen 0.12 -> 0.2, crinkle 0.1 -> 0.16, stitch pinches 0.09 -> 0.2 (x valley depth).
    roughness: 0.3,
    specularIntensity: 1,
    envMapIntensity: 0.95,
    clearcoat: 0,
    clearcoatRoughness: 0.3,
    sheen: 0.2,
    sheenRoughness: 0.45,
    anisotropy: 0,
    normalScale: 0.07,
  },
  satin_matte: {
    roughness: 0.62,
    specularIntensity: 0.55,
    envMapIntensity: 1,
    clearcoat: 0,
    clearcoatRoughness: 0.5,
    sheen: 0.3,
    sheenRoughness: 0.55,
    anisotropy: 0.15,
    normalScale: 0.2,
  },
} satisfies Record<Finish, Record<string, number>>;
