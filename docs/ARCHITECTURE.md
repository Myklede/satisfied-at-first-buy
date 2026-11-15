# Architecture — Milestone 2

Vite/React runs on 127.0.0.1:5710 and proxies /api to FastAPI on
127.0.0.1:8001. npm run dev starts both owned process trees. Body data stays local.

## Body engine

Anny 0.6.2 CPU blendshapes feed deterministic Adam / L-BFGS optimisation. Height
and signed volume use Anny anthropometry. Two scalar observations cannot identify
six shape coordinates: height/weight-only fits retain shipped adult muscle and
skeletal-proportion priors, releasing muscle only if the weight morph cannot meet
mass. Known tape constraints release all coordinates and ten local changes.
Up to four exact-section refresh passes update differentiable triangle/edge attachments.
Known constraints participate from the first Adam step; short L-BFGS solves stop
once exact measurements pass the original gates. Exact proxies are reused only for
bitwise-identical vertices. Conservative face-height bounds prune section searches.

Scene coordinates are metres, Y-up / +Z-front. Explicit rest-world LBS preserves
Anny's A-pose. Per-body acromion points use continuous coronal shoulder-ridge
attachments. The back shoulder route passes through C7 on posterior-facing skin.
An inclined C7/jugular-notch plane defines neck base; waist follows Anny's waist ring.
Conditional phenotype sampling produces q10–90 sensitivity bands through a separate
endpoint; these are not population confidence intervals. Density defaults to 1010,
with 1010 also supported and validated. All accuracy constants live in config.py.

## Garment engine

Validated, content-hashed products load from data/products. Actual owned-size tape
values, original BODY chart ranges and explicitly derived grading remain distinct.
Absent dimensions stay absent. The builder refuses incomplete garment geometry.

Pure fit math walks C7→shoulder→arm surface paths, places seams at half garment
shoulder width, and continues by sleeve length to locate cuffs. HPS→back surface
walking locates the hem; body girth is measured there. Inner girths prefer direct
lining tape, otherwise outer circumference − 2π × loft. Under-layers consume
another 2π × layer_cm. Loft uncertainty and available body girth bands propagate
into ease ranges. Thresholds, fit intent, preferences, weighted scores and missing
coverage are explicit heuristics. BODY-chart-only mode makes no geometry claim.

Fixed topology uses 24 angular samples / 14 torso rows / 8 sleeve rows, shared yoke
and armhole boundaries, an extruded collar, zip strip and cuff/hem bands. Smooth
normals, mild smoothing and folds give a shell proxy; this is not cloth simulation.
A vectorised 16-candidate triangle broad phase drives collision correction. Exact
queries use conservative triangle-enclosing spheres to certify pruning; tests
compare them with independent trimesh queries and an adversarial large triangle.
They verify vertices, edge midpoints and triangle centres before export.
GLB contains normals, colour, _gap_cm (outer distance), _inner_gap_cm (outer distance
minus loft/layer), and _detail. The underscore is glTF's custom-attribute convention.

Fitter: 16-body RAM LRU / RLock. GarmentService: 16-result and 32-mesh RAM LRUs /
RLock. Cache keys include body hash, product content hash, size, layer, preference
and model version; result keys also include computed uncertainty bands. Nothing
persists except explicit local validation exports. Hash lookup never builds a path
from API input. All responses are no-store, strict pydantic, loopback-only with
local CORS. Missing geometry returns 409; expired hashes return 404.

## Client and contracts

FastAPI OpenAPI → openapi-typescript → packages/api-types is the sole wire type
source. Typed zod schemas validate runtime responses. JSON person/garment schemas
come from scripts/export_schemas.py. npm run gen:api regenerates both contracts.

React owns forms, cancellations, product matching, size/mode controls, comparison
and explanation cards. Plain Three.js classes under engine own all scene behavior:
BodyLayer, GarmentLayer, LandmarkLayer, MeasurementLayer, FitAnnotationLayer,
CameraRig and Viewer. Shared topology permits a 400ms smoothstep buffer morph.
X-ray uses transparent material, depthWrite=false, body-first drawing and Fresnel
rim; heatmap uses the computed inner-gap attribute with thresholds from the API.
Compare uses two viewers with synchronised camera pose/target. Missing dimensions
show unknown zones and an unavailable 3D state. Generations/AbortControllers prevent
stale loads; replacement/unmount disposes geometry, materials, controls and labels.
Hidden body views suspend rendering. Live FPS is instrumentation, not a promised rate.

## Verification and remaining boundaries

Pure math, four real Anny reference fits, strict APIs, fixed topology, cache behavior,
GLB attributes, monotonic synthetic sizes and sampled collision checks have tests.
smoke:fit checks the running local proxy/API and parses actual GLBs using Three.js;
it does not execute browser rendering. Diagnostic PNGs use actual non-personal
reference geometry. Personal before/after and worn-fit reports are gitignored.

Current catalogue has complete S geometry in two products. Other sizes lack shoulder,
length, sleeve and bicep grades, so they have only estimated girth comparisons.
Browser automation stopped at a Windows URL-policy check; browser FPS and visual
WebGL/morph verification remain open. No Milestone 3 hand/webcam work is implemented.
