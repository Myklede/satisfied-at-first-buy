# PAUSED AT USER REQUEST — Nov 13 20:40 local

The user requested saving and pausing; no CX-DAY background waiter, Chrome,
server or lock remains. This overrides the earlier keep-waiter instruction.
AR scoring (including provisional rest measurements), full test gate and
two-pass production warm run completed before the pause. Attract, draft
fake-camera rehearsal and T1 pose capture remain pending. No new real-jacket
pose/edge observation was accepted this round. Earlier supplemental puffer
exposure below remains the only accepted real observation.

Exact saved evidence, test counts, limits and next commands are at the top
of [STATUS-demo-day](STATUS-demo-day.md) and [STATUS-ar-eval](STATUS-ar-eval.md).
No camera/video-derived image was committed, no foreign process/file was
changed and no paid/cloud call occurred. Resume only at the user's request.

---

# Prompt 16b resumed on user instruction / lead 19:20 (historical)

One persistent runtime-job waiter is active; do not stop it for RAM/lock
delay. AR scoring completed; the current waiter is the full test gate.
Follow the lead queue V4 -> V2 -> CX-DAY, then guarded gates, warm,
attract and draft rehearsal before resuming T1. Privacy/ownership and the
2.5 GiB launch floor remain binding. AR is not frozen; prior stopped
snapshots below are historical. No new T1 metric is claimed yet.

---

# Prompt 16b follow-up (2026-11-14 UTC)

The user resumed CX-DAY. Prompt 16b changes the order to AR scoreboard,
live demo pack, draft readiness, then incomplete T1. Scoreboard code and
demo docs are saved, but the RAM guard repeatedly blocked browser startup;
latest preparation preflight is NO-GO. Own waiter was stopped safely.
No new pose frames, accepted silhouette metrics or real/physics agreement
were produced this round. The saved supplemental exposure and uncertainty
below remain the only accepted real observation. [Current draft board and
exact continuation](STATUS-demo-day.md), [AR handoff](STATUS-ar-eval.md).

40/40 owned tests PASS, scoped ESLint/Prettier PASS. No current full-project
gates or final-build browser evidence is claimed. Private images/pose data
remain ignored and local; nothing was uploaded or newly committed as imagery.

---

# CX-DAY final handoff: BLOCKED, not final GO

Prompt 15b is **not complete**. Shared browser/resource coordination prevents T1,
and the lead has not declared AR frozen for T3. The waiting process was stopped
at the external blocker in accordance with shared rules; no work continues in
background. All completed CX-DAY work is saved in focused local commits.

| Real observation                                         |                                  Result | Uncertainty / scope                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Puffer, both arms up, 46-50 s, front hem to waistband    | Median 11.73 cm; observed 6.01-12.59 cm | Projected 2D, 5 manually reviewed frames; partial sensitivity 5.63 cm; total UNKNOWN because +/-1s endpoints hide waistband and depth is uncalibrated |
| Remaining pose-referenced hem/cuff metrics, both jackets |                                 Pending | No Chrome pose capture completed; never filled with zeros                                                                                             |

[Numbers and method](validation/tryon-real-exposure.json). Private frames, grids,
edge picks, paper corners, reference height and intermediate pose data stay in
`.cache/cxday-tryon/`; none committed.

[Comparison snapshot](validation/tryon-compare-metrics.json) retains SHA-256 source
digests. V3 parka cross-arms has simulated front hem rise 4.96 cm, left/right
ride-up 13.01/10.21 cm and front exposure 0 cm. Corresponding accepted real data
is absent, so deltas/verdicts are N/A. Recorded overhead reach is refused; no
substitution with preset physics. Puffer has the real supplemental observation
but no matching V3 physics. V2's named `tryon-ar-eval.json` is absent; AR grading
remains with the lead/V2/V5. Numeric overlap alone would not prove 2D/3D accuracy.

## Exact blockers and cleanup

- Browser job 1: repository-root Vite watcher reloaded on foreign cache updates;
  navigation timed out, zero measurements; own Chrome/server/lock closed.
- Job 2: after waiting, esbuild could not read the parent directory under sandbox;
  zero measurements and own lock released. Standard automatic escalation was
  requested for the same authorized local-only command; it was not rejected.
- Escalated retry waited on RAM/foreign locks. Last blocking lock:
  `V2 ar-run`, PID 45036. Its process start was observed at 16:25:56 local;
  it still held the lock after repeated 60-second polls despite RAM recovering
  above 3 GiB. Never removed that lock or stopped its process.
- Own waiting PID **34728**, command `node scripts/tryon-validate-real.mjs`,
  creation 16:31:05 local, was verified again before stopping. It had no Chrome,
  server or lock. Confirmed taskkill success. Shared 8001/5711 and live labs
  5760/5761/5765 remain untouched. No new dependencies, network outside loopback,
  paid API, real Claude CLI, history rewrite or push.
- No lead AR-freeze note exists. Final build/warm/rehearsal/preflight are therefore
  **NOT RUN**. Preparation preflight was NO-GO (RAM, stale dist, active dirty tree),
  with shared API privacy PASS. Earlier readiness is not final-build evidence.

## Continue after the lead releases the slot / freezes AR

1. T1 first: `node scripts/tryon-validate-real.mjs`. Use the normal automatic
   escalation if the esbuild parent-directory sandbox error repeats. Keep the
   2.5 GiB launch floor, own 5790, atomic shared lock and <=14 min lease.
2. `node scripts/tryon-validate-review.mjs`. Inspect private overlay sheets and
   ambiguous originals. Create private `.cache/cxday-tryon/review.json` with
   reviewed `accepted.parka/puffer.hem/left/right` timestamp arrays, per-product
   `scale.pxPerCm/fraction`, limitations, and optional `exposure` from the saved
   supplemental numbers. No automatic acceptance. Exclude misleading masks,
   occluded/out-of-frame wrists or ambiguous hems. Existing private
   `scale-private-series.json` holds paper/height crosschecks and corner
   sensitivity; do not treat a plane/depth sensitivity scenario as a measured
   confidence bound.
3. `node scripts/tryon-validate-real.mjs --report`, then
   `node scripts/tryon-validate-compare.mjs`. Read the actual numbers and refresh
   this table; never claim within-uncertainty accuracy across incompatible bases.
4. After explicit AR freeze and final source commits: required full gates,
   `npm.cmd run kiosk -- --warm --windowed`; close only its own judge window
   through its operator exit after both passes; wait for its lease to release.
5. `node scripts/demo-day-attract.mjs --label tryon-final-attract`. This fresh
   label avoids foreign old untracked evidence. Review every new screenshot.
6. `node scripts/tryon-validate-rehearse.mjs --freeze-confirmed` after the lead's
   note; it checks actual shader flag, fake-camera CPU scan and live start/Done
   camera stop, plus motion/zip/hood/reset. Fake bars cannot prove real-person
   recording/AR quality. Then `npm.cmd run preflight -- --kiosk`, record the actual
   final board and update judge pack. Keep >=3 GiB during actual judging.
7. Human full-demo timing is still unproven. V3's measured 41.474 s cross-arms
   bake alone exceeds the planned 19 s live slot. Preserve explicit waits or
   present the extended version; do not announce a verified two-minute end-to-end
   run. Historical private-photo cleanup still needs explicit user approval
   before publication; it was not attempted here.

## Saved verification

- Owned readiness/audit/warm/measurement/comparison/exposure tests: **29/29 PASS**.
- Scoped ESLint: PASS. Explicit-file Prettier check: PASS.
- Full current-source typecheck, whole-project test suites and final build were
  not run under the unresolved freeze/browser coordination blocker. No all-green
  repository claim. Foreign dirty files and pre-existing untracked attract
  artifacts are preserved and excluded from our commits.

---

# CX-DAY: real-jacket validation and final GO

## Active, prompt 15b, 2026-11-13

The user's new request resumes CX-DAY after the earlier stop. Read briefing,
AGENTS, shared rules, prompts 14, 14b and 15b, USER-RULES, video index and the
previous handoff. All existing foreign changes, including existing untracked
`demo-day-attract-final*` evidence, are baseline and will not be overwritten or
staged. No application/service/vision/AR changes, dependencies, external traffic,
paid calls, history rewrite or shared-process restart.

T1 first: use verified original 720x1280 one-second frame exports already present
in the gitignored cache. Existing `index.json` records decoded/current time;
the new runner checks requested/current times before reuse. Infer with public
`createPoseTracker`, heavy model, CPU delegate and person segmentation; inspect
private overlays before accepting any edge. Only reviewed aggregate numbers can
be committed. `git check-ignore` confirmed `.cache/cxday-tryon/probe.png` and
`docs/validation/look-cxday-probe.png` before writing derived imagery.

Measurement limitations: a monocular silhouette gives projected displacement,
not 3D surface length. Cuffs outside the frame or with poor landmark visibility
must be missing. A hidden waistband is not zero exposure. Uncertainty includes
neutral/move spread, +/-1 second index sensitivity, pixel sensitivity, and scale
disagreement; plane/depth and pose ambiguity remain explicit limitations.

Prepared runner/math/public-vision browser adapter. Four initial math tests pass.
Capture waits for shared browser slot and RAM >=2.5 GiB; first observation 1.49
GiB with no benchmark ports busy. Nothing foreign is stopped to obtain memory.

T2 waits for V3 `tryon-physics-eval.json` and optional V2
`tryon-ar-eval.json`; neither is invented. T3 final runs require the lead's AR
freeze note/commit. No final GO board is claimed yet.

## Prepared follow-up and first capture failure

The first Chrome attempt acquired the shared slot but produced **no measurements**:
Vite rooted at the repository observed another agent's changing `.cache/v1`
snapshot and repeatedly reloaded; page navigation timed out. Its browser/server
closed and its own lock was released in `finally`. Replaced the development
server with a small loopback HTTP server serving only the measurement bundle,
allowlisted model/WASM assets and scheduled private frames. No repo-wide watcher
or AR source modification. The retry waits behind V3/CX-TRY at the normal RAM
floor; observations include 0.78-2.01 GiB free. No bypass or process termination.

Privately reviewed original contact sheets for both jackets, including paper,
neutral, arms up, cross, seated, forward and bend. Paper scale from frame 20,
using existing `body_service.lookdev.scale.homography`, is approximately 6.782
px/cm vertically near the chest; the full-height crosscheck is about 6.638 px/cm
in that frame. Paper bends and is not proven coplanar with the hem. Puffer's
full-body frame 16 gives about 6.989 px/cm; its later neutral heads are cropped.
These are preliminary scale observations, not accepted movement metrics. Raw
corners, homography, height figures and derived images stay in the private cache.

Prepared `tryon-validate-rehearse.mjs`: final-build own 5793, actual warm flag,
CPU scan inference, real engine startup/Done with fake camera, stopped media
tracks, original zip/hood/motion/reset path, console and network evidence. It
refuses to run before an explicit lead AR-freeze note. It does not grade AR or
claim fake colour bars completed a human recording. The new scan capture hook
in `judgePath` is inert for callers without a callback.

Judge Q&A, submission draft and spoken demo now explain Preview versus Physics,
local capture, validity refusals, missing measurements and the unproven 120 s
end-to-end target. Comparison tool distinguishes descriptive numerical overlap
from a valid accuracy verdict; it never assigns parka physics to puffer and never
reports a failed bake's numbers. Targeted tests **11/11 passed** (8 new measurement/
comparison checks plus 3 existing warm checks); scoped ESLint/Prettier passed.

Preparation-only preflight (not the final board): API privacy PASS, kiosk_mode=true, saved=false, profile=null. NO-GO at 1.94 GiB free RAM; web dist older than active sources; 83 dirty/untracked paths; V3 owns browser slot. No rebuild or final run before AR freeze. V3 physics JSON now exists: recorded overhead reach refused before baking after tracking jump; cross-arms passes sleeve gate and took 41.474 seconds recorded-to-baked in the shared-load snapshot. No two-minute-flow proof.

Final-run preparation now supports a fresh attract evidence label: node scripts/demo-day-attract.mjs --label tryon-final-attract. This preserves the foreign untracked old attract artifacts. The final rehearsal waits for HTTP server shutdown before releasing its lock. CPU/mask thresholds are explicit operator settings, saved with each capture; temporal uncertainty requires accepted +/-1s endpoints for both move and neutral. No image-space uncertainty is a bound on unknown 3D depth or pose-model error. Targeted readiness/math/comparison checks: 21/21 passed.

## First directly visible supplemental observation

Puffer, reach_up_both, 46-50 s: manually reviewed front hem-to-top-of-black-waistband gap (grey underlayer plus skin), five original frames. Computed median 11.7336 cm, observed range 6.0099-12.5921 cm, partial additive sensitivity 5.6349 cm. Complete uncertainty remains UNKNOWN: the +/-1 s endpoints 45/51 hide the waistband, and monocular depth/plane is uncalibrated. Do NOT present this as 11.7 +/-5.6 cm with complete coverage. Raw numbers/method: validation/tryon-real-exposure.json. Original pixel picks, grid images and reference height remain private in .cache/cxday-tryon. This supplemental manual edge measurement does not replace the pending public-vision pose/silhouette T1. Nine measurement/comparison/exposure tests pass; one initial exact floating-point equality failed and was corrected to a 1e-12 numeric tolerance.
