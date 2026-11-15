"""Every number of the padded hood bake (agent H), with its source.

Nobody measured the hoods with a tape. Every hood dimension below is **estimated from photos**
(the user's photos in ``data/reference-photos/`` and the video frames indexed in
``docs/look/video-index.md``) or from the reference body's proportions. Each carries its
uncertainty (``±``). The photo-plane ruler (``body_service.lookdev.scale``) has no valid sheet in
any hood photo (``docs/look/photo-measurements.md``: "Hood width / depth / opening: not
measurable"), so scale comes from the taped jacket widths and from the head inside the hood.

Frames: metres, Y up, +Z = body front, +X = the wearer's left (shell.py convention). The hood
is built in the reference shell's frame, so on that body the engine's seam fit is ~identity.

Taped anchors used for scale (``data/products``, user tape, owned size S):
- parka FB7675-100 shoulder 60 cm, loft 1.0 cm;
- puffer DQ4920-206 shoulder 47 cm, funnel collar 35 cm inner / 8 cm high, loft 2.75 cm.
"""

from __future__ import annotations

# Reference body and size: the look sheets of L1b/L2 (female 168 cm / 62 kg, size M, t-shirt).
REFERENCE_BODY = {
    "sex": "female",
    "height_cm": 168.0,
    "weight_kg": 62.0,
    "size": "M",
    "layer": "t-shirt",
}
# The shader pushes the collar's displayed surface out along its normal by up to the loft; the
# hood's seam (which has its own thickness) is centred half-way (L2 garmentShader displacement).
SEAM_LOFT_FRACTION = 0.5
# Collision references (body, jacket) are cropped below this height (m): the hood never reaches.
REFERENCE_CROP_Y_M = 1.05

# Mesh resolution: columns across (corner to corner) and rows (neck seam to face edge).
SIDE_COLUMNS = 22  # per side panel
GUSSET_COLUMNS = 22
ROWS = 46
RIM_SAMPLES = 7  # half-round bound face edge
NECK_SAMPLES = 5  # closed neck edge (zip tape / sewn seam allowance)

# Reference head: half its front-back depth (m) about head_centre (top_of_head - 10 cm): the
# reference body's head spans z -5.0 .. +14.3 cm at 1.60 m (measured on the body mesh).
HEAD_HALF_DEPTH_M = 0.095

# Head clearance in the worn-up construction pose (m), body-proportional estimate: the hood's
# inner face clears the reference head by this much behind/above/beside it.
HOODS = {
    "FB7675-100": {
        "name": "parka",
        "removable": False,
        # Shell + lining + thin fill. Estimated from Parka7 (flat-laid hood edge) and the product's
        # taped loft (1.0 cm); prompt range 0.6-1 cm. 0.8 ± 0.2 cm.
        "thickness_m": 0.008,
        # Outer width across the hood worn up (back view), 24 ± 3 cm: video 233 s (hood up, back),
        # hood ~0.41 of the 60 cm taped shoulder line; head breadth 16.6 cm (reference body, ears)
        # + 2 x 0.8 cm loft + ~2 x 2.5 cm ease.
        "half_width_m": 0.112,
        # Gusset (centre panel) width 12.5 ± 2.5 cm: Parka7, gusset ~0.455 of the flat hood width;
        # flat width 28 ± 4 cm from Parka6 (hood ~0.47 of the 60 cm shoulder line, oblique view).
        "gusset_width_m": 0.125,
        # Sagittal outline of the hood worn up (mid-surface), reference-body frame: back -11 cm
        # (head back -5.0 cm + 4.5 cm room + half thickness: hoods hang off the back of the head;
        # video 229-236 s side views), front (forehead edge) +15 cm (forehead +14.3 cm), top
        # 4 ± 2 cm above the head top (padding + ease, video 222-250 s: a modest peak).
        "outline": {"z_back": -0.11, "z_front": 0.15, "y_top": 1.722, "y_bottom": 1.36},
        "outline_exponent": 2.4,  # rounded-rectangular dome (video 232-234 s, Parka2)
        "lateral_exponent": 2.8,  # flat-ish sides, flat gusset top (Parka7)
        # Angle of the face opening plane through the corners (deg from +Z toward +Y): the edge
        # rises from the zip top to the forehead (video 225-244 s). 76 ± 6 deg.
        "face_angle_deg": 76.0,
        # The face opening is a little narrower than the wall (video 225-244 s).
        "face_narrowing": 0.08,
        # Quilting: lines across the gusset and both side panels (Parka7: horizontal lines in a
        # back view of the flat hood), pitch 9 ± 2 cm on the gusset (Parka7: ~0.85 of the body's
        # 10.2 cm channel, photo-measurements.md). Line positions start one pitch from the seam.
        "quilt_pitch_m": 0.09,
        # Low-loft channels (L2 parka chamber: valley 0.75 of the crown over ~2 cm).
        "puff_m": 0.004,
        "puff_valley": 0.7,
        "puff_rise_m": 0.02,
        # Black binding round the face opening (spec: "hood edge and zip trimmed in black";
        # video 222-250 s), 1.2 ± 0.3 cm visible on each side.
        "binding_m": 0.012,
        "binding_black": True,
        "tabs": False,
        # Hood down: rolls back about the back-neck seam and rests on the yoke above the swoosh
        # (video 35-38 s: a thick rolled cushion standing back from the neck, top near ear height;
        # Parka2/6/7). Angle tuned by eye against those frames.
        "down_angle_deg": 25.0,
        # Without a head the front falls back behind the head: depth in front of the plane behind
        # the head and height above the neck seam kept (video 35-38 s: a cushion standing behind
        # the neck, top near ear height). By eye against those frames.
        "down_depth_keep": 0.45,
        # Agent CH (2026-11-13, the user's live test: "the hood-down reads as a funnel round the
        # neck"), measured with the hood fitted on the user's own shell (a male test body, S):
        # - video 38 s (back): the hood's top is 8.4 ± 1.5 cm below the top of the user's hair
        #   (hair width as the ruler), i.e. about 5.4-7.4 cm below the scalp with 1-3 cm of hair;
        #   the height kept (0.58) puts it 6.9 cm below Anny's vertex, inside that range (0.53
        #   put it 8.4 cm below: too low once the hair is counted).
        # - video 26/31 s (front): the hood beside the neck reaches about the chin, its opening
        #   edges chin -0.7..+1.9 cm. The corner strips near the zip ends kept their height and
        #   rose beside the jaw (front-half top chin +5.2 cm); dropping the height kept there
        #   (corner drop, over the outer 30 % of the width) brings that to chin +3.1 cm (0.6
        #   crossed the jacket on the 150/45 male body in the gate sweep).
        # Baked on H2's reference shell (.cache/h2/ref; the parka's seam is unchanged by CH). A
        # reference rebuilt from the v30 shell code moved the bake enough that the hood crossed
        # the jacket on the 195/110 and 150/45 bodies (gate sweep); this one passes it.
        "down_height_keep": 0.58,
        "down_corner_drop": 0.45,
        "corner_ramp": (0.015, 0.3),
        # The sides fall in toward the top (video 37-38 s: a round dome, about head-wide at the
        # top); 0.4 (CH) keeps the dome round with its top behind the head from the front.
        "down_top_squeeze": 0.4,
        "down_squeeze": 0.0,
        "collapse_corner_ramp": 0.15,  # fade the collapse at the corner strips (crimps)
        # Blender cloth settle (gravity, pinned seam band, jacket + body colliders) was tried and
        # is off: on the 1 cm grid the stiff sheet still buckled into small ripples (the mush the
        # user rejected); on a 4 cm cage it went unstable. Modelled roll-back instead.
        "settle_frames": 0,
        "settle_mass_kg": 0.18,  # whole hood, shell + lining + fill (estimate, ±0.06 kg)
        "settle_bending": 2000.0,
    },
    "DQ4920-206": {
        "name": "puffer",
        "removable": True,
        # Insulated hood, 2.5 ± 0.5 cm: Head-for-puffer / head-2 (face edge thickness against the
        # 3.5 cm-wide stitched binding), product loft 2.75 cm; prompt range 2-3 cm.
        "thickness_m": 0.025,
        # Outer width 27 ± 3 cm: head breadth 16.6 cm + 2 x 2.5 cm loft + ~2 x 2.5 cm ease; video
        # 28-30 s (hood down, back) ~0.55 of the shoulder line of a 47 cm taped shoulder.
        "half_width_m": 0.12,
        # Centre panel 11 ± 2.5 cm: video 28 s (two seams on the back of the hood, ~0.4 of its
        # width), head-3 (the gusset seam meets the face edge ~1/3 from the top).
        "gusset_width_m": 0.11,
        # The hood zips onto the top of the 8 cm funnel collar, so it starts at chin height.
        # Back -10 cm (head back -5 cm + 3.5 cm room + 1.25 cm half thickness), forehead edge
        # +15 cm, top 4 ± 2 cm above the head (head-3 standing bowl: rounded crown).
        "outline": {"z_back": -0.10, "z_front": 0.15, "y_top": 1.725, "y_bottom": 1.465},
        "outline_exponent": 2.3,
        "lateral_exponent": 2.5,
        "face_angle_deg": 72.0,
        "face_narrowing": 0.06,  # Head-for-puffer: the bound edge turns in slightly
        # No quilt lines on the outside beyond the panel seams (head-3, video 28 s): each panel
        # is one chamber. Chamber puff 0.9 cm over 4 cm (valley 0.55; L2 puffer torso profile).
        "quilt_pitch_m": 0.0,
        "puff_m": 0.009,
        "puff_valley": 0.55,
        "puff_rise_m": 0.04,
        # Self-colour bound edge with one stitch line 1 cm in (Head-for-puffer, head-2).
        "binding_m": 0.012,
        "binding_black": False,
        # Front corner tabs with black velcro (Head-for-puffer): 9 ± 2 cm long beyond the zip end,
        # 5 ± 1 cm wide, 1.0 cm thick; velcro patch 3 x 4 cm on the inner face of the tip.
        "tabs": True,
        "tab_length_m": 0.075,
        "tab_width_m": 0.04,
        "tab_thickness_m": 0.01,
        "velcro_m": (0.03, 0.04),
        # Hood down: stands behind the head as an empty rounded shape, leaning back a little
        # (video 27-32 s, 139-151 s; spec: "lies over the funnel collar's back").
        "hinge_m": 0.1,  # the zip edge eases into the hood over this band (detached bowl)
        "blend_m": 0.12,  # seam-fit blend band (engine) for small collar tops
        # Hood down (attached), agent H2: a padded bag of its own shape (hood_geometry.down_bag),
        # not a re-laid worn hood. Puffer3 (the truth): the hood lies on the upper back as a
        # rounded bag, outer fabric out, the centre panel's two seams running down it, the crown
        # at the bottom (about the shoulder-blade line), the opening at the top behind the neck
        # and its corners folded out as two "ears" over the shoulders. Construction: every column
        # of the pattern is a strip hanging from its stretch of the zip; it drapes down its own
        # fall line over the jacket (inner layer, hood_build.drape_paths), folds at the crown
        # (a padded half-round) and comes back up on top of itself (outer layer) to the face
        # edge, which is the bag's mouth rim. The short columns at the zip ends fold tighter and
        # run back along the collar's sides: the bag's rounded top corners. (Rounds 1-9 tried
        # the corners as unfolded wings out over the shoulders curling into ears: they knotted
        # where they met the folded columns, crumpled from the front.)
        "attached": "bag",
        # Mouth rim: m of strip below the zip (Puffer3: the bag's top is level with the collar
        # top; nothing stands above it, lead brief 2026-11-13). Nearer the zip, the outer layer
        # starts where the strip still slopes back and its offset lifts it above the collar.
        "bag_rim_m": 0.05,
        # Side-panel fraction t (from the zip end) over which the strips' ends curl over (fold
        # angle 0 -> pi), then over which the outer layer's return grows to the full bag.
        "bag_fold_t": (0.05, 0.25),
        # The strips at the zip ends hang parallel to the bag's side strip at the second value of
        # t, fully below the first (hood_geometry.down_bag).
        "bag_parallel_t": (0.2, 0.5),
        "bag_wing_t": (0.25, 0.6),
        # Gap between the two padded layers inside the bag (m) and the outer layer's dome: the
        # bag is rounded, puffiest in its middle (Puffer3), 1.2 ± 0.5 cm by eye.
        "bag_gap_m": 0.003,
        "bag_dome_m": 0.012,
        # Drape of each strip (hood_build.drape_paths): it leaves the zip this many degrees off
        # straight down, outward; gravity bends it down by this much per metre of strip; the
        # contact offset (clearance + half thickness + jacket relief) ramps in over this length.
        # Extra margin off the jacket for other bodies and sizes (seam fit scale clamped 0.85;
        # H's pouch needed 2 cm on the realism shells): checked by the 40-shell gate sweep.
        "bag_leave_deg": 5.0,
        "bag_gravity": 30.0,
        "bag_ramp_m": 0.03,
        "bag_margin_m": 0.01,
        # More margin toward the crown (m, over this span of strip from the zip): bigger backs
        # bulge out there relative to the collar; at 1 cm the crown fold crossed the jacket on
        # 8 of 40 sweep shells, by up to 16 mm (195/110 female, soak 09/15/17; H2 gate sweep 1).
        "bag_margin_low_m": 0.02,
        "bag_margin_low_span_m": (0.06, 0.16),
        # Strip headings (hood_geometry.bag_headings): the bag's strips take the zip point's
        # azimuth round the collar (0 = back) times this turn, never forward of the cap (deg from
        # the back): the bag hangs down the back, about 60 % of its width (Puffer3). The pull
        # (per metre of strip) turns each strip round the body toward its heading as it falls
        # (gravity and contact alone send the side strips forward, down the front of the
        # shoulders). By eye against Puffer3 / Puffer1.
        "bag_heading_turn": 0.35,
        "bag_heading_max_deg": 125.0,
        "bag_heading_pull": 15.0,
        # Each step a strip settles this fraction of the way back onto the jacket when it is up
        # to the reach beyond its contact offset (hood_build.drape_paths). By eye (H2 round 18).
        "bag_rest": 0.3,
        "bag_rest_reach_m": 0.04,
        "bag_smooth": 12,  # Taubin passes over the draped strips, across and along
        # Detached (Head-for-puffer, head-3): free-standing bowl on its zip edge. Placed lifted
        # off the collar so Z's rigid transform starts clear of the jacket.
        "detached_lift_m": (0.0, 0.06, -0.19),
        "detached_lean_deg": 55.0,  # leans back like the hood behind the head (video 27-32 s)
        "detached_squeeze": 0.06,  # the sides fall in a little without a head
        "detached_sag": 0.06,  # crown settles a little without a head (head-3)
        # Peel keys between down (0) and detached (1), opened from the wearer's right (Z's
        # hood_zip order) with a frontier this wide (fraction of the zip).
        "peel_keys": (0.25, 0.5, 0.75),
        "peel_width": 0.35,
    },
}

# Clearance (m) the hood's inner (lining) face keeps from the jacket and the body in the
# baked rest shapes (render tolerance; the shell's own displacement is bounded by the loft).
CLEARANCE_M = 0.005
# Smooth knee (m) of the hood-down collapse planes (behind the head, above the neck seam).
COLLAPSE_SOFT_M = 0.025
# Final Taubin fairing of each baked state (volume-preserving smoothing; seam row fixed).
FAIR_ITERATIONS = 8
CORNER_FAIR_ITERATIONS = 40
# The jacket is an open sheet: a hood point more than this (m) behind it is on its far side.
SHEET_MAX_DEPTH_M = 0.02
# Contact pushes spread over the padded shell (grid diffusion steps; ~8 cm reach at 1 cm cells).
PUSH_DIFFUSE_ITERATIONS = 60
# Seam blend band (m of material arc from the neck seam) for the bend and the seam fit
# (per hood "hinge_m" overrides it).
HINGE_M = 0.07
# The neck edge is thin (zip tape / sewn seam allowance; Head-for-puffer, Parka7): the shell is
# this fraction of its thickness at the seam and reaches full padding NECK_EDGE_RISE_M above it.
NECK_EDGE_THICKNESS = 0.3
NECK_EDGE_RISE_M = 0.04
# Corner tips (where the face edge meets the neck seam) are thin bound points: the padding is
# full only on columns longer than this (m, neck seam to face edge).
CORNER_PADDING_M = 0.12

# Hard budget per exported GLB (prompt: each under 1.5 MB).
MAX_GLB_BYTES = 1_500_000

# Cloth settle cage: every SETTLE_STEP-th grid line (~4 cm cells, the padding's fold scale).
SETTLE_STEP = 4

# Side-panel cross-shape (fractions of the corner-to-gusset-seam distance t): the wall reaches
# the full half-width by SIDE_RISE_T and rolls in to the gusset seam from SIDE_ROLL_T (a rounded
# hood shoulder; video 229-236 s side views, head-3). Gusset crown above its seams (m): the
# centre panel stands proud of the seams (Parka7, head-3), 1.5 ± 0.5 cm.
SIDE_RISE_T = 0.45
SIDE_ROLL_T = 0.72
GUSSET_CROWN = 0.015
