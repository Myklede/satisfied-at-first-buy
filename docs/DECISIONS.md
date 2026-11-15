# Decisions

## 2026-11-12 — Prompt 07 A, offline paper-relative colour

- Promote the already installed/locked Pillow 13.0.0 (HPND permissive licence)
  to a direct runtime dependency for local image decoding, EXIF orientation and
  ICC-to-sRGB conversion. No new package/version is installed; no cloud API is used.
- Keep the tool in `body_service/lookdev`, independent of garment code and renderer
  defaults owned by concurrent Claude agents. IEC sRGB, Bradford and CIEDE2000 are
  implemented using existing NumPy. Use published Delta E reference pairs as an
  independent check, not just a forward/inverse colour transform roundtrip.
- Assume paper diffuse reflectance 0.90 with 0.88–0.92 endpoints as supplied by
  prompt 07. This is not a calibrated sheet specification. Report endpoint colour
  sensitivity separately from region IQR and explicitly state unmodelled photo
  errors. Reject unusable calibration instead of emitting a plausible false colour.

## 2026-11-11 — Milestone 2 garment and Fit Studio

- Keep original Nike BODY charts separately from actual owned S garment tapes.
  Other chest/hem girths use the authorised constant-design-ease chart grade with
  derived_grading provenance. Missing shoulder, HPS length, sleeve and bicep grades
  prohibit geometry for non-owned sizes. Test-only full M dimensions never enter
  the real catalogue. No retailer/body number is silently treated as garment tape.
- Use outer−2π×loft (or direct lining tape), then subtract 2π×under-layer for inner
  ease. Carry men's ±0.25cm loft into the interval. Compare ease to owned-style
  design intent, not one universal loose-jacket band. Relaxed elastic-hem allowance
  is a tolerance heuristic, not an inferred maximum stretch.
- A fixed 24×14 torso / 8-row sleeve LOD, shared armhole/yoke, collar, zip and bands
  replaces denser meshes that exceeded 1.5s. The user chose to retain this resolution
  while lowering external machine load; do not reduce it further to pass timing.
  Reuse final exact vertex distances instead of querying twice. Final four-reference
  builds are 476.4–665.1ms. Candidate correction is followed by exact sampled verification.
  This produces a collision-cleared shell proxy, not fabric/pattern physics.
- Preserve outer _gap_cm in GLB and add _inner_gap_cm for insulation-aware heatmap.
  The UI explicitly labels the deduction, uses API thresholds, and adds Fresnel
  transparency, annotations, synchronised comparison and 400ms topology-safe morphs.
  API wire types stay generated; runtime zod schemas are checked against those types.
- Personal body and worn observations / derived predictions remain ignored. The
  public STATUS links to private local reports instead of publishing individual
  predictions. Missing worn readings stay pending and cannot produce an accuracy MAE.
- No new dependencies beyond the Part A spatial/rendering tools were required.
  Browser access host was unavailable; native Computer Use stopped at a Windows
  URL-policy check. Continue read-only API/asset checks, but do not claim browser
  shader/FPS validation or try another browser automation route around that stop.
- Share a certified exact surface query between body and garment: triangle-enclosing
  spheres conservatively include every potentially closer triangle. Test against
  independent trimesh distances and an adversarial far-centred large triangle.
  Prune horizontal section scans by conservative face-height bounds, and reuse exact
  proxies only when final vertices match bitwise. Start known-measurement optimisation
  with every supplied target, use shorter solves between exact geometry refreshes,
  and stop at the unchanged accuracy gates. No personal target enters these rules.
- Final constraint-first validation favours density 1010 for the measured-body
  workflow: all supplied target gates pass, unlike 980. Retain both options. Earlier
  preference for 980 was based on the preceding solver and is superseded by this run.
  H/W-only MAE is still slightly lower at 980; neither is a measured personal density.

## 2026-11-10 — Milestone 2 Part A

- Replace fixed acromion outputs with per-body continuous triangle attachments from a
  coronal shoulder ridge profile. A nearest coarse vertex can land in the axilla, so
  use barycentric weights in fitting. Retain seed indices for the other stable landmarks.
- Localise C7 and jugular notch against the fitted rig and use their inclined plane.
  Shoulder and back routes are sampled/projected onto the surface, avoiding graph-edge
  staircase inflation. Waist search follows Anny's shipped waist ring during local edits.
- Density is an explicit 980/1010 API/config choice. Both are validated; the final
  constraint-first tape comparison retains 1010 (see the later decision above).
  Conditional bands are computed
  separately and cached in RAM; they are sensitivity ranges, not calibrated confidence.
- New pinned dependencies: rtree 1.4.1 (MIT, spatial queries/collision), matplotlib
  3.11.2 (Matplotlib license, reference mesh PNG rendering), pypdf 7.0.1 (BSD-3-Clause,
  extraction of the original NZDF reference statistics). PDFs/model-reference downloads
  and matplotlib caches remain in .cache; only reference aggregates/images are committed.
- Update 2 of the demo-jacket addendum supersedes its unresolved flags. The user
  authorises set-in construction for both, jacket 1 sleeve 53cm / CB sleeve 82cm,
  jacket 2 effective loft 2.75±0.25cm. Do not retain earlier 70cm / 5–6cm values.
- For height/weight-only fits, retain shipped Anny adult muscle/proportion prior
  means, rather than optimising six latent coordinates against two observations.
  Release muscle only if the weight morph's boundary cannot meet mass. Keep cupsize
  and firmness at Anny defaults. Known tape targets still release all coordinates.
  Across-shoulder samples project onto posterior-facing upper-back triangles through C7.
  No real person's measurement appears in these rules. The local shoulder gate passes,
  but chest prediction regresses; full body accuracy remains an explicit limitation.
  Personal input and before/after validation exports are ignored, not committed.

## 2026-11-10 — Milestone 1 implementation (supersedes bootstrap blockers below)

- Network and Git writes were restored. uv 0.13.7 is bootstrapped in `.cache/uv`;
  Python 3.12.16 is managed under `.cache/python`; `uv.lock` pins the Python environment.
- Use Anny 0.6.2's commercial-friendly `anny` MakeHuman topology only, CPU torch,
  exact compact blendshapes, and ten discovered measurement-related local changes.
  No SMPL/SMPL-X data or extra is used. Default model assets ship in the wheel.
- Reuse Anny `Anthropometry.height` and `.volume` in autograd fitting. Its mass helper
  assumes 980 kg/m³; use the milestone's explicit 1010 kg/m³ assumption in config instead.
  These are geometric mass estimates, not measured body composition.
- Anny rest vertices are already an A-pose. Explicit rest-world bone matrices give
  identity LBS; default `None` uses reference orientations and recentres the root.
  Measurements and displayed overlays share the explicit rest A-pose frame.
- Single-thread torch and deterministic algorithms give identical independent fits.
  Adam then L-BFGS optimise sigmoid phenotypes; optional native [-1,1] local changes
  use tanh. Exact section hull attachments are refreshed between optimisation passes.
- Reject merged chest/arm contours above the axilla; hull each isolated loop, never
  all section points together. Measure upper arm at its midpoint to isolate it in A-pose.
- Keep all fitted bodies in a 16-entry memory LRU. Personal validation reports are
  explicit local exports; never upload body data. No telemetry or hosted deployment.
- Windows reserves TCP 5141–5240 on this laptop (`netsh ... excludedportrange`),
  including Vite's usual 5173. Use 127.0.0.1:5710 consistently in Vite, orchestration
  and the two permitted CORS origins. The body API remains 127.0.0.1:8001.
- Final measured CPU tuning: 20 Adam steps, at most 25 L-BFGS iterations per pass,
  and three exact tape-proxy refresh passes. A six-optional-measurement fit took
  4421.2 ms with maximum supplied length residual 0.02849 cm. Unit/integration tests
  enforce <5s on the four reference fits and that optional-target case.
- The Windows Python venv launcher starts a child interpreter. Dev shutdown terminates
  only the process trees it spawned, preventing an orphaned API process after Ctrl+C.
- Browser QA is incomplete. Isolated browser access was unavailable. After the user
  authorised opening a local test tab, Computer Use still stopped because it could
  not confidently determine Chrome's current URL for policy enforcement. Do not
  substitute a code build or geometric check for visual landmark/FPS verification.

Direct Python dependencies (versions pinned in `pyproject.toml`, transitives in `uv.lock`):
Anny (Apache-2.0 / MakeHuman data CC0), torch (BSD-3-Clause, CPU autograd), FastAPI
(MIT, API), uvicorn (BSD-3-Clause, ASGI), pydantic (MIT, strict validation), trimesh
(MIT, topology and GLB), numpy (BSD-3-Clause, geometry), scipy (BSD-3-Clause,
convex hull and graph paths). Development: pytest (MIT), ruff (MIT), httpx
(BSD-3-Clause, API integration), jsonschema (MIT, validation data).

Direct web dependencies: React/react-dom (MIT, UI), Three.js/@types/three (MIT,
renderer and typings), zod (MIT, runtime API validation), Vite/@vitejs/plugin-react
(MIT, local development/build), TypeScript (Apache-2.0), @types/react and
@types/react-dom (MIT). Development: ESLint/@eslint/js/globals/typescript-eslint
(MIT), Prettier (MIT), openapi-typescript (MIT, schema-generated API types),
Vitest (MIT, web unit tests). Exact versions live in package manifests and package-lock.json.

The first discovery accidentally allowed Anny's auto Warp backend, which initialized
its vendor-managed global kernel cache. All application/discovery code now explicitly
uses CPU `lbs` and repository-local caches; no CUDA runtime is needed.

## 2026-11-10 — Bootstrap and installation blocker

- Follow the updated `AGENTS.md`: coding may begin now. Use Anny with its default commercial-friendly topology, never the SMPL extra.
- Keep the uv bootstrap target inside `.cache/uv` rather than installing outside the allowed workspace. The installation failed, so uv is not available and no dependency has been added.
- Do not design measurements, phenotype mappings, or skinning against unverified Anny assumptions. Milestone 1 explicitly requires actual model discovery first.
- Stop at the dependency/model availability blocker rather than fabricate model output or claim unperformed validation. See `STATUS.md` for the observed errors and remaining work.
- Normal `git add` and `git commit` failed because `.git/index.lock` cannot be created. Do not relocate Git metadata or otherwise bypass the session's read-only protection.
# Local browser benchmark (continuation 03b)

`playwright` 1.56.1 (Apache-2.0), pinned in package-lock.json, is a development-only
dependency explicitly requested by the user/Claude continuation prompt. It launches
the already-installed Chrome headed (`channel: 'chrome'`); no browser download,
external service, telemetry or paid API. The benchmark blocks non-loopback network
requests and keeps measurements/screenshots local. Personal images remain ignored.

## CPU cloth contact and acceptance audit (2026-11-11)

- Keep CPU only per 03b. All per-constraint hypot/spread operations were removed;
  cached typed compliances, analytic eight-corner SDF gradients, dense counting-sort
  hash/CSR exclusions, conditional maps and recycled transferables are implemented.
  Current 2x1 substeps/iterations and every-second-frame particle self-contact are
  provisional: the independent strain/inter-panel acceptance gates still fail.
  Performance alone must not approve these numerical settings.
- Use a 7mm service-side, RAM-only body SDF, binary once per body. Refine a 6cm
  contact band against actual triangles seeded from nearby surface voxels; this
  remains an approximation. Independent exact closest-face sidedness plus ray
  parity for every closest-edge/vertex case verifies all body-contact samples
  rather than trusting that same field. A nonconvex annulus regression compares
  this classification with full ray parity. Caches evict dependent assets
  when a body's field expires. No new geometry dependency was added.
- Closed cuffs use mesh-derived arm/hand sections to preserve winding and derive
  an aperture barrier. This addresses vertex-only collision slipping through the
  hand, but depends on an unmeasured 21cm cuff assumption. Compliant fill (minimum
  loft ratio 0.25) replaces an impossible rigid insulation offset; it is not a
  measured Thermore modulus. Both require calibration, not personal-number tuning.
- RoomEnvironment, ACES, GTAO and SMAA come from the already-pinned MIT Three.js
  dependency; no HDRI download or new asset license. Physical fabric materials use
  procedural fine-weave/ripstop normals; metallic zipper shading is per vertex.
- Browser reports distinguish render RAF from actual worker-delivered physics
  frames. Full-mesh deterministic checks compare raw Float64 positions and strain
  bit for bit. Quality checks include edge/face body samples and two-way critical
  panel edge/triangle crossings; coplanar overlap and all same-panel self-contact
  remain outside that check. A failed audit exits nonzero and invalidates SIM fit
  confidence. It is not converted into a passing engineering test.
  Finite segment AABBs accelerate the inter-panel broad phase; the narrow phase
  remains two-sided Möller–Trumbore intersections. The audit child process uses
  one BLAS thread to avoid oversubscribing this laptop.


## 03c contact field correction

Closest points on a mesh edge or vertex use their feature pseudonormal rather
than an arbitrary incident face normal when refining the contact SDF. Vertex
normals are angle weighted by Trimesh; edge normals sum both incident face
normals. The independent quality audit retains exact closest-face queries and
ray parity. Five SDF/query tests pass in0.42s, including nonconvex parity. This
improves sign consistency but does not establish cloth acceptance; dynamic
stretch/convergence still fail in current prototypes.

## 2026-11-12 — 03c fallback 1 goes live: tape-true posed shell, no relaxation (Agent C)

- The pattern.py wrap (Codex WIP) failed its initial-state gates (edge ratio up to 3.1, up to
  6.1 cm body penetration, parka ~25 cm short) and the CPU XPBD relax drives even a zero-strain
  shell into free fall within 0.3 s. Following "correct and clean beats ambitious and broken"
  and the pre-approved 03c fallback, the live garment is a shell built directly on the posed
  body from the tapes (`garment/shell.py`), shown without simulation (`SHELL_RELAX_SECONDS = 0`).
  Switching back is one config value each (`GARMENT_CONSTRUCTION`, `SHELL_RELAX_SECONDS`).
- Rest geometry = displayed geometry except two physical cases that are computed, not tuned:
  sleeve material beyond the hand stop is axial compression (stacking), and the elastic hem's
  stretch over the hip is reported (the worn band is the rest state).
- Sleeve/torso and body clearance are enforced by small regional repairs and verified by the
  independent quality audit (exact closest-face + ray parity, two-way edge/triangle crossings).
- No new dependencies. The cloth asset gains `render_details` (sourced visual facts for the
  shader); API types regenerated.
- After a garment fit the server builds every size in a background thread, nearest sizes first,
  and only while no HTTP request is active (Python locks are unfair; this keeps live requests first).
## Milestone 3 kiosk (agent K, 2026-11-12)

- **No new third-party dependency.** `apps/web` now depends on the in-repo
  workspace `@satisfy/vision` (Claude-owned; used only through its public API).
  The kiosk server uses Node built-ins plus the already-pinned `zod`; the soak
  test uses the already-pinned `playwright` with installed Chrome.
- **Vision assets** (`/models`, `/mediapipe/wasm`) are copied by
  `scripts/kiosk-assets.mjs` from `packages/vision/public` into the gitignored
  `apps/web/public/vision/`; the kiosk passes `assetBase: '/vision/'` (scanner) and
  explicit model/WASM paths (hand tracker). A copy, not a symlink, so the
  production `dist/` is self-contained. Missing models trigger the vision
  package's own hash-verified fetch script.
- **Camera permission:** the kiosk Chrome uses a dedicated profile
  (`.cache/kiosk-chrome`) with `--use-fake-ui-for-media-stream`, which
  auto-accepts the permission prompt but still uses the real camera. Web security
  is never disabled. The soak test additionally uses
  `--use-fake-device-for-media-stream` (synthetic camera).
- **Loopback-only kiosk window:** `@mediapipe/tasks-vision` 1.2.2 contains a
  usage logger that POSTs to `https://odml.pa.googleapis.com/v1/log` when a task
  is created/closed, with no opt-out found in the bundle. The kiosk Chrome is
  started with `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1,
  EXCLUDE localhost"`, so nothing but loopback resolves in that window. The soak
  test counts these attempts separately (all blocked). The dev studio and the
  vision lab page are not protected by this flag (reported to the vision owner).
- **"Act on the recommendation":** the store button asks the kiosk server to open
  the catalogue's own product URL (looked up server-side by product id; the
  client never sends a URL) in the operator's **default browser** via
  `rundll32 url.dll,FileProtocolHandler` (no shell). It does not open inside the
  kiosk window because that profile auto-accepts camera prompts and resolves only
  loopback. The catalogue has no size-specific URLs, so none is fabricated: the
  button says "Open on Amazon in size M" / "Open store page (eBay)" and the
  caption says "Choose size M on the page". Under Vite dev (no kiosk server) it
  falls back to `window.open(url, '_blank', 'noopener')`. No QR code (would need a
  dependency).
- **Reset = forget + reload.** Reset calls `DELETE /body/{id}` (body, its scan
  base, garment fits, meshes, cloth assets, SDF bytes) and then reloads the page.
  The engine keeps module-level caches (settled cloth, SDF fetches) that the kiosk
  cannot reach without editing engine files; a reload provably drops all of them,
  plus any camera handle or worker. Cost: warm-up runs again (measured in
  `docs/validation/kiosk-soak.json`).
- **Scan soft constraints:** the scan solve starts from the no-scan body and adds
  a Gaussian anchor to it (`scan_config.py`), so σ → ∞ reproduces the no-scan body
  exactly (tested) instead of jumping to a different optimum when extra shape
  coordinates are released. Adam is skipped for that solve; L-BFGS only.
- **Accuracy board** lives in the gitignored `data/accuracy/board.json`, written
  only after the judge ticks the opt-in box. Entries hold predicted/measured
  offsets, integer height, sex, jacket style/size and whether a scan was used. No
  name, image or timestamp.

## Fit Agent M5 (agent F5, 2026-11-12)
- **No new dependencies.** The extension is bundled with the repo's existing `esbuild`
  (`node apps/extension/build.mjs`), type-checked with the root `typescript` and tested with the
  root `vitest`; its API shapes come from the generated `@satisfy/api-types`. Root
  `package.json` is untouched (no workspace added).
- **`anthropic` Python SDK: deferred.** User rule 2026-11-12 (`docs/USER-RULES.md`): no money
  outside the paid Claude plan. The paid `bedrock` / `anthropic` providers keep their interface
  (`agent/providers.py`), import the SDK lazily and are off unless credentials exist **and**
  `FIT_AGENT_ALLOW_PAID_LLM=1`; the UI and log say "paid provider disabled by user rule". When
  the user approves spending, add `anthropic[bedrock]==2.8.0` (resolved 2026-11-12; note it
  pulls boto3/botocore and pins `python-dateutil` to 2.9.0.post0 instead of 4.0.0).
- **Live LLM = `claude -p` (subscription).** Resolution order: reviewed extraction →
  deterministic rules parser → `claude_cli` → paid (disabled). Billing guard: the child
  environment drops `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK`, and `claude auth status`
  must report a `claude.ai` first-party subscription login before any prompt is sent. The page
  text is untrusted: no tools (`--tools ""`), no MCP, `--safe-mode`, page on stdin, argument list
  without a shell, 180 s timeout, at most 3 calls per minute, cached by ASIN + page hash, and
  every number in the answer must be printed on the page. An npm `.cmd` shim is resolved to its
  `claude.exe` (batch files would re-parse arguments). Model `claude-opus-5-5` (skill default),
  `--effort medium`, configurable with `FIT_AGENT_LLM_MODEL`.
- **Reuse the analytic engine unchanged.** `fit_math.fit_size` / `rank_sizes` run on a
  `GarmentSpec` built from the chart (inches × 2.54, flat half-widths × 2). Learned personal
  offsets are applied by running the same engine on a shifted spec (each size X cm smaller in
  the zone), which equals raising the target by X; the shown numbers stay the real ones.
- **Body charts** use fit_math's existing body-chart mode (distance from the retailer's body
  range); the "estimated garment = body + standard ease" range is shown, labelled estimated.
  Ranges are never collapsed to an invented midpoint.
- **Privacy split in the extension:** body data is entered only on the extension's own
  profile page (chrome-extension:// origin). The content script on amazon.com never receives
  it; the panel uses a closed shadow root (open only in the dev/e2e build). A non-remembered
  body lives in `chrome.storage.session` (memory, not readable by content scripts). The service
  refuses personal endpoints from any http(s) Origin (kiosk page and websites) and never
  reads or writes a profile when `SATISFY_KIOSK_MODE=1`.
- **E2E loading in branded Chrome 157:** `--load-extension` is ignored by branded Chrome, so
  the e2e loads the unpacked build through the DevTools protocol (`Extensions.loadUnpacked`,
  `--enable-unsafe-extension-debugging`) and drops Playwright's default `--disable-extensions`.

## Jacket logos and lettering as hand-drawn vector masks (agent L1a, 2026-11-12)
- **No new dependency, no Blender, no downloaded logo files.** The swoosh, the NIKE wordmark
  with swoosh and the THERMA-FIT lettering are vector paths drawn by hand in
  `apps/web/src/engine/garmentDecals.ts`, fitted by overlaying them on the user's own photos.
  They are rasterised once at start-up into a 2048 x 1024 mask atlas (canvas; about 11 MB of
  GPU memory with mipmaps). They are drawn only on the 3D model of the genuine product they
  appear on (FB7675-100 and DQ4920-206), to show that product truthfully. They are not used as
  branding of this app.
- **Decals live in the material charts, in metres.** They are not projected from the camera
  and not baked into a UV texture. They follow the cloth when it moves, keep their real size on
  every graded size, and never touch the fit surface. Where each one sits is a labelled
  `photo_estimate` in `garmentLook.detailEstimates`. The parka's torso logos follow the
  product's yoke and chamber data: they sit centred in the first chamber below the yoke.
- **No extra vertex attribute.** WebGL allows 16 and the garment uses all of them; adding one
  failed to link the puffer's program. The torso laterals are therefore derived in the shader
  from the server u and the CF/CB arcs (`torsoLaterals`, unit tested), and the sleeve frame is
  passed as a uniform.

## MSAA instead of SMAA for the 3D view (lead decision, agent L1a, 2026-11-12)
- **The problem:** the SMAA pass eroded 1-2 px detail. At kiosk distance the embroidered
  NIKE chest logo broke up; an A/B with SMAA switched off showed it crisp.
- **The change:** the EffectComposer now renders into a 4x multisampled HalfFloat
  `WebGLRenderTarget`, sized to the drawing buffer. The pass order is RenderPass, GTAO,
  OutputPass.
- **Fallback:** SMAA stays as the fallback (`apps/web/src/engine/antialias.ts`, unit tested) when
  the context cannot multisample 4x, or when the page is opened with `?aa=smaa`. That flag is
  for A/B checks and is a demo-day escape hatch.
- **Quality switch:** `setQuality` now also sets the composer's pixel ratio. EffectComposer
  keeps the ratio it was built with, so Medium never shrank its targets before.
- **Measured (one machine, RTX 3050 Laptop):**
  - Kiosk result screen over 6 soak cycles each: MSAA p50 91 fps / mean 89.0, SMAA p50 92 /
    mean 92.3.
  - Hand-pull e2e: p50 119 for both.
  - Within the 10 % budget the lead set.

## AO and shadows see the drawn jacket; softer studio AO (agent L2, 2026-11-12)
- The garment relief is drawn in its vertex shader, outward from the tape-true inner surface.
  The GTAO pass rendered its normal/depth buffer with one override material, and the shadow pass
  with the default depth material, so both saw the undisplaced inner surface, up to one loft
  inside the drawn jacket. GTAO then darkened the drawn sleeve up to the inner sleeve's outline:
  the hard vertical line down each sleeve (A/B: gone with AO off; unchanged with every shadow
  caster off).
- Fix: the garment material opts out of the override (`allowOverride = false`) and writes its
  own displaced depth and relief normal in that pass (`gNormalOut`); a `customDepthMaterial`
  with the same displacement casts its shadows.
- GTAO radius 0.25 → 0.1 m and blend 1 → 0.65 (`Viewer.ts`): at full strength every narrow gap
  (hood over the shoulders, sleeve beside the torso) went near black; the product photos show
  soft occlusion under large studio lights. Look convention.

## WebAssembly motion-bake kernels with AssemblyScript (agent W, 2026-11-12)
- **Why:** "Try moves" bakes took 11–17 s per (size, motion) on a quiet machine. Agent E showed
  plain JS cannot get faster without changing results (prompts/08).
- **Choice:** AssemblyScript **0.28.20** (Apache-2.0), with its pinned dependencies `binaryen`
  131.0.0-nightly.20260721 (Apache-2.0) and `long` 5.3.2 (Apache-2.0), as an exact-pinned root
  devDependency in `package-lock.json`. It compiles TypeScript-like source with npm only: no
  rustup or global installs, nothing written outside the repo. Hand-written WAT was the
  alternative; AssemblyScript keeps the port readable line by line against `ClothSolver.ts`.
- **Build and offline use:** `npm run build:wasm` compiles `apps/web/src/engine/cloth/wasm/solver.as.ts`
  (-O3, no assertions, stub runtime, default features: no SIMD, so no relaxed FMA) into
  `solverWasm.ts`, the binary as base64. It is committed, so the kiosk and Node need no
  compiler and no network. `npm run check:wasm` rebuilds it and fails on any byte difference; a
  unit test checks the recorded source hash.
- **Bit-identity rules:** same f64 operations in the same order (WebAssembly f64 is IEEE-754 like
  JS numbers), `Math.sqrt/min/max/abs/floor` as their f64 builtins, JS `!x` written out, the same
  iteration order and tie-breaks. Body-collider queries stay in JS and are called through
  imports. Verified: all 12 (motion, size) bakes hash identically to the JS path, and a runtime
  self-check falls back to JS on any mismatch (`?motionwasm=0` forces JS).
- **Scope:** motion bakes only. The hand pull keeps the unchanged JS solver.

## Additive collar tapes and existing product IDs (prompt 09, user approval 2026-11-12)

- `collar_inner` and `collar_height` are sourced garment measurements, provided
  together as exact tape readings; other sizes receive no inferred collar grade.
  The API validates circumference 10–100 cm, height 1–30 cm and any uncertainty
  below the measured value. These are input guards, not comfort thresholds.
- The two optional fields are excluded from the existing product content hash,
  as explicitly approved in prompt 09 section 6. Saved catalogue IDs and tape
  observations remain valid. Every other existing measurement field remains
  hashed; appearance keeps its existing separate treatment.
- Derived fit caches include the full sourced collar data and collar-fit
  version. Changing circumference, height, source details or uncertainty cannot
  return a fit cached for the previous tapes. A production-service cache test
  verifies this independently of body geometry calculations. Any asset builder
  that starts using these tapes must also include them in its own cache key.
- Python models generate OpenAPI and TypeScript. Browser validation mirrors
  only these collar input rules; generated files are never edited by hand.

## Padded hood baked in Blender (agent H, user decision 2026-11-12 night)

- **Tool:** Blender 5.3.0 (current stable, built 2026-11-10), official portable zip
  `https://download.blender.org/release/Blender5.3/blender-5.3.0-windows-x64.zip`
  (425,299,259 bytes). SHA256 computed here:
  `3ac567a63d59d9934f7b9213bfb27ba05760e1fb366f8f55c381573ec3eabfa8`, equal to the
  official `blender-5.3.0.sha256`. Unpacked to `.cache/tools/blender/x/` (gitignored), no
  installer, no admin rights; a `portable/` folder next to `blender.exe` keeps its user config
  inside the repo. Licence: GPL-2.0-or-later. It is a build tool only: nothing of Blender ships;
  the baked GLBs are our own data.
- **Run:** headless `blender -b --factory-startup --python scripts/blender/hood_build.py --
  --style <style>`; `hood_reference.py` (Blender's bundled Python) fetches the reference
  shell from the local body service first. Bakes are bit-identical across runs.
- **Why not per-particle cloth for the hood:** the user's verdict on the simulated thin hood
  ("nhão nhão, nước nước", wavy). A padded hood holds its form, so it is a baked rest shape,
  fitted rigidly (plus a small seam blend) onto the shell, and blended between baked keys.
- **Cloth simulation was tried and is off:** Blender's cloth settle (gravity, pinned seam band,
  stiff bending, jacket + body colliders) buckled into 1 cm ripples on the fine grid and went
  unstable on a 4 cm cage. The hood-down shape is modelled (roll back, collapse behind the head,
  smooth knees, diffused contact push-out). The settle code stays behind `settle_frames: 0`.
- **No new npm or Python dependency.** The GLBs load with the existing three.js `GLTFLoader`.

## Decart Lucy V-TON trial page (agent DC, user decision 2026-11-15 00:18)

- **Dependency:** `@decartai/sdk` (MIT, https://github.com/DecartAI/sdk), in `apps/web` only. It is
  Decart's official JS SDK, the documented way to open a `lucy-vton-latest` realtime session
  (WebRTC through LiveKit) and to mint client tokens (`client.tokens.create`). Its own dependencies:
  `livekit-client`, `zod`, `jose`, `mitt`, `p-retry`.
- **Scope:** only `apps/web/decart.html` + `apps/web/src/decart/*` import it. The main app does not,
  and keeps its loopback-only CSP. The trial page has its own CSP: self, loopback, and the hosts
  in Decart's network-requirements page (`api.decart.ai`, `lk.decart.ai`, `*.lkc.decart.ai`).
- **Privacy exception (user-approved, this page only):** while a session is live, the input video
  goes to Decart. Nothing is recorded to disk. The SDK runs with `telemetry: false`, and
  `platform.decart.ai` (telemetry) is not in the CSP.
- **Spend:** free credits only, no card. `scripts/decart-token-server.mjs` (127.0.0.1:5830)
  holds the secret, mints 60 s client tokens scoped to the vton model, the page origin and
  `maxSessionDuration: 75`, and refuses new sessions past `DECART_MAX_TOTAL_S` per day. Unreported
  sessions keep a full 75 s reservation.
- **Product decision:** whether Decart enters the product is decided after the trial.
