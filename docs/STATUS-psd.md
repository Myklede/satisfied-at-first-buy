# STATUS: pose-space correctives for the live jacket (agent V7, prompt 14 update 17:45)

Owner: V7. Paths: `apps/web/src/engine/live/deform/psd/**` and the one line in `deform/v7slot.ts`.

Evidence: numbers only, on the public neutral reference body (172 cm / 65 kg male).

- Raw outputs are in `.cache/v7/*-eval.json` (gitignored).
- Frames are in `.cache/v7/render-*.png`.

**Current state (CX-DAY,2026-11-14): OFF by default for both products.**
The completed live check fails the per-frame hole gate despite better mean counts;
see the Prompt17b/18 decision below. `?psd=1` remains an explicit lab opt-in.
Two bake workers stay configured because measured cost is within the budget.
Earlier offline passes remain historical evidence, not live default-ON approval.

## What it is

The live jacket is LBS-skinned, so its shape does not change the way cloth does with pose. Pose correctives learn this body and size's pose → cloth-shape map from the motion bake itself and play it back live: pose-space deformation (Lewis et al. 2000; weighted per region as in Kurihara & Miyata 2004).

The training data comes from `motion/bake.ts` `bakeMotion`:

- the same ClothSolver, collider, root anchors, hand stop, armhole-stop flag and `MOTION_FIT` constants as "Try moves" and "Record a move";
- the same dt.

### Key poses (`poses.ts`)

27 key poses in 10 chains, most important first:

1. relaxed arms (5° / 8°) and elbows bent;
2. the scapular raise up to reach_up_both's pose;
3. one arm up, right then left: up and forward;
4. cross arms and hug;
5. the diagonal raise (plane 65°);
6. the forward raise up to reach_forward's pose;
7. hands on hips, and arms forward with the elbows bent;
8. the sideways raise;
9. trunk twist ±25° and lean ±12°.

Each chain:

- starts from the relaxed neutral drape;
- ramps at the presets' validated speed (110 °/s, at least 0.5 s);
- holds 0.4 s, then records the particles.

The motion frames come from the service's custom-motion path and are fed to the bake at 10 fps: 6 solver steps of the asset dt per bake frame.

Asymmetric poses are baked on both sides. A mirrored field is not a faithful stand-in. On parka S, mirror(lean right) vs the baked lean left differs by 1.18 cm mean, 3.84 cm p95; twist 0.93 / 3.26 cm.

### Stored data

- Per particle: the correction in its LBS local frame, `B_i(pose)⁻¹ · (solved − LBS)`, minus the same at the neutral stand. The neutral drape stays the live preview's.
- The relaxed bake drape differs from the live drape by 1.66 cm mean, max 15.2 cm. That is not added.
- PCA to 16 components (truncation RMS 0.37 cm parka, 0.39 cm puffer).

### Run time (`model.ts` `PsdEvaluator.apply`)

- **Per-side Gaussian RBF.** The arm feature is:
  - the humerus direction (continuous through the ISB gimbal);
  - elbow flexion;
  - the other arm's height.
- **Interpolation:** near-exact (λ = 1e-6), so a key pose reproduces its own true solve. Arm width σ = 0.6.
- **Trunk RBF:** σ by leave-one-out (1.6).
- **Left/right masks:** smoothstep across ±10 cm of the mid-sagittal plane.
- **Transform back:** with the frame's LBS blend.
- **Body guard** (`guard.ts`, round 3): the correction never puts a particle below the posed skin of its own region, or deeper than LBS had it.
  - The skin is the posed position and normal of the nearest of 6 candidate vertices (the nearest 3 plus 3 spread within 15 cm, chosen at bind).
  - Where no candidate is within the particle's neutral distance + 3 cm, a fallback applies: the inward part along its own skin normal (carried by its LBS frame) is limited to its neutral clearance − 2 mm.
  - The search runs only where the correction heads into the skin (`guardSlackM`).

### Integration

- **Deformer** (`PoseCorrectives.ts`):
  - `bind` starts a bake in 2 Web Workers (`browserBaker.ts`, `psd.worker.ts`). Each worker refits after its chain, so correctives fade in (600 ms) after the first chain and improve as chains land.
  - Before then: a no-op with `status().note`.
  - Models are cached in memory by `binding.key` for the session only. There is no IndexedDB: the kiosk stores no profile.
- **Truthfulness:**
  - The basis stays `preview`.
  - Readouts come from the skinned buffer before the chain (V6's hook), so a corrective cannot change a fit number.
  - Baked playback bypasses it.

## Validation: hold-out true solves

The tables in this section use the round-2 guard. The round-3 guard's numbers, with penetration and AR holes, are in "The lead's decision rule" below.

Each hold-out pose is solved from the neutral drape: ramp ≥ 1 s, 0.6 s hold, 30 fps bake frames. Error is per particle, |PSD (guarded) − true solve|, cm. "LBS" is the live preview today. The last column counts particles more than 5 mm inside the posed body (the bake's own collider).

### Parka S (FB7675-100, 10,528 particles)

| Hold-out pose                                            | PSD mean / p95 / max | LBS mean / p95 / max | > 5 mm inside: LBS / PSD / truth |
| -------------------------------------------------------- | -------------------- | -------------------- | -------------------------------- |
| raise-mid (plane 60, elev 120, elbow 30)                 | 0.85 / 1.97 / 5.7    | 5.43 / 10.98 / 15.4  | 2 / 107 / 57                     |
| raise-low (20, 75, 40)                                   | 0.64 / 1.63 / 3.0    | 2.92 / 6.68 / 7.7    | 0 / 21 / 50                      |
| hug-wide (95, 70, 80)                                    | 0.63 / 1.59 / 5.7    | 3.96 / 8.28 / 11.0   | 189 / 99 / 80                    |
| relaxed-bent (7, 8, 45)                                  | 0.50 / 1.75 / 2.4    | 0.55 / 1.64 / 2.5    | 4 / 0 / 1                        |
| front-high-bent (90, 100, 60)                            | 0.75 / 2.54 / 9.6    | 5.17 / 10.60 / 14.2  | 84 / 154 / 82                    |
| cross_arms preset pose (65 / 55)                         | 1.06 / 3.22 / 8.8    | 3.46 / 7.51 / 16.1   | 305 / 192 / 117                  |
| reach_up_one pose (one arm 175 + lean −10)               | 1.42 / 4.09 / 9.0    | 5.56 / 14.15 / 16.7  | 5 / 289 / 10                     |
| twist 15 + arms (60, 45, 30)                             | 0.71 / 1.60 / 3.4    | 2.45 / 5.44 / 6.7    | 0 / 0 / 0                        |
| reach_up_both preset (training pose, preset's own solve) | 0.52 / 1.08 / 5.0    | 7.44 / 14.59 / 17.6  | 13 / 84 / 57                     |

### Puffer S (DQ4920-206, 9,080 particles)

| Hold-out pose          | PSD mean / p95 / max | LBS mean / p95 / max | > 5 mm inside: LBS / PSD / truth |
| ---------------------- | -------------------- | -------------------- | -------------------------------- |
| raise-mid              | 1.08 / 2.43 / 5.1    | 5.25 / 10.59 / 14.8  | 1 / 95 / 44                      |
| raise-low              | 0.62 / 1.57 / 2.4    | 2.53 / 6.25 / 7.7    | 0 / 13 / 48                      |
| hug-wide               | 0.79 / 2.24 / 5.8    | 3.93 / 8.33 / 11.4   | 212 / 131 / 90                   |
| relaxed-bent           | 0.54 / 1.74 / 2.4    | 0.67 / 1.78 / 2.8    | 7 / 2 / 0                        |
| front-high-bent        | 1.17 / 2.83 / 10.0   | 4.87 / 10.08 / 14.6  | 102 / 164 / 56                   |
| cross_arms preset pose | 1.11 / 3.92 / 8.0    | 3.57 / 8.19 / 15.8   | 341 / 233 / 114                  |
| reach_up_one pose      | 0.99 / 3.04 / 6.2    | 4.52 / 13.00 / 16.0  | 5 / 164 / 6                      |
| twist 15 + arms        | 0.60 / 1.37 / 2.6    | 2.21 / 5.48 / 7.0    | 0 / 0 / 0                        |
| reach_up_both preset   | 0.60 / 1.19 / 5.4    | 7.11 / 14.06 / 17.8  | 13 / 69 / 40                     |

### Round-2 changes and what they bought (parka S, mean / p95 cm)

| Hold-out        | Round 1 (commit 1ddbb64) | Now         |
| --------------- | ------------------------ | ----------- |
| raise-mid       | 1.37 / 3.31              | 0.85 / 1.97 |
| raise-low       | 0.76 / 1.67              | 0.64 / 1.63 |
| hug-wide        | 0.74 / 2.49              | 0.63 / 1.59 |
| front-high-bent | 0.77 / 2.64              | 0.75 / 2.54 |
| cross_arms      | 1.18 / 3.30              | 1.06 / 3.22 |
| reach_up_one    | 1.50 / 4.22              | 1.42 / 4.09 |
| reach_up_both   | 0.61 / 1.74              | 0.52 / 1.08 |

#### Waist tear

- **Cause:** the body guard. It tested particles against the tangent plane of a skin vertex chosen at the neutral pose. Where the true solve slides cloth along the body (sleeves ride 6+ cm down the arm), that plane is stale, and pushing along it crinkled the sleeves and tore the front waist.
- **Proof:** the unguarded PSD was clean and matched the chain-baked training sample and the true solve.
- **Fix:** the radius limit. The frames are clean now; a faint row of dimples remains at the zip.
- **Cost:** with the radius the guard changes the error by ≤ 0.01 cm, but it also prevents little penetration (next section).

#### Interpolation

- **Ridge:** leave-one-out preferred λ = 0.01–0.05. That blend smeared folds and put more particles inside the body (raise-mid 349 vs 66 > 5 mm), so λ = 1e-6.
- **Width:** at λ = 1e-6, leave-one-out chose σ = 0.35, which sags between key poses (raise-mid 2.66 cm mean). It is fixed at σ = 0.6, one global number chosen on the hold-outs. Against 0.9 it was better on 4 hold-outs (raise-low, hug, front-high-bent, raise-mid), worse on 4 and tied on reach_up_both. Against 1.3 it was better on 5 and worse on 3 (relaxed-bent, cross_arms, reach_up_one, each by ≤ 0.3 cm).

#### Tried and dropped

| Tried                                                               | Result                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Mirrored one-arm, twist and lean samples                            | Fields wrong by ~1 cm mean (see above); reach_up_one got worse (2.4 cm mean) |
| A one-arm-plus-lean sample stored as a residual over the trunk term | Did not help reach_up_one and worsened raise-low                             |
| An asymmetric cross sample                                          | cross_arms 1.08 / 2.74 cm (from 1.06 / 3.22): not worth a bake               |

**Remaining failures and their mechanism:**

- **reach_up_one** (one arm + lean): the arm and trunk corrections are added, but the true solve's lean-with-a-raised-arm is not their sum. The model reproduces one arm up (no lean) exactly, and twist + arms passes.
- **cross_arms:** which forearm lies on top is a contact outcome that the symmetric samples cannot say.

### Hem and collar lift on reach_up_both (preset hold end)

Hem rise at the hip-line waistband (front / back / sides), cm:

|            | Parka S          | Puffer S        |
| ---------- | ---------------- | --------------- |
| LBS        | 0 / 0 / 0        | 0 / 0 / 0       |
| PSD        | 7.1 / 8.1 / 10.1 | 6.8 / 8.7 / 9.5 |
| True solve | 6.8 / 7.8 / 9.9  | 6.6 / 8.0 / 9.3 |

Collar: LBS −0.3 / −0.4, PSD 0.0, true solve 0.0 cm.

The real parka (V3, from the user's video, by eye) shows a hem rise of about 23 cm and a collar rise of about 9 cm. PSD can only be as right as the solver; see "Armhole stop".

### Relaxed arms (elevation 5°, elbow 8°)

Sleeve-particle distance to the body (left sleeve, mean / p95), cm:

|            | Parka S     | Puffer S    |
| ---------- | ----------- | ----------- |
| LBS        | 1.16 / 1.41 | 1.16 / 1.42 |
| PSD        | 1.08 / 1.51 | 1.06 / 1.41 |
| True solve | 1.12 / 1.82 | 1.12 / 1.83 |

The true solve's relaxed sleeves are not closer to the arm than LBS's on this body. On this body the solver gives no evidence of a sleeve "splay" to correct.

### Run time

`apply`, Node, 400 random poses, 16 components. Times are load-dependent: the laptop ran other agents' browser jobs at about 46 % CPU.

|                                    | Median  | p95    |
| ---------------------------------- | ------- | ------ |
| Parka, quieter run                 | 0.68 ms | 1.1 ms |
| Parka, quieter run, with the guard | 0.89 ms | 1.5 ms |
| Parka, at 46 % CPU                 | 1.14 ms | 1.8 ms |
| Parka, at 46 % CPU, with the guard | 1.44 ms | 2.4 ms |
| Puffer                             | 0.70 ms | 1.3 ms |
| Puffer, with the guard             | 0.97 ms | 1.8 ms |

### Gates (lead): default ON only if all hold

| Gate                                     | Parka S                                                                                                                                                                                     | Puffer S                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Hold-out mean < 1 cm (guarded, round 3)  | 7 of 9. Fail: cross_arms 1.11, reach_up_one 1.43                                                                                                                                            | 5 of 9. Fail: raise-mid 1.10, front-high-bent 1.24, cross_arms 1.17, reach_up_one 1.01 |
| Hold-out p95 < 2.5 cm (guarded, round 3) | 5 of 9. Fail: hug-wide 2.63, front-high-bent 2.81, cross_arms 3.29, reach_up_one 4.15. The guard costs about 1 cm of p95 on hug-wide, where the true solve's own cloth lies inside the skin | 4 of 9                                                                                 |
| No penetration > 5 mm                    | Not met by anything, the true solve included. PSD < LBS on hug, relaxed and cross; PSD > LBS on raised arms (see the decision-rule section)                                                 | Same                                                                                   |
| No more AR holes than LBS (lead's rule)  | Fails on raised arms (raise-mid 1476 vs 71 px, reach_up_one 2301 vs 47). The true solve fails it the same way. Passes on relaxed, twist and cross                                           | Same pattern                                                                           |
| Readouts unchanged                       | Pass by construction (V6's skinned buffer)                                                                                                                                                  | Same                                                                                   |
| ≤ 1 ms / frame                           | Unguarded median 0.70–0.99 ms; guarded 1.10–1.77 ms (load-dependent)                                                                                                                        | Guarded 1.60 ms under load                                                             |

## The lead's decision rule: is PSD better than LBS, and does it open holes in AR?

Default ON needs **PSD's error ≪ LBS's** and **no more AR holes than LBS**. All numbers below use the shipped guard (round 3: skin candidates + clearance fallback).

### Why holes matter

In AR the posed body is drawn depth-only as an occluder (`ar/occluder.ts`: the body without hands and legs). Wherever cloth lies inside the body, the occluder wins and the real video (the person's own T-shirt) shows through.

### How holes are measured offline (`tools/holes.mjs`)

- Front view, orthographic, 2.5 mm pixels.
- The jacket and the occluding body are rasterised into depth buffers.
- A jacket pixel is a **hole** when the body is in front of the cloth by 1–30 mm: cloth just under the skin. The 1 mm stands in for the occluder's polygon offset.
- Not counted:
  - head and neck in front of the hood: correct;
  - the cloth's inner side, looking into a cuff or the neck opening: correct;
  - a limb ≥ 3 cm in front of the cloth, such as crossed forearms below a sleeve that rode up: correct, counted separately as "limb".

### Parka S

"Inside" is the number of particles inside the body at more than 0 / 2 / 5 mm (the bake's collider).

| Hold-out        | Error mean, cm: PSD / LBS | Holes, px: LBS / PSD / truth | Inside, LBS     | Inside, PSD     | Inside, truth   |
| --------------- | ------------------------- | ---------------------------- | --------------- | --------------- | --------------- |
| raise-mid       | 0.86 / 5.43               | 71 / 1476 / 1018             | 9 / 8 / 2       | 211 / 133 / 52  | 249 / 160 / 57  |
| raise-low       | 0.64 / 2.92               | 0 / 43 / 505                 | 0 / 0 / 0       | 19 / 1 / 0      | 144 / 106 / 50  |
| hug-wide        | 0.70 / 3.96               | 19 / 177 / 285               | 317 / 255 / 189 | 243 / 127 / 41  | 245 / 149 / 80  |
| relaxed-bent    | 0.50 / 0.55               | 0 / 0 / 0                    | 65 / 38 / 4     | 13 / 5 / 0      | 27 / 7 / 1      |
| front-high-bent | 0.84 / 5.17               | 31 / 609 / 609               | 162 / 124 / 84  | 337 / 215 / 101 | 370 / 217 / 82  |
| cross_arms      | 1.11 / 3.46               | 17 / 12 / 90                 | 528 / 424 / 305 | 463 / 335 / 202 | 472 / 275 / 117 |
| reach_up_one    | 1.43 / 5.56               | 47 / 2301 / 914              | 14 / 14 / 5     | 225 / 168 / 86  | 185 / 80 / 10   |
| twist + arms    | 0.71 / 2.45               | 0 / 0 / 6                    | 0 / 0 / 0       | 11 / 1 / 0      | 17 / 3 / 0      |
| reach_up_both   | 0.62 / 7.44               | 72 / 751 / 826               | 33 / 26 / 13    | 153 / 107 / 49  | 212 / 143 / 57  |

### Puffer S

| Hold-out        | Error mean, cm: PSD / LBS | Holes, px: LBS / PSD / truth | Inside, LBS     | Inside, PSD     | Inside, truth   |
| --------------- | ------------------------- | ---------------------------- | --------------- | --------------- | --------------- |
| raise-mid       | 1.10 / 5.25               | 58 / 1525 / 646              | 9 / 8 / 1       | 204 / 115 / 53  | 175 / 105 / 44  |
| raise-low       | 0.63 / 2.53               | 0 / 50 / 449                 | 0 / 0 / 0       | 17 / 4 / 0      | 135 / 92 / 48   |
| hug-wide        | 0.86 / 3.93               | 16 / 120 / 290               | 358 / 283 / 212 | 274 / 158 / 71  | 258 / 159 / 90  |
| relaxed-bent    | 0.54 / 0.67               | 0 / 0 / 0                    | 79 / 42 / 7     | 16 / 8 / 2      | 22 / 5 / 0      |
| front-high-bent | 1.24 / 4.87               | 31 / 609 / 443               | 193 / 145 / 102 | 321 / 222 / 120 | 294 / 166 / 56  |
| cross_arms      | 1.17 / 3.57               | 12 / 13 / 53                 | 623 / 494 / 341 | 521 / 387 / 247 | 479 / 279 / 114 |
| reach_up_one    | 1.01 / 4.52               | 44 / 1030 / 526              | 14 / 13 / 5     | 129 / 90 / 45   | 92 / 27 / 6     |
| twist + arms    | 0.60 / 2.21               | 0 / 0 / 3                    | 0 / 0 / 0       | 0 / 0 / 0       | 14 / 3 / 0      |
| reach_up_both   | 0.69 / 7.11               | 64 / 697 / 761               | 35 / 24 / 13    | 130 / 82 / 36   | 197 / 117 / 40  |

### Reading

- **Error:** PSD's is 3–12× below LBS's on every hold-out except relaxed-bent, where both are about 0.5 cm.
- **Holes:** PSD ≤ LBS on relaxed-bent, twist + arms and cross_arms. **PSD ≫ LBS wherever the arms are raised**: raise-mid, front-high-bent, reach_up_one, reach_up_both, and less so raise-low and hug.
  - **The true solve has the same pattern and magnitude** (raise-mid 1018, reach_up_both 826, front-high-bent 609 px).
  - The holes sit at the armpits and down the torso side under a raised arm (`.cache/v7/holes-*.png`).
  - That is the solver's own cloth inside the skin: the shoulder-ridge collapse the lead described (V3's b1 fix), plus contact allowed to −4 mm. A physics-shaped jacket cannot meet "no more holes than LBS" on raised arms until the true solve stops doing that.
- **Deep penetration (> 5 mm):** PSD < LBS on hug-wide, relaxed-bent and cross_arms (LBS sinks the sleeves and front into the body there). PSD > LBS on the raised-arm poses.
- **Limb in front:** PSD shows the forearm in front of the jacket more often than the truth on front-high-bent (934 vs 104 px) and hug-wide (400 vs 2 px). There its sleeves ride up further than the solve's: an interpolation error on cuff position.
- **Occluder push-back, a what-if for V2** (parka, PSD holes; LBS in brackets):

  |              | raise-mid | front-high-bent | reach_up_one |
  | ------------ | --------- | --------------- | ------------ |
  | 1 mm (today) | 1471 (72) | 1534 (31)       | 2317 (51)    |
  | 4 mm         | 983 (57)  | 1331 (25)       | 1510 (42)    |
  | 8 mm         | 500 (30)  | 1201 (16)       | 859 (17)     |

  These counts predate the limb split. Pushing the occluder back helps but does not close the gap: the solver's cloth there is more than 8 mm inside.

### Verdict

- PSD fails "no more holes than LBS" on raised arms, and so would the true solve.
- Re-measure after V3's b1 (skin collapse) and the armhole stop. The tools rerun as is (`psdNode.mjs train | holdout | eval`).

### Guard cost

The guard is a skin-vertex search that runs only where a correction heads into the skin (`PSD.guardSlackM` = 3 cm).

- **Cost:** +0.4–0.8 ms/frame. Parka `apply` median: 0.99 ms unguarded vs 1.77 ms guarded in the same loaded run; 1.10 ms guarded in a quieter run (at 1 cm slack). Puffer: 1.60 ms guarded under load.
- **Effect, vs the round-2 guard (which barely acted):** about halves the particles > 5 mm inside, and the holes on raise-low (486 → 43 px) and reach_up_one (4306 → 2301 px).

## Elevation fade (lead, round 4) and the default-ON gates

Each side's arm correctives apply at full weight up to 70° of that arm's shoulder elevation and fade (smoothstep) to 0 at 100°. The trunk term is not faded (`PSD.fade`; `PsdEvaluator.fadeDeg`).

The reason: with the arms raised, the true solve itself sinks cloth under the armpit and shoulder skin (the shoulder-ridge collapse, V3's b1), and AR shows that as holes.

**Gates, per pose:**

- holes ≤ LBS + 100 px or ≤ 1.5 × LBS;
- particles > 5 mm inside ≤ LBS's;
- shape error ≤ LBS's;
- cost ≤ 2 ms per frame (median, with the guard).

### Parka S, fade 70° → 100°

| Hold-out                   | Shape error mean (cm), PSD / LBS | Holes (px), PSD / LBS | > 5 mm inside, PSD / LBS | Result          |
| -------------------------- | -------------------------------- | --------------------- | ------------------------ | --------------- |
| raise-mid (elev 120)       | 5.43 / 5.43 (faded out)          | 71 / 71               | 2 / 2                    | pass            |
| raise-low (75)             | 0.73 / 2.92                      | 8 / 0                 | 0 / 0                    | pass            |
| **hug-wide (70)**          | 0.70 / 3.96                      | **177 / 19**          | 41 / 189                 | **fail: holes** |
| relaxed-bent               | 0.50 / 0.55                      | 0 / 0                 | 0 / 4                    | pass            |
| front-high-bent (100)      | 5.17 / 5.17 (faded out)          | 31 / 31               | 84 / 84                  | pass            |
| cross_arms (65 / 55)       | 1.11 / 3.46                      | 12 / 17               | 202 / 305                | pass            |
| reach_up_one (175 / stand) | 4.08 / 5.56                      | 41 / 47               | 1 / 5                    | pass            |
| twist + arms (45)          | 0.71 / 2.45                      | 0 / 0                 | 0 / 0                    | pass            |
| reach_up_both (170)        | 7.44 / 7.44 (faded out)          | 72 / 72               | 13 / 13                  | pass            |

Cost (Node, laptop under other agents' load): `apply` median 1.24–1.33 ms with the guard (p95 2.1–2.3), 0.70 ms without. Median within 2 ms.

### Puffer S, fade 70° → 100°

Every pose passes except **hug-wide: 120 hole px vs LBS 16**, against a limit of 116, missing by 4 px. Shape error 0.86 vs 3.93 cm; > 5 mm inside 71 vs 212. Cost: median 1.06–1.12 ms with the guard.

### What blocks it: hug-wide, on both jackets

- **The cause is not cloth inside the torso.** PSD's sleeves ride up further than the true solve's at the hug pose, so bare forearm shows in front of the chest where the forearms meet:
  - limb-in-front pixels: parka 400 vs truth 2, puffer 495 vs 64;
  - a thin rim of the same counts as "holes".
- **It is an interpolation error in cuff position** among the forward/hug key poses (hug 100/80/60, cross 110/60/115, reach-forward 90/80/25, forward-bent 90/90/90).
- **Fading earlier does not fix it, because a partly faded correction is not "less hole":**

  | Fade      | Parka holes | Puffer holes | Result                             |
  | --------- | ----------- | ------------ | ---------------------------------- |
  | 60° → 90° | 191         | 137          | both fail                          |
  | 55° → 85° | 132         | 101          | the puffer passes; the parka fails |

  Both also give up shape benefit (raise-low error 1.6–2.2 cm instead of 0.7).

**Result: kept OFF.** Next:

- denser key poses in the hug family (plane 95–110, elevation 65–85, elbow 60–115);
- validated against a NEW hold-out hug pose, so the gate is not tuned on its own test;
- after V3's b1: re-bake, re-measure, and widen the fade with the same measure.

## Round 5: hug-family key poses (lead, approved) and the default-ON gates

**New `hug` chain:** 4 key poses, baked after the relaxed, raised, one-arm and cross chains.

- hug-low-wide (plane 95, elevation 65, elbow 60);
- hug-low-tight (100, 65, 105);
- hug-high-tight (105, 85, 100);
- hug-mid-wide (105, 75, 70).

Together with hug (100, 80, 60) and cross (110, 60, 115), they bracket the family below the elevation fade.

**New hold-out `hug-hold` (102, 75, 90):** never trained on, alongside hug-wide (95, 70, 80).

**Bake:** the hug chain adds 3.9 s of simulation, 17.8–20.0 s of single-worker bake. With two workers the full set is then about 98 s on this loaded laptop for the parka, 78 s for the puffer. Relaxed and raised-arm correctives are still ready first, after about 13 s and 23 s.

The parka's asset key changed between bakes (`53c1f333…` → `286b163d…`: a new fit id after a service restart). The relaxed neutral drapes of every file are bit-identical, so the samples are from the same cloth.

### Parka S (fade 70->100, 16 components, 31 samples)

| Hold-out          | Shape error mean (cm), PSD / LBS | Holes (px), PSD / LBS | > 5 mm inside, PSD / LBS | Gate |
| ----------------- | -------------------------------- | --------------------- | ------------------------ | ---- |
| raise-mid         | 5.43 / 5.43                      | 71 / 71               | 2 / 2                    | pass |
| raise-low         | 0.75 / 2.92                      | 3 / 0                 | 0 / 0                    | pass |
| hug-wide          | 0.94 / 3.96                      | 57 / 19               | 70 / 189                 | pass |
| relaxed-bent      | 0.52 / 0.55                      | 0 / 0                 | 0 / 4                    | pass |
| front-high-bent   | 5.17 / 5.17                      | 31 / 31               | 84 / 84                  | pass |
| cross-arms-preset | 1.20 / 3.46                      | 20 / 17               | 280 / 305                | pass |
| reach-up-one      | 4.10 / 5.56                      | 43 / 47               | 3 / 5                    | pass |
| twist-arms        | 1.06 / 2.45                      | 0 / 0                 | 0 / 0                    | pass |
| reach_up_both     | 7.44 / 7.44                      | 72 / 72               | 13 / 13                  | pass |
| hug-hold          | 0.93 / 4.21                      | 85 / 14               | 63 / 221                 | pass |

Cost: apply median 1.483 ms with the guard (p95 3.222), 0.784 ms without.

### Puffer S (fade 70->100, 16 components, 31 samples)

| Hold-out          | Shape error mean (cm), PSD / LBS | Holes (px), PSD / LBS | > 5 mm inside, PSD / LBS | Gate     |
| ----------------- | -------------------------------- | --------------------- | ------------------------ | -------- |
| raise-mid         | 5.25 / 5.25                      | 58 / 58               | 1 / 1                    | pass     |
| raise-low         | 0.72 / 2.53                      | 2 / 0                 | 0 / 0                    | pass     |
| hug-wide          | 0.99 / 3.93                      | 182 / 16              | 100 / 212                | **fail** |
| relaxed-bent      | 0.60 / 0.67                      | 0 / 0                 | 3 / 7                    | pass     |
| front-high-bent   | 4.87 / 4.87                      | 31 / 31               | 102 / 102                | pass     |
| cross-arms-preset | 1.35 / 3.57                      | 15 / 12               | 323 / 341                | pass     |
| reach-up-one      | 3.54 / 4.52                      | 35 / 44               | 3 / 5                    | pass     |
| twist-arms        | 1.05 / 2.21                      | 0 / 0                 | 0 / 0                    | pass     |
| reach_up_both     | 7.11 / 7.11                      | 64 / 64               | 13 / 13                  | pass     |
| hug-hold          | 1.58 / 4.44                      | 92 / 21               | 80 / 254                 | pass     |

Cost: apply median 1.117 ms with the guard (p95 2.041), 0.598 ms without.

### Result

- **Parka S: every gate passes on all 10 hold-outs**, including the new hug-hold.
- **Puffer S: blocked by hug-wide** (182 hole px vs LBS 16).
  - The holes are bare forearm just in front of the chest where the two thick sleeves meet. The puffer's sleeves push each other's cuffs back there: a sleeve-on-sleeve contact effect that the added key poses do not capture.
  - With 24 components it is worse (274 px), though the parka still passes.
- **Default stays OFF**, since the gate needs both jackets.
- **Options:**
  1. enable per product (parka ON, puffer OFF), a one-line allow-list in config;
  2. more hug key poses near elbow 80–90 for the puffer, validated on yet another new hold-out.

## Round 6: parka ON (allow-list), the puffer attempt, and a third hug hold-out

**Parka ON by default** (`PSD.defaultOnStyles = ['FB7675-100']`, commit "on by default for the parka").

- **How the switch works:**
  - The browser baker looks up the product's style from the service's product list before any work.
  - A product that is not listed gets a plain status note and no bake.
  - Without Web Workers (Node, tests) nothing runs.
  - `?psd=0` turns it off; `?psd=1` turns it on for every product (labs).
- **A third, never-trained hug hold-out, `hug-hold-2` (99, 73, elbow 84):**
  - The shipped parka model (the round-5 training set) passes every gate on all 11 hold-outs.
  - hug-hold-2: shape error 0.99 vs LBS 4.13 cm, holes 55 vs LBS 5 px (limit 105), > 5 mm inside 49 vs 183.
  - Cost: median 1.40 ms with the guard.

**Puffer attempt: a `hug2` chain at elbow 85–90.** Poses (95, 78, 0, 88) and (105, 68, 0, 85), validated on hug-hold-2. It did not work, so it was dropped and not committed:

|                           | Parka                                                                                    | Puffer                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| hug-wide holes            | 57 → 210 px: **would block the parka**, although its shape error improved 0.94 → 0.54 cm | 182 → 137 px, still over its limit of 116 |
| cross_arms, > 5 mm inside | —                                                                                        | rose to 427 vs LBS 341 (fail)             |
| hug-hold / hug-hold-2     | pass                                                                                     | pass                                      |

- Hole counts at the hug pose are very sensitive to small cloth differences where the forearm meets the chest cloth: the puffer's thick sleeves press on each other there.
- The puffer stays off.
- **Next for the puffer:** model the sleeve-on-sleeve contact itself (the hug-family solve with the forearms' contact as the feature), not more interpolation samples.

**Live check (lead):** still required before the demo. In the browser slot, measure live holes with `?psd=0` vs `?psd=1` on cam-parka and cam-tshirt, plus ms per frame. If live holes are clearly worse than the offline prediction, the allow-list is reverted.

## Bake time (two workers, as the browser runs)

Neutral body; this laptop shared with other agents.

|                                  | Parka S                             | Puffer S             |
| -------------------------------- | ----------------------------------- | -------------------- |
| Relaxed arms (first correctives) | 12.7 s                              | 11.2 s               |
| Raised arms (hem lift)           | 23.0 s                              | 19.5 s               |
| All 27 poses                     | 88.2 s (90.4 s wall with data load) | 67.5 s (73.8 s wall) |

- Step times were 55–108 ms under contention; about 48 ms is the uncontended single-worker step.
- First and raised-arm correctives meet the lead's ~15 s / ~25 s.
- The full set misses ~60 s on this busy laptop. The heaviest worker simulates 15.4 s, about 55 s at the uncontended step.
- Lever if needed: drop `side` (≈ 9 s) or `bent` (≈ 11 s); they are last in the queue.

### Bake rate

Feeding the bake at 10 fps instead of 30 cuts the per-frame bookkeeping 3×. The end state differs from the 30 fps bake by:

- 0.1 cm mean, 2.1 cm max;
- 30 vs 15 fps: 0.07 / 2.0 cm, the solver's own path noise.

### Settle

After the 0.4 s hold, the particle travel over the last 0.1 s is p95 0.06–0.57 cm.

## Armhole stop (V3), true solve of reach_up_both, parka S, neutral body

|                                               | Hem rise front / back / sides | Collar | Max penetration |
| --------------------------------------------- | ----------------------------- | ------ | --------------- |
| Off (today's default)                         | 6.8 / 7.7 / 10.1 cm           | 0 cm   | 1.3 cm          |
| On (`armholeStop: true`, V3's state at 19:10) | 24.7 / 30.4 / 27.0 cm         | 0 cm   | 6.0 cm          |

The video shows about 23 cm hem and 9 cm collar. The PSD bake calls `bakeMotion` with the defaults, so it follows `MOTION_FIT` automatically. Re-bake and re-measure when V3's switches are on.

## How to run

- **Node**, the same code as the browser worker, on the neutral reference body from 8001:
  `node apps/web/src/engine/live/deform/psd/tools/psdNode.mjs train|holdout|eval|render --product FB7675-100|DQ4920-206 --out name [--chains a,b] [--extra name] [--holdout name] [--armhole] [--components n] [--sigmas x] [--lambdas x] [--exclude id]`
  Outputs go to the gitignored `.cache/v7/`.
- **Browser:** `?psd=1` in the labs.
- **Unit tests:** `npx vitest run src/engine/live/deform/psd`. They cover:
  - the local-frame round trip;
  - an exact solve at training poses, including combo residuals;
  - the no-op before ready;
  - the fade and the cache;
  - no bake while off;
  - the mirror;
  - the guard and its radius;
  - the schedule limits.

## Known gaps / next steps

- **Gates:** cross_arms, one arm + lean, front-high-bent p95, and the puffer's raise-mid mean.
  - Next: a joint arm-and-trunk sample for one arm + lean, both sides.
  - cross_arms needs a contact-aware treatment (which forearm is on top), not more samples.
- **Penetration:**
  - The guard covers only a particle's own region near its vertex.
  - V6's dynamics stage, which follows, collides with the body.
- **Not tested in a browser yet:** the lock needs ≥ 2.5 GiB free RAM; queued after V4, V2 and CX-DAY. The worker handler was smoke-tested in Node: init, chain, fit, apply.
- **Re-bake when V3's switches (b1 weight transfer, armhole stop + vertical LRA) are on.** The cache is session-memory only, so a page load bakes fresh.

## Prompt17b/18 live decision (2026-11-14)

Default PSD is now **OFF for both products**, with opt-in `?psd=1` preserved.
The full local liveCheck completed02:51 under browser-then-heavy (12min cap),
21 parka pairs and18 tshirt pairs. The literal failure is added holes>100 OR
on>1.5\*off. Parka2s:0->17,12s:7->58; tshirt5s:241->479 (+238),5.5s:281->382
(+101 even though ratio1.359). Seven parka samples and two tshirt samples fail.
Mean counts improve (parka103.2->95.3,tshirt448.3->414.3), but a mean cannot
cancel a per-frame failure. Numeric evidence: validation/demo-day-18-psd-live.json.

Keep **workers=2**: no-bake/one/two AR median10/11/10fps and tracker median
35.12/36.15/36.91ms; two-worker loss0%, added tracker1.79ms, within10%/5ms.
Actual learning samples40 per active condition, rather than post-bake idle values.
PSD apply median2.7ms,p954.2ms,max4.3ms (30 samples). These are instrumented
sequential conditions, not a stable-revision controlled speedup claim.

Fixed source-restart race in liveCheck: wait for a new ready source and tracking,
not the old posedScene. The earlier pre18 run failed while switching to tshirt;
retained privately at .cache/cx-day/psd/pre18-live-check.json and not used for quiet
timing acceptance. Private paired images: .cache/cx-day/psd/cam-parka-2p00-{off,on}.png
and cam-tshirt-5p00-{off,on}.png; no user pixels committed.

Checks: PSD Vitest19/19 PASS, Node gate3/3 PASS. Initial test expected the old
parka allow-list and failed18/19; policy expectation corrected while retaining
explicit opt-in/allow-list behavior coverage. No physics switch/version/API restart.
