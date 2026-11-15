# Satisfied at First Buy

`satisfy-at-the-first-buy` is a local 3D **fit** studio for online shopping.
It builds a real Anny body mesh and compares it with two tape-measured jackets.
The kiosk includes optional local webcam scanning, X-ray fit comparisons, hand
pull with a tension readout, and indicative fit in motion. The displayed jacket
uses a tape-based wrapped shell; motion uses CPU physics with WebAssembly kernels.
Material/contact constants and worn fit predictions still need calibration.

## Before a judging session

Follow the [three-minute demo runbook](docs/DEMO.md) for the judge path, operator
recovery, privacy answers and the current pending features.

Run `npm run preflight` for development, or `npm run preflight -- --kiosk` to
require kiosk privacy mode. It prints ✅/⚠️/❌
checks for runtime versions, RAM, power, Chrome/camera, model/vision assets, service
ports, kiosk privacy, fresh web build and clean git status. Exit code is nonzero
on ❌; a development API warns in the default mode and fails with `--kiosk`.
Low-RAM warnings include the five largest memory users for operator review.
It is read-only: it never starts/stops services, changes power settings or
cleans git. Camera presence is best-effort, not a live capture test. Resolve red
checks before demoing; `npm run kiosk` starts its service in privacy mode.
If the kiosk reports a fallback API port, check that instance with
`npm run preflight -- --kiosk --api-port 8002` (substitute its reported port).

During parallel agent work, browser tests must hold `.cache/locks/browser` for
the entire job. Use `withBrowserSlot` from `scripts/lookdev/browser-slot.mjs`:
it waits in 60-second polls for the six shared ports and at least 2.5 GiB free
RAM, then acquires the lock atomically and releases its own lock in `finally`.
Never stop another agent's service or remove its lock. Benchmarks also require
a quiet machine. Preserve the existing Python environment; do not run `uv sync`.

## Run on this Windows machine

Prerequisites: Node/npm (verified Node 26.13.0 / npm 11.20.0), Git, and a Python
installation accessible through `py`. First setup needs dependency downloads;
normal operation is entirely local after the model cache is warm.

```powershell
npm ci --no-audit --no-fund
npm run setup:python
npm run gen:api
npm run dev
```

Open **http://127.0.0.1:5710**. The Python API binds to **127.0.0.1:8001**;
interactive API documentation is at http://127.0.0.1:8001/docs.
`npm run dev` starts both processes; Ctrl+C stops them together.

Python 3.12 and uv are installed in repository-local `.cache` directories and
dependencies in `.venv`. Setup removes `PIP_NO_INDEX` from child-process environments.
The first Anny cache build can take minutes; the service logs its progress. Wait
for `Application startup complete`. The web page retries connection while it warms.

The body shown initially is the **172 cm / 65 kg male reference input**, not your
personal measurements. Enter height, weight and body-model sex, then **Build my body**.
Expand optional measurements for tape constraints. Neutral shape reference is the
default; the exposed Anny presets are optional shape controls.

Use **1** front, **2** back, **3** shoulders, **4** side, or the camera buttons.
Drag to orbit and scroll to zoom. Wireframe, landmarks and tape lines can be toggled.
Length measurements use centimetres; mesh/overlay coordinates use metres.

Choose **02 Try a jacket →** for Fit Studio. Select FB7675-100 (white parka) or
DQ4920-206 (rattan puffer), or paste their known Amazon/eBay/Nike URL. Matching is
local; an unknown URL does not trigger scraping or transmit body data. Both owned
**S** sizes use measured dimensions. Other size tabs use explicitly estimated
Anny body-chart grading, including uncertainty for shoulder/sleeve/length/bicep.
Under-layer and fit preference recalculate analytic inner room.

Switch **Normal / X-ray / Heatmap / Tension**; **5** frames both shoulders in X-ray. The
heatmap shows estimated inner gap after insulation and the under-layer, with
red ≤0.5cm / blue ≥3cm and neutral grey elastic gathers. White dots mark
acromion/wrist, coloured dots seam/cuff. Compare mode syncs cameras. Size changes
use a 400ms morph and other sizes prepare in the background. High/Medium controls
AO and resolution. Source notes distinguish measured and estimated sizes; failed
solver-quality checks suppress confident simulated fit verdicts.

## Demo day (judge kiosk)

One command, after the one-time setup above (`npm ci`, `npm run setup:python`):

```powershell
npm run kiosk                 # true fullscreen (Chrome --kiosk); Esc on the attract screen exits
npm run kiosk -- --windowed   # Chrome app window instead
```

It copies or downloads the camera models, builds the web app, starts the body
service (restarted automatically if it dies), serves the app on
**http://127.0.0.1:5730/?kiosk**, waits until the body model is loaded and opens
installed Chrome. A progress bar covers the warm-up (reference fit, pose and hand
models, shaders); then the attract screen turns slowly. Nothing needs configuring.

- Ports: `--port` / `SATISFY_KIOSK_PORT` (default 5730), `--api-port` /
  `SATISFY_API_PORT` (default 8001). `npm run dev` keeps 8001/5710 and also reads
  `SATISFY_API_PORT` / `SATISFY_WEB_PORT`.
- **`npm run dev` already running?** The kiosk checks the API port first. If a healthy body
  service of this checkout's engine version (`/health` `engine_version` = `MODEL_VERSION` in
  `services/body/body_service/config.py`) answers there, the kiosk reuses it and says so; that
  service is then **not** restarted by the kiosk's watchdog. Anything else on the port (another
  version, not healthy) → the kiosk starts its own service on the next free port. For demo day,
  stop `npm run dev` first so the kiosk owns (and restarts) its service.
- Privacy: the kiosk's service runs with `SATISFY_KIOSK_MODE=1`, so the Fit Agent never reads or
  writes a stored body profile (`GET /agent/profile` reports `kiosk_mode: true`). A running
  service is reused only if it reports kiosk mode; `npm run dev` does not, so the kiosk then
  starts its own service on the next free port.
- Exit: Esc on the attract screen (the only screen that shows the hint), or the operator key
  Ctrl+Shift+Q on any screen.
- `--no-browser` serves without opening Chrome; `--no-build` reuses `apps/web/dist`.
- Camera permission is auto-accepted only in the kiosk's own Chrome profile
  (`.cache/kiosk-chrome`). That window resolves only loopback addresses.

Flow: attract → **You** (height, weight, body shape; ft/lb by default, cm/kg
toggle) → **Scan** (optional; stand 1.5–2.5 m / 5–8 ft away, jacket off; Skip is
always there, "Continue without scan" after 25 s) → **Fitting** (the no-scan body
and both garment fits already started on the You screen's Continue; the result shows as soon as
both recommended jackets are on screen, the cloth settles and the other sizes load behind it) →
**Result** (size per jacket with a one-line reason, a "Women's cut" / "Men's cut" badge when the
jacket's cut differs from the chosen body shape, an X-ray line comparing the neighbouring size
that differs most, size tabs, automatic X-ray shoulder close-up with one large seam label, key 5
still works, "Open on Amazon in size M" / "Open store page (eBay)" in the default browser,
**Try moves**: fit in motion on the judge's body, recommended vs contrast size, first motion
pre-baked in the background) → **Try it on** (predicted shoulder seam, cuff and hem vs a tape,
marked "not yet validated" until the board has a measured entry; optional measured values;
opt-in anonymous accuracy board). Every number shown is the fit engine's prediction; the value
measured on the 3D drape appears only as a labelled detail (docs/STATUS.md "Numbers on
screen").

Operator keys (hidden):

| Keys | Action |
| --- | --- |
| Ctrl+Shift+R | Reset: forget this judge's body in the service, reload to attract |
| Ctrl+Shift+D | Diagnostics overlay (fps, fit/solver ms, scan Hz + delegate, GPU) |
| Ctrl+Shift+B | Accuracy board (table + mean absolute error per metric) |
| Ctrl+Shift+Q | Quit (closes Chrome, the service and the server) |

Reset also happens with **Start over** and after 90 s without input. All body
data is in memory only; the board (`data/accuracy/board.json`, gitignored) is
written only when the judge ticks the opt-in box and holds only numbers.

**If the camera fails** (no camera, denied, busy): the scan screen says so and
offers **Continue**; the fit uses height and weight only. Check that no other app
holds the camera, then Ctrl+Shift+R. **If the service dies** the screen shows
"Reconnecting…", the launcher restarts it, and the kiosk returns to attract.
**If Chrome is not found**, set `CHROME_PATH` or open the printed URL yourself.

Soak test (20 judge cycles with Chrome's fake camera, screenshots of every
screen): `npm run kiosk:soak -- --cycles 20 --screenshots` → `docs/validation/kiosk-*`.

## Jacket sandbox (look-dev against the real products)

Local reference tools report [paper-relative colour](docs/look/colour-measurements.md)
and [photo dimensions with uncertainty](docs/look/photo-measurements.md). The ruler
sheet is US Letter (21.59 × 27.94 cm); curved or off-plane features may have no
defensible centimetre value. Images and extracted video frames stay gitignored.

```powershell
npm run sandbox               # builds, starts/reuses the body service, opens Chrome (windowed) at /?sandbox
npm run sandbox -- --no-browser --port 5740 --api-port 8001   # just serve; open http://127.0.0.1:5740/?sandbox
```

The page shows a jacket on a body through the **same Viewer** as the kiosk (materials, tone
mapping, exposure, lights), with: jacket and size pickers; body presets or custom sex / height /
weight (real body service); front, back, left, right, 3/4 views and close-ups (collar/hood
junction, sleeve baffles, cuff, hem, zipper, chest logo); the kiosk lighting plus a studio and a
daylight look (a "same as kiosk" toggle keeps everything identical to the demo); wireframe,
panel/baffle seam lines, normals, garment and body on/off; a reference-photo panel with an
optional opacity overlay on the 3D view; an eyedropper with sRGB hex and CIEDE2000 between a photo
point and a 3D point; and PNG screenshots (3D only or side by side) named after
jacket/size/body/view. It also works in the Vite dev server (`npm run dev`, then `/?sandbox`).

Put the real product photos and short videos in `data/reference-photos/<folder>/`
(`FB7675-100-parka-trang`, `DQ4920-206-puffer-kem`; subfolders allowed; .jpg .png .webp .mp4 .mov;
gitignored). They are served read-only on loopback from a listing of that folder only (no path is
built from the request). `node scripts/sandbox-shots.mjs` takes headed-Chrome screenshots of a
running sandbox into `docs/validation/`.

## Verify

```powershell
npm run gen:api
npm run lint
npm run typecheck
npm test
npm run build
npm run validate:body
npm run validate:garment
# With npm run dev running in another terminal:
npm run smoke:fit
```

Tests include real CPU Anny fits for four reference inputs, independent deterministic
fits, optional girth targets, extreme-shape landmark ordering, strict API validation,
GLB normals/frame checks, analytic geometry, schemas and web client/camera math.
`pytest` includes `slow` integration tests by default. To run only fast Python tests:
`.venv/Scripts/python.exe -m pytest -m "not slow" -q`.

## Check against a tape measure

Copy `data/ground-truth/me.example.json` to `data/ground-truth/me.json`, replace all
illustrative values with your measurements, and read [MEASUREMENTS](docs/MEASUREMENTS.md)
for matching posture and tape placement. Real person files and derived validation
exports are gitignored. `npm run validate:body` writes
`docs/validation/body-after-YYYY-MM-DD.md`, comparing height/weight-only fitting with
fitting assisted by all supplied tape measurements. Examples are never counted.
Use `npm run validate:body -- --before` before a model change to preserve a separate
before table. The engine version and actual run results are recorded. Both densities
are checked on all four reference bodies (8 fits); the reference-only public table
contains no personal data. With zero real files, the command explicitly
states that human accuracy is unverified.

`npm run validate:garment` computes private predictions for each owned jacket and
the tape-assisted body. It reports non-convergence rather than hiding body errors.
Copy `data/ground-truth/worn.example.json` into the ignored `data/ground-truth/worn/`
directory, fill real worn readings, and rerun to compute signed errors. See
[the template](docs/validation/garment-template.md) and measurement instructions.

## Realism diagnostics (Milestone 2.5)

With `npm run dev` running, use `npm run bench:web -- --full`. It drives installed
headed Chrome locally, records separate render FPS and worker delivery/step rates,
uncached/cached size-click times, and captures Normal/X-ray/Tension front/back/side
and shoulder/cuff/hood/quilting close-ups. Reference PNGs and benchmark JSON are in
`docs/validation/realism-*`; personal PNGs and all mesh exports stay gitignored.
The benchmark blocks requests to non-loopback hosts. No Computer Use is required.

`npm run validate:realism` exports the actual bodies/cloth locally, runs the shared
TypeScript solver, verifies two full reference runs match exactly, and checks body
exact closest-face sidedness and ambiguous-edge/vertex ray parity at all cloth
vertices/edge midpoints/face centres, plus inter-panel edge/triangle
crossings. It exits nonzero when stretch or penetration acceptance fails. This is
separate from unit tests and **currently fails**; see [STATUS](docs/STATUS.md).
Coplanar self-overlap is not certified by the crossing check.

After the full browser run, `npm run report:realism` writes analytic/SIM/worn tables.
It first checks actual canvas pixels to catch an inactive Tension shader, and
verifies all 84 required PNGs. See the [evidence index](docs/validation/realism-evidence.md)
and [measured performance](docs/validation/realism-performance.md).
SIM results are diagnostic while physics gates fail. Missing human worn readings
are `pending`. Hood size, cuff opening, garment mass and material stiffness remain
labelled uncalibrated assumptions. No WebGPU implementation or M3 work is included.

## Troubleshooting

- **EACCES on port 5173:** Windows reserves 5141–5240 on this laptop. The app uses
  5710. If another application uses 5710 or 8001, stop your own conflicting process;
  do not alter system port reservations. Keep Vite, dev orchestration and CORS origins aligned.
- **Service connecting:** first cache build is slow. Inspect the body-service log.
  Do not open the Vite URL on another machine; it intentionally binds to loopback.
- **Python missing:** rerun `npm run setup:python`. Never install `anny[smpl]`.
- **GLB expired / 404:** the 16-entry LRU lives in RAM. Build the body again after
  a restart or eviction. Browser responses are marked `no-store`.
- **Garment source:** S uses owned tapes; other sizes now use labelled Anny
  chart-body grading with uncertainty. These estimates are not measured garments.
- **Target residuals too large:** the shape may be outside Anny's supported range.
  The UI reports the measured residuals; it does not pretend convergence.
- **WebGL unavailable:** enable hardware acceleration in your browser and reload.
- **Agent sandbox EPERM/EACCES:** sandboxed tools on this machine may need their
  normal execution approval to spawn esbuild or write cache/Git metadata. Direct
  commands in the user's PowerShell run with the user's permissions.
- **Test warning:** current Starlette deprecates its httpx TestClient transport;
  the pinned transport still passes. This is a development-only upstream warning.

## Privacy, accuracy and licenses

Body meshes, measurements and input hashes remain in local RAM. There is no telemetry,
webcam capture, remote body processing, or hosted upload. Dependency/model downloads
are the only network activity in this milestone. Validation exports are an explicit
local action; reports can contain personal derived measurements.

Anny is **Apache-2.0**; its MakeHuman assets are **CC0**. The project uses the standard
Anny topology, never noncommercial SMPL/SMPL-X assets. Dependency purposes and licenses
are recorded in [DECISIONS](docs/DECISIONS.md).

Geometric mass defaults to an assumed 1010 kg/m³ density; Anny's native 980 is also
supported. Both pass reference constraints. The local tape-assisted fit favours
1010 and passes all supplied targets (one person; not population calibration).
H/W-only shoulders meet the local approximately 2cm gate, but chest prediction
regresses and other unprovided dimensions remain inaccurate. Fitting a target is not
evidence of accurate unprovided girths. Surface landmarks and anatomical search windows
are documented approximations and require tape validation on real people before Gate A
can be called established. See [STATUS](docs/STATUS.md) for measured results and gaps,
including measured browser performance and the failing cloth acceptance gates.
