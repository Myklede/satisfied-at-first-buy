# STATUS: try-on AR view (agent V2, prompt 14)

Owner: Claude agent V2. Paths: `apps/web/src/engine/live/ar/**` (except `ar/finish/**`, agent V4),
`apps/web/src/labs/ar/**`, this file and `docs/validation/tryon-ar-eval.json`. Last update:
2026-11-13 night.

## What it is
The left half of "Try it on you": the camera image of the real person with our jacket over them.
It implements `ArRenderer` (`engine/live/contract.ts`), plus `setMirrorDisplay`, `adjustPose`
(V1's screen-fit seam) and `debugState()` (V1's diagnostics, V5's scoreboard). V1's
`LiveTryOnEngine`, the kiosk (CX-TRY) and `/?arlab` all use `ArCompositor`.

**Hybrid (lead/user decision, 2026-11-13).**
- The 3D solve gives the geometry and **every fit number**.
- A 2D image-space "glue" then warps the rendered jacket onto the person's keypoints.
- The view is tagged **"visual overlay · fit numbers from 3D"**.

## Method
1. **Camera solve** (`ar/cameraModel.ts`, `ar/ArTracker.ts`).
   - **Correspondences.** Posed joints (V1 rig bone heads) ↔ MediaPipe landmarks: shoulders,
     elbows, wrists, hips, knees and ankles, plus the eyes at weight 0.3 (a face and scale helper).
     - The shoulder landmark is matched to the rig's posed **acromion** (body vertex nearest the
       asset body's acromion landmark), not the upper-arm joint 4.4 cm below it
       (`SHOULDER_MARK_BLEND`, `ar/anchors.ts`). Matched to the joint, the whole body and the
       collar were drawn several cm too high (agent CH, 2026-11-13). Blend 0.75 joint → acromion,
       measured: face offset −0.4 cm on cam-parka, +0.1 cm on the puffer video; blend 1 bound the
       glue cap on almost every frame.
     - The landmarks are One Euro smoothed before the solve.
     - Only landmarks inside the frame with visibility ≥ 0.5 are used.
   - **Pinhole solve.** Square pixels, centred principal point, no lens distortion.
     - Robust Levenberg–Marquardt over yaw, pitch, roll and translation, with pseudo-Huber loss.
     - A session-learned lateral landmark-spread scale (fast over 45 facing frames, then a 30 s
       EMA) absorbs MediaPipe's shoulder/hip definition. Without it the solver read a ±30° yaw
       with a random sign while the person faced the camera.
     - The yaw prior comes from MediaPipe's world landmarks (σ 20°).
   - **Drawn pose.**
     - Yaw: One Euro at 0.4 Hz, a soft 8–16° deadband, pinned to 0 when 2D evidence says frontal
       (nose centred, shoulder span ≥ 90 % of its recent maximum). It is limited to ±75°, with
       front/back folding and no jump over 25° unless sustained 300 ms.
     - Pitch and roll: smoothed toward a slowly learned camera tilt.
     - Translation: re-solved with the angles pinned. The depth (drawn size) is held by a 0.25 Hz
       One Euro, a 2 % backlash and an outlier gate; solves outside 0.6–6 m are not drawn.
   - **Collar target, per product (only without the glue).** With the glue on, the target is off:
     the glue re-pins the shoulders, so a whole-jacket shift only stretched the hem. The mouth
     guard then acts only when the collar is more than 2 cm over the mouth line, and moves it at
     most 2 cm (torso-joint alignment ≥ 0.65).
     Without the glue: The visible collar top (the asset's `collar_top` path, never
     the hood panel's hidden rim strips) is aimed at a face point: the chin for the parka, the
     lower lip for the funnel-collar puffer (asset path `hood_zip`). Chin = mouth line + 1.4 ×
     nose→mouth (CH, measured on the user); lower lip = + 0.35 × (estimate). A per-session
     vertical offset, clamped to ±5 cm, puts it there; the mouth-line guard is the safety net.
   - **Back view** (`ArTracker.backView`, config `BACK_VIEW`). MediaPipe keeps the face
     "visible" on a person's back, so the cues are:
     - the flipped shoulder order in the image;
     - the nose behind the shoulders in MediaPipe's world landmarks;
     - a raw solve past ±120°.

     It enters on 2 votes, or on 1 vote held for 2 frames, and leaves after 300 ms of frontal
     evidence. A back view is fully faded with the prompt "Turn back toward the camera…"; a front
     jacket is never drawn on a back.
   - **Heading.** `ArCompositor.bodyHeadingDeg` (and `ArTracker.headingDeg`): 0 = facing,
     + = turned to the person's left, ±180 = back. Read-only, for V6's `rootYawDeg`.
   - **Fade.** The overlay fades past 60° of turn, on side views (2D shoulder span < 0.6 of
     frontal) and on back views. A wrong solve is never drawn.
   - **Focal length.** A 75° diagonal-FOV prior. A keyframe estimate replaces it only when well
     constrained (±8 %).
2. **Arm fit** (`ar/screenFit.ts`, through V1's `adjustPose`).
   - Per arm, the corrected elbow and wrist are placed on the landmark rays, at the bone lengths,
     nearest the previous fit (branch continuity).
   - They are converted to contract DOFs with the vision ISB inverse (exact plane, no gimbal
     hold), then two Newton passes on the rig's own FK.
   - There is no smoothing filter (it caused 330–370 ms of lag) and only a 40°/frame spike guard.
3. **Render** (`ar/ArCompositor.ts`).
   - Video background, unchanged (it is not sRGB-encoded twice any more).
   - Posed body as a depth-only occluder: torso, arms and head; no hands or legs
     (`ar/occluder.ts`).
   - The jacket in the kiosk's look (`ar/ArKioskJacket.ts`: the kiosk `GarmentLayer`, Viewer
     lights, key-light shadow, Neutral tone mapping, exposure and white balance matched to the
     video).
4. **Glue** (`ar/warp.ts`, `ar/glue.ts`, `ar/sleeveLayers.ts`).
   - **Layers.** The jacket is split by cloth panels into a torso layer (with hood and hardware)
     and one layer per sleeve. Each renders complete into its own offscreen target.
   - **Torso warp.** Rigid moving least squares on a 24-column grid, with:
     - controls: shoulders and hips (spread-corrected) onto their landmarks, holding their size
       with a 1.5 % backlash;
     - **contour fit** (`ar/contour.ts`, default on). On 5 rows from the shoulders down to the
       hips, the 3D body's torso silhouette is registered to the person mask's edge, and the jacket
       keeps its 3D ease outside it. Arm-adjacent sides are skipped; each row has a 1.5 px backlash
       hold and a 40 px cap. The hem below the hips and the hood are never driven. Outline error
       before → after: cam-tshirt 8.3 → 1.1 px, cam-parka 16.6 → 1.6 px, puffer 28.3 → 4.7 px,
       at 0.3–0.6 ms. It replaces the coverage step below, which runs only with it off;
     - silhouette coverage at the chest and waist rows, from the jacket's torso panels only, with
       the person's edge walk stopped at the shoulder landmarks' span, so a hanging arm is not
       torso (`glueGroups.coverTorso`, `coverClamp`; they took the cap from 55/56 bound frames to
       12/54 on cam-parka facing);
     - the 3D hem and the frame border as anchors;
     - a ±15 % local scale cap.
   - **Sleeve warps.** Rigid MLS without a scale cap: the shoulder is anchored where the torso
     warp put it, and the elbow and wrist go onto their landmarks.
   - **Finish.** The finisher seam (`ArFinisher`, agent V4) composites coverage, cuffs, feather,
     shadow and grain. It is wired but **off by default** (`useFinisher`; it cost ~110 ms/frame
     here) until V4 measures it under 4 ms/frame; `?finish=1` opts in. Without it, the glue
     composites itself.
   - **Hands.** Real hands are drawn over the cuffs by default (V4's finisher when present).

## How to run
- **Lab.** `cd apps/web && npx vite --port 5765`, then open
  `http://127.0.0.1:5765/?arlab&jacket=FB7675&size=S&h=<cm>&w=<kg>`.
  - Add `&source=camera` for the live camera, `&nomirror` for AR only, `&mirror=0` for an
    unflipped display.
  - `window.__arlab` exposes `sample()`, `seek()`, `evaluateAt()` and `stillness()`.
- **Evaluation, numbers only.** `node apps/web/src/labs/ar/eval/run-ar-eval.mjs --port 5765`
  takes the browser lock. The independent scoreboard is V5's `scripts/ar-eval.mjs`
  (`docs/STATUS-ar-eval.md`).
- **Tests.** `cd apps/web && npx vitest run src/engine/live/ar src/labs/ar`, plus
  `packages/vision/src/poseTracker.test.ts`.

## Results
These were measured in `/?arlab` on the user's videos (2026-11-13), with the finisher off (it
changes the look only). The raw numbers are in `.cache/v2/` (gitignored, numbers only); the per-move
eval is in `docs/validation/tryon-ar-eval.json`. Clips: kiosk camera `cam-tshirt`, `cam-parka`
(1280×720, about 22–26 fps here) and the phone video `video-puffer`.

**Registration** (facing windows):

| | cam-parka 1.5–3 s | cam-tshirt 1–3 s | puffer 4–6 / 15–17 s |
|---|---|---|---|
| facing yaw | 0.0 ± 0.0° | 0.0 ± 0.1° | 0.0 ± 0.0° |
| alignment score (all joints) | 0.76–0.80 | 0.53–0.61 | 0.37–0.40 (arms) |
| face offset, rig eyes vs real | +1.1…+1.7 cm | −8…−11 cm (eye-spacing units; ≈ −5 cm body scale) | +0.3 / +3.3 cm |
| collar top vs target | −0.4…+0.4 cm vs chin | −8 cm vs chin (at the mouth line) | −1.1 / −2.1 cm vs lower lip |

- The T-shirt clip's face offset (−9.5 eye-spacing cm, about −5 cm body scale) is still
  unexplained. Ruled out:
  - clothing bias: the shoulder landmark sits 3.3 cm under the silhouette top, as on the other
    clips;
  - head pitch: MediaPipe's nose sits 0.8 cm under the ear line, against 2.0–2.6 cm;
  - a forward head: the B1 calibration measures a forward-head angle of −0.9° vs the rig, against
    −15…+4° on the upright clips.

  Left: the solved camera pitch (19° against 3–7°), probably absorbing a trunk lean toward the
  laptop. B1 (forward-head flexion of the eye anchors) is built and calibrated (offset −4.2°) but
  OFF. It did not help: with it on, the puffer's shoulder error rose 8.0 → 13.8 px and 16.8 → 21.2
  px, while cam-parka was unchanged (yaw 0.0°, alignment 0.74 → 0.80). The demo camera setup
  (chest to eye height, 1.5–2 m) avoids it.
- The shoulder blend A/B, collar target on/off, and back-view and yaw-lag traces are summarised in
  the method above.

**Glue** (hybrid overlay):
- Post-glue keypoint residual: cam-parka 0.0–0.5 px, cam-tshirt 0.0–1.0 px, puffer 1.9–3.7 px.
- The elbows, wrists and sleeve shoulders reach their targets exactly (0 px; sleeve layers).
- **Contour fit**, outline error before → after the warp:

  | clip | before | after |
  |---|---|---|
  | cam-tshirt | 8.3 ± 2.4 px | 1.1 ± 0.3 px |
  | cam-parka | 16.6 px | 1.6 px |
  | puffer | 28.3 px | 4.7 px |

  It costs 0.3–0.6 ms (1.3 ms max).
- Torso scale cap: bound on 55/56 frames before the coverage fix and 12/54 after (cam-parka). The
  puffer still binds on most frames.
- Warp time 0.5–2.4 ms. Outline step 2.3–4 px/frame at ~24 fps (the target is < 1.5; the person's
  own sway is included).

**Arms:**
- The 3D arm fit alone takes elbow + wrist error from 66–74 px to 13–40 px. The glue's sleeve layers
  then pin them.
- Arm-target lag behind the raw landmarks on moving frames: 5–15 ms.
- Per-frame arm DOF steps at ~24 fps (cam-parka facing): elevation p50/p90 0.5–0.7 / 3.1–3.5°,
  elbow 0.6–0.8 / 3.5–5.0°.

**Turning and back view (cam-parka trace):**
- The drawn yaw follows a turn without lag: at 3.18 s the drawn yaw is −24° (raw −31°, MediaPipe
  −24°), where before the fix it lagged ~0.7 s.
- Back view is detected at 6.8 s and 9.6–11.4 s, and held through MediaPipe's hallucinated frontal
  frames (7.26–7.39 s and 9.90 s). No front jacket is drawn on a back.
- cam-tshirt's facing close-up with the head cut off (10.6–12.8 s, V4's false back at 12.5 s) is
  never called a back view now. One-frame span glitches are smoothed by a 120 ms fade.

**Steadiness:**
- Drawn size step p95: 0–0.26 % on the puffer and cam-parka facing; 1.2 % on cam-tshirt 1–3 s, right
  after load (the target is < 0.5 %).
- Video luma matches the raw video (Δ 0.62 levels).

**Per move, phone videos** (`docs/validation/tryon-ar-eval.json`, run 2026-11-14 01:11 UTC). The
offsets are the DISPLAYED (glued) overlay vs the real jacket mask, as medians, signed ours − real:
shoulder + = ours lower, sleeve + = ours sticks out, cuff + = ours longer, hem + = ours lower. The
alignment column is the 3D solve's (pre-glue) score.

| video | move | tracked | alignment | shoulders L/R cm | sleeves L/R cm | cuffs L/R cm | hem cm |
|---|---|---|---|---|---|---|---|
| parka | neutral | 6/6 | 0.74 | -2.7 / -1.7 | -0.5 / +0.2 | +17.7 / +20.6 | +36.2 |
| parka | turn | 5/5 | 0.59 | +0.0 / +0.0 | -0.3 / -1.3 | +7.4 / -3.1 | +0.3 |
| parka | reach up both | 4/4 | 0.57 | +4.9 / -1.0 | +4.1 / +2.9 | -11.3 / +9.0 | +9.4 |
| parka | reach up one | 3/3 | 0.29 | +2.8 / +2.2 | +1.0 / +1.5 | -3.8 / +26.8 | +9.2 |
| parka | cross arms | 2/2 | 0.08 | -4.0 / -3.1 | +1.7 / +1.9 | +12.2 / +32.8 | +44.3 |
| parka | sit | 3/3 | 0.72 | -2.1 / +0.5 | -1.5 / +0.2 | +10.1 / +2.7 | +19.5 |
| parka | bend | 1/2 | 0.75 | -4.2 / -5.6 | – / – | – / – | -4.5 |
| parka | reach forward | 2/4 | 0 | – / +0.0 | – / -0.5 | – / – | +47.5 |
| puffer | neutral | 6/6 | 0.62 | -10.7 / -4.2 | +1.4 / +2.0 | +26.5 / +22.2 | +13.2 |
| puffer | turn | 3/5 | 0.33 | +2.2 / +0.0 | +0.1 / -1.1 | +0.5 / +37.8 | +29.5 |
| puffer | reach up both | 1/4 | 0 | +4.6 / -6.2 | +10.4 / +5.2 | +8.4 / +0.4 | +11.5 |
| puffer | reach up one | 4/4 | 0.3 | +1.0 / -8.0 | +1.7 / +1.6 | +0.1 / +0.0 | +3.5 |
| puffer | cross arms | 3/3 | 0 | -2.1 / +2.1 | +1.8 / +0.2 | +38.1 / +0.0 | +32.3 |
| puffer | sit | 3/3 | 0.64 | -11.8 / -9.6 | +0.2 / +1.4 | +7.7 / +17.2 | +19.7 |
| puffer | bend | 0/2 | – | – / – | – / – | – / – | – |
| puffer | reach forward | 2/4 | 0 | +13.8 / +22.5 | +0.9 / – | – / – | -3.0 |

- Shoulders and sleeves land within about ±3 cm on most moves.
- The cuffs and hem read long: the real-jacket mask is chest colour ∩ person, so it loses the real
  cuffs and hem against the background and the hands. Treat these as upper bounds.
- The puffer pass overlapped CH's 8001 restart (v30). A rerun on one asset version is pending.
- The cam clips' play-through alignment medians are 0.48 (cam-parka) and 0 (cam-tshirt). They are
  sampled every 0.5 s across the whole clip, including the turns, back views and the close-up.

**Speed** (finisher off, this laptop): AR render 6–11 ms, solve 0.5–1.2 ms, 14–26 fps (MediaPipe
bound, and lower while other agents' jobs ran).

## Known gaps
- **Collar height.** With registration from the body (the shoulder → acromion blend 0.75), the
  parka collar lands within ±0.4 cm of the chin on cam-parka. The puffer funnel lands 1–3 cm above
  the lower lip on the current asset (CH's v30). On the T-shirt clip the collar reaches the mouth
  line: the user hunches toward a low laptop camera (see Results). The demo camera setup is chest
  to eye height at 1.5–2 m. A neck DOF in the shared rig (B2) is left for later.
- **Body proportions.** The body comes from height and weight. A camera body scan (V1) should fix
  neck, shoulder width and arm length. The solve is compatible: correspondences come from the
  posed rig, whatever its proportions.
- **Arms out of the picture.** A sleeve can only follow an arm whose elbow or wrist landmark is
  inside the frame. On screen: "Keep your hands in the picture: step back a little".
- **Turning.** The overlay fades past 60° of turn, on side views and on back views; a back view
  shows "Turn back toward the camera to see the jacket on you". The kiosk shows the front.
- **Forward-head flexion (B1)** is built but off: it would correct only the AR's eye anchors, and the
  measured head angle did not explain the T-shirt clip's offset. The mirror avatar and recorded
  physics keep an upright neck (the neck is not a skinning driver).
- **No lens distortion model.** The focal length is the 75° diagonal prior. The overlay is
  insensitive to it to first order (weak perspective).
- **Look and finishing are V4's** (`ar/finish/**`): coverage over the real clothes, dark closed
  cuffs, feather, contact shadow, grain. The glue's own contact shadow is off.
- **Visual overlay.** The glue moves pixels to the person; fit numbers come only from the 3D,
  never from the warp.
