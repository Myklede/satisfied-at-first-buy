# Prompt17b active takeover — CX-DAY

The user resumed CX-DAY for prompt17b. Read shared17, briefing12, previous16b,
all named handoffs and the paused reports. Current order: independent current
AR baseline; PSD live check/decision; b1+armhole six-preset gates and avatar-only
acceptance renders; CH e2e/renders; V4 measurements/merge; draft demo checks;
T1; final verification pack. A failing switch stays OFF. Final GO awaits
Claude's verification of both packs and an explicit AR-frozen note.

Coordination is exclusively append-only codex-sync.md. New lease helper reads
that file, yields after our lease when CX-TRY is waiting, and records actual
acquisition/release. Initial script/coordination tests20/20 PASS, scoped ESLint
and Prettier PASS. Item0 baseline now completed on both clips: see current
STATUS-ar-eval table. Guarded TypeScript, node21/21, scoped ESLint/Prettier
all PASS at01:31 local; no duplicate waiter or owned lease remains. Item1
PSD live-check measurement is prepared next, including the strict OR gate.

Measurement correction for this round: wait for lab tracking/drawn calibration
readiness before rewinding and sampling the entire clip. Previous 16b runs
forced video playback through calibration's intentional pause, so their early
rest windows could measure startup drift. Preserve those numbers as historical;
do not call protocol changes an engine improvement. Default coverage sampling
is now every1, source hashes and actual HEAD are captured after lock acquisition.

Pre-existing foreign dirty paths, including motion/BakeQueue.test.ts and
person.schema.json, remain preserved. The overwritten V4 report is merged
only as explicitly requested in item4; it is never committed as-is. No new
dependency, paid/cloud call, private imagery commit or API restart so far.

---

# PAUSED AT USER REQUEST — 2026-11-14 01:40 UTC / Nov 13 20:40 local (historical)

The user is leaving and explicitly requested saving everything and pausing.
This supersedes the earlier keep-waiter instruction. All CX-DAY jobs had
already completed naturally when the pause was checked: AR scorer session
94984 exited 0, warm session 5242 exited 0, test session 45819 exited 0.
No matching CX-DAY scorer process and no owned browser lock remained.
No waiter/background job is left; no foreign process/lock was stopped.
Resume only when the user asks.

## Saved results

- `ar:score` first rows and the later 20:20 rest-stability extension ran
  on both kiosk-camera videos. Latest source snapshot a246b8d+wip, ending
  HEAD a246b8d, every=1, finisher on, independent V4 coverage. Numbers in
  [AR scoreboard](STATUS-ar-eval.md). Rest outline/rotation/scale all FAIL;
  AR fps about 9. Coverage is 4.76% FAIL (tshirt,14 samples), 1.02% ok
  (parka,31). Back handling N/A without isolated labelled back hold.
- Onset figures 32/0 processed observations are **provisional threshold
  crossings**, not validated camera-frame latency. Input noise thresholds
  were 232.64/88.99px; do not cite the parka's computed zero as proof of
  a true <=1 camera-frame response. Manual independent onset review remains.
- Guarded typecheck PASS. Root lint FAIL at the observed foreign
  `apps/web/src/engine/live/deform/collide.ts:70` prefer-const; no edit there.
- Full test gate PASS: web **507 PASS / 1 SKIP**, reference **8 PASS**,
  Python **395 PASS / 1 deprecation warning**. One Vitest worker, serial
  suites, 11m03s lease then release. Shared HEAD changed 62ba249 -> 26934bc;
  this is not frozen-build proof. [Gate JSON](validation/demo-day-16b-test.json)
- Production warm build succeeded, 321 modules. Both complete UI paths,
  zip open/close on both jackets, puffer hood off/on and confirmed DELETE
  resets passed. Skip->dressed **32.221s / 6.194s**, result->X-ray draw
  **35.896s / 2.633s**. Pass-2 load task **4.955s** means strict warm proof
  remains WARN (`proven:false`), not a guarantee after Chrome restart.
  Own reopened judge window exited via verified own /kiosk/quit, HTTP200.
  No external request observed. [Warm JSON](validation/demo-day-16b-warm.json)
- Demo AR segment, fallback, privacy/Anywear/back-fade Q&A and operator
  conditions are saved. Complete human two-minute timing remains unproven.
- New rest pure maths/pixel-pair tests and all earlier owned checks: **46/46 PASS**;
  committed evidence is numeric only. No private camera/video image added.

## Remaining work, in order after user resumes

1. Read lead-to-CX-DAY again. AR is NOT frozen in the latest note; keep new
   e6/rig and all later commits as baseline. Preserve foreign dirty files.
2. Run `node scripts/demo-day-attract.mjs --label draft16b-attract` with
   the lock/RAM guard; inspect all new synthetic images. Not run this round.
   Existing untracked attract-final files belong to another agent; preserve.
3. `node scripts/tryon-validate-rehearse.mjs --draft`: real fake-camera
   CPU scan + Try-it-on-you start/Done stop. Not run this round. No AR grading.
4. Run preflight --kiosk and refresh the draft board with current source.
   Do not turn older preflight or warm disk cache into a final GO.
5. T1: `node scripts/tryon-validate-real.mjs`, private overlay review,
   accepted timestamps/scale file, `--report`, comparison. Pose-referenced
   hem/cuff data is still pending; only earlier supplemental puffer exposure
   is accepted. [T1 handoff](STATUS-tryon-validation.md)
6. Independently review rest-window validity/onset in private source clips;
   the newly measured threshold-crossing lag is provisional. Reload retry
   and capture-manifest per-step playback still need runtime verification.
7. Final source gates/build/GO only after explicit lead AR-frozen note.
   Before publishing, private Git-history cleanup still needs user approval;
   no history rewrite, push, paid API or real Claude CLI was performed.

**Current board: DRAFT / NO-GO; final GO withheld.** Latest earlier preflight
is historical, not rerun after this new warm build. No action is required
from the user before leaving; all next commands are saved for resumption.

---

# Prompt 16b resumed: single persistent waiter (historical)

The user explicitly resumed this work and requires keeping one waiter alive;
do not stop it for RAM/lock delays. Lead accepted all four prior commits and
queued V4 (about 8 minutes), then V2 (<=10), then CX-DAY. One active
job polls every 60 seconds for the free lock and >=2.5 GiB. The AR job has
now completed and the single active waiter is the full test gate. No
second waiter/heavy job is launched alongside it.
Continue serially with guarded gates, warm, labelled attract, draft rehearsal,
then T1, releasing/requeuing <=15-minute leases. AR is explicitly NOT frozen;
V3 is preparing the new e6/scapular-rhythm baseline. No final GO yet.
Earlier stopped/blocker snapshots below are historical, not current process state.

Current execution: first AR rows saved in 8d52caf (residual 49.96/43.05px,
AR fps 10.52/10.34, FAIL); typecheck PASS; full lint FAIL on foreign
deform/collide.ts:70 prefer-const. Full test gate completed 01:27Z: web
507 PASS / 1 SKIP, reference-photos 8 PASS, Python 395 PASS / 1 deprecation
warning. All three suite exit codes are zero; lease 11m03s, released.
HEAD changed 62ba249 -> 26934bc during this shared-tree run, so this is
draft evidence, not an immutable frozen-source claim. One warm waiter is
now active; attract, draft rehearsal and T1 follow. No step is silently
skipped because a foreign gate fails.

---

# Prompt 16b: BLOCKED draft readiness, not final GO (prior snapshot)

Completed code/docs are committed locally; runtime validation is incomplete
because the shared machine remains below the mandatory RAM floor. The
normal scorer wait ran repeatedly; only its own verified waiter PID15528
was stopped, with no browser/server/lock ever acquired. No background work
continues. No foreign process, file or lock was touched.

D1: `npm.cmd run ar:score` now covers both kiosk-camera MP4s and paired raw
captures, supports any local video and optional capture-v1 manifest, keeps
V5 columns, adds V4 frontal clothing coverage, back handling, finisher ms,
AR fps and per-step alignment. Incremental numeric checkpoints and one
reload retry are implemented but **not browser-verified**. No new score
rows are available; historical V5 evidence is preserved, not relabelled.
[Scorer method and continuation](STATUS-ar-eval.md)

D2: completed a narrated 28-second live segment with relaxed/raised arms,
Record a move and actual valid physics cm; honest local-file lab fallback;
Anywear/generative, back fade and recording privacy Q&A; front light,
plain background, chest-height camera, 1.5-2.5m framing and >=3 GiB judging
RAM. The measured 41.474 s bake remains explicit: the complete two-minute
story is not proven. No mock/live-success substitution.

| Draft check                                 | Latest actual result                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Owned node tests                            | 40/40 PASS, including 11 AR tests                                                              |
| Scoped ESLint / explicit-file Prettier      | PASS                                                                                           |
| Preflight --kiosk, 2026-11-14 00:07 UTC     | **NO-GO**, exit 1                                                                              |
| RAM                                         | Preflight sampled 1.18 GiB; wrapper sampled 0.668 GiB afterward; launch floor 2.5, judging >=3 |
| API privacy                                 | PASS: ready, kiosk_mode=true, saved=false, profile=null                                        |
| Web dist / Git                              | FAIL: stale dist, 82 dirty/untracked paths at preflight; foreign work preserved                |
| Lock                                        | Free at latest preflight; foreign V2 lock earlier preserved                                    |
| Assets / disk                               | PASS, six local vision assets and 41.97 GiB disk                                               |
| Full typecheck/lint/tests                   | NOT RUN: guarded heavy gates cannot start below RAM floor                                      |
| Fresh build + warm kiosk                    | NOT RUN: resource blocked                                                                      |
| Attract matrix                              | NOT RUN: resource blocked                                                                      |
| Fake-camera CPU scan + live start/stop      | NOT RUN; --draft prepared                                                                      |
| Actual judge window green cue               | Not observed on a new build                                                                    |
| Final GO                                    | WITHHELD: no explicit lead AR-frozen note                                                      |
| D4 / T1 pose-referenced real jacket metrics | Pending after D1-D3; no new T1 measurement this round                                          |

[Numeric draft preflight](validation/demo-day-16b-preflight.json); exact raw
log stays in ignored `.cache/demo-day-16b/preflight.txt`. Best-effort power/
camera probes were WARN, not confirmed hardware failures. Preparation
preflight is real but is not a final AR-frozen board. Earlier statuses below
are historical and do not override this snapshot.

## Exact continuation order

1. Obtain a quiet resource window (>=2.5 GiB + free shared lock), then
   `npm.cmd run ar:score`; inspect JSON/rows, no engine tuning to pass.
2. D2 docs are done; follow [live script](DEMO-SCRIPT-2MIN.md), preserving
   explicit waits and recorded-input disclosure.
3. D3 gates, each takes its own bounded resource lease:
   `node scripts/demo-day-gates.mjs typecheck`, then `lint`, then `test`.
   Cache logs are private; aggregate results go to demo-day-16b-\*.json.
   Report foreign failures without editing their paths.
4. `npm.cmd run kiosk -- --warm --windowed` on a resource-ready machine;
   close only its own judge window after evidence via operator exit.
   It takes the browser lock; no shared API restart. Wait for actual green
   dot and keep >=3 GiB for judging.
5. `node scripts/demo-day-attract.mjs --label draft16b-attract`; inspect
   every fresh synthetic screenshot. Do not overwrite foreign existing
   attract-final artifacts.
6. `node scripts/tryon-validate-rehearse.mjs --draft`; checks fake-camera
   CPU scan + live start/Done clean stop, no AR grading. Draft output names
   cannot be confused with final evidence. Rerun preflight --kiosk.
7. D4: `node scripts/tryon-validate-real.mjs`, private overlay review,
   `--report`, comparison; details in [T1 handoff](STATUS-tryon-validation.md).
8. Final GO only after lead writes explicit AR frozen in
   `docs/requests/lead-to-CX-DAY.md`; revalidate final source/build.

No additional permission is needed for these authorized local steps. The
external blocker is RAM/scheduling, not approval rejection. No dependency
install, outside-loopback traffic, paid API, real Claude CLI, shared-service
restart, history rewrite or push occurred.

---

# Prompt 15b handoff: blocked before final GO

Current final handoff: [STATUS-tryon-validation.md](STATUS-tryon-validation.md).
Supplemental real puffer exposure and an explicitly incomplete comparison are
saved; 29/29 owned tests, scoped lint and format pass. T1 pose capture remains
blocked on shared browser coordination. T3 final runs have not started because
no lead AR freeze exists. Own waiting process stopped; no background job remains.
Do not treat previous build evidence below as final GO.

---

# Resumed on user request: prompt 15b, CX-DAY

The previous stop below is historical. The user explicitly resumed CX-DAY for real-jacket metrics and final demo readiness. Current decisions, privacy controls, evidence and blockers: [STATUS-tryon-validation.md](STATUS-tryon-validation.md). Final GO runs require the lead's AR freeze; no current-build GO is claimed by the earlier evidence. Existing untracked attract-final artifacts at resumption belong to another agent and are preserved.

---

# STOPPED AT USER REQUEST - Claude handoff, 2026-11-13

All CX-DAY work is saved. Do not resume without the user's request. Own poller PID 31708 was stopped; no CX-DAY browser/server remains. Shared API 8001, vision 5711 and foreign processes/files were preserved. Foreign H2 work is deliberately not staged.

## Remaining work for Claude

1. Fix/recheck the two S-owned UI defects in `docs/requests/CX-DAY-to-lead.md`: initial dressing cover hides attract text/Exit; hand hint overlaps Zip instructions at 1280x720, scales 1 and 1.25. Original 70 screenshots and complete 10-path matrix are committed; visual review FAIL remains honest.
2. Wait for H2's final hood commit and review the latest S/A changes. Rebuild/run `npm.cmd run kiosk -- --warm --windowed`, inspect both passes, then close only its judge window. E4 has NOT run on the final build; older proof does not certify it.
3. Run `node scripts/demo-day-attract.mjs` on that final build. PREPARED AND LINT/FORMAT CHECKED, NOT BROWSER-RUN. It uses own port 5792, fake camera, bounded browser lock, early/green-cue attract screenshots across all resolutions/scales, plus 1280 Feel overlap and zip/hood/reset checks. Inspect every output image and `docs/validation/demo-day-attract-final.json`. Follow prompt 12-shared-rules.
4. Run final-source typecheck/gates and `npm.cmd run preflight -- --kiosk`; save/paste the final GO/NO-GO board here. NO FINAL BOARD EXISTS. Owned node tests: 19/19 passed. Earlier typecheck/build passed, but not rechecked after the latest S/A/H2 changes. Keep at least 3 GiB free for judging; wait for the green dot in the actual judge window. Separate warm-up cannot guarantee shader-cache retention.
5. Resolve the strict API contract outside CX-DAY's code ownership: `demo-day-api-owned.json` covers 31 operations x 3 on real own throwaway resources: 45 returned 4xx, 48 returned 2xx. Two unknown/range-query DELETEs removed only the test body, so strict 4xx/no-state-change FAIL. Final cleanup confirmed mesh 404; persisted profile/learning/board unchanged. Personal DELETE checks are Origin-guard-only to protect existing files. Never use another client's body for cleanup.
6. Finish the changed-image audit. Original 173 images, 30 later Fit Agent images, all 70 matrix screenshots and its contact sheet were reviewed. A/H2 images changed/added AFTER those hash manifests need incremental review/hash updates. H2's many uncommitted images belong to H2, not CX-DAY.
7. Refresh judge-pack source snapshots when everything settles. Latest A commit `8b9a5c8`: 61/61 e2e, own console 0, retailer errors 407 retained, external completed 0. The earlier 11.220488699999986 s rehearsal timed fit/selection transfer, NOT fully dressed cloth. A prior dressed studio waited 41.4 s after its fit card under load. The complete cold two-minute demo is NOT proven; rehearse and keep the explicit wait/overrun caveat.
8. Before publication/push, remove private historical photos ONLY with explicit user approval; no rewrite/push was performed. Real subscription-model smoke/live Amazon requires the user present; no paid API calls.

Judge pack already exists: `docs/JUDGE-QA.md`, `docs/SUBMISSION.md` (DRAFT), `docs/DEMO-SCRIPT-2MIN.md`. Completed work, evidence and decisions follow below. Stop here unless the user requests resumption.

---

# CX-DAY — prompt 13b round 2 — 2026-11-13

## Prompt 13b round 2 — in progress, 2026-11-13 ~10:00

Decisions: obey the shared CX-DAY row; retain all later commits and all foreign dirty files as baseline. No subagents, external network, paid API, dependency changes, shared-service restart or history rewrite. Shell startup recovered without permission changes; use `npm.cmd` from PowerShell because the machine blocks `npm.ps1`. No need for the user to relax execution policy.

E1: 60-second slot observations started at 14:53:33Z, with a three-hour maximum. S currently holds the lock and RAM is below 2.5 GiB. Work on E2/E3 continues while waiting. Warm instrumentation now measures Skip → both settled and result → both X-ray garment draws, using the browser clock; reported draw submission does not certify hardware presentation latency. The 15-second WARN boundary comes directly from prompt 13b's 15–30-second warning. Warm launcher retains its browser lease through the reopened judge window.

E2: **all 173 tracked docs images visually reviewed**; 14 contain retailer models, none observed to contain private user reference photos. Full path/hash/category manifest: `docs/validation/demo-day-images.json`. All 31 OpenAPI operations × three invalid probes ran: **69/93 4xx, 24/93 2xx**, persisted store/board hashes unchanged. Strict all-route 4xx expectation is FAIL: eight no-input read routes ignore undeclared queries. Parameterized invalid-ID and protected DELETE probes have explicit coverage qualifications, not fake independent field-validation passes. Details and lead requests are in the audit/request files. Historical private-photo blocker remains unresolved and untouched.

Validation so far: `npm.cmd run typecheck` passed; readiness + audit unit tests **15/15 passed**. Scoped ESLint and Prettier passed. No application source changed. Earlier round-1 evidence below is historical.

### E1 actual browser proof — first build, started 15:01:57Z

`npm.cmd run kiosk -- --warm --windowed` built successfully (Vite, 224 modules), reused private 8001 and completed both UI paths. Both sessions confirmed their own successful DELETE reset. Both jackets' zips opened/closed; the puffer hood detached/reattached in both passes. The reopened judge window was then closed through this launcher's own `/kiosk/quit`; its browser/server exited, shared 8001/5711 were untouched. Raw evidence: [demo-day-warm-first.json](validation/demo-day-warm-first.json), including build hash, program counts and local request log. No external request attempt was observed by this page-level logger; it is not an OS-wide traffic capture.

| Phase / measurement          |    Pass 1 |   Pass 2 |
| ---------------------------- | --------: | -------: |
| Load/warm-up longest task ms |      6216 |     1231 |
| Attract longest task ms      |         0 |        0 |
| Body entry longest task ms   |         0 |        0 |
| Scan longest task ms         |         0 |        0 |
| Dressing longest task ms     |       159 |      342 |
| Result longest task ms       |        81 |        0 |
| X-ray wait longest task ms   |       166 |        0 |
| Motion longest task ms       |       124 |      153 |
| Feel longest task ms         |       585 |      586 |
| Skip → both settled ms       | **25887** | **3068** |
| Skip → result ms             |     25780 |     2993 |
| Result → both X-ray draws ms | **36032** | **2534** |

Zero means no observed Long Task entry (the browser reports tasks ≥50 ms), not zero CPU work. Timings use browser clock, with result/settled observations sampled every 20 ms and actual garment X-ray draw submission. Display hardware presentation time is unmeasured. The first pass is **first observed**, not guaranteed cold. Pass 2 is faster and satisfies the measured warm-path criteria. Overall **WARN after Chrome restart**: the launcher closes the warm Chrome before reopening its app window, and S's evidence shows on-disk cache persistence is unreliable. No post-restart speed claim is made. Matrix now running, one bounded lock lease per viewport; final S/H2 build proof remains pending.

### E3 judge pack

[JUDGE-QA.md](JUDGE-QA.md) has 28 short evidence-linked answers. [SUBMISSION.md](SUBMISSION.md) is explicitly DRAFT with the requested Vietnamese introduction, solo-project attribution, real stack and measured/qualified achievements. [DEMO-SCRIPT-2MIN.md](DEMO-SCRIPT-2MIN.md) maps speech to exact UI actions, marks actual waits, releases the kiosk browser before launching `npm.cmd run amazon-demo`, and distinguishes chart-only pages from the measured-catalogue 3D handoff. The two-minute duration is a presentation target; variable startup/compute waits can overrun it. All repository file links checked to exist.

### S follow-up / lead ruling, commit 71fc210

Read `docs/requests/lead-to-CX-DAY.md` and S's final memory-pressure findings (`360b030`). The critical RAM-pressure signal can purge the shader cache even between same-browser reloads; the initial two-pass success is one measured run, not a permanent property. Updated `preflight --kiosk`: FAIL below 2.5 GiB, WARN from 2.5 to below 3 GiB, PASS from 3 GiB. Default development preflight retains the previous 4 GiB advisory. New threshold regression test passes; total owned tests **16/16**. Warm evidence stays advisory and never alone makes the board NO-GO.

Runbook now requires keeping ≥3 GiB free, closing completed agents/editors/unrelated Chrome/Outlook/Zalo/ChatGPT, and waiting for S's green attract dot in the **actual judge window**. S's measured cold observation was about 70 s, not a countdown guarantee. Preflight reports this as an explicit manual check: do not add a remote debugging port or pretend it sampled another Chrome. S's new cue and earlier hand-tracker start are still landing; final proof waits for those commits and H2.

### Subsequent baseline commits and incremental audit

S's operator cue landed in `5def2ac`; CX-FIT's final G7 landed in `ae54235` (**42/42**, own-code console 0; retailer errors 405 retained). These are read-only baselines. Updated judge pack to cite the passing G7 without claiming an empty retailer console or a guaranteed dressed-jacket handoff latency. Reviewed the 30 newly tracked failed/final Fit Agent images too: all three additions sheets viewed; 20 retailer-model screenshots, no private reference photo observed. Original + additions manifests cover **203** pre-matrix tracked images (34 retailer-model screenshots); matrix screenshots are reviewed separately. H2 has had its browser slot; current matrix is continuing its last two configurations. Its original build remains frozen until that run finishes.

### D3 completed — ten real browser scenarios, 70 screenshots

`node scripts/demo-day-matrix.mjs` exited **0**. Five resolutions (1920×1080, 1600×900, 1536×864, 1366×768, 1280×720) × scale 1 / 1.25 all completed the full judge path, both jackets' zip actions, puffer hood detach/reattach and confirmed successful DELETE resets. Build SHA-256 stayed unchanged throughout. [Raw matrix and review](validation/demo-day-matrix.json), [contact sheet](validation/demo-day-matrix.png).

All **70 screenshots** and the contact sheet were inspected, using per-scenario readable sheets plus individual originals for ambiguity. They show synthetic inputs, mannequin renders and fake-camera frames; no private photo. **Functional path PASS; visual review FAIL pending S's fixes:** attract text/exit hint hidden behind the initial body-cover canvas in the ten immediate captures, and the hand hint overlaps the zip instructions at 1280×720 at both scale factors. Paths and likely stacking cause are filed in the request file. The 30 detector “covered” findings refer to background buttons under the open motion modal and are intentional. Raw findings are preserved; the script's selector is corrected for future runs to scope the modal and include `.k-feel-hint`. The original run did not use those corrected selectors; do not confuse static lint with a rerun.

The resource poll ran every 60 s throughout; when RAM/lock were unavailable the matrix waited, including allowing CX-FIT's G7 and H2's browser work between windows. Every scenario held its own bounded lease, and all matrix-owned Chrome/server instances have closed. S/H2 final-build gate and a focused attract/1280 Feel retest remain pending; no final visual PASS is claimed.

### E2 independent live-resource route audit

After the initial sentinel-ID run, `node scripts/demo-day-api-owned.mjs` completed the same **31 × 3 = 93** probes using its own randomized synthetic body, a real catalogue product/fit/S cloth/SDF and valid motion ID. Unknown-field/range requests no longer fail simply because their path ID is malformed. Results: **45 4xx, 48 2xx, 0 request errors/5xx**. Both unknown/range-query body DELETE cases removed only this job's created body (mesh 200→404); it was recreated only for its own next test. Final owned-body cleanup 200 and confirmed absent (404). Persisted profile/learning/board hashes unchanged; no foreign body or personal-file deletion. Personal DELETE remains 403 Origin-guard evidence only, and physical inputs absent from a schema are explicitly N/A. [Raw proof](validation/demo-day-api-owned.json). Strict 4xx/no-state-change contract **FAIL**, now with independent real-resource evidence. New safety tests cover foreign-body refusal, unknown query with a valid ID, and rejecting a newly introduced destructive operation before probing it. Total owned node tests now **19**.

### Later source updates while E4 waits

S's shared-hand-tracker fix and final follow-up report landed as `559697e` / `2099f5d`. A's full-engine catalogue ranking/dressed proof landed as `c8a7dfc`, `33c4222`, `194fcfb`: the current G7 artifact now has **46/46**, own-code console **0**, retailer errors **401** retained, external completed **0**. Updated judge pack to match the replacement artifact. The older 11.220488699999986 s rehearsal is explicitly an earlier fit/selection-transfer endpoint; the newer fully dressed studio waited **41.4 s after its fit card** under shared load. The complete cold two-minute sequence is not proven; the script now states that limitation instead of promising its final twelve-second slot. Handoff layer/preference and catalogue display-precision changes (`c653d81`, `e54a4d9`) are newer read-only baselines. H2 is still finishing its owned shape/bake/screenshots; final launcher/build proof waits for its commit.

## Round 1 historical snapshot (superseded by round 2 evidence above)

**State: BLOCKED, not demo-certified.** Offline implementation and targeted checks completed; the required headed rehearsal and resolution screenshots have not run. No application/engine/garment/vision files were edited. No shared process was stopped and no dependencies, external calls or paid APIs were used.

## What changed / how to run

- D1: opt-in `npm run kiosk -- --warm --windowed` prepares two full reference-input UI paths on origin 5730 and `.cache/kiosk-chrome`, observes long tasks and renderer stats, drives mouse zip/hood, confirms successful reset DELETE responses, closes the warm browser, then opens the judge window. Cache evidence includes the SHA-256 content hash of every dist file. A failed path is recorded, never passed silently. The shared API must already be loaded and private; warm mode refuses a fallback API port. Default launch behaviour is retained.
- D2: `npm run preflight -- --kiosk` adds dist-hash warm evidence, RAM/disk, Chrome version, lock owner and a final GO/NO-GO line to existing power/camera/API/ports/freshness checks. This command remains read-only. Warm evidence is WARN until two completed runs with confirmed resets and second-run phase maxima <1500 ms exist.
- D3: `node scripts/demo-day-matrix.mjs` implements seven UI screenshots at five resolutions × two scale factors on 5791, per-scenario lock/release, geometry/centre-occlusion/text-overflow/panel-overlap checks and a local contact sheet. **Execution blocked before scenario 1**; `docs/validation/demo-day-matrix.json` records why. No contact-sheet PNG or successful screenshot matrix exists.
- D4: `node scripts/demo-day-audit.mjs` writes reproducible image inventory, narrow secret-pattern findings and six non-mutating invalid fit-request results. See `AUDIT-demo-day.md` for source trace, history cleanup proposal and explicit coverage gaps.
- D5: DEMO.md now documents warm evidence, the board, current zip/hood/jacket controls and code-checked recovery actions.

## Tests / proof

`node --test scripts/preflight.test.mjs scripts/demo-day-warm.test.mjs`: **11 tests, 11 pass, 0 fail**. Tests cover byte/name-sensitive build hashing, incomplete resets, the strict 1500 ms limit, stale/missing evidence, first-blocker ordering and existing readiness/privacy/freshness/port behaviour.

ESLint on the seven CX-DAY `.mjs` files: pass. Prettier is applied/checks only explicit owned paths. No repo-wide formatter/fixer was run. Full web/Python suites and typecheck were not claimed: application source was untouched and sustained CPU/browser work conflicts with concurrent benchmarking. Targeted runtime checks are recorded below.

`node scripts/demo-day-audit.mjs`: **6/6 HTTP 422**, 0 tracked private-reference paths, 0 tracked look images, 0 matches in the documented secret-pattern scope; 173 tracked docs images enumerated, one mannequin render visually inspected. This does not certify all images or all public routes.

`npm run kiosk -- --warm --windowed`: **blocked**, initially free RAM 1.449 GiB <2.5 GiB. On repeat after adding the shared-API guard: `Warm-up requires a privacy-mode API; ask its owner to prepare it. No service was changed.` It exited before build/browser/service changes. Required end-to-end gate is **not passed**.

### D1 cold vs warm

| Phase                                                             | First pass longest task | Second pass longest task |
| ----------------------------------------------------------------- | ----------------------- | ------------------------ |
| Attract / body / scan / dressing / result / X-ray / motion / Feel | Not measured (blocked)  | Not measured (blocked)   |
| Time to dressed                                                   | Not measured            | Not measured             |
| Program counts / DELETE confirmations / request log               | Not collected           | Not collected            |

The existing profile was not erased, so the eventual first pass must be labelled **first observed pass**, not guaranteed cold GPU cache. Cross-page/reset and post-browser-restart shader-cache benefits remain unproven (S's recorded risk).

### D2 board output (recorded snapshot; not a current promise)

Full output also lives in `docs/validation/demo-day-preflight.txt`.

```text
PASS Node             v26.13.0; pinned Vite supports ^20.19.0 or >=22.12.0
PASS Python           Python 3.12.16; repo requires 3.12
FAIL Free RAM         1.55 GiB; close unneeded apps if below 4 GiB; browser requires 2.5 GiB
PASS Free disk        45.23 GiB on repo drive; free space if below 2 GiB
WARN Browser lock     Codex Fit Agent round 2 proof / PID 39612 / owner 5e4c75c4-a831-4dfe-ab24-a33027672c2a
PASS Chrome           C:\Program Files\Google\Chrome\Application\chrome.exe
PASS Chrome version   157.0.8103.51
WARN Top memory users Memory Compression 969 MiB; claude 638 MiB; python 565 MiB; node 400 MiB; VSCodium 381 MiB
PASS Power supply     AC power online
PASS Camera           1 present camera/image device(s); live capture untested
PASS Port 8001        Owned local service
PASS Port 5711        Owned local service
PASS Port 5730        Free
PASS Power plan       Legion Performance Mode (52521609-efc9-4268-b9ba-67dea73f18b2)
PASS Anny cache       Nonempty local model cache (not a load/integrity test)
PASS Vision assets    6 local wasm/task asset files
FAIL API + privacy    127.0.0.1:8001: Kiosk requires verified privacy mode
FAIL Web dist         Web dist is older than sources; run npm run build
FAIL Git              34 dirty/untracked paths; review before judging
WARN Warm-up          Warm-up absent, stale or failed; run npm run kiosk -- --warm
NO-GO: Free RAM: 1.55 GiB; close unneeded apps if below 4 GiB; browser requires 2.5 GiB
```

## Decisions

1. Follow today's narrow ownership table; STATUS-demo-day replaces edits to the lead-owned STATUS.md. Foreign dirty changes were preserved; only explicit CX-DAY paths are staged/committed.
2. Do not restart shared 8001, remove another owner's browser lock, or start a fallback API on an unassigned port. The opt-in warm path requires verified existing kiosk privacy mode. Default launcher is unchanged.
3. Resource observations while other work proceeded: free RAM 0.65, 2.14, 1.45 and 1.55 GiB; S then CX-FIT owned the browser lock. Attempts were separated by more than 60 seconds. Do not run long builds/soaks without the slot. Lock windows are bounded to 14 minutes of browser work; normal launch opens the judge window after releasing the warm-up lock.
4. Treat absent/unproven warm evidence as WARN, not a fabricated PASS; RAM <2.5 GiB, stale dist, unverified kiosk privacy and dirty Git remain blockers. Disk <2 GiB is an operational blocker, not an accuracy threshold. Existing RAM <4 GiB advisory retained above the hard browser minimum.
5. No history rewrite or push. Explicit user approval is required before cleaning private photos from history. Proposed commands are documentation only.
6. Preserve truth over completion claims: six validation cases cover only the kiosk fit POSTs. No live network proof or complete visual image audit is claimed.

## Known gaps / exact next commands

Blocking owner request is in `docs/requests/CX-DAY-to-lead.md`. Lead must prepare shared API privacy mode after coordinating with active clients; a free browser slot and ≥2.5 GiB RAM are also required. Then:

```powershell
npm run kiosk -- --warm --windowed
```

Inspect `.cache/kiosk-warm.json`, exercise/close the opened judge window, and only then:

```powershell
node scripts/demo-day-matrix.mjs
npm run preflight -- --kiosk
```

Review generated screenshots/contact sheet and put every confirmed defect and screenshot path into the request file. Re-run if build hash changes. Run `node scripts/demo-day-audit.mjs` to refresh the API/input/file inventory. Complete all-route validation and full image/history review with the lead. If any zip/hood action fails or no-hand exit races it, retain the failure and adjust only the owned automation after observing real UI evidence. D1 and D3 code is unit/lint checked but **not browser-validated**; no full prompt-12b completion claim is made.

No CX-DAY-started service/browser remains running. Other agents' changes may keep global Git status dirty; they are not staged or reverted here.

## Prompt18 active checkpoint - 2026-11-14

Exactly two workers: CX-DAY/DAY-P (physics) and CX-DAY/DAY-G (CH/T1/drafts).
Main completed synthetic+four-way frozen ruler before opening their heavy/browser
work; numbers and the source-change caveat are in STATUS-ar-eval.md and codex-sync.
Added token-verified heavy lock (3GiB), browser-first timing acquisition, full worker
names and team fairness; bounded local runner closes only its own child tree.
Main owns5770-5774; subagent ports follow18. No8001 restart or switch flip.
DAY-P motion suite85PASS/1warning; main will merge its complete handoff later.
Final GO remains DRAFT pending Claude verification of both packs and AR-frozen note.

Prompt18 next checkpoint: PSD complete and defaultOFF (f774f6d); workers2 remain
within measured cost. Ruler/resources saved edca3a4. Browser fairness now tracks
pending/release by full worker; one sibling cancellation cannot erase another.
Node resource/demo/T1 math33/33 PASS, PSD19/19 PASS, scoped ESLint PASS. A transient
shared-tree TypeScript failure in TRY-owned KioskMirrorView.test.ts was reported;
next tsc returned exit0 after the owner fixed it. No foreign path was edited.

Preflight --kiosk executed: API loaded and privacy true/savedfalse/profilenull;
Node/Python/assets/AC/disk PASS (40.74GiB disk). NO-GO due1.86GiB RAM during peer
lease, stale old rootdist and expected shared dirty tree; warm/shader checks WARN.
No readiness claim follows from this. Own warm/rehearsal tools now use main ports
5770/5774 and fresh private dist rather than disturbing another generated build.
Physics dumps use a separate neutral directory; old V3 private-body dumps preserved.
