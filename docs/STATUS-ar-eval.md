# Prompt17b item0 — current-HEAD independent baseline

## Prompt19/20 checkpoint — 2026-11-14

The user's real jackets have horizontal channels. Anywear thresholds in prompt20
are binding; unavailable or unreviewed criteria cannot pass.

V4 completed with exact FB7675-100 selected and stable source hash
e34fab369e40ca84fc333d35209d9eba4640246293cbd496d0b4ea413127657b.
The numeric run was merged into committed82b4426, preserving its four historical
calibration/study blocks. Frontal old coverage before/after: cam-parka5.52%/0%,
cam-tshirt3.25%/0%; independent coverage3.43%/0.70%(n5) and0.53%/0.12%(n3).
Sampled means do not establish every-frame coverage. The cam-tshirt12.5s independent
region is unavailable. Both close-up images were opened: shoulder extensions and
wrist fill remain visibly wrong. Acceptance FAIL; private before/after paths are
listed in ar-finish-v4.json.

Instrumented V4 lab mean finisher main-thread1.1708ms(parka)/1.1042ms(tshirt), worker
segmenter30.6519/30.8206ms at configured15Hz cap. With/without-finisher mean AR
13.087/13.5652fps and12.6522/14.087fps. These are lab diagnostics, separate from
the actual kiosk profiles. Stale-mask lag0.1s:5 valid samples; cam-tshirt3.5s
unavailable because no mask existed at t-lag. All raw diagnostics, including large
missed fractions in the shirt samples, remain in the report. Nominal real still
windows are not truly still; the legacy finisher gradient proxy cannot certify
the verified0.3px/camera-frame contour threshold.

Four native real-review passes completed, exact FB7675-100, still0/1, both clips.
All four sheets opened locally:
`.cache/cx-day/look/sheets/clip-cam-{parka,tshirt}-{segments,still-strip}.png`.
Eight timestamp samples are labelled honestly; missing pose categories are not
invented. Streams have independent first-frame timestamps: visual evidence only,
never onset measurements. Cam-tshirt shows large AR rotation and tracking-loss
artifacts; the mirror also enters raised/crouched poses. Cam-parka is better but
is not a truly still input. No visual quality PASS follows. Numeric proof index:
`docs/validation/ar-eval-real-review.json`.

First16/60 stock cases complete; all eight initial stock sheets opened. Numeric
residual can pass while silhouette/collar visibly fails; visual criteria remain
separate mandatory rows. Remaining44 cases continue under individual browser-first
timing leases. No stock fit verdict. All pixels stay ignored locally. Node
scorer/rest/onset/testset26/26 PASS; scoped ESLint/Prettier and proof-sheet Ruff
PASS. No AR, body asset, API or live-default change in this evidence step.

## Earlier baseline (historical)

Completed on f76daf8+wip; web/vision source hashes match before/after each

clip. Sampling every1, finisher ON, independent coverage, no mirror. The

script waits for a selected product and tracking/drawn readiness, then

rewinds the whole clip. Previous 16b forced playback through calibration;

a protocol correction is not evidence of an engine improvement. Initial

pre-fix startup timed out at180s with zero frames; not a valid measurement.

| Metric | cam-tshirt | cam-parka |

| ------------------------------------------ | ---------------------: | -------------------------------------------: |

| Drawn residual px (<5) | 80.96 FAIL | 4.39 ok |

| Independent uncovered % (<2) | 24.25 FAIL | 1.30 ok |

| AR fps (>=24) | 8.43 FAIL | 9.37 FAIL |

| Finisher main-thread ms (<=4) | 3.39 ok | 5.62 FAIL |

| Rest edge px/processed observation (<=0.3) | N/A:5/12 drawn,2 pairs | 14.571745 FAIL |

| Rest rotation RMS deg (<=0.2) | N/A | 1.081711 FAIL |

| Rest scale-step p95 % (<=0.1) | N/A | 1.889858 FAIL |

| Provisional onset (<=1 observation) | N/A | FAIL:no output crossing in observed movement |

| Interior flicker8bit (report) | N/A | 8.305943 |

Missing tracking/coverage never counts as stillness PASS. Provisional

threshold crossings are not sensor/display latency; readbacks affect FPS.

Back/capture per-step results remain N/A without an appropriate manifest.

JSON: ar-eval-cxday-a2c1ada8e8d0c654.json / ar-eval-cxday-4095919c848a0708.json.

TypeScript PASS; node21/21 PASS; scoped ESLint/Prettier PASS (guarded lease).

After CX-TRY announces item1 done, repeat the same protocol and report

agreement/disagreement plainly; no engine tuning by this scorer.

---

# PAUSED AT USER REQUEST — latest rest scoreboard saved (historical)

All owned jobs completed before the user's pause; no waiter/Chrome/server

or lock remains. Latest run: a246b8d+wip, ending HEAD a246b8d, every=1,

finisher ON, independent V4 coverage. Both clips completed; no images saved

or committed. All earlier rows remain historical evidence.

| Latest rest metric | Target | cam-tshirt | cam-parka |

| ------------------------------------------------------------------ | ------ | ---------------------: | ----------------------------------------------: |

| Outer scanline-edge normal motion, source px/processed observation | <=0.3 | 12.273774 FAIL | 10.314771 FAIL |

| Drawn solved rotation RMS, deg | <=0.2 | 0.714929 FAIL | 0.539308 FAIL |

| Depth scale-step p95, % | <=0.1 | 6.231521 FAIL | 1.183628 FAIL |

| Provisional input/output onset, processed observations | <=1 | 32 FAIL | 0 computed ok, NOT camera-latency certification |

| Common-interior flicker, 8-bit RGB mean absolute difference | report | 5.246794 | 6.409045 |

| Independent frontal clothing uncovered, % | <2 | 4.76 FAIL (14 samples) | 1.02 ok (31 samples) |

| AR fps | >=24 | 9.08 FAIL | 9.04 FAIL |

Method: V4 measureLayers supplies final alpha and premultiplied jacket

colour in browser memory. Outer first/last row/column alpha=0.5 crossings

are linearly interpolated, matched by scanline and averaged in source px.

Clipped/unmatched edges are excluded; this is boundary-normal motion, not

optical flow. Flicker uses common alpha>=0.9 cross-eroded interior,

unpremultiplied RGB, no image registration; it includes changing shading.

Rotation uses circular axis centres and RMS angular-vector deviation;

scale is the p95 consecutive drawn-depth percentage step. Lead-selected

windows: tshirt1.2-3s, parka1.5-3s; capture facing_relaxed cue is supported.

Minimum5 drawn frames,4 pairs,>=80% drawn observations. Missing never zero.

Onset is **provisional**: input max visible limb displacement crosses

max(2px,3x rest-step p95); output boundary displacement from last rest

crosses max(0.3px,3x rest-outline p95). Search lasts <=10s. These clips

had very large input thresholds **232.64/88.99px**, output85.24/48.98px.

Small initial motion can therefore be missed. Raw frames and alpha onset

have not been independently reviewed; 0/32 is not a validated sensor/display

frame latency or a guarantee that the stillness lock never delays a move.

Targets are scored mechanically against this operational detector only.

Readbacks add substantial overhead; FPS/main-thread values are instrumented,

shared-load observations, not isolated app throughput benchmarks.

New rest maths tests:6/6, AR tests combined17/17. Full earlier app gate:

507 web PASS/1 SKIP,8 reference PASS,395 Python PASS/1 warning. Warm/full

readiness and remaining tasks: [paused handoff](STATUS-demo-day.md).

Do not resume a waiter without the user's request.

---

# Prompt 16b: first current AR rows measured, draft only (historical)

`npm.cmd run ar:score` completed both source files at 2026-11-14 00:25 UTC,

queued/ending HEAD 3476f7f+wip / 3476f7f. Standard capture/manifest pairs

were absent. No screenshot was written. Each source released its lock/server/

Chrome in finally; the single waiter was kept alive through resource delays.

| Source | Frames | Drawn residual px | V5 uncovered proxy % | Tracked fps | AR fps | Finisher main-thread ms | V4 frontal % |

| ---------- | -----: | ----------------: | -------------------: | ----------: | ---------: | ----------------------: | ------------------------- |

| cam-tshirt | 150 | 49.96 FAIL | 11.10 FAIL | 4.5 FAIL | 10.52 FAIL | 49.12 FAIL | N/A: 4 samples, mean 0.00 |

| cam-parka | 209 | 43.05 FAIL | N/A | 7.6 FAIL | 10.34 FAIL | 4.80 FAIL | N/A: 5 samples, mean 0.06 |

V4 requires >=8 valid samples; those small means are descriptive only,

not coverage PASS. Back handling remains N/A without an isolated labelled

back hold. First-pass main-thread numbers include startup/warm costs and

instrumented readback on a shared machine; they are not isolated steady-state

V4 benchmarks. No engine or threshold was changed to pass a number.

Raw aggregate rows/limitations follow below and in ar-eval-cxday-\*.json.

Typecheck passed afterward; lint/test/warm/attract/draft flow continue serially.

Reload retry and manifest per-step playback remain unexercised at runtime;

aggregation unit tests passed. AR is NOT frozen and e6 changes are pending.

V4 subsequently added an independent coverage reference in 10225ec. The

scorer now requests `measureCoverage(renderer, false, 'independent')` for

future runs; no engine edit. The first rows above predate that change and

used region-clipped reference, so their tiny descriptive means cannot prove

uncovered real clothing. They were already N/A and remain unchanged. A new

run is needed for the independent metric; the active single gate waiter

was not interrupted to do this source-only compatibility update.

---

# Prompt 16b resumed after lead's 19:20 acceptance (earlier progress)

User requires a single persistent waiter; `npm.cmd run ar:score` is active,

polling every 60 seconds for lock + >=2.5 GiB RAM. Do not stop/relaunch it

because of resource delay. Lead queue is V4, V2, then CX-DAY. No current

video score yet; pending execution will update the numeric rows below.

AR is not frozen; queued HEAD and ending HEAD must not be confused with

an immutable build while the e6 rig baseline is landing.

---

# Prompt 16b execution handoff: resource BLOCKED (prior snapshot)

The scorer implementation is saved; its browser execution is **not verified**.

`npm.cmd run ar:score` was actually launched and repeatedly waited at the

2.5 GiB RAM guard. Observed free RAM fell below 1 GiB; V2 PID46056 held

the lock for part of the wait, then released it. CX-DAY never removed

a foreign lock or stopped another agent. Own waiter PID15528 was checked

by exact command/creation time and stopped after the repeated external

blocker; npm session exited 1. It never acquired the lock, opened Chrome

or started Vite. No new video rows, partial samples or current-build AR

quality claim exist. **All rows below are historical V5 evidence.**

11/11 focused AR tests pass; all 40 CX-DAY readiness/measurement/AR tests

pass. Scoped ESLint and explicit Prettier pass. Reload retry, incremental

browser checkpoints, arbitrary file input and runtime cleanup still need

Chrome verification; unit tests establish aggregation only.

Next: arrange >=2.5 GiB free and an available shared lock, then rerun

`npm.cmd run ar:score`. Source setup uses 5791/no-HMR; retain <=14 min per

lease. Paired captures will be discovered automatically when available.

Per-step names/times and aggregate results are written into the JSON and

scoreboard; no real frame is committed. Per-step times currently use video

currentTime when the processed frame is sampled, not sensor timestamp

ground truth. Final demo GO is separate and requires lead AR freeze.

---

# AR evaluation scoreboard (agent V5)

Independent, numbers only. One row per run; "ok" = target met, "FAIL" = target missed, "n/a" = not measurable in that mode (diag mode has no rendered pixels). Frames used for the video rows are kiosk-camera recordings; the uncovered/jitter/residual metrics need video mode.

| commit | UTC date | source | keypoint residual px (< 5) | uncovered clothing % (< 2) | outline jitter px/frame (< 1.5) | facing abs yaw mean deg (< 2) | facing yaw sd deg (< 2) | scale step p95 % (< 0.5) | tracked fps (>= 24) | camera to screen ms (< 50) |

| ----------- | ---------------- | ------------------------------ | -------------------------- | -------------------------- | ------------------------------- | ----------------------------- | ----------------------- | ------------------------ | ------------------- | -------------------------- |

| 8878f8f+wip | 2026-11-13T20:27 | diag:diag-20261113-144400.json | n/a | n/a | n/a | 0.12 ok | 1.51 ok | 0.566 FAIL | 21.3 FAIL | 42.5 ok |

| 8878f8f+wip | 2026-11-13T20:27 | diag:diag-20261113-151209.json | n/a | n/a | n/a | 10.01 FAIL | 7.46 FAIL | 0.455 ok | 24.3 ok | 36.8 ok |

| 8878f8f+wip | 2026-11-13T20:27 | diag:diag-20261113-151843.json | n/a | n/a | n/a | 0 ok | 0 ok | 0.695 FAIL | 18.5 FAIL | 45.6 ok |

| 27519c7 | 2026-11-13T20:32 | video:cam-tshirt | 69.19 FAIL | n/a | n/a | n/a | n/a | 9.447 FAIL | 13.9 FAIL | 38.8 ok |

| 27519c7 | 2026-11-13T20:33 | video:cam-parka | 3.52 ok | 2.04 FAIL | n/a | 0 ok | 0 ok | 2.197 FAIL | 11.8 FAIL | 40 ok |

## CX-DAY methodology / prompt 16b

`npm.cmd run ar:score` scores both kiosk-camera MP4s and every paired

`capture-*.webm` / `.json` under the private live-diag folder, serially, with

one bounded browser lease per source. `node scripts/ar-eval.mjs --video <path>`

accepts any local video through the lab's local-file input; optional

`--manifest <path>` adds half-open video-time step windows. No upload.

Default is a no-HMR/no-watch Vite on own port 5791, installed Chrome,

finisher ON, no mirror, same source-specific local fitted body, size S.

Engine code is never changed by the scorer. Numbers are shared-load observations.

Historical V5 rows above remain verbatim. Their uncovered metric is a

pre-finisher torso/person-mask proxy. New V4 frontal coverage is post-finisher

clothing-class coverage via `ar.finisher.measureCoverage`; class fallback is

missing, never zero. That synchronous evaluation readback and incremental

checkpoints add instrumentation overhead to observed throughput. AR fps and

finisher main-thread applyMs are smoothed debug statistics; the latter has

the lead's <=4 ms budget, not a GPU completion claim. V5's camera-to-screen

column is retained as engine processing totalMs, excluding sensor/display lag.

Read CX-TRY's new uncommitted capture manifest/routine read-only: it uses

`schema`, version 1 and `{name,startMs,endMs}`; compatible with the scorer.

Its `show_back` step includes both turns, so remains unscored as isolated

back ground truth (regression tested). Raw camera fps/labels, jacket text

and per-frame capture timestamps are not copied into public evidence.

Capture contract: `{format: "satisfy-capture", version: 1, steps: [{name,

startMs, endMs}]}` (`schema`accepted as an alias for`format`). Preserve

labels verbatim, reject overlapping/invalid steps, report even empty steps

with nulls. A back-turn step includes frontal transitions; it cannot be

scored entirely as a back hold. Back handled >=95% requires an isolated

operator-labelled `back hold` / `back view` window; detector backView alone

is not independent ground truth. A frame is safe only at >=95% fade or an

explicit correct-back flag. Fewer than 30 back frames stays n/a.

Per-step alignment reports solve RMS px separately from drawn-keypoint

residual (median <5 px, >=30 samples); no inferred labels for unmanifested videos.

Aggregate JSON checkpoints are overwritten incrementally every 30 observed

frames; raw frames/landmarks and exception details stay in ignored `.cache/ar-eval`.

Final/incomplete rows upsert by source and starting HEAD (+wip for ANY tree

changes); source SHA-256 and ending HEAD expose input/build drift. A destroyed

execution context/reload retries full setup once, within the 14-minute lease.

No screenshots are committed; privacy-ignore checks run before private writes.

Implementation checks: 11/11 focused unit tests pass, including step boundaries,

missing data, independent back truth and V4 coverage exclusions. Browser rows

for this revision are pending execution below; historical V5 fps is not a

current performance claim.

## CX-DAY prompt 16b

<!-- cxday-score:start -->
| commit | UTC date | source | keypoint residual px (< 5) | uncovered clothing % (< 2) | outline jitter px/frame (< 1.5) | facing abs yaw mean deg (< 2) | facing yaw sd deg (< 2) | scale step p95 % (< 0.5) | tracked fps (>= 24) | camera to screen ms (< 50) | V4 frontal uncovered % (< 2) | labelled back handled % (>= 95) | finisher main-thread ms (<= 4) | AR fps (>= 24) | rest outline px/frame (<= 0.3) | rest rotation RMS deg (<= 0.2) | rest scale step p95 % (<= 0.1) | motion onset lag frames (<= 1) | rest pixel flicker 8bit (report) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3476f7f+wip | 2026-11-14T00:25 | video:cam-tshirt.mp4 | 49.96 FAIL | 11.1 FAIL | n/a | 0.33 ok | 1.87 ok | 9.026 FAIL | 4.5 FAIL | 85.9 FAIL | n/a | n/a | 49.12 FAIL | 10.52 FAIL | n/a | n/a | n/a | n/a | n/a |
| 3476f7f+wip | 2026-11-14T00:25 | video:cam-parka.mp4 | 43.05 FAIL | n/a | n/a | n/a | n/a | 5.158 FAIL | 7.6 FAIL | 65.1 FAIL | n/a | n/a | 4.8 FAIL | 10.34 FAIL | n/a | n/a | n/a | n/a | n/a |
| a246b8d+wip | 2026-11-14T01:38 | video:cam-tshirt.mp4 | 41.31 FAIL | 16.06 FAIL | n/a | n/a | n/a | 13.811 FAIL | 6.3 FAIL | 73.8 FAIL | 4.76 FAIL | n/a | 59.6 FAIL | 9.08 FAIL | 12.27377397669788 FAIL | 0.7149293254340715 FAIL | 6.231520801067655 FAIL | 32 FAIL | 5.246794242957512 reported |
| a246b8d+wip | 2026-11-14T01:39 | video:cam-parka.mp4 | 17.51 FAIL | 14.69 FAIL | n/a | n/a | n/a | 1.011 FAIL | 7 FAIL | 93.2 FAIL | 1.02 ok | n/a | 3.72 ok | 9.04 FAIL | 10.314770639613094 FAIL | 0.5393082417328786 FAIL | 1.183627673226884 FAIL | 0 ok | 6.40904504796961 reported |
| f76daf8+wip | 2026-11-14T05:43 | video:cam-tshirt.mp4 | 80.96 FAIL | 35.92 FAIL | n/a | n/a | n/a | 11.751 FAIL | 6.5 FAIL | 81.1 FAIL | 24.25 FAIL | n/a | 3.39 ok | 8.43 FAIL | n/a | n/a | n/a | n/a | n/a |
| f76daf8+wip | 2026-11-14T06:02 | video:cam-parka.mp4 | 4.39 ok | 9.86 FAIL | n/a | n/a | n/a | 6.673 FAIL | 6.9 FAIL | 78.8 FAIL | 1.3 ok | n/a | 5.62 FAIL | 9.37 FAIL | 14.571744845967183 FAIL | 1.081710623253803 FAIL | 1.8898575633620198 FAIL | FAIL (no response) | 8.305943084391025 reported |
| d7e90fd+wip | 2026-11-14T07:29 | video:cam-parka.mp4 | n/a | 12.18 FAIL | n/a | n/a | n/a | 7.335 FAIL | 8.2 FAIL | 84.3 FAIL | 1.36 ok | n/a | 4.78 FAIL | 10.28 FAIL | 2.0535221999788553 FAIL | 0.9543280305745055 FAIL | 0.12258513072518382 FAIL | 268 FAIL | 6.163829913614555 reported |
| 63308ed+wip | 2026-11-14T07:32 | video:cam-parka.mp4 | 5.38 FAIL | 11.68 FAIL | n/a | n/a | n/a | 6.723 FAIL | 5.9 FAIL | 81.2 FAIL | 1.55 ok | n/a | 5.56 FAIL | 7.62 FAIL | 2.1263883784750464 FAIL | 0.9001760052985006 FAIL | 0.15849518202544588 FAIL | 0 ok | 6.888496661244233 reported |
| 73633fe+wip | 2026-11-14T10:30 | video:cam-parka.mp4 [FB7675-100, still0] | 3.15 ok | 24.8 FAIL | n/a | n/a | n/a | 3.269 FAIL | 6.9 FAIL | 69.4 FAIL | 1.47 ok | n/a | 2.22 ok | 8.71 FAIL | 2.1862746851039394 FAIL | 0.9816807551156559 FAIL | 0.0815701202527628 ok | 0 ok | 15.692718659604152 reported |
| 73633fe+wip | 2026-11-14T10:31 | video:cam-parka.mp4 [FB7675-100, still1] | 3.11 ok | 22.14 FAIL | n/a | 0 ok | 0 ok | 3.353 FAIL | 11 FAIL | 61.4 FAIL | 3.96 FAIL | n/a | 1.87 ok | 12.88 FAIL | 2.099801185449866 FAIL | 1.137255642783469 FAIL | 0.3809549550931789 FAIL | 0 ok | 13.559792578532276 reported |
| 73633fe+wip | 2026-11-14T10:31 | video:cam-tshirt.mp4 [FB7675-100, still0] | n/a | 26.97 FAIL | n/a | n/a | n/a | 26.146 FAIL | 6.7 FAIL | 87.6 FAIL | 33.82 FAIL | n/a | 6.19 FAIL | 7.88 FAIL | n/a | n/a | n/a | n/a | n/a |
| 73633fe+wip | 2026-11-14T10:32 | video:cam-tshirt.mp4 [FB7675-100, still1] | n/a | 28.65 FAIL | n/a | n/a | n/a | 13.983 FAIL | 6.8 FAIL | 115.1 FAIL | 4.99 FAIL | n/a | 6.53 FAIL | 8.62 FAIL | n/a | n/a | n/a | n/a | n/a |
| cb111dc+wip | 2026-11-14T10:55 | video:mixkit-460-standing-woman-listening-to-music.mp4 [FB7675-100, still0] | 3.13 ok | 17.93 FAIL | n/a | 0.53 ok | 5.63 FAIL | 0.576 FAIL | 8.7 FAIL | 68.9 FAIL | 7.52 FAIL | n/a | 1.89 ok | 10.77 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:04 | video:mixkit-460-standing-woman-listening-to-music.mp4 [FB7675-100, still1] | 2.62 ok | 17.8 FAIL | n/a | 0.75 ok | 3.07 FAIL | 1.796 FAIL | 8.9 FAIL | 67.2 FAIL | 7.37 FAIL | n/a | 1.95 ok | 10.77 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:06 | video:mixkit-460-standing-woman-listening-to-music.mp4 [DQ4920-206, still0] | 2.03 ok | 7.12 FAIL | n/a | 0.59 ok | 2.6 FAIL | 0.978 FAIL | 8.7 FAIL | 58.6 FAIL | 7.7 FAIL | n/a | 2.28 ok | 10.57 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:08 | video:mixkit-460-standing-woman-listening-to-music.mp4 [DQ4920-206, still1] | 3.06 ok | 14.11 FAIL | n/a | 1.69 ok | 5.19 FAIL | 1.223 FAIL | 9.2 FAIL | 65.5 FAIL | 6.23 FAIL | n/a | 1.87 ok | 11.04 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:10 | video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [FB7675-100, still0] | 1.73 ok | 27.41 FAIL | 2.631 FAIL | 0 ok | 0 ok | 0.098 ok | 9.6 FAIL | 65.8 FAIL | 1.06 ok | n/a | 2.23 ok | 11.02 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:12 | video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [FB7675-100, still1] | 3.39 ok | 29.97 FAIL | 0 ok | 0 ok | 0 ok | 0 ok | 12.2 FAIL | 41.6 ok | 1.27 ok | n/a | 0.49 ok | 14.39 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:14 | video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [DQ4920-206, still0] | 1.31 ok | 22.27 FAIL | 2.394 FAIL | 0 ok | 0 ok | 0.131 ok | 9.7 FAIL | 64.7 FAIL | 0.52 ok | n/a | 2.01 ok | 10.97 FAIL | 0.7523319584042678 FAIL | 1.140939351150016 FAIL | 0.0667122992901702 ok | n/a | 2.908163775326698 reported |
| 1e0caf4+wip | 2026-11-14T11:16 | video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [DQ4920-206, still1] | 3.71 ok | 23.3 FAIL | 0 ok | 0 ok | 0 ok | 0 ok | 12.6 FAIL | 39.9 ok | 0.99 ok | n/a | 0.49 ok | 14.96 FAIL | 0 ok | 0 ok | 0 ok | n/a | 0.002434199562527409 reported |
| 1e0caf4+wip | 2026-11-14T11:18 | video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [FB7675-100, still0] | 0.7 ok | n/a | n/a | 0 ok | 0 ok | 0.246 ok | 9.7 FAIL | 62.5 FAIL | n/a | n/a | 1.75 ok | 11.61 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:20 | video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [FB7675-100, still1] | 1.1 ok | n/a | n/a | 0 ok | 0 ok | 0.242 ok | 9.9 FAIL | 61.4 FAIL | n/a | n/a | 1.58 ok | 11.8 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:22 | video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [DQ4920-206, still0] | 0.66 ok | n/a | n/a | 0 ok | 0 ok | 0.268 ok | 10 FAIL | 59.7 FAIL | n/a | n/a | 1.55 ok | 11.93 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:24 | video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [DQ4920-206, still1] | 0.84 ok | n/a | n/a | 0 ok | 0 ok | 0.222 ok | 9.7 FAIL | 61.2 FAIL | n/a | n/a | 1.63 ok | 11.8 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:26 | video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [FB7675-100, still0] | 1.6 ok | n/a | n/a | 2.74 FAIL | 4.71 FAIL | 0.389 ok | 10.3 FAIL | 56.3 FAIL | n/a | n/a | 1.54 ok | 13.04 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:28 | video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [FB7675-100, still1] | 1.61 ok | n/a | n/a | 1.09 ok | 2.74 FAIL | 0.313 ok | 10.5 FAIL | 56.3 FAIL | n/a | n/a | 1.51 ok | 12.83 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:29 | video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [DQ4920-206, still0] | 1.77 ok | n/a | n/a | 3.35 FAIL | 4.97 FAIL | 0.492 ok | 9.7 FAIL | 60.2 FAIL | n/a | n/a | 1.79 ok | 11.94 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:31 | video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [DQ4920-206, still1] | 1.68 ok | n/a | n/a | 2.62 FAIL | 4.59 FAIL | 0.261 ok | 10.7 FAIL | 52.8 FAIL | n/a | n/a | 1.43 ok | 13.37 FAIL | n/a | n/a | n/a | n/a | n/a |
| 1e0caf4+wip | 2026-11-14T11:48 | video:cam-parka.mp4 [FB7675-100, still0] | n/a | 22.79 FAIL | n/a | n/a | n/a | 2.701 FAIL | 6.9 FAIL | 79.2 FAIL | 3.02 FAIL | n/a | 2.53 ok | 7.81 FAIL | 2.208408452438754 FAIL | 3.581497991296946 FAIL | 0.2072315776702923 FAIL | 0 n/a | 16.75105729843273 reported |
| 1e0caf4+wip | 2026-11-14T11:50 | video:cam-parka.mp4 [FB7675-100, still1] | 3.21 ok | 25.11 FAIL | n/a | 0.45 ok | 0.96 ok | 7.825 FAIL | 6.5 FAIL | 78.5 FAIL | 1.67 ok | n/a | 2.39 ok | 7.69 FAIL | 2.0316398421985773 FAIL | 1.3198547402575822 FAIL | 0.30919218559266537 FAIL | 3 n/a | 14.280090923394784 reported |
| 2e8f645+wip | 2026-11-14T11:52 | video:cam-tshirt.mp4 [FB7675-100, still0] | n/a | 18.16 FAIL | n/a | n/a | n/a | 11.949 FAIL | 6.9 FAIL | 86 FAIL | 18.43 FAIL | n/a | 5.14 FAIL | 9.1 FAIL | n/a | n/a | n/a | n/a | n/a |
| 2e8f645+wip | 2026-11-14T11:54 | video:cam-tshirt.mp4 [FB7675-100, still1] | 2.95 ok | 12.41 FAIL | n/a | n/a | n/a | 4.926 FAIL | 7.8 FAIL | 83.1 FAIL | 1.07 ok | n/a | 4.28 FAIL | 9.59 FAIL | 2.7360870484869912 FAIL | 1.053100190116231 FAIL | 0.6580654364349712 FAIL | n/a | 13.296008681098032 reported |
| 2e8f645+wip | 2026-11-14T12:04 | video:mixkit-11569-woman-standing-in-a-modern-office.mp4 [FB7675-100, still0] | 1.23 ok | 23.46 FAIL | 0.707 ok | 0 ok | 0 ok | 0.271 ok | 7.4 FAIL | 99.3 FAIL | 2.07 FAIL | n/a | 6.03 FAIL | 8.49 FAIL | n/a | n/a | n/a | 40 FAIL | n/a |
<!-- cxday-score:end -->

## Prompt18 ruler correction (2026-11-14)

The previous scanline-normal average under-reported a rigid 1px translation and

labelled processed observations as frames. Historical rows through f76daf8 use

that old definition and are not comparable to the corrected ruler. The new

64-point centroid-polar contour measures 1 source px as 1px (?0.05 test); static

alpha=0, circular rotation RMS=0.5?, and a known scale step=0.5% pass. Camera

presented-frame identities are associated with raw source callbacks; outline and

scale endpoint steps divide by that gap, while observation values remain visible.

Missing identities are N/A. Unsampled within-gap excursions remain unobservable;

this does not prove sensor/display latency. Onset thresholds remain provisional.

`node scripts/ar-eval.mjs --video cam-parka --ruler` completed the second trial

with both browser/heavy locks. `ar-eval-ruler.json` records all four frozen-input

combinations: finish/still OFF/OFF 0.34316px/camera-frame (0.61945/obs), OFF/ON

0.53526 (1.72874), ON/OFF 0.53885 (0.79033), ON/ON 0.48702 (0.59794). All exceed

0.3. Rotation RMS respectively 0.11913?,0.09247?,0.04532?,0.06137?; scale0.

Finish OFF uses actual glued torso+sleeve alpha; colour flicker unavailable there.

Finish ON uses final finisher alpha before contact shadow. Codec-induced pixel

noise is still to be checked; the local clip is `.cache/cx-day/ruler/frozen-parka.webm`.

The first trial failed creating the repeated clip (AbortError), retained privately.

On the real parka still window the raw visible-joint max-step mean is

3.64521px/camera-frame (18.78228px/observation), p95 5.45367; this includes any

actual motion within the labelled still interval. Corrected trial outline2.12639,

rotation0.90018?, scale0.15850%, AR7.62fps. \*\*Source hashes changed during this

trial\*\*, so this is provisional instrumentation evidence, not stable-HEAD acceptance.

The full independent check must repeat after CX-TRY announces item1 done.

Validation: Node28/28 PASS; TypeScript PASS; scoped ESLint PASS. PSD affected

suite subsequently19/19 PASS after updating its default-off policy expectation.

No API restart or physics flip; private pixels remain ignored/local.

<!-- steps:6c09734ef6aaa80b:start -->

### video:mixkit-460-standing-woman-listening-to-music.mp4 [FB7675-100, still0] / cb111dc+wip steps

| step    | video ms | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | -------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 0-9000   | 81     | 32.31 FAIL                  | 3.11 ok                | 7.54 FAIL                | n/a                   | 1.89 ok           | 10.75 FAIL    |
| relaxed | 0-10100  | 90     | 35.55 FAIL                  | 3.13 ok                | 7.52 FAIL                | n/a                   | 1.89 ok           | 10.77 FAIL    |

<!-- steps:6c09734ef6aaa80b:end -->

## Prompt19 window / prompt20 Anywear bar (2026-11-14)

Pending ruler followups committed97240a7, Node8/8, TypeScript/lint/format PASS.
Expanded layer/onset/testset arithmetic now26/26 PASS. All new evidence uses
exact FB7675-100 / DQ4920-206 and validates the selected catalogue style.
Earlier parka scorer/PSD used FB7675 prefix, which matches the expected parka;
no puffer alias was requested by those runs. Their selected style was not
asserted, so historical rows lack product-identity certification. They must not
serve as a puffer result. No old puffer-alias result is promoted here.

Frozen8-case matrix: fresh stable snapshot9a3f24c89cd6cb98a7b71e929b1d3ed45ccabdc8cbf807cec903580f098cc41c,
exact parka, identical delivered raw image hash in all12 proof frames per case.
Numerics run4s after2.5s warm-up;12 native screenshots follow in a separate pass.
No extra render is injected. AR before-finisher, final alpha, glue controls,
mirror display-source vertex buffers, grade and raw landmarks are recorded.
Private sheets `.cache/cx-day/frozen/sheets/`; both still1/finish1 view sheets
were opened and contain actual coloured images, not cleared GL buffers.

| source     | still | finish | final edge px/camera frame | rotation RMS deg | mirror mm/camera frame | glue px/camera frame | engaged |
| ---------- | ----- | ------ | -------------------------- | ---------------- | ---------------------- | -------------------- | ------- |
| cam-parka  | 0     | 0      | 0.512300                   | 0.953032         | 1.887854               | 0.405244             | 0       |
| cam-parka  | 1     | 0      | 0                          | 0                | 0                      | 0                    | 1       |
| cam-parka  | 0     | 1      | 0.751333                   | 0.078107         | 1.840885               | 0.593940             | 0       |
| cam-parka  | 1     | 1      | 0                          | 0                | 0                      | 0                    | 1       |
| cam-tshirt | 0     | 0      | 27.803922                  | 3.106104         | 8.119747               | 40.599532            | 0       |
| cam-tshirt | 1     | 0      | 12.132379                  | 0.499326         | 3.727016               | 11.938844            | 0       |
| cam-tshirt | 0     | 1      | 12.144750                  | 1.254000         | 4.155342               | 19.655928            | 0       |
| cam-tshirt | 1     | 1      | 14.123246                  | 1.167093         | 5.061382               | 16.571606            | 0       |

Full precision scale, grade, raw jitter and observation gaps are in
validation/ar-eval-frozen-matrix.json and the per-source frozen JSONs. Parka
still1 stationarity passes this fixed-input check only. Shirt still1 FAILS:
raw landmark max-step noise27.30/30.38px per camera gap while delivered pixels
are identical; the detector never engages. Large glue motion already exists
before finishing. This points upstream of the finisher. Cropped framing is a
correlation in the sheet, not a proven cause. Native proof shows continued
shirt AR and mirror motion. No live tracking/coverage/look/fps PASS follows from
the parka frozen result. The prior VP8/mixed-revision pilot stays historical.

Real OFF/ON rows complete, same snapshot/exact parka, in ar-eval-real-window.json:
parka residual3.15/3.11px, independent uncovered1.47/3.96%, instrumented AR8.71/12.88fps;
shirt residual unavailable, uncovered33.82/4.99%, AR7.88/8.62fps. Nominal still
windows are labelled NOT TRULY STILL. Onset now includes raw/control proxy events
with camera-gap bounds; sparse observations cannot certify a one-camera-frame
response, and missing/ambiguous reach/cross groundtruth stays N/A.

Prompt20 started immediately after19 Main1-3. The manifest parser maps15clips,
keeps back isolated and discards descriptive person metadata from reports. Stock
bodies use the app default fallback172/65; no stock fit measurements are reported.
Still intervals require >=2s/>=5 observations and <=2source-px raw pose RMS
about the window mean (operator qualification, not an engine threshold). A moving
or unobservable nominal still segment never becomes a zero-motion PASS.

Pilot clip460/parka/still0 completed all numeric, native-stream visual and
actual kiosk profile stages:42proof images, zero all-black images. Kiosk profile
is separate from readbacks/screenshots and is the real UI with native local video
fixture,6s sampling. All visual criteria remain unvalidated until opened/reviewed;
missing criteria block an Anywear PASS. No default or geometry change from these tests.

<!-- steps:5e4846a19919c855:start -->

### video:mixkit-460-standing-woman-listening-to-music.mp4 [FB7675-100, still1] / 1e0caf4+wip steps

| step    | video ms | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | -------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 0-9000   | 82     | 25.51 FAIL                  | 2.62 ok                | 7.37 FAIL                | n/a                   | 1.94 ok           | 10.8 FAIL     |
| relaxed | 0-10100  | 90     | 25.03 FAIL                  | 2.62 ok                | 7.37 FAIL                | n/a                   | 1.95 ok           | 10.77 FAIL    |

<!-- steps:5e4846a19919c855:end -->

<!-- steps:ed135192e7f63c0e:start -->

### video:mixkit-460-standing-woman-listening-to-music.mp4 [DQ4920-206, still0] / 1e0caf4+wip steps

| step    | video ms | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | -------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 0-9000   | 79     | 22.76 FAIL                  | 2.03 ok                | 7.7 FAIL                 | n/a                   | 2.27 ok           | 10.47 FAIL    |
| relaxed | 0-10100  | 88     | 22.8 FAIL                   | 2.03 ok                | 7.7 FAIL                 | n/a                   | 2.28 ok           | 10.57 FAIL    |

<!-- steps:ed135192e7f63c0e:end -->

<!-- steps:fdbe49417b6eb526:start -->

### video:mixkit-460-standing-woman-listening-to-music.mp4 [DQ4920-206, still1] / 1e0caf4+wip steps

| step    | video ms | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | -------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 0-9000   | 86     | 21.71 FAIL                  | 3.04 ok                | 6.39 FAIL                | n/a                   | 1.86 ok           | 11.05 FAIL    |
| relaxed | 0-10100  | 93     | 22.01 FAIL                  | 3.06 ok                | 6.23 FAIL                | n/a                   | 1.87 ok           | 11.04 FAIL    |

<!-- steps:fdbe49417b6eb526:end -->

<!-- steps:ac79059b61e67bdd:start -->

### video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [FB7675-100, still0] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-14800 | 131    | 16.58 FAIL                  | 1.59 ok                | 1.06 ok                  | n/a                   | 2.03 ok           | 10.95 FAIL    |
| closeup | 0-14800    | 141    | 16.43 FAIL                  | 1.73 ok                | 1.06 ok                  | n/a                   | 2.23 ok           | 11.02 FAIL    |

<!-- steps:ac79059b61e67bdd:end -->

<!-- steps:067804206c6eb227:start -->

### video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [FB7675-100, still1] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-14800 | 165    | 12.1 FAIL                   | 3.59 ok                | 1.27 ok                  | n/a                   | 0.32 ok           | 14.58 FAIL    |
| closeup | 0-14800    | 180    | 12.05 FAIL                  | 3.39 ok                | 1.27 ok                  | n/a                   | 0.49 ok           | 14.39 FAIL    |

<!-- steps:067804206c6eb227:end -->

<!-- steps:cfb7f5a226e48263:start -->

### video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [DQ4920-206, still0] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-14800 | 131    | 18.45 FAIL                  | 1.23 ok                | 0.49 ok                  | n/a                   | 1.9 ok            | 10.95 FAIL    |
| closeup | 0-14800    | 143    | 17.6 FAIL                   | 1.31 ok                | 0.52 ok                  | n/a                   | 2.01 ok           | 10.97 FAIL    |

<!-- steps:cfb7f5a226e48263:end -->

<!-- steps:bc11927c40ddfde3:start -->

### video:mixkit-4833-female-doctor-talking-on-a-video-call.mp4 [DQ4920-206, still1] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-14800 | 172    | 11.39 FAIL                  | 3.86 ok                | 0.99 ok                  | n/a                   | 0.32 ok           | 15.17 FAIL    |
| closeup | 0-14800    | 186    | 11.36 FAIL                  | 3.71 ok                | 0.99 ok                  | n/a                   | 0.49 ok           | 14.96 FAIL    |

<!-- steps:bc11927c40ddfde3:end -->

<!-- steps:bf8a6134d0b77445:start -->

### video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [FB7675-100, still0] / 1e0caf4+wip steps

| step       | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ---------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still      | 1000-15000 | 138    | 16.9 FAIL                   | 0.73 ok                | n/a                      | n/a                   | 1.78 ok           | 11.22 FAIL    |
| cross_arms | 1000-15000 | 138    | 16.9 FAIL                   | 0.73 ok                | n/a                      | n/a                   | 1.78 ok           | 11.22 FAIL    |

<!-- steps:bf8a6134d0b77445:end -->

<!-- steps:36374fcfabddabd7:start -->

### video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [FB7675-100, still1] / 1e0caf4+wip steps

| step       | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ---------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still      | 1000-15000 | 137    | 16.64 FAIL                  | 1.1 ok                 | n/a                      | n/a                   | 1.59 ok           | 11.43 FAIL    |
| cross_arms | 1000-15000 | 137    | 16.64 FAIL                  | 1.1 ok                 | n/a                      | n/a                   | 1.59 ok           | 11.43 FAIL    |

<!-- steps:36374fcfabddabd7:end -->

User reference confirmed2026-11-14: the real parka quilting is HORIZONTAL
CHANNELS. This resolves the Nike box-grid versus user-coat question; the user's
coat is authoritative. No garment geometry or material change by CX-DAY.

<!-- steps:b44b007508b82417:start -->

### video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [DQ4920-206, still0] / 1e0caf4+wip steps

| step       | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ---------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still      | 1000-15000 | 137    | 16.76 FAIL                  | 0.71 ok                | n/a                      | n/a                   | 1.57 ok           | 11.53 FAIL    |
| cross_arms | 1000-15000 | 137    | 16.76 FAIL                  | 0.71 ok                | n/a                      | n/a                   | 1.57 ok           | 11.53 FAIL    |

<!-- steps:b44b007508b82417:end -->

<!-- steps:6abd8984a6dce3d9:start -->

### video:mixkit-4834-therapist-in-his-office-talking-to-the-c.mp4 [DQ4920-206, still1] / 1e0caf4+wip steps

| step       | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ---------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still      | 1000-15000 | 137    | 17.04 FAIL                  | 0.87 ok                | n/a                      | n/a                   | 1.66 ok           | 11.31 FAIL    |
| cross_arms | 1000-15000 | 137    | 17.04 FAIL                  | 0.87 ok                | n/a                      | n/a                   | 1.66 ok           | 11.31 FAIL    |

<!-- steps:6abd8984a6dce3d9:end -->

<!-- steps:a68a77e5322e5b9d:start -->

### video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [FB7675-100, still0] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-10100 | 87     | 123.95 FAIL                 | 1.87 ok                | n/a                      | n/a                   | 1.63 ok           | 11.52 FAIL    |
| closeup | 0-10100    | 104    | 123.95 FAIL                 | 1.6 ok                 | n/a                      | n/a                   | 1.54 ok           | 13.04 FAIL    |

<!-- steps:a68a77e5322e5b9d:end -->

<!-- steps:e1178a1a0194dd87:start -->

### video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [FB7675-100, still1] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-10100 | 91     | 99.24 FAIL                  | 1.61 ok                | n/a                      | n/a                   | 1.54 ok           | 11.8 FAIL     |
| closeup | 0-10100    | 106    | 99.87 FAIL                  | 1.61 ok                | n/a                      | n/a                   | 1.51 ok           | 12.83 FAIL    |

<!-- steps:e1178a1a0194dd87:end -->

<!-- steps:b395757c0ae38655:start -->

### video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [DQ4920-206, still0] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-10100 | 85     | 102.24 FAIL                 | 1.88 ok                | n/a                      | n/a                   | 1.81 ok           | 10.94 FAIL    |
| closeup | 0-10100    | 98     | 102.24 FAIL                 | 1.77 ok                | n/a                      | n/a                   | 1.79 ok           | 11.94 FAIL    |

<!-- steps:b395757c0ae38655:end -->

<!-- steps:fbd720a51050c3f1:start -->

### video:mixkit-10457-guy-facing-in-the-middle-of-a-video-call.mp4 [DQ4920-206, still1] / 1e0caf4+wip steps

| step    | video ms   | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| ------- | ---------- | ------ | --------------------------- | ---------------------- | ------------------------ | --------------------- | ----------------- | ------------- |
| still   | 1000-10100 | 92     | 111.64 FAIL                 | 1.72 ok                | n/a                      | n/a                   | 1.45 ok           | 12.25 FAIL    |
| closeup | 0-10100    | 108    | 111.64 FAIL                 | 1.68 ok                | n/a                      | n/a                   | 1.43 ok           | 13.37 FAIL    |

<!-- steps:fbd720a51050c3f1:end -->



<!-- steps:746c6f028db3cd13:start -->

### video:mixkit-11569-woman-standing-in-a-modern-office.mp4 [FB7675-100, still0] / 2e8f645+wip steps

| step | video ms | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cross_arms | 0-11400 | 84 | 24.32 FAIL | 1.23 ok | 2.07 FAIL | n/a | 6.03 FAIL | 8.49 FAIL |
| still | 1000-11400 | 75 | 25.42 FAIL | 1.38 ok | 2.07 FAIL | n/a | 3.97 ok | 8.55 FAIL |

<!-- steps:746c6f028db3cd13:end -->
