"""Accuracy-affecting constants: assumptions are explicit, not population guarantees."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODEL_VERSION = "anny-0.6.2-gate-b-v4"
FIT_RANKING_VERSION = "common-zones-v1"  # review 02: missing evidence must not reward a candidate
GARMENT_ASSET_VERSION = "realism-wrap-v30-ch-collar"  # CH: parka stand at the chin
DISPLAY_POSE_VERSION = "relaxed27-absolute-elbow12-v2"
# Approved realism visual specification: inner elastic cuff / hook-and-loop adjuster.
ADJUSTABLE_CUFF_STYLES = ("FB7675-100", "DQ4920-206")
# NZDFAS original report p119, automatic height, all-service samples:
# male n790 mean1786mm SD65mm; female n212 mean1671mm SD55mm.
# A military-population proxy, not the shopper's height or a Nike size standard.
GRADING_HEIGHT_CM = {"male": 178.6, "female": 167.1}
GRADING_HEIGHT_SD_CM = {"male": 6.5, "female": 5.5}
GRADING_HEIGHT_SOURCE = "https://openrepository.aut.ac.nz/server/api/core/bitstreams/d707fec4-33ba-42e7-bf86-ccf9ffa9b14a/content"
GRADING_VERSION = "chart-midpoints-free-mass-v1"
GRADING_SEED_BMI = 22.0  # initial request label only; no mass loss or BMI fitting target
GRADING_DELTA_UNCERTAINTY_CM = 3.0  # uncalibrated model-delta allowance, not population confidence
UNOBSERVED_SHAPE_DEFAULT = 0.5  # Anny default cupsize/firmness, no personal calibration.
FALLBACK_RAW_LIMIT = 4.0  # Restart saturated sigmoid weights with a usable gradient.
# Explicit assumption, NOT an individually measured density. Both options are validated.
# 1010 fits all supplied tape targets with lower assisted MAE (N=1; see body-fixes-review).
DENSITY_KG_M3 = 1010.0
DENSITY_CHOICES = (980.0, 1010.0)  # Anny Anthropometry default / original milestone assumption.
# Anny anchors: newborn=-1/3, baby=0, child=1/3, young=2/3, old=1.
ADULT_AGE = 2.0 / 3.0
SEED = 42
TORCH_THREADS = 1  # Stable reduction order and avoids small-matrix thread oversubscription.
PRIOR_WEIGHT = 0.001  # Weak neutral-shape regularisation; not a statistical confidence model.
ADAM_STEPS = 20
LBFGS_STEPS = 25
# Shorter constrained solves; exact geometry refreshes enforce the unchanged accuracy gates.
KNOWN_LBFGS_STEPS = 12
CACHE_SIZE = 16
# Residual normalisation and acceptance gates from Milestone 1 (cm, kg).
HEIGHT_TOLERANCE = 0.5
MASS_TOLERANCE = 1.0
GIRTH_TOLERANCE = 1.5
BACK_PROXY_SCALE_CM = 1.5  # cm residual scale for the contoured back-length constraint
LOCAL_LABELS = [
    "measure-bust-circ-incr",
    "measure-waist-circ-incr",
    "measure-hips-circ-incr",
    "measure-shoulder-dist-incr",
    "measure-upperarm-length-incr",
    "measure-lowerarm-length-incr",
    "measure-napetowaist-dist-incr",
    "measure-upperarm-circ-incr",
    "measure-wrist-circ-incr",
    "measure-neck-circ-incr",
]
# Fractions below define search windows on the neutral adult mesh, not human ground truth.
# Torso windows follow visible rib/iliac/buttock regions; validated on reference/extreme shapes.
CHEST_WINDOW = (0.70, 0.78)
WAIST_WINDOW = (0.57, 0.65)
WAIST_ANCHOR_RADIUS = (
    0.04  # stature fraction around Anny's shipped waist ring; follows local length edits
)
HIP_WINDOW = (0.46, 0.56)
SECTION_SAMPLES = 13
SECTION_EPS = 1e-7  # metres; endpoint welding for plane-section connectivity.
# Anatomical surface search windows in metres, relative to Anny skeletal joints.
SHOULDER_RADIUS = 0.085
MIDLINE_WIDTH = 0.025
NECK_RADIUS = 0.12
ARM_SECTION_FRACTION = 0.50  # Mid upper-arm: proximal planes merge with torso in native A-pose.
ACROMION_OFFSET = (0.025, 0.045, 0.0)  # m from humeral joint toward superior-lateral surface.
# Remaining surface selection/proxy tolerances; neutral topology heuristics, not calibrated anatomy.
HPS_OFFSET_FACTOR = 0.45
HEEL_REGION_HEIGHT = 0.06
BUST_X_WINDOW = (0.04, 0.16)
BUST_HEIGHT_WINDOW = (0.69, 0.77)
NECK_LEVEL_BAND = 0.025
CROTCH_MIN_Y = 0.5
POSTERIOR_MARGIN = 0.015
WRIST_PROXIMAL_FRACTION = 0.02
IDENTITY_SKINNING_ATOL = 2e-5
ADAM_LEARNING_RATE = 0.12
LBFGS_GRAD_TOLERANCE = 1e-5
PROXY_REFRESH_PASSES = 4
# Anatomical detector heuristics (metres). No population-width clamp: ANSUR is a sanity check,
# not a substitute for detecting a subject's surface. ISO 8559-1:2017 3.1.2 / 5.4.3.
RIDGE_CORONAL_BAND = 0.018
RIDGE_BONE_WINDOW = (0.95, 1.10)  # bony-head neighbourhood; excludes the lateral deltoid cap turn
# Anny rig-to-skin offsets differ between its male/female shape endpoints. These search
# neighbourhoods were calibrated by reference-mesh inspection, not population-width clamping.
RIDGE_WINDOW_MALE = (1.00, 1.05)
RIDGE_WINDOW_FEMALE = (1.05, 1.25)
RIDGE_SLOPE = -0.70  # transition from shallow shoulder ridge to descending upper arm
RIDGE_SAMPLES = 81
RIDGE_SMOOTH_SIGMA = 1.5
C7_LEVEL_BAND = 0.009
NOTCH_LEVEL_BAND = 0.012
NOTCH_CLAVICLE_BLEND = 0.5  # sternal skin notch above the rig's medial clavicle head
C7_HEIGHT_OFFSET = 0.020  # model neck01 -> posterior skin projection, provisional anatomical offset
# Model neck01 -> suprasternal skin level, provisional anatomical offset.
NOTCH_HEIGHT_OFFSET = -0.020
ANATOMY_REFERENCE_STATURE = 1.75  # offsets scale with stature, not sex/population-mean width
RIDGE_HEAD_EXCLUSION = 0.035
SURFACE_ROUTE_SAMPLES = 33  # sampled contoured shoulder path through C7, projected to skin
# Garment heuristics: calibrate with real jackets / worn measurements;
# these are not universal standards.
LAYER_PRESETS_CM = {"t-shirt": 0.3, "hoodie": 0.9}
PREFERENCE_EASE_SHIFT_CM = {"fitted": -2.0, "regular": 0.0, "relaxed": 4.0}
DESIGN_EASE_FALLBACK_CM = {"slim": 6.0, "regular": 10.0, "loose": 16.0, "oversized": 24.0}
EASE_TOLERANCE_CM = {"chest": 6.0, "hem": 8.0, "bicep": 5.0}
OFFSET_BANDS_CM = {"shoulder": (-1.0, 1.5), "sleeve": (-1.5, 2.0)}
ZONE_WEIGHTS = {"shoulder": 3.0, "chest": 3.0, "hem": 1.0, "sleeve": 2.0, "bicep": 1.5}
MISSING_ZONE_PENALTY = 0.3
ELASTIC_HEM_TOLERANCE_CM = 4.0
# Fixed LOD chosen from four-reference CPU benchmarks; smooth normals retain silhouette.
GARMENT_ANGULAR_SAMPLES = 24
GARMENT_TORSO_ROWS = 14
GARMENT_SLEEVE_ROWS = 8
GARMENT_ARMHOLE_HALF_SPAN = 3
GARMENT_SURFACE_MARGIN_M = 0.002  # numerical clearance, not extra garment ease
GARMENT_COLLAR_HEIGHT_M = 0.035  # visual collar convention, not a measured product dimension
GARMENT_BAND_HEIGHT_M = 0.015  # visual cuff/hem detail
GARMENT_FOLD_AMPLITUDE_M = 0.002  # visual low-frequency folds, not a fabric simulation
GARMENT_COLLISION_PASSES = 5
HEATMAP_TIGHT_CM = 0.5
HEATMAP_LOOSE_CM = 3.0
CUFF_EASE_FRACTION = 0.5  # inferred visual taper; no cuff-girth fit claim without tape data
MIN_CUFF_EASE_CM = 2.0
BICEP_DESIGN_FRACTION = 0.5
STATUS_PENALTIES = {"fit": 0.0, "relaxed": 0.4, "tight": 2.0, "too_big": 1.3}
BICEP_DESIGN_EASE_CM = {"slim": 2.0, "regular": 4.0, "loose": 6.0, "oversized": 8.0}
INTENT_SHOULDER_DROP_CM = {"slim": 0.0, "regular": 0.0, "loose": 8.0, "oversized": 12.0}
SURFACE_CANDIDATE_FACES = 16  # broad phase only; certified exact queries verify final distances
SURFACE_EXACT_CHUNK_SIZE = 128  # bound temporary triangle arrays on this 14GB machine
SURFACE_BOUND_EPS_M = 1e-12  # roundoff guard for conservative enclosing-sphere query bounds
GARMENT_SMOOTHING_WEIGHT = 0.12
GARMENT_COLLISION_GAIN = 1.5
# Realism discretisation and unmeasured pattern/hardware conventions (not tapes).
# Panel count fixed across sizes; approx 1–1.5 cm body edges for the measured S.
CLOTH_TORSO_N = 96
CLOTH_TORSO_ROWS = 69
CLOTH_SLEEVE_ROWS = 32
CLOTH_SHOULDER_ROW = 6
CLOTH_CHEST_ROW = 24
CLOTH_ARMHOLE_HALF_SPAN = 10
CLOTH_CAP_TOP = 6
CLOTH_CAP_BOTTOM = 22
CLOTH_SHOULDER_DROP_M = 0.04  # unmeasured sloping pattern shoulder, not a body-fit target
CLOTH_CAP_HEIGHT_FACTOR = 1.3  # construction assumption: sleeve-head ease above bicep diameter
CLOTH_CHEST_BELOW_CAP_M = 0.025  # supplied tape protocol: 2.5 cm below the armhole
CLOTH_CAP_BLEND_ROWS = 6
CLOTH_BICEP_ROW = 6
CLOTH_TORSO_ASPECT = 0.62
CLOTH_NECK_RADIUS_M = 0.075
CLOTH_NECK_INNER_RADIUS_M = 0.065  # original 7.5cm parka collar minus 1cm loft; unmeasured
CLOTH_YOKE_DEPTH_M = 0.105
CLOTH_CUFF_INNER_M = 0.21  # inferred opening, not a supplied garment cuff tape
CLOTH_COLLAR_ROWS = 4
CLOTH_HOOD_N = 40
CLOTH_HOOD_ROWS = 25
CLOTH_HOOD_WIDTH_M = 0.17
CLOTH_HOOD_HEIGHT_M = 0.33
CLOTH_HOOD_DEPTH_M = 0.17
CLOTH_HOOD_CHAMBER_M = 0.09  # unmeasured hood quilting convention; not a tape claim
CLOTH_ZIP_WIDTH_M = 0.006
CLOTH_HARDWARE_RELIEF_M = 0.002
# Unmeasured hardware proportions for procedural rendering; replace with tape/photo calibration.
CLOTH_PULL_WIDTH_M = 0.009
CLOTH_PULL_LENGTH_M = 0.021
CLOTH_ADJUSTER_WIDTH_M = 0.025
CLOTH_CORD_N = 4
CLOTH_CORD_RADIUS_M = 0.0015
CLOTH_TOGGLE_WIDTH_M = 0.008
CLOTH_TOGGLE_LENGTH_M = 0.014
CLOTH_BILL_DEPTH_M = 0.04
CLOTH_BILL_HALF_WIDTH_M = 0.09
CLOTH_BILL_ARCH_M = 0.035
CLOTH_BILL_N = 16
CLOTH_POCKET_LENGTH_M = 0.16
CLOTH_POCKET_WELT_M = 0.012
CLOTH_POCKET_ANGLE_SAMPLES = 11
CLOTH_POCKET_SLANT_ROWS = 4
CLOTH_POCKET_ROWS = 12  # fixed topology; physical extent comes from sourced pocket length
CLOTH_SUPPORT_ROOT_STRIDE = 16  # six neckline cloth roots for geodesic strain limiting
CLOTH_DRESS_SHOULDER_CLEARANCE_M = 0.025  # dressing initialisation, not a final pin
CLOTH_DRESS_CUFF_PROXIMAL_M = 0.025  # dressing cuff above hand, never a final position pin
CLOTH_CUFF_SECTION_STEP_M = 0.007  # same resolution as body SDF; geometry-derived aperture barrier
CLOTH_CUFF_GUIDE_MIN_M = 0.004  # radial slack while preserving closed-cuff winding around the arm
# Requested relaxed display pose, independent of anthropometric rest measurement.
DISPLAY_ARM_ANGLE_DEG = 27.0
DISPLAY_ELBOW_BEND_DEG = 12.0
WRAP_ARM_WEIGHT_THRESHOLD = 0.5  # dominant Anny arm skinning weight separates limb from torso
WRAP_RING_OVERSAMPLE = 4  # convex polygon sampling before arc-length matching; tapes root-solved
WRAP_RING_SECTORS = 4  # retain anatomical front/back/left/right seam origins during arc matching
WRAP_ARAP_ITERATIONS = 20  # static metric-preserving wrap optimisation, not gravity simulation
# Dimensionless soft target / local edge degree; numerical, not material calibration.
WRAP_TARGET_WEIGHT = 0.01
WRAP_PIN_WEIGHT = 100  # strong initial semantic-boundary constraints, released before relaxation
WRAP_ADMM_RELAXATION = 1.5  # over-relaxation in the standard convergent ADMM interval (0, 2)
WRAP_INITIAL_ITERATIONS = 100  # provisional static solve; final acceptance is independently gated
WRAP_INITIAL_TARGET_WEIGHT = 0.001  # numerical target regularisation, not a fabric property
WRAP_INITIAL_STRETCH = 1.06  # reserve below the03c final1.10 edge-ratio ceiling
WRAP_INITIAL_STRETCH_RESERVE = 0.01  # numerical reserve below configured elastic stretch
CLOTH_WRAP_RELAX_SECONDS = 1.5  # prompt03c maximum simulated relaxation time
CLOTH_SUPPORT_COARSENING = 4  # numerical multigrid ratio; arc bounds use actual product edges
CLOTH_FABRIC_SELF_RADIUS_M = 0.001  # provisional thin shell contact; puff is rendered separately
# SDF and solver numerical parameters. Mechanical coefficients are provisional,
# uncalibrated polyester-puffer assumptions, not measured material properties.
SDF_SPACING_M = 0.007
SDF_VERSION = "triangle-pseudonormal-contact-band-v3-lattice"
SDF_REFINE_BAND_M = 0.06  # current 2.75cm loft + up to 2cm under-layer + grid guard
SDF_QUERY_CHUNK = 4096  # memory bound; no geometry/collision resolution is discarded
SDF_NEARBY_SEEDS = (
    4  # actual-triangle candidates from nearby surface voxels, validated independently
)
SDF_PADDING_M = 0.12
SDF_THREADS = 4  # contact-band refinement threads (numerical; chunks are independent)
ASSET_WORKERS = 4  # cloth-asset worker processes: SDF, body sections and both jackets in parallel
ASSET_WORKER_BODIES = 2  # bodies whose shell sections a worker keeps (RAM only, LRU)
CLOTH_QUALITY_ENDPOINT_EPS_M = (
    1e-6  # exclude shared-seam ray endpoint roundoff, not a depth allowance
)
CLOTH_QUALITY_PARALLEL_EPS = 1e-10  # dimensionless relative determinant, excludes coplanar rays
CLOTH_QUALITY_BARY_EPS = 1e-7  # conservatively ray-test closest points near a face edge/vertex
CLOTH_CONFIG = {
    "dt": 1 / 60,
    "substeps": 2,
    "iterations": 1,
    "gravity": -9.81,
    "damping": 0.985,
    "stretchCompliance": 1e-8,
    "bendCompliance": 2e-4,
    "seamBendCompliance": 2e-2,
    "elasticCompliance": 2e-5,
    "stretchMax": 1.03,
    "strainAcceptanceTolerance": 0.005,  # numerical 0.5 percentage-point residual allowance
    "friction": 0.35,
    "collisionMargin": 0.002,  # 2mm guard on the triangle-refined 7mm SDF
    "selfRadius": 0.008,
    "kineticEpsilon": 1e-5,
    "maxSeconds": 4,
    "particleMass": 0.0001,
    "bendMaxCorrection": 0.003,  # trust region for nearly degenerate sewn triangles
    "bendRestEdgeFraction": 0.25,  # correction bounded by actual local rest resolution
    "velocityLimit": 2.0,  # m/s numerical trust region for dressing/contact projection
    "collarCompression": 0.9,  # unmeasured semi-rigid collar stand, prevents loop collapse
    "selfEvery": 2,  # test every other integration frame; final contacts always checked
    "surfaceContactPasses": 6,  # virtual edge/face particles for final body contact projection
    "surfaceCorrectionLimit": 0.02,  # metres, contact trust region per virtual particle
    "strainPolishPasses": 64,  # static constraint residual reduction before final surface contacts
    "loftMinimumRatio": 0.25,  # provisional compressed fill floor; not a measured Thermore modulus
    "loftCompliance": 0.3,  # m/N per particle, uncalibrated compliant-fill contact
    "ringCorrectionLimit": 0.002,  # numerical trust region for global ring circumference
    "hardRingContactIterations": 3,  # ring/body contact; hard stretch has no trust clamp
    "offsetShowBothCm": 1.5,  # prompt 03 analytic/simulated disagreement threshold
    "cuffTooLongCm": 2.0,  # inherited heuristic cuff verdict, awaits worn calibration
    "cuffTooShortCm": -1.5,
}
GARMENT_ARM_ROUTE_SAMPLES = 12  # per arm segment; CPU interpolation accuracy convention
GARMENT_BACK_ROUTE_SAMPLES = 80  # posterior profile sampling from HPS to floor
GARMENT_CHEST_DROP_M = 0.02  # keep the torso grid below chest tape / armhole
GARMENT_ARMHOLE_RADIUS_FACTOR = 0.8  # provisional cap-to-chest layout, not pattern cutting
GARMENT_YOKE_NECK_DROP_M = 0.015
GARMENT_CUFF_SUPPORT_MAX_M = 0.15  # reject torso/other-limb sections beyond this radius
GARMENT_TANGENT_STEP_M = 0.005  # finite-difference tangent on metre surface routes
GARMENT_ZIP_HALF_WIDTH_M = 0.0015  # visual 3 mm zip strip
PLANE_VERTEX_EPS = 1e-10  # symbolic positive side for a plane passing exactly through a vertex
SHOULDER_TOP_MARGIN = 0.035
# Conditional shape ensemble, NOT population-calibrated confidence intervals.
UNCERTAINTY_SAMPLES = 8
UNCERTAINTY_FREE_RANGE = (0.20, 0.80)
UNCERTAINTY_STEPS = 24
UNCERTAINTY_LBFGS_STEPS = 15
UNCERTAINTY_QUANTILES = (0.10, 0.90)
UNCERTAINTY_KNOWN_PERTURB = (
    0.05  # local ensemble around constrained MAP, accepted only if all targets pass
)
PROXY_EARLY_STOP_FRACTION = 1.0  # stop when every exact measure passes its required accuracy gate

# --- 03c fallback: tape-true shell built on the posed body (garment/shell.py) ---
# Construction/numerical conventions, not garment tape. Tape values come from the product file.
SHELL_TORSO_N = 96  # torso columns; ~1.2 cm arc at a 115 cm girth
SHELL_ROW_SPACING_M = 0.015  # target row spacing below the armhole and along sleeves
SHELL_ROWS_TOP = 6  # neckline -> shoulder ridge rows
SHELL_ROWS_MID = 10  # shoulder ridge -> armhole bottom rows
SHELL_LEVEL_STEP_M = 0.003  # dense horizontal body sections used to trace column meridians
SHELL_MIN_YOKE_M = 0.03  # smallest neckline->ridge arc so front yoke rows never collapse
SHELL_CLEARANCE_M = 0.003  # inner fabric surface to body, on top of the under-layer
SHELL_ARMHOLE_DROP_M = 0.02  # armhole bottom below the body armpit (set-in sleeve convention)
SHELL_ARMHOLE_HALF_ANGLE_DEG = 20.0  # armhole front/back extent about the side line
SHELL_ARMHOLE_ROUNDNESS = 3.0  # armhole seam superellipse exponent, grid space (look; 2 = ellipse)
SHELL_CAP_ROWS = 4  # sleeve cap rows blending the armhole loop into the first arm ring
SHELL_CAP_CLEAR_M = 0.02  # first full arm ring this far beyond the armhole loop along the arm
SHELL_COLLAR_ROWS = 3  # fewest collar rows
SHELL_COLLAR_ROW_M = 0.012  # collar row spacing at its tallest column (numerical)
# Collar construction by hood kind (agent L1b, look conventions from the user's photos in
# data/reference-photos; uncalibrated, no tape). Attached hood (FB7675-100, Parka1/3/4): no stand
# collar; the hood's lower front closes up the neck and its opening edges rise round the sides
# into the hood behind the neck, loose (leaning out), more behind the neck where the hood gathers.
# Heights are above the body's neck-base plane (the parka's seam).
# CH: zipped, the real parka's front is a level stand at the chin (user 2026-11-13: "fully
# zipped, the top reaches the chin, no higher"; video 12 s zipping to the chin). The old 1.2 cm
# V point put the zip top 2.1 cm below the chin on the user's body; 3.3 cm puts it 1.0 cm below
# (the body clearance under the chin holds it there).
SHELL_HOOD_BASE_FRONT_M = 0.033  # stand height round the front and sides (chin, user's body)
# Hood edge height at the centre back, reached as -cos over the back half (CH: from the
# sides, the 6.5 cm band stood beside the jaw up to the ear lobes in the kiosk and AR views).
SHELL_HOOD_BASE_SIDE_M = 0.065
SHELL_HOOD_BASE_LEVEL_M = 0.08  # neckline arc from the zip before the edges lean out (CH)
SHELL_HOOD_BASE_V_M = 0.04  # neckline arc past that over which the lean grows to the sides'
SHELL_HOOD_BASE_LEAN_M = (0.012, 0.03)  # outward lean at the top: sides, behind the neck
# Removable hood (DQ4920-206, Puffer1/2): tall insulated funnel collar, even height. Puffer2 at
# 0.0644 cm/px (225 px = 14.5 cm chamber): ~115 px seen from slightly above -> 7.4 cm projected;
# taken as 8 +- 1.5 cm. Leans out slightly at the top (stands off the neck).
SHELL_FUNNEL_COLLAR_M = 0.08
SHELL_FUNNEL_LEAN_M = 0.008
SHELL_FUNNEL_THICK_M = 0.015  # insulated funnel: thickness of its turned top edge (look)
SHELL_FUNNEL_TURN_DEPTHS_M = (0.012, 0.025)  # inner rows below the top edge (look)
SHELL_SEPARATION_M = 0.003  # sleeve rests this far outside the torso shell below the armhole
SHELL_HOOD_ROWS = 22  # pillow rows (numerical; 14 left 30-44 mm root rows: slivers)
SHELL_HOOD_BLEND_ROWS = 5  # rows over which the pillow leaves the neckline root (numerical)
SHELL_HOOD_ROLL_POWER = 1  # root roll bump sin(pi t)^p (numerical)
SHELL_HOOD_ROOT_SIN = 0.15  # hood root spans the back neckline (sin(theta) < this)
# Removable hood: attaches round the back of the funnel collar only (from its crest, the
# root ends at the sides of the neck cut across the collar's top; look, uncalibrated).
# L2: -0.35 rooted it far enough round the neck that its sides stood beside the funnel top (the
# grey "ears" seen from the front and 3/4); -0.55 keeps the root behind the neck.
SHELL_HOOD_REMOVABLE_SIN = -0.55
# Roll removed toward its root ends (look, L2; 0.8 sheared the root rows into 1.8 deg slivers).
SHELL_HOOD_REMOVABLE_ROLL_TAPER = 0.4
# Funnel collar: where its turned top edge fades to a small cap under the hood (sin of the column
# angle below this + 0.3). Kept at the G4/L1b root extent when the hood root narrowed (L2): the
# turn there is what keeps the collar clear of the neck (1 inside sample on 162/57 XS otherwise).
SHELL_FUNNEL_COVERED_SIN = -0.35
# Removable hood folded down lies bunched (Puffer1): narrower than the flat hood, so its sides
# stay on the back instead of wrapping the dropped shoulders (look, uncalibrated).
# L2: 0.12 put the hood's sides beside the funnel top, seen from the front as dark "ears";
# Puffer2 (closed, front) shows no hood beside the collar. 0.09 keeps it behind the funnel.
SHELL_HOOD_REMOVABLE_HALF_WIDTH_M = 0.09
SHELL_HOOD_TOP_ROLL_OUT_M = 0.045  # hood folding over a collar top: outward roll (numerical)
SHELL_HOOD_FOLD_FRACTION = 0.75  # visible folded length / CLOTH_HOOD_HEIGHT_M (uncalibrated)
# Attached hood (FB7675-100) folded down: length below the collar top and pillow thickness.
# Parka2/Parka6: the hood lies flat above the back swoosh, ending at the yoke stitch line
# (7.5 cm below HPS); from a 6.5 cm collar top behind the lower back neck point that is ~9 cm
# (look, uncalibrated; 12 cm still covered the swoosh top).
SHELL_HOOD_ATTACHED_FOLD_M = 0.09
# Its half-width (look, uncalibrated; L2). The flat hood's 17 cm, reached 3.6 cm below the root,
# put the pillow's lower corners on the shoulder slopes, where the drape lifted them sideways
# into flaps (the ragged bits at the hood ends, Parka2/Parka7 show a rounded pillow).
SHELL_HOOD_ATTACHED_HALF_WIDTH_M = 0.13
SHELL_HOOD_ATTACHED_THICK_M = 0.025
SHELL_HOOD_FLAT_FRACTION = 0.25  # folded pillow thickness / CLOTH_HOOD_DEPTH_M (uncalibrated)
SHELL_HOOD_ROLL_M = 0.02  # extra lift where the hood rolls over at its root (uncalibrated)
SHELL_HOOD_GAP_M = 0.004  # minimum hood-to-back clearance (no crossings)
# Attached hood worn down: padded face-opening edges round the neck (look values from the
# product photos, uncalibrated; same as the former render-only proxy in garmentLook.ts).
SHELL_HOOD_RIM_OPENING_M = 0.02  # collar arc from centre front where each edge starts
SHELL_HOOD_RIM_LENGTH_M = None  # collar arc per edge; None = continuous round the back of the neck
SHELL_HOOD_RIM_RAMP_M = 0.045  # rise/radius ease-in at both ends
SHELL_HOOD_RIM_RISE_M = 0.008  # roll above the collar top
SHELL_HOOD_RIM_BACK_RISE_M = 0.015  # extra rise at centre back (hood stands behind the neck)
SHELL_HOOD_RIM_RADIUS_M = 0.013  # padded edge radius
SHELL_HOOD_RIM_GAP_M = 0.002  # clearance outside the collar relief
SHELL_HOOD_RIM_LIFT_LOFT = 0.62  # collar relief the edge stands outside (x loft; renderer)
SHELL_HOOD_RIM_MIN_EASE = 0.3  # smallest ease at the strip ends (no short edges or slivers)
# Rounded hood tip, numerical: the old 0.05 / 0.6 collapsed the last row to 0.9 mm edges and
# sliver triangles that any relax motion stretched 2x. These keep tip edges >= ~3 mm.
SHELL_HOOD_TIP_MIN = 0.3  # squared half-width floor of the rounded tip (was 0.05)
SHELL_HOOD_TIP_ROW_SCALE = 0.85  # last (rim) row width relative to the outline (was 0.6)
GARMENT_CONSTRUCTION = "shell"  # "shell" (tape-true posed shell) or "pattern" (03c wrap WIP)
SHELL_SHOULDER_REACH_M = 0.03  # shoulder sections include the arm root up to acromion + this
SHELL_UNQUILTED_PUFF = 0.5  # rendering convention: yoke/collar/bands puff to half the loft
SHELL_TETHER_ROOT_STRIDE = 4  # every 4th neckline/shoulder-ridge vertex is a geodesic root
# Relax of the wrapped shell under gravity + body contact (agent S, 2026-11-12). 0 = fallback 1
# (no simulation, the computed wrap is shown). The old 2-substep solve free-fell (one
# Gauss-Seidel sweep per substep makes a hanging chain sag ~rows^2*g*h^2); see STATUS.
SHELL_RELAX_SECONDS = 0.0  # live: static shell until the relaxed look is verified (see STATUS)
# Solver settings merged over CLOTH_CONFIG for shell assets (ClothSolver small-steps path).
# Numerical choices are measured on .cache/solver/run.mjs; material values are uncalibrated.
SHELL_CLOTH_CONFIG = {
    "smallSteps": 1,  # Macklin et al. 2019: many substeps, lambda reset per substep
    "substeps": 10,  # measured: fewer lets the one-sweep stretch chain sag/stretch
    "iterations": 2,  # stretch sweeps per substep (2nd reversed); 1 left 2-4 mm edges at 1.11
    "strainLimitPasses": 2,  # hard passes over edges above stretchMax (hot list, before contact)
    "oneWayTethers": 1,  # LRA roots (neck/shoulder ridge) are not dragged by their children
    "supportCompliance": 0.3,  # m/N, numerical: one-sided pull to the constructed root distance;
    # extra sag ~ particleMass*g*compliance = 0.3 mm, carries weight the 1-sweep chain cannot
    "rootCompliance": 0.1,  # m/N, roots held at their body anchors: shoulder static friction
    # (uncalibrated); measured creep <= 0.4 cm at the shoulder seam
    "hingeCompliance": 1e-3,  # m/N cross-edge bending distance, uncalibrated (rest = wrapped shape)
    "hoodLayerGap": SHELL_HOOD_GAP_M,  # hood keeps the back shell's body clearance + this gap
    "dampingPerSecond": 3.0,  # 1/s velocity decay, uncalibrated air/fill damping
    "guides": 2,  # hand stop only: the cuff band never slides past where the wrap put it
    "selfEvery": 4,  # sleeve/torso, hood/back particle contact every 4th frame (cost)
    "contactFromInitial": 1,  # contact starts at the built clearance where < layer + margin
    "hingeSkipElastic": 1,  # elastic rib bands gather freely (no shape-memory hinges)
    "elasticStretchMax": 1.10,  # uncalibrated elastic rib limit (woven shell keeps stretchMax)
    "layerPairRadius": 0.015,  # m, cloth-on-cloth pairs (sleeve/torso, hood/back) built at start
    "layerPairsPerVertex": 3,  # closest triangles per vertex / edge midpoint
    "layerGap": 0.002,  # m, kept between layers (or the constructed gap if smaller)
}
SHELL_UNTANGLE_PASSES = 12  # sleeve-off-torso crossing repair passes (each re-checks the body)
SHELL_UNTANGLE_STEP_M = 0.002  # outward move per pass for vertices of crossing sleeve edges
SHELL_REPAIR_BELOW_M = 0.12  # armhole repair region: from this far below the armhole bottom
SHELL_REPAIR_ABOVE_M = 0.08  # ... to this far above the shoulder point
SHELL_ARM_SIDE_BAND_M = 0.12  # taped rings this far below the armhole clear the hanging arm
# Fit intents whose torso rows below that band hang from the row above (scaled to the tape, never
# inside body + clearance) instead of following each body section (agent L2: loose jackets fall
# straight from bust/shoulder blades in Parka1-2 and Puffer2-3; fitted rows showed the body).
SHELL_HANG_FIT_INTENTS = ("loose", "oversized")
SHELL_HANG_BLEND_M = 0.02  # smooth-max width where the body takes over (numerical, L2)
# (side flattened, tape taken up front/back: the arm presses the side panel; geometry rule)
SHELL_ARM_SIDE_ROOM_LAYERS = 2  # clearances kept between flattened side and arm (torso + sleeve)
SHELL_SMOOTH_PASSES = 6  # Taubin passes on shoulder/cap rows (numerical, volume-preserving)
SHELL_MID_SMOOTH_PASSES = 6  # Taubin passes, shoulder ridge -> armhole bottom rows (numerical)
SHELL_FINAL_SMOOTH_PASSES = 4  # Taubin passes on untaped torso rows after the clearance push
SHELL_ARMHOLE_EDGE_SMOOTH_PASSES = (
    6  # Taubin passes along the armhole's front/back edge columns (L1b)
)
SHELL_SLEEVE_RESPACE_PASSES = 2  # cap-row re-spacing after the clearance push (numerical)
# Sleeve stacking: compression grows from (1-r) to (1+r) x its mean, shoulder -> cuff (look, L1b:
# Puffer2/Parka2 photos show even tubes tapering steadily; uncalibrated).
# L3: smallest dropped-shoulder distance (shoulder tape vs body arc, per side) that draws the
# body panel over the sleeve cap down to the seam ring. Below it the seam is drawn at the armhole
# (within the 1 cm the cap blend already spans; look convention, not a fit value).
SHELL_DROPPED_SEAM_MIN_M = 0.01
SHELL_SLEEVE_STACK_RAMP = 0.4
SHELL_UNFOLD_PASSES = 6  # crease fairing passes on body-facing armhole/cap faces (numerical)
# Where the arm presses on the torso (G4): a sleeve sample within torso shell + separation +
# clearance + this band is resting on the side panel and is not pushed into it by the arm
# (numerical; body-grid sweep: 0 -> 8 mm left 0 visible underarm creases on the pinch bodies,
# 16 mm and more crossing-repair passes were worse).
SHELL_PINCH_REST_M = 0.008
SHELL_PINCH_WARN_M = 0.001  # warn when a sleeve rests this far inside a pressed arm (G4)
SHELL_UNFOLD_SMOOTH_STEPS = 3  # umbrella steps per unfold pass (numerical)
SHELL_UNFOLD_SLEEVE_ROWS = 3  # sleeve rows past the bicep ring the unfold may move (untaped)
# Underarm cap rows: row q at arc fraction (q / (rows + 1)) ** this along its column (1 = even),
# for cap columns up to the first length below, easing to even at the second (numerical).
# Motion bakes, puffer M woven worst, reach_up_both: even 1.88, 0.6 -> 1.43, 0.4 -> 1.42.
SHELL_CAP_ROW_GRADING = 0.4
SHELL_CAP_GRADED_COLUMN_M = (0.025, 0.05)  # cap column arc: fully graded .. even
SHELL_HOOD_CLEAR_PASSES = 12  # final hood-off-back crossing passes (numerical, 2 mm each)
SHELL_HOOD_SMOOTH_PASSES = 4  # Taubin passes on the folded hood pillow (numerical; root row fixed)
SHELL_HOOD_DRAPE_ROUNDS = 3  # final hood clearing: lift-to-gap + smooth rounds (numerical, L1b)
SHELL_HOOD_DRAPE_PASSES = 3  # Taubin passes per drape round (numerical)
SHELL_CHEST_ROW_BELOW_ARMHOLE = (
    2  # chest tape ring: 2 rows (~3 cm) below the armhole bottom (flat-lay 1 in. below pit)
)
SHELL_OFFSET_ARC_STEPS = 3  # corner arc samples in the dense offset polygon (numerical)
SHELL_RING_TOLERANCE_M = 1e-7  # ring perimeter vs tape solve tolerance (numerical)
SHELL_RING_SECANT_STEPS = 12  # bracketed secant steps before the brentq fallback (numerical)
# Shell look-defect gates (garment/shell_defects.py, agent G3). Look gates, not tape values.
# Shoulder/cap may stand outside the upper-body hull this much beyond the chest/bicep ease.
SHELL_GATE_FLAP_TOL_M = 0.02
SHELL_GATE_INVERTED_COS = 0.3  # inverted: normal > ~107 deg from "away from the body part"
SHELL_GATE_INVERTED_MIN_GAP_M = 0.004  # faces nearer the body are not judged (direction noise)
SHELL_GATE_INVERTED_PATCH_M2 = 0.0002  # largest visible inside-out patch, m^2 (2 cm^2)
SHELL_GATE_VIEW_COUNT = 16  # turntable camera azimuths for the inside-visibility test
SHELL_GATE_VIEW_ELEVATIONS_DEG = (0.0, 20.0)  # camera elevations (kiosk eye height ~ chest)
SHELL_GATE_HEM_HEIGHT_M = 0.005  # hem ring vertical spread (level hem in the display pose)
SHELL_GATE_HEM_DENT_M = 0.001  # hem vertex inside its neighbours' chord (convex outline expected)
# Elastic hem rows gather only if worn at least this much shorter than the body fabric (chest
# tape) fed into the casing; below it the casing is taut (look rule: ~1 gather per 2 cm needs a
# few % excess fabric to read at all; uncalibrated, no worn-hem photos yet).
SHELL_HEM_GATHER_MIN = 0.03

# Demo hardening (06 B): scheduling only; geometry/material constants above are unchanged.
# Windows BELOW_NORMAL_PRIORITY_CLASS (Microsoft processthreadsapi / SetPriorityClass):
# let the foreground camera/render thread run before these CPU-only asset workers.
ASSET_WORKER_PRIORITY_CLASS = 0x00004000
# MKL uses per-thread native buffer pools by default. Short-lived API/speculation
# threads left RSS growing with flat Python caches. Disable those pools, not numerical
# kernels; source: Intel oneMKL "Avoiding Memory Leaks in oneMKL" (Windows guide).
API_DISABLE_MKL_FAST_MM = True
