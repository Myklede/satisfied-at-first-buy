"""Constants for the motion rig. Every value that changes a pose or a distance has a source.

Units: angles in degrees (API) / radians (internal maths, converted where used),
lengths in metres. Scene frame: Y up, +Z body front, +X the subject's LEFT.
"""

# --- Contract and versioning ---------------------------------------------------------------
MOTION_VERSION = "motion-rig-v1"  # bump when a pose mapping, preset or export layout changes
FPS = 30  # frame rate requested by the P1 brief

# --- Anatomical limits (clamping) ----------------------------------------------------------
# Identical to P3's POSE_LIMITS (packages/vision/src/anatomicalPose.ts) so presets and the
# webcam clamp the same way. Source: AAOS normal range of motion (Greene WB, Heckman JD,
# eds. "The Clinical Measurement of Joint Motion", AAOS 1994): shoulder flexion/abduction
# 180, horizontal adduction 135, internal 70 / external 90; elbow flexion 150; hip flexion
# 120, extension 30; knee flexion 135; thoracolumbar extension 25, lateral 35, rotation 45.
# Where the motion contract's "range used" is wider, the contract wins (trunk flexion 90
# includes pelvic rotation at the hips; knee 140; axial +-90). Plane of elevation -90 (arm
# straight back) ... 135 (horizontal adduction across the chest), contract update 2026-11-12.
LIMITS_DEG: dict[str, tuple[float, float]] = {
    "trunk_flexion": (-25.0, 90.0),
    "trunk_lateral": (-35.0, 35.0),
    "trunk_twist": (-45.0, 45.0),
    "shoulder_plane": (-90.0, 135.0),
    "shoulder_elevation": (0.0, 180.0),
    "shoulder_axial": (-90.0, 90.0),
    "elbow_flexion": (0.0, 150.0),
    "hip_flexion": (-30.0, 120.0),
    "knee_flexion": (0.0, 140.0),
}
# Implied ankle angle when the foot is kept flat on the floor. Reported, never clamped,
# because the other DOFs fully determine it. AAOS: dorsiflexion 20, plantar flexion 50.
ANKLE_LIMITS_DEG = (-50.0, 20.0)  # (plantar flexion, dorsiflexion)

# --- Trunk distribution -------------------------------------------------------------------
# Share of trunk_flexion produced by pelvic rotation over the hips (the rest is spinal).
# Lumbopelvic rhythm: in full forward bending the hips contribute slightly more than the
# lumbar spine (Esola MA et al., Spine 1996;21(1):71-78). A constant share is a
# simplification: the real ratio is phase dependent (lumbar-dominant early, hip late).
PELVIC_FLEXION_SHARE = 0.55
# Spinal motion is split across Anny's five spine bones in proportion to representative
# segmental ranges of motion (White AA, Panjabi MM, Clinical Biomechanics of the Spine,
# 2nd ed. 1990, thoracic and lumbar tables). Each Anny bone was assigned the vertebral
# levels whose joints lie at/above its head, judged from the bone-head heights of the
# fitted rest skeleton (spine05 at the sacrum ... spine01 at about T7; neck01 at C7):
#   spine05: L5-S1, L4-5   spine04: L3-4, L2-3   spine03: L1-2, T12-L1
#   spine02: T11-12 .. T8-9   spine01: T7-8 .. T1-2
# Per-level representative values (degrees) summed per bone:
#   flexion/extension: 20+16 | 15+14 | 12+12 | 12+9+6+6 | 6+5+4*5
#   lateral bending:   3+6   | 8+6   | 6+8   | 9+7+6+6  | 6*6+5
#   axial rotation:    1+2   | 2+2   | 2+2   | 2+2+4+6  | 8*6+9
SPINE_BONES = ("spine05", "spine04", "spine03", "spine02", "spine01")
SPINE_FLEXION_ROM = (36.0, 29.0, 24.0, 33.0, 31.0)
SPINE_LATERAL_ROM = (9.0, 14.0, 14.0, 28.0, 41.0)
SPINE_TWIST_ROM = (3.0, 4.0, 4.0, 14.0, 57.0)
THORAX_BONE = "spine01"  # the clavicle shrug axis rides on this bone
# The trunk drive angles are solved so the MEASURED angles match the request (quasi-Newton).
TRUNK_SOLVE_ITERATIONS = 8
TRUNK_SOLVE_TOLERANCE_DEG = 0.01

# --- Shoulder girdle -----------------------------------------------------------------------
# Scapulohumeral rhythm: the first ~30 degrees of humeral elevation are a "setting phase"
# with little scapular/clavicular motion (Inman VT, Saunders JB, Abbott LC, J Bone Joint
# Surg 1944;26:1-30). Above it the clavicle elevates; in-vivo bone-pin data show roughly
# 10-15 degrees of clavicular elevation at maximal humeral elevation (Ludewig PM et al.,
# J Bone Joint Surg Am 2009;91(2):378-389). 0.1 deg/deg over the remaining 150 degrees
# gives 15 degrees at 180. Visible as a shoulder shrug; the humerus direction itself is
# still set exactly from the ISB angles relative to the thorax.
GIRDLE_SETTING_PHASE_DEG = 30.0
CLAVICLE_ELEVATION_RATIO = 0.1

# --- Support / chair -----------------------------------------------------------------------
# Feet stay flat and planted: the root is translated so the lowest foot vertex touches the
# floor (y = 0) and the mid-foot point keeps its rest x/z. With hips and knees at 90 degrees
# and vertical shanks the thigh underside then sits at the body's own popliteal (knee)
# height: that surface is reported as the implied chair seat (seat height = popliteal height
# is the standard ergonomic rule, Pheasant & Haslegrave, Bodyspace, 3rd ed. 2006, ch. 5).
SEAT_HIP_FLEXION_MIN_DEG = 60.0  # a pose with both hips >= this is reported as seated
# Foot vertices within this height of the rest floor are the sole candidates for planting
# (the arch and toes of a flat foot all lie below 3 cm; generous, only a speed cut-off).
SOLE_BAND_M = 0.03
FLOAT_WARNING_M = 0.002  # report when the planted root had to be RAISED by more than this

# --- Skinning -----------------------------------------------------------------------------
SKINNING_METHODS = ("lbs", "dqs")
# Decision recorded after measurement (docs/validation/motion-skinning.md).
DEFAULT_SKINNING = "lbs"

# --- Articulated collision field -----------------------------------------------------------
# 6 mm grid: the thinnest collision-relevant limb section (adult wrist, ~5 cm across) gets
# >= 8 samples; trilinear error on a convex surface of radius r is about h^2/(8 r) =
# 0.18 mm at r = 2.5 cm. Slightly finer than the 7 mm whole-body field (garment/sdf.py) so
# that wrist and cuff gaps stay resolved after the segment re-sampling.
SDF_SPACING_M = 0.006
# Grid padding around each segment. Matches the whole-body contact band (2.75 cm loft + up
# to 2 cm under-layer + guard, config.SDF_REFINE_BAND_M = 0.06) so cloth offsets stay inside.
SDF_PADDING_M = 0.06
# Grid nodes next to the surface (inside/outside transitions and nodes around dense triangle
# samples) get their exact closest surface point; every other node uses the closest point of
# its nearest such node (EDT feature map). Nodes with |d| below this band could additionally
# be re-solved exactly. Measured before the hybrid split (overlapping 30 % segments, 175/75
# reference): band 0 gave contact-zone p95 1.8 mm in 2.4 s, band 12 mm 1.0 mm in 4.7 s. With
# rigid cores + exact joint zone the rest-pose p95 is 1.3-1.4 mm at band 0
# (docs/validation/motion-sdf.md), so the band stays off to keep the build near 1 s.
SDF_EXACT_BAND_M = 0.0
SDF_CANDIDATES = 8  # nearest triangle centres tested for each exact closest-point query
# Rigid segment fields cover only each segment's near-rigid CORE: vertices whose skin weight
# on the segment's bones is at least this. LBS blends the remaining joint-zone skin between
# two bones, which no rigid field can follow (measured with 30 % overlap margins instead:
# shoulder p95 error 19-26 mm, hip 29-41 mm, mostly phantom skin). Those blend-zone triangles
# are skinned per frame and queried exactly (collision.zone_distance).
SEGMENT_CORE_WEIGHT = 0.9
ZONE_BARY_EPS = 1e-6  # closest point counts as on an edge/vertex of the zone border
# Segments: name -> (reference bone for the local frame, bones whose weight counts). Bone
# lists are completed with every descendant not owned by another segment (fingers, toes,
# face). Spine segments follow the spine split above so each is close to rigid.
SEGMENTS: dict[str, tuple[str, tuple[str, ...]]] = {
    "head_neck": ("neck01", ("neck01", "neck02", "neck03", "head")),
    "chest": ("spine01", ("spine01", "clavicle.L", "clavicle.R", "shoulder01.L", "shoulder01.R")),
    "lower_chest": ("spine02", ("spine02",)),
    "abdomen": ("spine04", ("spine03", "spine04")),
    "pelvis": ("root", ("root", "spine05", "pelvis.L", "pelvis.R")),
    "upperarm.L": ("upperarm01.L", ("upperarm01.L", "upperarm02.L")),
    "upperarm.R": ("upperarm01.R", ("upperarm01.R", "upperarm02.R")),
    "forearm.L": ("lowerarm01.L", ("lowerarm01.L", "lowerarm02.L")),
    "forearm.R": ("lowerarm01.R", ("lowerarm01.R", "lowerarm02.R")),
    "hand.L": ("wrist.L", ("wrist.L",)),
    "hand.R": ("wrist.R", ("wrist.R",)),
    "thigh.L": ("upperleg01.L", ("upperleg01.L", "upperleg02.L")),
    "thigh.R": ("upperleg01.R", ("upperleg01.R", "upperleg02.R")),
    "shank.L": ("lowerleg01.L", ("lowerleg01.L", "lowerleg02.L", "foot.L")),
    "shank.R": ("lowerleg01.R", ("lowerleg01.R", "lowerleg02.R", "foot.R")),
}

# --- Anchors -------------------------------------------------------------------------------
RING_SAMPLES = 32  # every 11.25 deg; 0 = front centre, 8 = subject's left, 16 = back, 24 = right
# Waistband height between the waist line (t=0) and hip line (t=1); contract definition.
WAISTBAND_FRACTIONS = {"high": 0.0, "mid": 0.5, "low": 1.0}
# A vertex is torso skin for the exposure mask when arm (clavicle subtree) and leg
# (upperleg subtree) bones carry less than this weight.
EXPOSURE_LIMB_WEIGHT_MAX = 0.5

# --- Custom (recorded) motions: POST /motion/{body_id}/custom/frames.bin (prompt 14) --------
# Longest recording accepted. The kiosk's "Record a move" captures about 5 s; prompt 14 caps
# the request at 8 s (the bake time grows linearly with it, ~2 solver steps per frame).
CUSTOM_MAX_DURATION_S = 8.0
# Nominal input sample rate (Hz) the client declares. From keyframe-like input (the presets'
# keyframes are 0.9-1.6 s apart, about 1 Hz) up to a 60 Hz camera; it bounds the sample count
# (ceil(CUSTOM_MAX_DURATION_S * fps) + 1). The output is always resampled to FPS.
CUSTOM_FPS_RANGE = (1.0, 60.0)
# A recording that does not start (end) at the body's neutral display pose gets a smoothstep
# transition from (back to) it, like every preset, so the cloth starts from its settled drape
# without a jump. Its length is the larger of CUSTOM_LEAD_S and the largest angle change
# divided by CUSTOM_LEAD_SPEED_DEG_S, so the transition is never faster than the presets'
# validated ramps: reach_up_both raises the arms 143 deg (27 -> 170) in 1.3 s = 110 deg/s mean
# (smoothstep peak 165 deg/s). Measured by V3 (tools/bakeNode.mjs, the user's body, parka S):
# a fixed 0.8 s lead-in to arms already overhead (peak wrist 2.5 m/s) made the cloth lose
# both sleeves before the recording even started.
# Minimum 0.5 s (was 0.8 s): the speed bound below already governs large changes; a short
# lead-in for a small change saves simulated time (the judge waits for the bake; lead-approved
# <= 20 s plan, docs/STATUS-tryon-physics.md).
CUSTOM_LEAD_S = 0.5
CUSTOM_LEAD_SPEED_DEG_S = 110.0

# --- Shoulder-ridge weight transfer (motion/ridge.py; lead-approved option b1) -------------
# LBS collapses the top of the shoulder when the arm is raised (measured: the ridge 9-21 cm
# from the midline drops 1.4-3.6 cm at reach_up_both's hold while the glenohumeral joint rises
# 4.3 cm), so a jacket yoke resting there cannot rise. Above 90 degrees of humeral elevation
# relative to the clavicle, ridge skin above the joint moves its upper-arm weight to the
# clavicle, as the scapula carries the shoulder top in real elevation (scapulohumeral rhythm,
# Inman, Saunders & Abbott 1944; Ludewig et al. 2009).
# Mask m_v = max_share * smoothstep((height - height_from_m) / height_ramp_m)
#            * (1 - smoothstep((lateral - lateral_from_m) / lateral_ramp_m)),
# height above and lateral distance past the glenohumeral joint at rest. Calibrated on the
# neutral reference body (ridgeSlices.mjs, 2026-11-13): moving only the skin above the joint
# (from 0, ramp 4 cm; lateral 0, ramp 4 cm) at full share levels the ridge (+0.0..+2.8 cm) but
# the deltoid cap, which this rig turns about 150 degrees about the joint relative to the
# clavicle (in vivo glenohumeral elevation is about 120 degrees), sweeps through the retained
# ridge: 62 crossing triangle pairs. Including the cap in a wider ramp (from 6 cm below the
# joint over 8 cm; lateral from 6 cm over 6 cm) at max_share 0.7 gives 0 crossings on every
# active frame, ridge -0.4..+2.5 cm (plain LBS -2.9..-0.4); max_share 0.8 gives 12 crossings.
#   ramp_deg: no change at or below 90 degrees (the rest pose and arms-down moves are exact),
#     full transfer at 180.
# enabled: False until the e6 gates pass (rest pose, sleeves, strain, renders, video).
SHOULDER_RIDGE = {
    "enabled": False,
    "version": "ridge1",
    "height_from_m": -0.06,
    "height_ramp_m": 0.08,
    "lateral_from_m": 0.06,
    "lateral_ramp_m": 0.06,
    "max_share": 0.7,
    "ramp_deg": (90.0, 180.0),
}

# --- Service -------------------------------------------------------------------------------
CACHE_SIZE = 4  # bodies with precomputed motion data kept in RAM (never on disk)
