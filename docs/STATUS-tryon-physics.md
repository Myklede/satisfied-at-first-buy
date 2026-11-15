# STATUS: "Record a move", true cloth physics on a recorded move (agent V3, prompt 14)

Owner: V3. Paths: `apps/web/src/engine/live/record/**`, `services/body/body_service/motion/**` (+ its
tests), the custom-motion source in `apps/web/src/engine/motion/**`. Evidence (numbers only):
`docs/validation/tryon-physics-eval.json`.

## What exists
1. **Endpoint** `POST /motion/{body_id}/custom/frames.bin` (`motion/custom.py`, `FORMAT.md`).
   - Request `{fps, poses: [{t, pose}]}`: `t` in seconds from 0; `pose` is a partial `AnatomicalPose`,
     and a DOF left out takes the body's neutral value, exactly like an unlisted DOF in a preset
     keyframe.
   - The samples become the keyframes of a `Motion` and go through the preset path unchanged:
     `resolve` → `sample` (smoothstep) → `pose_skeleton` (same rig, clamping, trunk solve, pelvis
     drop, foot planting) at 30 fps.
   - Validation (StrictModel): ≤ 8 s, fps 1–60, DOFs inside `LIMITS_DEG`, finite numbers, no unknown
     fields or DOFs. The 422 lists `loc`/`msg`/`type` and never echoes the poses; JSON NaN gives a
     422, not a 500.
   - Privacy: poses are never logged or cached; `forget_motion_body` drops the body (nothing of a
     recording is kept).
   - Neutral lead-in / lead-out when a recording does not start / end at neutral. Length:
     max(0.8 s, largest angle change / 110 deg/s), the presets' validated ramp speed (see "Bug").
2. **Client** `engine/live/record/`:
   - `recordedPoses(frames)`: LiveFrame stream → poses + trace. A DOF estimated in < 80 % of the
     tracked frames, or missing > 200 ms, is held at the body's neutral for the whole move and named
     in `trace.message`. No extra smoothing: `LiveFrame.pose` is already One Euro filtered. True
     pose, no mirror. Throws `RecordingError` when the person is lost > 200 ms.
   - `RecordMoveBaker` (`createMoveBaker`): posts the poses, bakes the frames with the existing
     MotionClient worker → `bake.ts` → WebAssembly kernels. Progress = solver steps done / to do.
     Cancellable. `warm()` preloads the data and relaxes the cloth.
   - `RecordedBakedMove`: `applyFrame` drives V1's `LiveAvatar` (`setDrivers` with the bone world
     poses rebuilt from the drivers, then `setJacketPositions` with the simulated cloth).
     `readouts(i)`: exposure (mid waistband, front / back / sides) and sleeve ride-up with the
     `metrics.ts` formulas; zones with basis `physics` (static ease − simulated tape stretch;
     `tight` when the fabric is at its stretch limit).
   - **Sanity gate** (`sleeves`): a cuff that rode up, or sits away from its wrist, by more than
     the body's own forearm length means the sleeve came off the arm. `bake()` then rejects with
     `PhysicsInvalidError` and a one-line reason; no impossible number reaches the screen.
   - **Step subdivision** (`subdivision.ts`): a move whose wrist / elbow travels more than the
     measured 3.5 cm per solver step is baked at dt / k (k ≤ 4), through a per-bake worker
     override. Presets never send it. Evidence at k = 1:
     - the sleeves stay on at 3.04 (presets), 3.1 (the user's cross arms), 3.37 and 3.50 cm;
     - a sleeve is lost at 3.70 and 3.90 cm; at k = 2 both of those keep it.
3. **Tools** (`record/tools/`, outputs only to the gitignored `.cache/v3/`):
   - `videoEval.mjs`: the user's video in Chrome under the browser lock → pose tracking → bake →
     numbers and avatar-only renders.
   - `bakeNode.mjs`: the same bake in Node, for synthetic or recorded poses.
   - `writeEvidence.mjs`: the committed numbers-only evidence.

## Parity: presets unchanged, and the custom path is the preset path
- `tests/test_motion_custom.py`: for all 6 presets, a custom request built from the preset's own
  keyframes returns the same frames bit for bit. Every blob byte is identical; the whole file equals
  the preset's with only the header's `motion` descriptor swapped (id `custom`).
- Preset `frames.bin` sha256 before and after the refactor: identical, 12 of 12 (6 presets × 2 bodies).
- Preset bakes after all of V3's commits (`tools/presetChecks.mjs`, under the browser lock):
  - `scripts/motion-validate.mjs`: 12 of 12 (6 presets × S and M) identical to the stored run `e5-final`, across every hash (positions, strain, exposure, metrics, summary, checks);
  - `bakeCheck.mjs`: JS and WebAssembly identical (reach_up_both and cross_arms, S, 60 frames).
- `bake.ts`, the cloth and collider kernels and `BakeQueue` were not changed. The worker and
  MotionClient changes add a custom path only; a preset's worker message is unchanged
  (`MotionClient.custom.test.ts`).

## Bug found by V1 and fixed: a bare raised arm, "sleeve ride-up 84.9 cm"
Measured with `tools/bakeNode.mjs` on the user's body, parka S, hoodie layer:
- Cause: a limb faster than any preset. The presets peak at 1.1–1.8 m/s at the wrist, at most
  3.04 cm per solver step (reach_up_one). Faster, the cloth loses the sleeve.
- V1 started recording at 47 s with the arms already overhead. The fixed 0.8 s lead-in then raised
  them from 27° to about 165° at 2.5 m/s, and the sleeve was lost 0.7 s in, before the recorded
  window.
- Fixes:
  - the lead-in speed limit (server);
  - subdivision (client): arms up then a 1.3 s lowering lost the sleeve at k = 1 and kept it at
    k = 2, with 10.9 cm ride-up;
  - the gate (client).
- Very fast synthetic raises (5.5 m/s) still lose the sleeve at k = 3. The gate reports that
  honestly instead of showing numbers.

## Real test on the user's own video (2026-11-13, numbers in `docs/validation/tryon-physics-eval.json`)
Setup:
- The video is the parka phone video, tracked in Chrome by the live pipeline (MediaPipe "full", GPU, about 29 Hz inference, One Euro filter, neutral calibration on a front stand frame).
- The body is the user's own (figures in the gitignored `toi.txt`); the garment is the parka FB7675-100 in the size he wears, with the hoodie under-layer preset.
- 8001 ran garment asset `realism-wrap-v29-ch-neck`, which includes CH's uncommitted collar work (neck and chin only).

| Move | Video window | Result |
| --- | --- | --- |
| Reach up both | 47–52 s | **Refused before baking.** MediaPipe lost the left arm overhead: it read 128° → 23° in 0.1 s and back, at up to 4,119°/s. The right arm and both elbows were tracked in only 57–72 % of frames. Before the plausibility gate, this bake ran 88 s and the sleeve gate rejected it ("left sleeve came off the arm"). |
| Reach up both (final) | 212.5–217.5 s | **Refused before baking.** The left arm was lost overhead again (3,750°/s at 2.3 s). |
| Cross arms | 65.5–69.5 s | Every DOF tracked; peak joint speed 349°/s. Sleeves stay on: ride-up L 13.0 / R 10.2 cm (k = 2), or L 15.9 / R 8.4 cm (k = 1). Hem rise 5.0 cm (front), 7.1 cm (sides); exposure 0. This fits the video qualitatively (sleeves bunch at the elbow, zip line straight); the video gives no numbers. |

**Hem rise against the video.** The user's reach-up cannot be tracked, so the same move as the preset `reach_up_both` was baked on his body:
- the hem rises 5.2 cm at the front, 6.9 cm at the back and 9.6 cm at the sides;
- it ends 20.6 / 18.8 / 16.2 cm **below** the hip line, with exposure 0;
- the video shows the hem riding up to about hip height. Measured by eye on the local frames (31 s vs 48 s, relative only, ± 3 cm), **the hem rises about 23 cm and the collar about 9 cm**: the whole coat is lifted;
- **the simulation under-predicts the hem rise by about 13–18 cm. It does not match.**

Also, the simulated parka's neutral hem sits 25.8 cm below the hip line, while the video shows it "just over the knees". That is garment geometry, routed to CH.

**Browser parity.** `reach_up_both` baked as the preset and as a custom request built from its keyframes, both through the MotionClient worker:
- identical digest (`ed5fe020…`);
- byte-identical frame blobs.

**Bake time** (cross arms, 4 s window, warmed, on this laptop with 1.9 GiB free RAM and other agents running): 41.5 s in total.
- 1.3 s for the custom frames on the server.
- 0.3 s of relax (cached copy).
- 39.8 s of motion: 145 frames × 4 steps (k = 2) = 576 steps at 69 ms each.
- k = 2 because the wrist peaked at 1.87 m/s, 3.1 cm per step, exactly the old limit.

Plan approved by the lead to stay ≤ 20 s:
- a 3 s window;
- a minimum lead-in of 0.5 s (server; ships with a later restart);
- a step limit of 3.5 cm (to be evidenced);
- the honest step-count progress bar;
- "about 30 s" shown for faster moves.

Estimate: (15 + 90 frames) × 2 steps × 45–69 ms ≈ 10–15 s.

## Known gaps
- The phone video's reach-up windows cannot be tracked overhead, so no recorded reach-up has a physics bake yet. Retest with `cam-parka.mp4` (the kiosk's Integrated Camera) or live.
- The hem lift under-predicts the video by about 16–21 cm on reach_up_both. The armhole stop that lifts it fails the penetration and strain gates (below), so it stays OFF.
- Very fast moves (wrist ≥ about 4.5 m/s) lose the sleeve even at k = 3. The gate refuses them honestly.

## Hem lift: why the simulated coat does not ride up (investigation, lead's request)
- **Real (video, by eye, relative):** the hem rises about 23 cm and the collar about 9 cm (it reaches the nose). The raised arms lift the whole coat.
- **Simulated:** `reach_up_both` on the same body, parka S, hoodie layer, mean over the hold. 20 solver variants (`tools/hemExperiments.mjs`; all numbers in `docs/validation/tryon-physics-eval.json` → `hemLift`):

| Variant | Hem rise F / B / S (cm) | Yoke lift (cm) | Max strain (zone) |
| --- | --- | --- | --- |
| baseline | 4.7 / 6.2 / 9.3 | +1.0 | 1.39 (armpit) |
| roots unanchored (`rootCompliance` 0) | 7.5 / 9.3 / 11.1 | +1.5 | 1.37 |
| lift-free off (control) | 1.0 / 2.3 / 3.7 | +0.1 | 1.45 |
| hard contact | 7.3 / 6.4 / 8.9 | +1.3 | 1.99 |
| friction 1 + hard contact + roots free | 9.5 / 8.3 / 9.2 | +1.4 | 2.11 |
| 64 final strain passes | 4.8 / 5.3 / 8.1 | +1.1 | 0.71 (armpit) |
| 20 substeps | 5.0 / 5.9 / 8.2 | +1.0 | 0.63 (sleeves) |
| roots bound to arm skin (`rootArmWeightMax` 0.5–1) | 4.3–4.5 / 5.4–6.0 / 8.0–9.2 | +0.9–1.0 | 1.38–1.40 |
| two-way tethers | 6.1 / 8.8 / 9.5 | +2.6 | 1.60 (armpit) |

Findings:
- **No anchoring, contact, friction, convergence or tether change gets the yoke above +2.6 cm or the hem above about 10 cm.** Every variant keeps the sleeves on, with the cuffs sliding 10–12 cm down the forearm.
- The arm's lift goes into stretching the armpit fabric (26–110 % on a 3 %-stretch weave), or into the sleeve sliding along the arm. It is never carried up to the coat's shoulders, which is what the video shows.
- Enforcing the fabric limit harder lowers the strain but not the rise.
- **Root cause, as far as the experiments show:** the cloth model has no way for the raised upper arm to carry the coat through the armhole. The coat hangs from the neck and shoulder roots on one-way tethers; the arm only pushes the underarm fabric locally.

Proposed fix (not done; needs a new `ClothSolver` constraint in `engine/cloth`, outside V3's paths):
- an **armhole stop**, like the existing hand stop: the sleeve's underarm seam cannot slide below the armpit point of the upper arm's skin;
- so the raised humerus lifts the armhole ring, and with it the coat;
- validate it against this table and the video: about 23 cm hem and about 9 cm collar on reach_up_both; cross-arms ride-up; sit and bend from `docs/look/video-index.md`.

**Presets are unchanged:** no physics default was changed.

## Armhole stop (lead-assigned; `engine/cloth/armholeStop.ts`, `engine/motion/armhole.ts`) — OFF by default
**Constraint.** Each underarm seam particle keeps (p − A)·u ≥ its rest offset:
- A is its rest point carried by the upper-arm skin; u is the humerus axis;
- it is a no-op at rest and while the arm hangs;
- it is bound after the relax, so frame 0 is unchanged;
- it is applied after the hand stop in JS on the shared positions, so JS and WebAssembly stay identical (checked with it on and off).

Gate: `MOTION_FIT.armholeStop.enabled` = 0.

Round 1, `reach_up_both`, the user's body, parka S; hold mean:

| Variant | Hem rise F / B / S (cm) | Yoke (cm) | Max strain | Max penetration / share |
| --- | --- | --- | --- | --- |
| off | 4.7 / 6.2 / 9.3 | +1.0 | 1.39 | 1.0 cm / 0.11 % |
| hard stop | 18.8 / 20.6 / 19.8 | +0.7 | 2.72 | 4.0 cm / 1.08 % |
| compliant 0.3, toward the anchor | 16.8 / 18.8 / 18.0 | +1.2 | 1.80 | 3.1 cm / 0.96 % |
| the same + hard contact | 17.9 / 19.2 / 18.3 | +1.3 | 2.30 | 1.8 cm / 0.06 % |
| the same + 32 strain passes | 16.8 / 18.3 / 17.2 | +1.1 | 1.73 | 1.4 cm / 0.08 % (bake +15 %) |

Findings:
- The hem moves toward the video's ≈ 23 cm.
- The strain gate fails: the lift enters at the underarm seam.
- The yoke and collar do not rise.

Round 2 (in progress):
- long-range attachments from the stop points (Kim et al. 2012) to spread the lift;
- unanchored, one-sided roots.

`sit`: sleeves on with it off and on; strain 0.113 → 0.131.

### Armhole stop round 2–4 (2026-11-13 evening; `reach_up_both`, the user's body, parka S, hold mean)
Base for every row: stop compliant 0.3, toward the anchor. Each row adds the listed change.

| Variant | Hem rise F / B / S (ring) cm | Collar | Max strain (zone) | Penetration max / share | Rest hem vs hip | Bake |
| --- | --- | --- | --- | --- | --- | --- |
| off | 4.7 / 6.2 / 9.3 (6.7) | +0.1 | 1.39 (armpit) | 1.0 cm / 0.11 % | −25.8 | 17.6 s |
| (stop only) | 16.8 / 18.8 / 18.0 (18.0) | 0 | 1.80 | 3.1 / 0.96 % | −25.8 | 18.5 s |
| + Euclidean LRA (Kim 2012) | 20.6 / 26.7 / 23.4 (23.7) | 0 | **4.37 (back)** | 6.0 / 1.78 % | | 18.5 s |
| + Euclidean LRA + one-sided roots | 24.4 / 31.3 / 25.8 (27.0) | +0.3 | 4.09 (back) | 6.0 / 1.94 % | | 20.8 s |
| + **vertical** LRA | 17.7 / 19.9 / 18.9 (19.0) | 0 | 1.79 (armpit) | 3.1 / 0.97 % | −25.8 | 19.1 s |
| + vertical LRA + one-sided roots | 21.2 / 23.7 / 20.7 (21.7) | +0.1 | 1.85 | 3.6 / 0.97 % | **−28.4** | 17.2 s |
| + vertical LRA + hard contact | 19.2 / 20.6 / 19.6 (19.8) | 0 | 2.30 | 1.9 / 0.09 % | −25.8 | 17.6 s |
| + whole armhole ring + vertical LRA + one-sided roots | 21.2 / 23.7 / 20.7 (21.7) | +0.2 | 2.00 | 3.3 / 0.98 % | | 19.6 s |

Findings:
- **Euclidean LRA** pulls the back panel straight toward the underarm point, through the torso (4.4 cm deep, strain 4.4).
- **The vertical bound** removes that: the hem rise reaches 19–22 cm (video 23 ± 3) with no back-panel artefact.
- **One-sided roots** (`rootCompliance` 0) let the coat sag 2–2.6 cm at rest, which fails the rest-pose gate.
- **No variant moves the collar** (real ≈ +9 cm). Extending the stop to the whole armhole ring changes nothing.
- **The strain gate fails in every lifting variant** (1.79–2.30 against 1.39, at the underarm).

**Decision: `MOTION_FIT.armholeStop` stays OFF.** The candidate, if the gates are relaxed: stop 0.3 toward the anchor + vertical LRA, which keeps the rest pose exactly and costs +8.5 % bake time.

### Gate sweep, all six presets (2026-11-13, 19:22–19:33; numbers in `docs/validation/tryon-physics-eval.json` → `armholeGate`)
Candidate: stop 0.3 toward the anchor + vertical LRA. The user's body, parka S, mid-hold frame. Penetration = particles more than 5 mm inside the body.

| Preset | Penetration off → cand | Share of particle-frames | >10 % strain, underarm (of all edges) | >10 % strain, outside | p99 outside the underarm | Hem rise F (cm) | Bake |
| --- | --- | --- | --- | --- | --- | --- | --- |
| reach_up_both | 5 → **133** | 0.11 → 0.97 % | 0.03 → 0.19 % | 0.28 → 0.48 % | 0.051 → 0.086 | 4.7 → 17.7 | 26.1 → 26.4 s |
| cross_arms | 3 → **44** | 0.08 → 0.26 % | 0.00 → 0.01 % | 0.47 → 0.52 % | 0.049 → 0.073 | 3.7 → 2.8 | 16.9 → 17.2 s |
| sit | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0.035 → 0.035 | 14 → 14 | 22.1 → 22.9 s |
| bend_tie_shoes | 42 → **191** | 0.24 → 0.97 % | 0.15 → 0.41 % | 0.20 → **0.88 %** | 0.052 → 0.091 | 14 → 15.2 | 38.2 → 37.5 s |
| reach_forward | 8 → **122** | 0.04 → 0.62 % | 0.06 → 0.19 % | 0.03 → **0.60 %** | 0.045 → 0.066 | 4.4 → 3.5 | 16.9 → 21.3 s |
| reach_up_one | 3 → **54** | 0.03 → 0.28 % | 0.01 → 0.19 % | 0.15 → 0.30 % | 0.044 → 0.065 | 4.6 → 17.7 | 23.7 → 19.6 s |

Passes:
- sleeves on in every preset;
- rest pose unchanged (0 cm);
- frames.bin untouched (client-side constraint);
- p99 outside the underarm worse by at most 0.039 (limit 0.05).

Fails:
- **Penetration.** The coat sinks into the body at the back and the armpit on 5 of 6 presets, with 4.5–27 times as many particles as today. That is the "skin through the coat" defect V7's renders showed.
- **Strain is not confined to the underarm.** On bend_tie_shoes and reach_forward most of the added >10 % edges are outside it.
- Bake times swing by −17 % to +26 % with machine load, so no conclusion on time.

Hard contact (`contactCompliance` 0) with the candidate, reach_up_both only:
- it removes the penetration (17 particles, 0.09 %);
- but it stretches the whole coat: p99 outside the underarm goes from 0.051 to 0.140 (hard contact alone gives 0.121), and 2.0 % of edges outside the underarm exceed 10 %.
- This also fails, so the other five presets were not run.

**Decision: `MOTION_FIT.armholeStop` stays OFF** (the agreed gates fail). The hem lift stays a known gap: 4–9 cm simulated against about 23 cm in the video on reach_up_both.

Visual check (3-view render of the mid-hold frame, avatar only, in the gitignored `.cache/v3/renders/gate3-before-after.png`):
- **Off:** reach_up_both already shows skin at both shoulder blades below the hood, plus a gap at the armpit in the side view. cross_arms is covered.
- **Candidate:** the reach_up_both back exposure grows into a band across the upper back. cross_arms gets two large holes at the shoulder blades.
- The candidate makes the back defect worse, which confirms the penetration counts.
