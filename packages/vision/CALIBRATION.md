# Body-scan calibration protocol

The webcam scan measures a 2D silhouette: a front width and a side depth per height
level, an ellipse girth, a shoulder "corner" and a 2D arm polyline. These raw values have
unknown bias for a real body, a real camera and real clothing. Calibration fits, per
measurement,

```
value = a · raw + b        σ² = sigma_cm² + (sigma_rel · value)² + (a · scan_spread)²
```

against tape readings. Until real pairs exist, the committed
`calibration/current.json` is the explicit **`uncalibrated`** set (a = 1, b = 0; σ from
the literature/heuristic constants in `src/calibration.ts`). Every scan result lists this
in its `warnings`.

Nothing in this package has been checked against a real person yet. The unit tests use
synthetic shapes only.

## Privacy

- Pair files contain body measurements. They live only in
  `packages/vision/calibration/pairs/` (gitignored) and are never committed or uploaded.
- Use an anonymous id (`p01`, `p02`, …). Never use a name in the id or the filename.
- The scan never saves frames. The lab's **Download calibration pair** button saves only
  numbers, and only when you press it.
- Commit only the fitted `calibration/current.json` (coefficients, no personal values).

## What to wear and prepare

- Thin, fitted T-shirt and fitted leggings or cycling shorts in a colour that contrasts with
  the background. No jacket, hoodie, or loose shirt (loose clothing is not detected
  automatically and inflates chest, waist and hip).
- Barefoot or thin socks, because the stature you type in is barefoot stature and the scale
  comes from crown to floor. Shoes add their sole thickness and bias every value.
- Hair tied up above the shoulders. Hair on the shoulders hides the shoulder corner.
- Empty pockets. No bag, lanyard or belt.
- Tools: flexible tape measure, washable skin marker, a helper, and a wall for stature.

## Camera setup

|                          | Portrait phone (DroidCam, rotate 90°/270°) | Landscape laptop webcam |
| ------------------------ | ------------------------------------------ | ----------------------- |
| Distance, camera to body | ~1.5 m                                     | ~2.5 m                  |
| Lens height              | ~1.0 m, level (not tilted)                 | ~1.0 m, level           |

- The whole body, head to feet, must be visible with a small margin. The lab warns
  `too_close` above 95 % of frame height and `too_far` below 60 %.
- Stand centred in the image (lens distortion is worst at the edges).
- Use a plain background, even light from the front, and only one person in view.
- Keep the same camera, distance and height for every scan in a session, and note them.

## Scan procedure (lab page)

1. `npm run dev -w packages/vision`, then open http://127.0.0.1:5711/scan.html.
2. Choose the camera and rotation, then press **Open camera**. Enter the barefoot stature
   (measured against a wall, to 0.5 cm) and sex. Keep model `pose heavy` unless it is too
   slow; record which model you used.
3. Press **Start scan**.
   - **Front:** face the camera, feet about hip-width apart, arms straight and about 30°
     away from the body (hands clear of the hips, not raised to shoulder height). Look
     ahead. Hold still until the bar fills (2 s of good frames).
   - **Side:** turn 90° so your left side faces the camera. Arms relaxed straight down along
     the body, not swinging forward. Hold still until done.
4. Check the result table and the warnings. Enter the anonymous person id and press
   **Download calibration pair**.
5. Step out of the frame and back in. Repeat for **3 scans per person**. Each download is
   one pair file. Do not average them yourself.

## Tape readings (must match docs/MEASUREMENTS.md)

Take tape readings on the skin, or under the T-shirt, so they are body measurements. The
calibration then absorbs the clothing offset for this kind of fitted clothing. Take each
reading 2–3 times and enter the median. Mark the acromia first.

| Pair field          | How to measure (definition from docs/MEASUREMENTS.md)                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shoulder_width_cm` | Helper palpates each **acromion**: follow the spine of the shoulder blade outward to its bony lateral tip, then mark it. Measure the **straight** distance between the two marks (calliper, or a tape held straight across the back). Do not follow the back curve. |
| `chest_cm`          | Horizontal tape around the fullest chest or bust, below the armpits. Breathe normally.                                                                                                                                                                              |
| `waist_cm`          | Narrowest torso between the lower ribs and the iliac crest. Keep the tape horizontal.                                                                                                                                                                               |
| `hip_cm`            | Fullest buttock or hip circumference. Keep the tape horizontal.                                                                                                                                                                                                     |
| `arm_length_cm`     | Arm in the scan A-pose, elbow almost straight: acromion mark → elbow point → wrist crease, as two segments added together. The scan uses the mean of both arms, so measure both and enter the mean. Record left and right in `notes`.                               |

Open the downloaded pair file. Replace each `null` in `"tape"` with your reading in
centimetres. Leave `null` for anything you did not measure, and never enter 0. Add
clothing, posture and setup details to `"notes"`. Save the file to
`packages/vision/calibration/pairs/`.

## Fit

```
node packages/vision/scripts/fit-calibration.mjs --dry-run   # inspect
node packages/vision/scripts/fit-calibration.mjs             # writes calibration/current.json
```

- **Fewer than 5 distinct people:** only the offset `b` is fitted, with `a = 1`. A slope
  from one or two bodies is not identifiable: every scan of one person sits at almost the
  same raw value, so the slope would only fit noise. The literature/heuristic σ is kept,
  because a few people cannot show how the error changes across body sizes. The residual
  SD (mostly scan repeatability) is added in quadrature.
- **5 or more people:** ordinary least squares fits `a` and `b`, and σ = √(SSR/(n−2)).
- The printed `mean|resid|` is in-sample error and is **not** an accuracy claim. To measure
  accuracy, fit on some scans and compare a new, unused scan against tape.
- Commit only `calibration/current.json`. The id records the date and the number of people.

## Results (fill in from real sessions only)

| Date | Calibration id | People | Scans | Camera / distance / model | Measurement | Tape (cm) | Scan before cal. (cm) | Scan after cal. (cm) | Held-out error (cm) |
| ---- | -------------- | ------ | ----- | ------------------------- | ----------- | --------- | --------------------- | -------------------- | ------------------- |
|      |                |        |       |                           |             |           |                       |                      |                     |

No real-person data has been collected yet.
