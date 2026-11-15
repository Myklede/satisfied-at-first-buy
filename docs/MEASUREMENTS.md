# Measurements and Anny discovery

Milestone 2 update: current per-body shoulder/C7/jugular detection, inclined neck
plane, contoured routes, density comparison and conditional uncertainty are documented
in [body-fixes-review.md](validation/body-fixes-review.md). Those definitions supersede
the original fixed-acromion/horizontal-neck descriptions below. Seed topology indices
remain useful for the other landmarks; acromion output points now use triangle attachments.

Current density defaults to **1010kg/m³**, with native Anny 980 also supported.
The local N=1 tape-assisted comparison favours 1010; 980 has slightly lower
height/weight-only MAE. Neither is an individually measured body density.
H/W-only fits retain shipped skeletal/muscle priors; known tape constraints still
release all shape coordinates. Neither approach establishes whole-body accuracy.

## Worn jacket validation (Milestone 2)

Use a helper, a flexible tape and the same thin t-shirt as the default under-layer.
Zip the jacket normally, empty its pockets, unfold cuffs, and let the hem settle.
Mark C7, left/right acromia, wrist creases and the horizontal fullest-hip level on
the body before dressing. Repeat each reading 2–3 times; keep raw readings in notes.

For the model comparison, hold the native A-pose: upper arms roughly 40–45° down
from horizontal, elbows almost straight, forearms slightly forward. A relaxed arm
or bent elbow changes cuff position; note posture rather than mixing measurements.
Do not pull out natural gathers or stretch the elastic hem to match a prediction.

1. **Shoulder seam offset:** measure from each marked acromion along the top/back
   shoulder→upper-arm surface to the sleeve-cap shoulder seam. Positive means the
   seam has dropped down the arm; negative means it lies inward toward the neck.
   Record both sides in notes; enter their mean in shoulder_offset_cm. Use the
   actual set-in seam, not the edge of a puff baffle. Raglan has no equivalent seam.
2. **Cuff offset:** extend the same shoulder→elbow→wrist route to the cuff edge.
   Measure signed distance from the wrist mark to the cuff: positive beyond the
   wrist toward the hand, negative if short. Record both sides and enter their mean
   in cuff_offset_cm. Record compressed/gathered fabric and elbow angle in notes.
3. **Hem versus hip:** measure the vertical height of the centre-back hem and the
   marked hip level from the same floor. Enter hem height minus hip height in
   hem_vs_hip_cm: positive above the hip, negative below. This is a vertical offset,
   distinct from the surface-walked HPS→hem tape length used to place the model hem.

Copy data/ground-truth/worn.example.json into data/ground-truth/worn/ with a separate
file for each product. Keep the product content hash and size exact, replace only
null readings with actual signed centimetres, and set person_id to the matching
person file. The directory and generated garment-personal-<date>.md reports are
gitignored. Run npm run validate:garment to fill predictions and prediction−tape
errors; a missing observation stays pending, never zero. This script uses regular
preference, the t-shirt layer and the body file's density / known constraints.

Garment chest/hem/bicep outer tapes are flat widths ×2 with the jacket zipped.
Direct chest_inner / hem_inner lining tapes take precedence when available.
Otherwise inner circumference ≈ outer circumference −2π×effective loft; loft is
compressible and its uncertainty propagates into ease. The men's elastic hem tape
is relaxed; maximum stretch is unknown. Cuff opening taper is a visual inference,
not a measured cuff-girth fit claim. Current PNGs use public reference bodies only.

Discovery performed on the installed **Anny 0.6.2** package and instantiated CPU model,
2026-11-10. Reproduce with `.venv/Scripts/python.exe scripts/discover_anny.py`.
Full label inventories and numerical discovery output are in `anny-discovery.json`.

## Actual model

- Standard `anny` topology: **13,718 vertices / 27,420 triangular faces**, four connected
  components, watertight and consistently wound in trimesh. The disconnected internal
  and eye geometry is part of the shipped model. No holes were filled and no vertices
  were welded or retopologised. Signed-tetrahedron volume uses the complete oriented mesh.
- Rest vertices use **metres, X lateral, Z up, -Y front**. The native pose is A-shaped,
  upper arms about 40–45° below horizontal with forearms slightly forward; it is not a T-pose.
- The scene conversion is `(x, y, z) = (native.x, native.z - min_z, -native.y)`.
  It preserves scale and handedness and places the feet at Y=0.
- `Anny()` defaults to six exposed phenotypes: `gender, age, muscle, weight, height,
  proportions`. Our `phenotypes="all"` model exposes exactly:
  `gender, age, muscle, weight, height, proportions, cupsize, firmness, african, asian, caucasian`.
- Gender endpoints are **0 male, 1 female**. Height/weight/muscle/proportions are
  normalised shape controls, not physical centimetres or kilograms. `cupsize` and
  `firmness` control breast morphology.
- Age anchors, from `models/phenotype.py` and `models/model_data.py`:
  newborn=-1/3, baby=0, child=1/3, **young=2/3**, old=1. We fix the named young-adult
  anchor 2/3; we do not interpret the slider as a linear number of years.
- Ethnicity-like `african/asian/caucasian` controls **exist**; the model normalises
  them to sum to one. Default service input uses an equal 1/3 mix. Optional UI presets
  select a shape reference. They do not identify a person's ancestry or guarantee accuracy.
- `local_changes="default"` exposes **254** controls, while plain `Anny()` exposes
  none. Relevant discovered labels include `measure-bust-circ-incr`,
  `measure-waist-circ-incr`, `measure-hips-circ-incr`, `measure-shoulder-dist-incr`,
  `measure-napetowaist-dist-incr`, `measure-upperarm-length-incr`,
  `measure-lowerarm-length-incr`, `measure-upperarm-circ-incr`,
  `measure-wrist-circ-incr`, `measure-neck-circ-incr`. The engine exposes these ten
  internally when optional tape targets are supplied. Native local changes use [-1,1].
- Rig has **104** bones; exact labels are in the discovery JSON. Landmarks use
  `upperarm01.L/R`, `lowerarm01.L/R`, `wrist.L/R`, `neck01`, `root`, and `foot.L/R`.

## Shipped utilities (installed-source search)

`anny/anthropometry.py` ships `Anthropometry.height`, `waist_circumference`,
`volume`, `mass`, and `bmi`. We reuse its differentiable height and signed-volume
implementations during optimisation. Its waist routine follows a fixed 46-vertex
ring, not a minimum convex-hull tape; exact reporting uses our plane-section rule.
Its mass helper uses **980 kg/m³**. The milestone requests approximately 1.01 g/cm³,
so our config uses **1010 kg/m³** explicitly, multiplying its computed volume.
This density is an assumption, not a measurement of any person's body composition.

`shape_distribution.py` includes morphological-age mapping and age/sex-conditioned
shape distributions calibrated with WHO height-vs-age data. These sample normalised
phenotypes; they do not directly invert a given adult cm/kg pair into phenotypes.
`anny_inverter.py` inverts supplied mesh/joint observations, not scalar tape inputs.
Our scalar-target optimisation therefore uses the shipped anthropometry and autograd,
with a weak neutral-slider prior. That prior is a modelling assumption, not a validated
adult population distribution.

Default `return_bone_ends=True` is unsupported for the current cached-orientation rig.
The service uses the returned rest bone heads. Also, `pose_parameters=None` is not
an identity deformation: it applies reference orientations and recentres the root.
We explicitly pose bones at their rest-world matrices. Identity LBS is then checked
against rest vertices; mesh, landmarks and tapes undergo the same identity deformation
and coordinate conversion. Measurements are made on rest geometry, independently of cameras.

## Definitions and limitations

These are practical apparel measurements using ISO 8559-1-style terminology, **not
a claim of ISO conformity**. Anatomical search windows and vertex indices are
explicit approximations in `config.py` and `services/body/landmarks.json`.
They need validation with tape measurements before making claims about human accuracy.

| Output | Exact reported computation | How to tape yourself to match it |
| --- | --- | --- |
| Stature | Rest vertical max Y − min Y | Barefoot, standing straight, floor to crown. |
| Mass | Closed signed-tetrahedron volume × 1010 kg/m³ | Use a scale in light clothing; density remains assumed. |
| Chest | Largest isolated torso convex-hull section in 70–78% of stature; skip arm-connected sections | Horizontal tape around fullest chest/bust below armpits; breathe normally. |
| Waist | Minimum torso hull girth in 57–65% of stature | Narrowest torso between lower ribs and iliac crest; keep tape horizontal. |
| Hip | Maximum hull girth in 46–56% of stature | Fullest buttock/hip circumference; tape horizontal. |
| Neck base | Horizontal hull section midway between neck-base front/back landmark heights | Tape around base of neck; keep it level. Natural sloped collar girth can differ. |
| Upper arm | Limb-perpendicular hull at midpoint of acromion→elbow | Left arm held in the displayed A-pose; tape perpendicular to upper arm at midpoint. |
| Wrist | Limb-perpendicular hull 2% proximal to the wrist landmark | Tape immediately above left wrist, perpendicular to forearm. |
| Shoulder width | Straight distance between surface acromion landmarks | Have a helper measure straight acromion-to-acromion distance; do not follow the back curve. |
| Shoulder arc | Shortest triangle-edge path restricted to the posterior surface | Tape follows the back surface across the shoulder points. Discrete mesh paths can overestimate smooth arcs. |
| Back length | C7 to nearest back waist surface point, shortest mesh-edge path within midline strip | Mark C7 at nape, follow centre back down to the marked horizontal waist. |
| Arm length | Left acromion→surface elbow→surface wrist polyline | Hold the displayed A-pose with slight elbow bend; measure the same two segments. |
| HPS L/R | Surface nearest lateral neck-base joint offset | Mark the highest shoulder point where neck meets shoulder, for later garment length. |

Every girth first intersects triangles, welds shared endpoints, isolates connected closed
loops, and chooses the relevant body-part loop. Only then does its **2D convex hull**
define a tape perimeter. A convex hull bridges body concavities like a tensioned tape.
Hulling all torso/arm section points together is explicitly avoided. The returned 3D
polylines are the actual hull tapes; hull edges may bridge skin concavities.

The crotch, heels, crown, bust points, elbow/wrist, C7, neck bases, HPS and acromia use
fixed topology indices selected once on a neutral adult mesh, combining bone proximity
with documented surface rules. Waist/hip levels are recomputed from each shape's exact
tapes and returned as plane-centre landmarks. Extreme-shape ordering is tested; anatomical
localisation accuracy requires human review. `scripts/build_landmarks.py` regenerates
indices with `PYTHONPATH=services/body` set (or through the documented project scripts).

## Fitting and interpreting residuals

Sex and adult age are fixed. Height, weight, muscle, proportions, cupsize and firmness
are sigmoid-bounded; relevant optional local changes are tanh-bounded. Adam followed
by L-BFGS minimises normalised squared target residuals plus a weak neutral prior.
Convex-hull and surface-path measurements are differentiated through edge/path attachments,
then exact sections are recomputed between three refinement passes and for final reporting.
Unreachable targets return `converged=false` with actual residuals and a warning.

Acceptance gates: height <0.5 cm, geometric mass <1 kg, supplied tape lengths <1.5 cm.
The four reference inputs check these **supplied constraints** only. They have no real
tape girths, so they cannot establish human girth prediction accuracy.

## Personal validation workflow

1. Copy `data/ground-truth/me.example.json` to `me.json`. Example numbers are illustrative.
2. Replace height, weight, sex and every known length with your own readings. Omit a
   known field you did not measure. Use an anonymous `person_id` and add posture/date
   notes, clothing and tape tension; do not put identifying details in the filename.
3. Take each tape reading 2–3 times without compressing skin and record the median.
   Use a helper for shoulder width and back length. Keep posture consistent with the viewer.
4. Run `npm run validate:body`. It fits each real file from height/weight/sex, then with
   all provided known lengths. Reports show signed errors and MAE in cm across provided
   tape lengths; kg errors remain separate. No example is included as a measured person.
5. Inspect the local, gitignored `docs/validation/body-YYYY-MM-DD.md`. Do not commit
   personal data. Human Gate A remains unestablished until real measurements are supplied.
# Realism: sourced appearance and model-based grading

`visual` stores each feature with provenance and an approximate flag. Photo values
are the approved Claude estimates in prompt 03, scaled by the owned HPS tape;
the two hex colours are explicitly uncalibrated model assumptions. Logos are omitted.
Appearance is excluded from the stable measurement ID and included in mesh cache keys.

Run `npm run prepare:garments` to fit public chart-midpoint bodies (chest, waist,
hip). Height uses the NZDF Anthropometry Survey, table 6.4.1, printed p.119:
male 178.6 cm (SD 6.5), female 167.1 cm (SD 5.5). This military sample is a
population proxy, not a universal shopper distribution. Primary report:
https://openrepository.aut.ac.nz/server/api/core/bitstreams/d707fec4-33ba-42e7-bf86-ccf9ffa9b14a/content

Reference fits constrain height and three girths; mass is computed, never supplied
as an observed chart fact. All 11 fits meet the existing exact measurement gates.
Grade shoulder/sleeve/HPS length/bicep by reference shoulder arc/arm length/back
length/upper-arm deltas from the owned S. Equal-weight isotonic projection keeps
grades monotone with an exact zero at the owned tape. Reports retain raw deltas
and projection corrections. Bands add 3 cm of uncalibrated model allowance,
projection correction and a height-SD sensitivity term; these are not confidence
intervals. Raw product files retain missing non-owned tapes. Runtime preparation
adds labelled `derived_grading` values from the committed public reference reports.

## Rest cloth, display pose and simulated offsets

The dense procedural rest pattern is independent of the shopper. Actual mesh
paths reproduce chest/hem/shoulder/HPS/sleeve/bicep tapes within 0.5cm for every
graded size; topology is fixed per product. A cosine quilt displacement is zero
at stitch paths. Rest lengths are never rewritten to match the posed body.
Hood dimensions and 21cm inner cuff opening are uncalibrated construction assumptions.

Anny bone transforms place the arms at 27 degrees with 12 degrees elbow flexion;
anthropometry remains on the original rest body. Initial sleeves follow the
actual posed shoulder/elbow/wrist bone route. Hardware inherits adjacent triangle
frames. These operations only initialise dressing; they are not final world pins.

The CPU XPBD solver uses original edge lengths, signed dihedral rest angles,
seam weld distances, elastic circumference constraints, dynamic-cloth-root geodesic
upper bounds, body SDF contacts/friction and inter-panel particle hashing. A cuff
winding guide follows mesh-section centres; its distal barrier is computed where
the body section plus under-layer exceeds the inferred opening. A large opening
has no barrier. This is a topology/contact approximation, not a prescribed wrist
position or a calibrated cuff model. Excess sleeves still exhibit excessive
strain and require solver correction before fit claims.

Insulation contact is compliant, with a provisional 25% minimum loft and unmeasured
compliance. Heatmap inner gap subtracts the current compressed insulation and
under-layer from outer distance; neutral gathers do not signify a tightness verdict.
This compression model is uncalibrated and does not alter analytic rest-girth ease.

Simulated seam offset projects seam minus acromion along the posed upper arm;
cuff offset projects the closed ring centre minus wrist along the posed forearm.
Hem minus hip is the vertical signed difference. Left/right offsets are averaged;
anchors retain both sides. Differences over 1.5cm show analytic and SIM values.
SIM bands are null because no calibrated simulation uncertainty exists. A failed
stretch gate suppresses confident SIM verdicts; numerical positions remain visible
for diagnosis. Worn errors are only computed after real human readings are supplied.


## 03c neutral fabric and outer reference (2026-11-11)

The new wrap path distinguishes the unpuffed simulation fabric from the rendered
outer surface. The outer reference is explicitly `mesh.vertices + render_offsets`;
its actual paths and an independent ordered chest section reproduce every supplied
tape within 0.5cm for all 11 sizes. The lining alone is not reported as an outer
tape. Product-only cosine loft determines the difference; no shopper numbers enter
rest calibration. The cuff band has zero puff at its compressed seam, so its
unmeasured 21cm opening is not enlarged by adding full insulation loft twice.

Both variants remain available while runtime integration is in progress. The new
neutral variant shares cloth seams and stores hardware as local triangle-frame
attachments. Sleeve-enclosure validation uses ordered concavity-preserving mesh
sections, never a convex hull that could conceal an escaped arm. Current static
contact prototypes still fail stretch; none is acceptance evidence yet.

## Webcam scan constraints (milestone 3)

`FitRequest.scan_measurements` carries @satisfy/vision results:
`shoulder_width_cm`, `chest_cm`, `waist_cm`, `hip_cm`, `arm_length_cm`, each
`{value_cm, sigma_cm, method}`, plus the calibration id. Values use the same
physical ranges as tape `known_measurements`; σ must be 0.1–100000 cm; unknown
fields are rejected.

Fitting (`fit.py`, constants in `scan_config.py`):

1. Fit the same request **without** the scan (cached; this is the "base" body).
2. Starting from the base body, release muscle/proportions/cupsize/firmness and
   the local changes, and minimise
   `((h−H)/0.5)² + ((m−M)/1.0)² + Σ_tape ((t−T)/1.5)² + Σ_scan ((s−S)/σ)² + anchor`,
   where `anchor = Σ((p−p_base)/0.25)² + Σ((l−l_base)/0.5)²`. Scan terms are
   therefore weighted by **1/σ²**; tape terms keep their stronger 1/1.5² weight
   and a tape value of the same name overrides the scan entry
   (`scan.overridden_by_tape`). Height and mass remain hard targets for
   `converged`; scan residuals are reported, not gated.
3. The response's `scan` block records `source: "webcam_scan"`, calibration,
   weighting, value/σ/fitted/residual per entry and `base_body_id`.

Measured on the 172 cm / 65 kg male reference with synthetic scan offsets of
+3 cm shoulder width and +6 cm chest (tests in `test_scan_fit.py`):

| σ (cm) | shoulder moved | chest moved |
| ---: | ---: | ---: |
| 1.0 | +3.30 | +5.85 |
| 1.5 | +2.45 | +5.65 |
| 2.0 | +2.44 | +5.27 |
| 6.0 | +1.07 | +3.23 |
| 10 000 | 0.000 | 0.000 (same body as no scan, max vertex Δ < 1 mm) |

Uncertainty bands with a scan keep the same phenotype sampling as without one and
additionally reject samples that disagree with any scan value by more than
max(1.5 cm, 2σ). Chest band width (q10–q90): 6.77 cm without scan, 4.53 cm with
σ = 2 cm. These are conditional sensitivity bands, not population confidence. The
anchor widths and the 2σ acceptance are heuristics; the scan calibration itself is
currently `uncalibrated` (see packages/vision/CALIBRATION.md).
