# Three-minute judge runbook

**Tóm tắt:** Cắm điện, chạy preflight; sau mỗi build dùng `npm run kiosk -- --warm`.
Chỉ trình diễn khi đã xem GO/NO-GO và bằng chứng warm-up; thiếu bằng chứng thì chưa được coi là đã warm.
Giới thiệu cơ thể → hai áo → X-ray/fit → kéo vải → đổi size → Try moves cuối.
Số đo và độ căng đều được tính; mô phỏng chuyển động và các phần chưa hiệu chỉnh phải nói rõ.
Không hứa thời gian chờ cố định. Quét lỗi thì bỏ qua; “Reconnecting…” thì đợi tự phục hồi.

This script follows the current kiosk code. Rehearse on the demo laptop before each session.
Use the labels actually on screen; do not substitute a memorised size or measurement.

## Before the session

1. Connect AC power. Select the laptop's performance power plan and the NVIDIA GPU for Chrome.
2. Close applications you do not need. `npm run preflight` is read-only: low RAM lists the five
   largest process working sets so the operator can decide what to close. No process is killed.
   A development API privacy warning is expected before kiosk launch; other failures need review.
   **Keep at least 3 GiB free during judging** (lead's rule following S's measured memory-pressure
   cache purge). Close coding agents, Cursor/VS Code, unrelated Chrome windows, Outlook, Zalo and
   ChatGPT when no longer needed. Do this after coordinating/completing their active work; never
   kill shared API/vision services. The 2.5 GiB browser launch threshold is only a minimum to start.
3. After every new build, run `npm run kiosk -- --warm` in PowerShell (`--windowed` for rehearsal).
   It requires the shared API to be ready in privacy mode; coordinate with its owner if it refuses.
   The browser slot needs at least 2.5 GiB free RAM, the six shared benchmark ports free and no
   browser lock. Do not remove another agent's lock. Retry after 60 seconds or finish preparation
   while waiting. Warm-up uses the real 5730 origin and `.cache/kiosk-chrome` profile, drives two
   reference-body sessions, records per-phase long tasks/render-program counts and confirms reset
   DELETEs. Inspect `.cache/kiosk-warm.json`: `proven` must be true; an incomplete zip/hood action or
   second-run task ≥1.5 s or dressing/X-ray wait ≥15 s is not a pass. The two-pass check is inside
   one Chrome process. S proved reloads can stay warm, but shader persistence after closing and
   restarting Chrome is unreliable: test the reopened judge window too, and let that window
   finish background compilation. Default `npm run kiosk` remains available.
   During parallel agent work the warm launch retains its browser lock through the reopened
   window and automatically closes within the original 14-minute lease. Close that rehearsal
   window before running the resolution matrix or Amazon demo; do not leave another job blocked.
   The launcher prepares local vision assets if missing, builds the web
   app, starts or reuses a compatible **privacy-enabled** local API, and opens fullscreen Chrome.
   Finish asset preparation before disconnecting the network. Keep the terminal open.
4. Wait for “Step up to find your size”. Attract preparation includes the model and vision models;
   it does not by itself prove the complete judge path has warmed.
   The attract body is a reference example, not the next judge's body.
   **In the actual judge window, wait for the small lower-left operator dot to turn green.**
   S measured all programs linked about 70 s after a cold page load; this is a historical observation,
   not a fixed countdown. The cue corresponds to `html[data-kiosk-warm="1"]`. Keep this Chrome
   open and avoid memory pressure between judges. A separate two-pass `--warm` session only proves
   the build's end-to-end path and best-effort disk-cache warming; it does not guarantee judge warmth.
5. In a second terminal, run `npm run preflight -- --kiosk`. This mode requires a loaded API and
   `kiosk_mode=true`, `saved=false`, `profile=null`. The default API port is 8001; if the launcher
   reports another port, use e.g. `npm run preflight -- --kiosk --api-port 8002`. The output names
   the API actually checked. Never change or stop
   somebody else's service to make a check pass. The Git check also reports concurrent work.
   The board prints PASS/WARN/FAIL and ends in GO or the first NO-GO reason. Review WARN rows too:
   a matching build hash without successful two-pass evidence does not pass warm-up. Free disk,
   Chrome/version, AC/power plan, browser-lock owner and ports are reported read-only. Resolve
   stale dist, privacy failures and unreviewed concurrent changes before judging.
   `--kiosk` uses the 3 GiB judging recommendation (WARN at 2.5–3 GiB). Warm proof remains advisory;
   the board does not fail solely because pass 2 waited. The judge-window green dot is a manual
   operator check: preflight does not add a Chrome debugging port to inspect it.
6. Check the real camera, lighting and space: 1.5–2.5 m for a full-body scan; 0.5–1 m for hand pull.
   The preflight device listing does not prove live camera capture. Do one manual rehearsal.

## The judge path

| Time      | Action                                                                                                                                                                                                                                | What to say                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:35 | Tap or press a key. Enter height and weight, choose units and a body shape, then Continue. Scan if there is room; otherwise use **Skip scan** / **Continue without scan**.                                                            | “This builds a body from your inputs. The optional camera scan adds measurements with an uncertainty estimate. It is not a medical body scan.”                                                                               |
| 0:35–0:55 | Let the judge's body appear, then both jackets. Read each recommendation and any estimated-grade/cut note.                                                                                                                            | “These are two different measured jackets fitted to the same body. The recommended size comes from the fit calculation; the other sizes may use an estimated grade.”                                                         |
| 0:55–1:15 | The result automatically moves to a shoulder X-ray after 2.5 seconds. Read the seam/chest/sleeve comparison exactly as shown.                                                                                                         | “The X-ray compares the garment seam with the shoulder bone. The card gives the computed distance. Drawn cloth and tape-based fit can differ; a small size difference should not be oversold.”                               |
| 1:15–1:55 | Open **Feel the fabric** once enabled. Step closer. Pinch in the air **over the jacket on screen**, pull, then release. Use the measured follow/tension readouts; **Measure** runs the standard pull for the size on screen.          | “Pinch the jacket on the screen as if you were holding it. The cloth response and how far it follows are measured by the local solver. The tension colour is an indicative model result, not a calibrated force in newtons.” |
| 1:55–2:05 | In Feel, drag the visible zip pull down and up. For the puffer, choose **Hood view**, pull the hood away, then bring its edge back to the collar. **Front view** returns the camera. Rehearse first; this time slot may be too short. | “Opening changes the displayed garment. Pull measurement is disabled until the measured closed configuration returns.”                                                                                                       |
| 2:05–2:25 | Return to the result and switch size. Wait for settling/loading to finish before continuing. Compare the displayed fit values. To compare pull measurements, visit Feel for that size and measure again.                              | “Changing size changes the actual garment geometry and its computed fit. This comparison uses the size currently on screen.”                                                                                                 |
| 2:25–3:00 | Open **Try moves** last. Prefer a motion marked **ready**. Show one reach or sitting motion in the two displayed sizes; keep the **indicative** qualification.                                                                        | “The background queue prepares motion simulations while we explore fit and fabric. A ready marker means that motion is cached. A new motion can still take time; these movement results are indicative.”                     |

The time slots are a presentation target, **not measured latency guarantees**. Continue/dressing,
precompute and motion work depend on machine load. Most motions are **not yet proven ready within
1–2 minutes** for every judge: the latest W evidence is 9.7–16.3 s per cached-relax bake in Node;
after a 60 s result dwell, uncached WebAssembly motions still took 7–19 s after clicking (single
samples). See [W's measurements](STATUS-kiosk.md). The queue pauses for hand pull and size builds.
Wait for actual **ready** markers instead of promising a fixed countdown.
The result card's Try moves checkmark refers to its initial warm bake, not all six motions;
inside Try moves, each motion button has its own ready state.

Feel has a **Jacket** selector once the jackets are ready. Both result cards have their own
size and Try moves controls (`FeelScreen.tsx` Jacket group; `KioskApp.tsx` result cards).

## Recovery and operator controls

| If this happens                     | Do this                                                                                                                                                                                                          | Code checked                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| API says Reconnecting…              | Wait for the owning watchdog; a reused shared API requires its owner. Recovery resets the lost session. Never restart shared 8001 yourself.                                                                      | `kiosk/watchdog.ts`, `KioskApp.tsx` reconnect effect; `scripts/kiosk.mjs` reused/service watchdog |
| First session freezes after a build | Wait for responsiveness, then Start over; rehearse `--warm` and inspect its evidence. If the window cannot respond, close only the demo window and relaunch. Do not promise a timing fix without measured proof. | `engine/Viewer.ts` program warmup; STATUS-kiosk S/M measured stalls                               |
| Camera denied/busy                  | Use Skip scan or Continue without scan/Continue →. In Feel, orbit/mouse and Done remain available; do not claim tracking works.                                                                                  | `ScanScreen.tsx` failed/slow actions; `FeelScreen.tsx` camera catch; `feelText.ts` cameraMessage  |
| RAM below 2.5 GiB                   | Close unneeded apps yourself using preflight's top-memory list, wait 60 s, rerun. The automation never kills them.                                                                                               | `preflight.mjs` RAM row; `demo-day-warm.mjs` browserSlot                                          |
| Judge walks away                    | Allow the 90 s idle reset. Feel returns after 20 s without a hand; a running urgent motion bake is protected up to 5 minutes. Start over is the immediate operator action.                                       | `KioskApp.tsx` idle interval; `idle.ts`; `FeelScreen.tsx` noHandExitMs                            |
| Accidental Esc                      | On attract it quits the kiosk: relaunch. Mid-session Esc does not trigger that quit handler.                                                                                                                     | `KioskApp.tsx:442` attract-only Escape condition                                                  |
| A size is missing/disabled          | Missing means no geometry for that size; do not invent it. Disabled means settling/switching: wait for readiness or inspect the displayed cloth error.                                                           | `fitSummary.ts` geometrySizes; `KioskApp.tsx:1144` size filter and disabled guard                 |

- **API dies:** “Reconnecting…” covers the session. The launcher restarts an API that it owns;
  the kiosk returns to the attract screen because the restarted service has forgotten the body.
  A reused API is not restarted by this launcher. Wait; if it remains down, inspect the terminal
  and coordinate with its owner. Do not kill port 8001 or the vision lab on 5711.
- **Camera fails or scan does not pass:** use Skip/Continue without scan. Height/weight fitting
  remains available. On Feel, the camera failure message leaves the 3D view usable with orbit;
  do not claim live hand tracking is working. No hand for 20 seconds returns from Feel.
- **Chrome freezes:** try `Ctrl+Shift+R` only if the page still responds. If it is fully frozen,
  close the demo's own Chrome window with `Alt+F4`, stop the demo launcher with `Ctrl+C`, then
  relaunch `npm run kiosk`. Close only this demo's processes. A fresh launch repeats warm-up.
- **Exit fullscreen:** on the attract screen press `Esc`; anywhere use `Ctrl+Shift+Q`.
  `Ctrl+C` in the launcher stops its own API/browser. `--windowed` starts an app window for rehearsal.
- **New judge:** Start over or `Ctrl+Shift+R` forgets the body and reloads. Inactivity for 90 seconds
  also resets. `Ctrl+Shift+D` toggles diagnostics; `Ctrl+Shift+B` opens the tape comparison board.

## Privacy answers

“Camera frames are processed in browser memory. They are not automatically saved or uploaded; an explicit local recording/export is the exception. Body
measurements go only to the API on this laptop's loopback interface. The kiosk does not read or
write a saved Fit Agent body profile. Start over forgets the service body and reloads the page,
dropping the page's caches. This is local session handling, not a claim of forensic secure erase.”

Models and packages may be downloaded during preparation. The dedicated kiosk Chrome profile
blocks non-local host resolution; prepare the assets before the session. The storefront button
deliberately opens the product's external page in a separate browser window; skip it for an
offline demonstration. No paid LLM or cloud provider is needed for this judge path.

## Pending features and evidence

- **Collar label:** implemented through `fitSummary.ts` collarLine. It identifies estimated neck,
  the single measured collar and uncalibrated thresholds. Missing tapes yield no assessed collar fit.
- **Interactive zipper and hood:** implemented in Feel, with Hood view / Front view and a
  Close the zip recovery control when opened. CX-DAY's first two-pass browser proof confirmed
  both jackets open/close and the puffer hood detaches/reattaches; see
  [raw build-specific proof](validation/demo-day-warm-first.json). Recheck after a build change.
- **Motion readiness:** all six motions exist; the universal ≤10 s bake target and “most ready
  within 1–2 minutes” claim remain unproven. Keep the indicative label and use ready markers.
- **Scan/fit accuracy:** camera calibration and the garment's unmeasured/estimated zones are not
  automatically validated by a successful scan or a smooth animation. Report uncertainty honestly.

## Live try-on: operator privacy and evidence

The new **Try it on you** view is a camera overlay plus fitted moving mirror. Follow its calibration and framing instructions; live output is **Preview**. **Record a move** holds about five seconds of pose locally in memory and waits for a cloth bake before **Physics** playback. A refused recording or invalid bake must remain an error, never be replaced with mock output. Use **Done** and verify the camera indicator stops; **Start over** ends the body session. [Screen status](STATUS-tryon.md), [physics gates](STATUS-tryon-physics.md)

A fake camera proves flow startup/exit and CPU scan initialization only. It cannot validate human tracking, AR alignment or successful human-move physics. Before calling this final-build ready, read [independent validation and GO progress](STATUS-tryon-validation.md). The final run waits for the lead's AR freeze and the normal browser/RAM guards; keep at least 3 GiB free for actual judging and wait for the actual window's green shader dot.

Private reference frames, masks, overlays, sheets and recordings never belong in committed screenshots. Diagnostic outputs derived from a real person go only in `.cache/**` or `docs/validation/look-*.png`, after verifying `git check-ignore`; recording exports stay under the gitignored `data/reference-photos/`. Numerical evidence must retain its method and uncertainty. Do not publish this repository until the separate owner-approved Git-history privacy cleanup is complete. [Privacy contract](../prompts/14-live-tryon.md), [history blocker](AUDIT-demo-day.md)

## Live AR conditions and recorded-input fallback (prompt 16b)

Use even light from in front, a plain background and the camera at chest
height. Begin about **1.5-2.5 m** away; confirm head-to-hips framing, face
the camera and relax both arms for calibration. Raise the arms slowly.
If the room/camera cannot frame the upper body at that distance, follow the
screen guidance rather than promising distance detection the engine lacks.

Before judges arrive, keep **>=3 GiB free RAM**: close completed coding
agents, editors and unrelated browser/apps yourself. Agents never terminate
other owners' processes. The browser-job floor of 2.5 GiB is not a judging
readiness pass; 2.5-3 GiB remains WARN. Wait for the green attract dot in the
actual judge window. A separate warm Chrome cannot guarantee retained GPU
shader cache after restart or memory pressure.

For poor live tracking, use the declared recorded-input lab fallback in the
[28-second live segment](DEMO-SCRIPT-2MIN.md). `/?arlab` -> **local file** ->
select a private raw clip -> **Start**, and state that it is recorded input.
Use **Stop** afterward. Match the clip wearer to the local fitted body; do
not use composite screen recordings as raw camera footage. If no suitable
clip exists, say tracking is unavailable. Never show a mock as successful AR.

Independent quality command: `npm.cmd run ar:score`; results and targets in
[STATUS-ar-eval](STATUS-ar-eval.md). It evaluates files locally through a
no-HMR server on 5791, so do not run it during judging. Private raw captures
and derived images stay ignored; only numerical evidence is committed.
Draft pre-freeze rehearsals are readiness observations. **Final GO requires
the lead's explicit AR-frozen note and final-build revalidation.**
