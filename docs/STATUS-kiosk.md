# S — garment shader programs compiled ahead, without blocking (agent S, 2026-11-13 ~07:15-09:30)

Request: [requests/M-to-lead.md](requests/M-to-lead.md) §2. With a cold GPU shader cache (fresh
Chrome profile, or the first run after the garment shader source changes), the first draw of each
garment program froze the page for 5–8 s; the money shot's X-ray switch froze it for 20–27 s.

## Inventory (measured, cold profile, every program the judge's flow links)
Tool: `.cache/s/flow-s.mjs` (gitignored). Fresh Chrome profile per run; the page hooks
`linkProgram` (program name, defines, length, context), times `getProgramInfoLog` (three's first
use: where a draw waits for the driver), polls `COMPLETION_STATUS_KHR` on three's contexts, and
records long tasks and `renderer.info.programs` per kiosk view at every phase start.

Only one kind of program is slow: the garment shell (`MeshPhysicalMaterial` + the garment
`onBeforeCompile`, ~105 k character fragment shader). Everything else links in ≤ 0.5 s.

| Program (per view; view i always shows product i) | Variants | First draw, before |
| --- | --- | --- |
| garment shell, product look (opaque, `DOUBLE_SIDED`; key differs per finish: anisotropy / clearcoat / sheen) | 1 | attract or dressing: 5.7–7.8 s |
| garment shell, X-ray: transparent double-sided is drawn in two passes, back faces (`FLIP_SIDED`) then front faces, one program each (M's guess, confirmed) | 2 | money shot: 5.0–8.3 s each, 4 in a row |
| garment shadow caster (custom `MeshDepthMaterial`, `DOUBLE_SIDED`) | 1 | 0.17 s |
| padded hood (`MeshPhysicalMaterial` + hood shader) | 1 | 0.22 s |
| hardware details: zip pulls (clearcoat), gunmetal pull, toggles (sheen); default depth casters | 3 + 2 | 0.13–0.19 s |
| fit annotations (LineBasic, MeshBasic) | 2 | small; rebuilt (new programs) at every size switch and return to result |
| Feel: zip pull, edge walls, teeth strips, velcro tabs | 3–4 | 0.14 s |
| motion studio (own WebGL context per open): ground, posed body (vertex colours), baked cloth (sheen, double-sided), 2 depth casters, PMREM | 5 + 6 | 0.15–0.19 s; the cloth program was destroyed and relinked at every motion change |

No skinning, morph targets or instancing in any drawn variant: the motion body is skinned on the
CPU, and the hood's morph targets are removed at load.

How the driver compiles (`.cache/s/compile-exp.mjs`, idle page, a unique comment per program so
each compile is cold): one garment program 6.8 s synchronously, 7.4 s with
`KHR_parallel_shader_compile`; 2 at once 7.4–7.6 s; 4 at once 13.0–13.6 s; 6 at once 16.8–18.5 s.
The GPU process compiles about two at a time, and programs submitted together finish together.
Inside the running kiosk (rendering, MediaPipe, other agents' load) it is about twice as slow:
2 at once ~14 s, 4 at once ~28–30 s.

## Fix
- `engine/programWarmup.ts` (new): `ProgramWarmup.compile(key, target, standIns, shared, lights)`
  calls `renderer.compile()` with the given render target bound (and restores the previous one),
  then polls every program of every material with `isReady()` (`COMPLETION_STATUS_KHR`; both side
  passes of a transparent double-sided material, where `compileAsync` checks only the last). It
  never blocks and never rejects. The stand-ins are never drawn and are kept until the renderer is
  disposed, so the programs they share with real materials are never destroyed when a real
  material is (details, hood, hardware and motion cloth are rebuilt per asset or motion).
- Program key = the real draw's:
  - The scene draws into the composer's targets: `composer.readBuffer` is bound (no tone mapping,
    linear output, as WebGLPrograms.getParameters reads them). Shadow maps and the AO normal pass
    are render targets too, so the same key.
  - Full-screen pass quads (GTAO, denoise, copy, blend, SMAA) are drawn as a bare mesh: compiled
    with an empty lights scene (the scene's lights had added shadow-map code: 4 mismatches in the
    first try, fixed). `OutputPass` sets its defines on its first render: the same defines are set
    before its compile.
  - Stand-ins are twins of the real materials (`twin()` = clone + the same `onBeforeCompile`, which
    is in the key) or come from the same factories (`detailMaterialVariants`, `annotationStandIns`,
    `HoodLayer.programTwin` via a shared `applyHoodLook`, `zipPull`/`TeethStrip`/`EdgeWall`/
    `velcroTab`, `motionBodyMaterial`/`motionGarmentMaterial`). The garment finish code is one
    function (`applyFinish`) for the shell and its stand-ins.
- `Viewer`: batch `scene` (mannequin, ground, AO, annotations, output) at construction;
  `prewarm(finish, 'normal')` = batch `look:<finish>` (shell, caster, details, hood, Feel
  hardware); `prewarm(finish, 'xray')` adds batch `xray:<finish>` (the two X-ray passes).
  `setMode('xray')` switches only once that batch is linked; until then the product look stays
  (the camera still moves). Any later `setMode` cancels a waiting switch.
- `GarmentLayer.show()` waits for `look:<finish>` (and `xray` when in X-ray) before it builds and
  adds the shell (`timing.programsMs`). On a cold cache the wait is behind "Dressing both jackets…"
  (body on screen, page responsive); on a warm one the batch is already linked.
- `MotionScene`: compiles its stage (ground, posed body, baked cloth, depth casters into a 1×1
  target) before its first draw and clears to its background colour until then; the cloth program
  is kept across motions.
- Kiosk warm-up: waits for the views' `scene` batches (small) instead of the old synchronous
  `views[0].compile()` (which built tone-mapped programs the composer never used). After the
  camera models: the product looks of both views, then the X-ray passes view by view.

## Results: cold profile, 5 runs before (`before-1..5`) vs 5 after (`after-7..11`, final build)
Same machine (RTX 3050 Laptop, ANGLE D3D11, installed Chrome, shared with other agents, CPU
~50 % busy), a fresh Chrome profile per run, shared 8001 API, frozen builds of HEAD `270bb72`
(before) and of the final code (after). Flow per run:
- attract 5 s;
- You (172 cm, 65 kg, male), scan 2.5 s, Skip;
- result 12 s, including the money shot;
- size switch to the contrast size and back;
- Try moves, 2 motions;
- Feel on both jackets (zip open and closed, hood view, a standard pull);
- back to result.

Longest main-thread task and longest compile block per phase, as min–max (median) over the runs.
"Programs linked" counts `linkProgram` calls on that context in the phase. "At a draw" means the
program's first use came in the same frame as its link; the other links are background batches.

| Phase | Longest task, before (ms) | Longest task, after (ms) | Longest compile block, before (ms) | Longest compile block, after (ms) | Programs linked, view 0 / 1 / motion: before | after | of which at a draw, after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warm-up (before attract)¹ | 4851–7447 (6867) | 4313–4436 (4359) | 470–6840 (6255) | 488–508 (492) | 19–25 / 6 / 0 | 26 / 26 / 0 | 6 / 6 / 0 (PMREM, at construction) |
| attract (5 s) | 0–6573 (0)¹ | 0–86 (0) | 0–5993 (0) | 0 | 0–5 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| You + scan | 612–815 (648) | 704–793 (729) | 0 | 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Skip → result ("Dressing both jackets…") | 5693–8668 (7424) | **97–138 (107)** | 5664–8589 (7394) | **0** | 5 / 13 / 0 | 2 / 0 / 0² | 0 / 0 / 0 |
| result + money shot (X-ray), 12 s | 21347–31214 (27632) | **73–104 (95)** | 5722–11038 (8786) | **0** | 4 / 4 / 0 | 0 / 2 / 0² | 0 / 0 / 0 |
| size switch and back | 105–130 (125) | 176–230 (203) | 0 | 0 | 6 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Try moves (2 motions) | 193–398 (382) | 108–121 (117) | 187–200 (193) | 0 | 0 / 0 / 12–13 | 0 / 0 / 11 | 0 / 0 / 6 (PMREM, at construction) |
| Feel (both jackets) | 271–494 (281) | 307–387 (345) | 141–153 (143) | 0 | 2 / 2 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| back to result | 0 | 0 | 0 | 0 | 3 / 2 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

¹ Before, the attract jacket's first draw froze the page before the attract screen showed in 4 of
5 runs (warm-up 14.9–16.6 s instead of ~8.9 s), so its 6 s block is counted under warm-up. After,
the warm-up's longest task is not a compile; its longest compile block is PMREM's, 0.5 s.
² The X-ray batch of each view, compiled in the background once the looks were linked. No draw
used them before they were ready.

`renderer.info.programs` per view at each phase start (attract, You, dressing, result, size,
motion, Feel, back, end):
- before-3: `[17,0] [17,0] [14,0] [15,12] [19,16] [17,16] [17,16] [16,16] [19,16]`. Programs
  were created at draws, and destroyed and recreated with details, annotations and hardware.
- after-8: `[20,20] [20,20] [20,20] [22,20] [22,22] [22,22] [22,22] [22,22] [22,22]`. The
  only changes are the two X-ray stand-ins per view.
- After warm-up, no phase added a program at a draw, on either view, in any of the 5 runs.

| Run | Skip → result (ms) | Skip → both settled (ms) | Warm-up (ms) | Dressed | Console errors |
| --- | --- | --- | --- | --- | --- |
| before-1 | 9414 | 10963 | 8945 | yes | 0 |
| before-2 | 7305 | 8867 | 14947 | yes | 0 |
| before-3 | 7087 | 8756 | 16559 | yes | 0 |
| before-4 | 10291 | 11925 | 16157 | yes | 0 |
| before-5 | 8396 | 10189 | 15738 | yes | 0 |
| after-7 | 9564 | 11374 | 8692 | yes | 0 |
| after-8 | 6572 | 8154 | 8588 | yes | 0 |
| after-9 | 6573 | 8280 | 8834 | yes | 0 |
| after-10 | 6521 | 8275 | 8279 | yes | 0 |
| after-11 | 5442 | 7199 | 8865 | yes | 0 |

- **Skip → result, cold:**
  - before: 7.1–10.3 s (median 8.4 s), most of it a frozen page;
  - after: 5.4–9.6 s (median 6.6 s), page responsive throughout.
- **After, the judge pressed Skip before the product looks were linked**: Skip at ~16.5 s, looks
  ready at 21.7–25.7 s. The looks are submitted at the end of warm-up (~8 s) and take
  13.7–17.7 s together in the running kiosk.
- An extra run with a 15 s attract (`after-6`, one build earlier, same look path): Skip → result
  1.5 s, settled 3.2 s.
- **X-ray on a cold cache:** drawn 26.4–27.4 s (view 0) and 29.4–30.7 s (view 1) after the
  money shot. Meanwhile the product look stays, the camera moves, and every control responds.
  Before, the page froze for 21–31 s at that point instead.

## Warm cache
Profile W was first used by `after-11`. Then four sessions ran on it, alternating builds:
`before-warm`, `after-warm`, `before-warm2`, `after-warm2`. The garment shader source hashes are
identical in both builds.

| Run | Skip → result (ms) | Skip → settled (ms) | Longest task in the judge's flow (ms) | Garment compile blocks |
| --- | --- | --- | --- | --- |
| before-warm (W's 2nd session) | 8360 | 9993 | 17171 (money shot) | 4 of 6 garment programs cold: 5.8, 6.8, 10.7, 6.3 s; 2 hits (37 ms) |
| after-warm | 1415 | 3010 | 622 (scan) | none; every garment program linked in 63–322 ms |
| before-warm2 | 1450 | 3059 | 641 (scan) | all hits (34–45 ms) |
| after-warm2 | 1213 | 2828 | 612 (scan) | none |

When the cache holds every program (profile W, sessions 3–5), a session is not slower after the
change: Skip → result 1.2–1.4 s against 1.45 s. Whether the cache keeps holding them across page
loads is a separate question, answered below.

### Judge after judge (page reload in the same Chrome): warm, measured
Follow-up for the lead (2026-11-13 ~09:30). The "open risk" in my first report was a measurement
artifact for the judge-to-judge path:
- the harness closed Chrome after every session, so it measured Chrome's **on-disk** GPU
  program cache;
- the kiosk's reset (operator Ctrl+Shift+R, idle reset, Start over: forget the body, then
  `location.reload()`) reloads the page **inside the running Chrome**. There, the GPU process's
  in-memory program cache serves every garment program.

`flow-s.mjs --sessions 3`: one Chrome, fresh profile, final code, the kiosk's own reset between
sessions. CPU 23–83 % (two Codex agents and H2 running).

| Session | Garment programs (link → ready) | Compile blocks > 30 ms after warm-up | Skip → result | X-ray first drawn vs the money shot | `renderer.info.programs` per view, every phase |
| --- | --- | --- | --- | --- | --- |
| `reload-r-s1` (cold) | compiled: looks +19.3/+19.9 s, X-ray +33.7–34.2 s (background) | 0 | 12.8 s | 29.7 / 32.8 s late | `[20,20]` → `[22,22]` |
| `reload-r-s2` | **all 6 from cache, +82–183 ms** | **0** | **1.54 s** | **on time** (−0.5 s against the harness's estimate) | `[22,22]` throughout |
| `reload-r-s3` | **all 6 from cache, +95–201 ms** | **0** | **1.60 s** | **on time** (−0.8 s) | `[22,22]` throughout |

But the same in-browser reset can also come back cold. Two more one-Chrome runs, during heavy
load from the other agents:

| Run (one Chrome, resets in between) | Free RAM during the sessions (Node `os.freemem`, every 2 s) | Session 2 | Session 3 |
| --- | --- | --- | --- |
| `reload-r` (above) | not sampled; 3.2 GB free at the start | all 6 hits, 1.54 s | all 6 hits, 1.60 s |
| `idle-i`: 75 s attract in session 1 | not sampled; the lock had waited for RAM, 0.5 GB free just before | **all 6 compiled again**: 24.5 s, X-ray 31–33 s late | — |
| `e1`: same as `idle-i` | **min 327 / 416 / 156 MB** in sessions 1 / 2 / 3 | **all 6 compiled again**: 18.3 s | **all 6 again**: 22.0 s |

**Root cause: Chrome's GPU process clears its program cache on critical memory pressure, and
during these runs the machine kept hitting it.** Isolated test (`.cache/s/cache-pressure.mjs`):
one page, the garment program with a unique comment (cold), linked synchronously in fresh WebGL
contexts, 3.0–3.2 GB free throughout:

| Link | Time (ms) |
| --- | --- |
| A, cold | 9624 |
| B, again | 42 (in-memory hit, across contexts) |
| C, again | 34 |
| D, after CDP `Memory.simulatePressureNotification` **moderate** | 33 (kept) |
| E, after the same with **critical** | **8969 (cache dropped)** |
| F, again right after E | **7137** (E's program was not cached again) |

- That is Chrome's own behaviour, outside our code.
- This laptop (14 GB) fell to 150–600 MB free while two Codex agents, H2, the editors and the test
  Chrome ran. Those runs missed on every reload.
- With ~3 GB free, reloads were warm.
- The same mechanism explains the erratic cross-restart table below: those runs also overlapped
  the other agents' load.

Hypotheses checked:
1. **Program source differs between sessions: no.** The source hash (FNV over the full vertex +
   fragment text at `linkProgram`) of every garment, caster and hood program is identical in all
   14 sessions measured, in both builds: `30acb6c`, `c19eb92c`, `35164dd5`, `600621a3`,
   `eb9be5e1`, `eb4f3d51`, `fb32e106`, `1bfa3eed`. Nothing per-session (decal count, uuid,
   formatted numbers, define order) reaches the GLSL.
2. **Context attributes or context loss: no.** The Viewer's WebGL attributes are constants. The
   reset path calls no `forceContextLoss` / `WEBGL_lose_context`; it is a plain
   `location.reload()`.
3. **Flush timing / eviction: memory pressure, see above.** A critical memory-pressure signal
   empties the GPU program cache, and that cache did not take the program back right after.
   Across a Chrome restart (the table below), persistence was erratic in runs that overlapped
   the other agents' load. An isolated two-session test, run on a quiet machine, cached all 5
   test programs.

**Operator mitigation (demo day), in order:**
1. Keep the kiosk laptop out of memory pressure while judges use it: no agents, no editors, no
   other Chrome windows. This test machine dropped to 150–600 MB free under that load; the
   reloads that stayed warm started with ~3 GB free.
2. After every kiosk launch, leave it on the attract screen for about 70 s before the first
   judge. Measured, cold profile:
   - `idle-i-s1`: every garment program compiled in the background by 70.3 s after page load;
   - Skip → result 1.63 s, X-ray on time (−0.56 s), 0 compile blocks.

   Or run one warm-up session in that same Chrome window and reset it.
3. A warm-up in a separate Chrome that is then closed relies on the on-disk cache; see below.
   This is the current `npm run kiosk -- --warm`, which runs a Playwright Chrome on
   `.cache/kiosk-chrome` and closes it before the kiosk Chrome starts.

**Code-level option, not done (needs the lead's decision):** a reset without
`location.reload()`. Reset in-page instead, keeping the two Viewers and their WebGL contexts:
their linked programs would then survive every judge whatever Chrome's cache does. That touches
the whole reset path (workers, camera, React state, motion clients), which M and others built
around a reload. It is too risky to change today without a decision.

### Across Chrome restarts: on-disk cache, erratic (Chrome internal)
Each session below is a new Chrome launch on the same profile. Garment programs compiled again
per session:

| Profile, build | Session 1 | Session 2 | Session 3 |
| --- | --- | --- | --- |
| W: `after-11`, then alternating builds | `after-11`: cold | `before-warm`: 4 of 6 compiled again, **each a 5.8–10.7 s freeze** | `after-warm`, `before-warm2`, `after-warm2`: 0 of 6 (all hits) |
| A: final code, after only | `after-a1`: cold | `after-a2`: 4 of 6 (both looks, both X-ray fronts), in the background; Skip → result 6.2 s | `after-a3`: the same 4 of 6; Skip → result 6.0 s |
| C: settle variant (`ac6f845`, reverted), after only | `after-c1`: cold | `after-c2`: 3 of 6 (both looks, view 0's X-ray front); 16.6 s, CPU at 100 % | `after-c3`: **both looks**, all X-ray hits; 17.3 s |
| K: final code, after only, `--gpu-program-cache-size-kb=65536` | `after-k1`: cold | `after-k2`: 5 of 6 (all but view 0's look); 9.0 s | `after-k3`: 4 of 6 (view 1's look, 3 X-ray passes); 12.6 s |

- After a Chrome restart, on profiles used only by the after build, **product-look programs were
  compiled again in every later launch**: 13–23 s in the background, from the end of warm-up.
  - A and C: both looks, 2 of 2 later sessions each.
  - K: view 1's look, 2 of 2.
  - X-ray programs: kept from session 3 on C, not on K.
  - In the alternating profile W, every program was a hit from session 3 on, in both builds.
  - Every program is cached after a cold session in an isolated two-session test
    (`.cache/s/cache-exp.mjs`: async or sync, drawn at once, drawn 1 s later or never drawn: 5 of
    5 hits). So the kiosk's misses come from the kiosk's own session, not from the async path as
    such.
- I tried delaying each compiled batch's first draw by 1 s (`ac6f845`): no effect (profile C).
  It was reverted (`6ada130`).
- I tried a 64 MB GPU program cache (Chrome switch, profile K): not a fix either. Which programs
  survive changes from session to session.
- Machine state: CPU 60–100 % from other agents during C and K. MediaPipe adds ~300 programs per
  session.
- What this means on demo day:
  - It touches the **first judge after each Chrome launch** (start of the day, or after a crash
    or quit).
  - It also touches **any judge after a critical memory-pressure event**; otherwise judges after
    a reset are warm (tables above).
  - Such a judge, with the final code: a Skip within ~15–25 s of the attract screen waits behind
    "Dressing both jackets…" (page responsive), and the X-ray can come up to ~30 s late.
  - Before the change, the same misses froze the page for 6–11 s per program.
- **Operator mitigation: let the kiosk's own Chrome do the compiling.**
  - After each kiosk launch, leave it on the attract screen for about 70 s (measured: every
    garment program linked by 70.3 s after page load, cold). The kiosk compiles both looks, then
    the X-ray passes, in the background in that Chrome.
  - Or run a warm-up session in that same Chrome window and reset it (Ctrl+Shift+R); do not
    close the window.
  - A warm-up in a separate Chrome that is then closed (the current `npm run kiosk -- --warm`
    design: a Playwright Chrome on `.cache/kiosk-chrome`, closed before the kiosk Chrome starts)
    depends on this on-disk persistence, so for the look programs it is not reliable (profiles
    A, C, K).

### Operator readiness cue (lead's follow-up 1)
- On attract, a 7 px dot in the bottom-left corner, low contrast and `aria-hidden`: grey while
  the jackets' shader programs compile, green once every garment program (both views' looks and
  X-ray passes) is linked. Code: `kiosk/shaderWarm.ts`, wired into the warm-up chain in
  `KioskApp`.
- The same moment logs `[kiosk] shaders warm: every garment program linked <ms> ms after page
  load` (`console.info`) and sets `<html data-kiosk-warm="1" data-kiosk-warm-ms="<ms>">` for
  scripts: CX-DAY's preflight and runbook can wait on `document.documentElement.dataset.kioskWarm`.
- It is not set when a product has no known finish: that jacket's programs would compile on first
  show.
- Unit test: `kiosk/shaderWarm.test.ts`.
- Cold-profile check (`.cache/s/flow-s.mjs --wait-warm`, CPU loaded by other agents, free RAM
  370–3290 MB):
  - grey when the attract screen appeared;
  - green, with `data-kiosk-warm-ms`, at **82.1 s** (`cue1`) and **87.6 s** (`feel1`) after page
    load;
  - the green dot is barely visible in the corner of the attract screenshot (seen).

### Feel screen: the 3.5–4.9 s task (lead's follow-up 2)
**What it is (measured).** User Timing marks around the Feel screen's camera and hand-tracker
start (`feel:camera`, `feel:hand-tracker`), plus a CDP CPU profile from the "Feel the fabric"
click until the first jacket is ready (`cue1`, old path, cold profile, free RAM min 370 MB):
- `feel:camera` 428 ms (async, `getUserMedia`);
- `feel:hand-tracker` **6396 ms** on the first Feel open and 608 ms on the jacket switch (Feel
  remounts per jacket);
- the profile's self time: **5265 ms in native `useProgram`** and 949 ms in `readPixels`;
- so it is MediaPipe's HandLandmarker start: `createHandTracker` →
  `HandLandmarker.createFromOptions` with the GPU delegate, then its warm-up `detectForVideo`.
  Its first inference waits synchronously for its own GPU programs (~57) to link (`useProgram`),
  then reads back. It is slow when Chrome's program cache was purged (memory pressure, above), or
  cold.

**Fix (kiosk call site only; `packages/vision` unchanged).**
- The tracker uses its camera only through the public `CameraHandle` interface (`source`,
  `onFrame` from `start()`). The kiosk warm-up already built a hand tracker on a still stand-in
  camera, then closed it.
- Now the warm-up builds it on a `CameraRelay` (`kiosk/cameraRelay.ts`, 3 unit tests) and keeps
  it for the page's life.
- `FeelScreen` opens only the camera and attaches it to the relay. On exit it stops the shared
  tracker, which releases any held grab through the sink as `close()` did, unsubscribes, detaches
  and closes the camera.
- Without a shared tracker (warm-up failed) Feel builds its own, as before.

| Run (cold profile, one Chrome, agents' load) | `feel:hand-tracker` open / jacket switch | Feel phase longest task | MediaPipe programs linked in Feel | Free RAM min |
| --- | --- | --- | --- | --- |
| `cue1`: old path | 6396 / 608 ms | **5499 ms** | 57 + 57 (two new contexts) | 370 MB |
| `feel1`: shared tracker | **0 / 0 ms** | **259 ms** | 0 | 701 MB |

- The warm-up's longest task did not grow: 6252 ms before, 5739 ms after. The warm-up built this
  tracker before too; it just closed it.
- Memory: one MediaPipe hand context now lives for the page's life, instead of being created per
  Feel open.
- Gates on this change:
  - `handpull-e2e --build`: **PASSED, errors 0**; the no-hand exit after 20.4 s releases the
    tracker and camera;
  - `interact-e2e --build`: **PASSED 9/9, errors 0**;
  - typecheck and `eslint apps scripts` pass;
  - web vitest: **48 files / 271 tests**.

## Looks: renders before vs after
Tool: `.cache/s/shots-s.mjs`. Sandbox canvas renders (the same `Viewer` + `GarmentLayer` as the
kiosk), size M, kiosk lighting: front, three-quarter, back and two X-ray views of both jackets.
Each render waits for the hood and for the cloth worker's state. Pixel diffs (0–255 per channel):

| Pair | Product look (6 renders) | X-ray (4 renders) |
| --- | --- | --- |
| before vs before (two page loads, same build), AO on | 21–37 k px differ, max 11–26 | 276–497 px differ, max 1 |
| before vs after, AO on | 20–36 k px differ, max 14–30 (same as before vs before) | 314–482 px, max 1 |
| before vs after, AO off | **0 px in 4 renders**, 5 and 13 px at ±1 in 2 | 320–481 px, max 1 |

- With AO on, two loads of the unchanged build differ as much as before vs after. The cause is
  GTAOPass's denoise noise texture, built with `new SimplexNoise()` and so seeded from
  `Math.random` on every page load.
- With AO off, before and after are identical, apart from a few ±1 pixels. The X-ray's ±1
  pixels are the same run-to-run noise as before vs before.
- I looked at the renders myself: puffer front and parka X-ray front, before and after. No
  visible difference.
- No GLSL changed: the stand-ins and the hood refactor produce the same shader sources, and the
  per-phase counters show the real draws reuse the precompiled programs.
- The garment programs' source hashes (vertex + fragment) are identical in the two builds:
  `30acb6c`, `c19eb92c`, `35164dd5`, `600621a3`, `eb9be5e1`, `eb4f3d51`.

## Gates
| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `eslint apps scripts` | pass (0 problems) |
| `prettier --check` (changed files) | pass |
| web vitest | **46 files / 264 tests pass**, including the new `programWarmup.test.ts` (10); run on `a5d792a`, the same code as the final |
| `npm run validate:realism` | **pass** (exit 0; 4 assets `pass: True`; two full solves match exactly per jacket) |
| `node scripts/handpull-e2e.mjs --build --port 5764` | **PASSED, errors 0** (`docs/validation/handpull-e2e.json`, final code built 09:08) |
| `node scripts/interact-e2e.mjs --build --port 5765` | Final code: run 1 **8/9**, "parka zip, mouse" stopped at 0.506 ("mouse drag did not open the zip to the hem"; errors 0; CPU 90–100 %). Run 2 **PASSED 9/9, errors 0** (`docs/validation/interact-e2e.json`). An earlier build with the same behaviour (`a5d792a`) also passed 9/9. The Feel phase links no program, so this flake is in the zip drag timing, not in the shaders |
| Cold flow, 5 before + 5 after, fresh profiles | table above; 0 console errors, dressed 10/10 |
| Extra cold runs on the reverted 1 s settle variant (`after-12..16`, `after-c1`; CPU 90–100 % from other agents; vitest ran during `after-12`) | Skip → result 8.3–25.0 s, dressed 6/6, 0 errors. No garment compile block. Under that load MediaPipe tasks reached 12 s (scan) and 4.7 s (Feel), and the motion studio's PMREM blocked 1.33 s once |

Evidence: `docs/validation/kiosk-s-shader.json`. It holds every run per phase, the compile
experiment and the render comparisons. The tools are in `.cache/s/` (gitignored):
`flow-s.mjs`, `shots-s.mjs`, `compile-exp.mjs`, `cache-exp.mjs`, `summarize.mjs`.

## Known gaps
- **The compile itself is as slow as before on a cold cache**, it just no longer blocks: ~7 s of
  GPU-process time per garment program, about two at a time; in the running kiosk the two looks
  take ~14–18 s together and the X-ray passes ~30 s. On the first sessions after a new build or
  on a fresh Chrome profile:
  - the judge may wait behind "Dressing both jackets…" (body on screen, page responsive), but
    only when Skip comes less than ~14–18 s after warm-up;
  - the X-ray switch comes up to ~30 s after the money shot. The product look stays meanwhile,
    and the page responds.

  Only the first judge after a Chrome launch, or after a critical memory-pressure event, can
  meet this (see "Judge after judge" and "Across Chrome restarts" above).
- **Judge after judge is warm when the laptop has free memory.** Across the kiosk's own reset
  (reload in the same Chrome, ~3 GB free), sessions 2 and 3 had 0 slow compiles, Skip → result
  1.5–1.6 s, and the X-ray on time.
- **Chrome drops its GPU program cache on critical memory pressure** (CDP-simulated: 33 ms hit →
  9.0 s miss). On this agent-loaded machine, with 150–600 MB free, every reload recompiled in the
  background. Chrome internal, outside our code.
  - Mitigation: free memory on the kiosk laptop (no agents, editors or other Chrome windows), and
    ~70 s on attract after each launch, or a warm-up in the kiosk's own window.
  - Code option for the lead: an in-page reset without `location.reload()` would keep the
    programs regardless of Chrome's cache.
  - For `npm run kiosk -- --warm` (CX-DAY): warming a separate Chrome that is then closed is not
    a reliable warm-up for the looks. The warm-up must run in the kiosk's own Chrome, or the
    kiosk must idle on attract after launch.
- Under 100 % CPU (other agents), the motion studio's PMREM environment blocked once for 1.33 s
  (task 1.74 s). That is 6 small programs compiled synchronously when the studio opens, normally
  under 0.2 s. Not changed.
- **Cheaper compile not attempted**: changing the garment shader risks the look on demo day.
  Likely cause, for whoever owns the shader: the fragment shader inlines `gRelief` (146 lines)
  4× for its finite differences, `gNoise3` 12× and `gSurfGrad` 5×, and D3D's compiler flattens
  all of it.
- MediaPipe's own WebGL contexts (scan pose, Feel hands) compile ~90 programs each. MediaPipe does
  this itself, outside three.js.
  - Longest tasks there: 0.6–0.8 s with ~50 % CPU, before and after.
  - Under the agents' load (150–600 MB free, CPU 80–100 %), opening Feel took one 3.5–4.9 s task
    in 6 of 8 one-Chrome sessions, with no three.js compile block.
  - That is the hand tracker's start (`packages/vision`, not my path), worth a look by its
    owner.
- The warm-up's longest task (4.3–4.4 s after; 4.9–7.4 s before) is before attract and is not
  a shader compile.
- `renderer.info.programs` per view grows by 2 once, when that view's X-ray batch is submitted in
  the background. No draw links a program after warm-up.

## Commits
- `93cb579` feat(engine): compile garment shader programs ahead, without blocking; draw only once
  linked
- `10b6320` feat(motion): compile the motion stage's programs before its first draw and keep them
- `a5d792a` feat(kiosk): queue the jackets' shader programs after warm-up, looks before X-ray
- `ac6f845` fix(engine): first-draw a compiled shader batch 1 s after it links. Its premise was
  refuted by `after-c2`; reverted in `6ada130`, so the final code equals `a5d792a`'s behaviour,
  which `after-7..11` measured.
- docs: this section, `docs/validation/kiosk-s-shader.json`, the status line in
  `requests/M-to-lead.md` §2


# M — "Try moves" stall in cycle 1 (agent M, 2026-11-13 ~05:00-07:30)

Symptom (L3, P2): `[soak] fit in motion not ready within 180 s`, `state: null`, then no `Close`
button. `window.__satisfyMotion` is set on every render of `MotionStudio` and never removed, so
`null` means the studio never rendered on that page.

## Reproduction
Tool: `.cache/m/soak-m.mjs` (gitignored), a copy of `scripts/kiosk-soak.mjs` with extra
diagnostics:
- all console messages, page errors and workers;
- pointer/click targets and navigations;
- a main-thread heartbeat and `longtask` observer;
- the time of every `getProgramInfoLog` call;
- a CDP CPU profile, mapped through sourcemaps;
- the kiosk state at the click: screen, `.k-moves` enabled, rect, what `elementFromPoint` hits at
  its centre, studio, queue;
- a fresh Chrome profile per run (`M_PROFILE`), i.e. a cold GPU shader cache.

Command: `--cycles 1 --motion-cycles 1 --dwell 10`, under the browser lock, shared machine.

**Before the fix, 6 natural runs with a cold profile:**
- **2 failed** (runs 1-2). The kiosk reset itself before the click (`DELETE /body`, then
  navigation), so the `.k-moves` click had nothing to click (run 1) or landed on the reloading page.
- 4 passed.

**Synthetic, deterministic:**
- A 95 s main-thread stall inside a frame callback, then a click 1.5 s after the page responds:
  **FAIL**. At the click the page was back in warm-up: the kiosk had reset, and the studio never
  opened.
- A click queued during the stall, or sent the instant it ends, still worked: Chrome delivers that
  input before the overdue timers.

## Root cause (three findings; the first two make the dead click)
1. **The main thread blocks for 20–76 s right after the result appears.**
   - Timing `getProgramInfoLog` and the CPU profile show the cause: the first draw of each garment
     `MeshPhysicalMaterial` program (a ~105 k character fragment shader) waits synchronously for
     ANGLE/D3D11 to compile it, **4.9–9.1 s per program**.
   - 2 programs block while dressing (9.1 s + 6.3 s).
   - The money shot's X-ray switch 2.5 s after the result adds **4 programs in a row: 20.1–22.5 s**
     in 16 cold runs, and **~76 s** in run 2 under load.
   - The profile of run 4: 23.8 s of a 50.9 s window inside `getProgramInfoLog`, under
     `Viewer` → `EffectComposer` → `RenderPass` → `setProgram`.
   - With a warm Chrome GPU cache it is gone: the longest task was 1.2 s in the warm loop runs.
     That is why it is intermittent: it hits the first session on a new Chrome profile or after
     the garment shader source changed (other agents' look work). That was P2's "first soak after
     acquiring the lock", while the lead's run used the warm shared profile.
2. **The idle reset counted the stall as judge inactivity.**
   - The 1 s idle check was overdue when the thread freed up. The last input was the Skip click,
     so more than 90 s had passed, and it reset the kiosk before the next click.
   - In the soaks, Playwright was itself blocked in `page.evaluate` during the stall, then waited
     2 s and clicked: the click arrived after the reset.
   - A judge reading the cards without touching the mouse loses the session the same way.
3. **The Try moves button was partly hidden.** The result card's content was ~35 px taller than
   the fixed 368 px card:
   - at 1600x900, button 798–847 vs card bottom 816;
   - at **1536x864, the kiosk laptop's real CSS size**, 761–811 vs 780.
   - So only the top 18–19 px of the 49 px button showed, and `elementFromPoint` at its centre was
     the footer `nav`: a dead click for a person aiming at the middle.
   - Playwright succeeded only by scrolling the `overflow: hidden` card.

Ruled out:
- the button being disabled (always enabled at the click);
- a lazy chunk or worker error (none, and 0 console errors);
- the watchdog (no reconnect overlay);
- B3's dissolve;
- the background bake queue (idle at the click).

The motion path's 410 (lead's clue) is a separate issue; see below.

## Fix (M's paths only, minimal)
- `kiosk/idle.ts` (new, pure, 6 unit tests) and the idle interval in `KioskApp.tsx`:
  - On a visible page, check time beyond the 1 s period (more than 1 s of slack) is a
    main-thread stall, not inactivity. A hidden page's throttled timers still count.
  - While the judge's own motion bake is running in the open Try moves view (`urgentPending`),
    the session stays alive, up to 5 min.
  - Otherwise the 90 s reset is unchanged.
- `kiosk.css`:
  - the result card is a flex column whose children keep their size;
  - the store note shrinks first (it was always below the clip before, so never visible), then
    the collar note (it scrolls) shrinks down to one line;
  - the store / Try moves row is always whole; the card scrolls as a last resort.
  - After the fix: button 764–813 inside the card (bottom 816), and `elementFromPoint` at its
    centre is the button.
  - Cost: the collar note shows one line (it scrolls) instead of three at these sizes.
- `MotionClient.ts`: one retry of a cloth asset after HTTP 410, unless our own reset aborted the
  request (3 unit tests).

Not fixed here, because it is not M's path: **the stall itself.** While it lasts, the page cannot
paint or react to clicks; it handles a queued click once the stall ends, and the studio opens.
- The engine needs async compilation of the garment's normal and X-ray programs
  (`compileAsync` / KHR_parallel_shader_compile, with the composer's render target) before they
  are drawn.
- Exact request: [requests/M-to-lead.md](requests/M-to-lead.md) §2.
- Operator workaround until then: after every new build, run one judge session (e.g. the soak)
  on the kiosk's own Chrome profile before judges arrive, so the GPU shader cache is warm.

## After the fix

| Check | Result |
| --- | --- |
| Repro loop (`.cache/m/loop.sh`): 15 consecutive runs, `--cycles 1 --motion-cycles 1` | **15/15 passed**, studio opened in every run. Dressed 15/15. 0 console errors. 0 non-loopback requests. Six motions baked in every run. |
| Mix of the 15 runs | 13 cold: 12 fresh profiles, plus run 5, the first use of the reused profile. The post-result stalls of 20.1–22.5 s still happen and are survived. 2 warm (runs 10 and 15: longest task 1.2 s). Dwell 0, 3, 5, 10, 20, 30, 45 s. Viewports 1600x900 and 1536x864. Run 7: synthetic 95 s stall, then the click 1.5 s later, **passes** (FAIL before). |
| Standard soak `node scripts/kiosk-soak.mjs --cycles 5 --motion-cycles 1 --dwell 10 --out kiosk-m-soak5.json` | **Dressed 5/5**, 0 console errors, 0 non-loopback requests, all 6 motions ready after click in cycle 1 (8.7–15.6 s each, baked on click), Skip → result median 2.6 s (1.4–3.2 s). Shared Chrome profile, warm. |
| `node scripts/handpull-e2e.mjs --build --port 5745` | **8/8 PASSED**, errors 0 (`docs/validation/handpull-e2e.json`); fps p50 164; latency p50 19–25 ms, p95 30–43 ms |
| `npm run typecheck`, `eslint apps scripts`, `prettier --check` | pass |
| web vitest | 44 files / 253 tests pass, including the new `idle.test.ts` (6) and `MotionClient.test.ts` (3) |

## The lead's clue: HTTP 410 on `GET /fit/{fit_id}/{size}/cloth`
- In `app.py` `forget()` (`DELETE /body/{id}`), every pending cloth build of **every** body is
  cancelled, not only the forgotten judge's. The workers are owner-scoped since P2; that loop is
  not.
- `interact-e2e` / `handpull-e2e` serve against the shared 8001. Any other client's reset there
  410s Z's background preloads, and the motion prewarm too.
- The motion path can hit it (`MotionClient.load` fetches the recommended + contrast cloth), but it
  is not the `state: null` stall: a failed load shows its error inside the studio.
- On demo day (one kiosk, which aborts its own requests before its DELETE) it does not happen.
- Client side: the motion load now retries once. Chrome's own log line for the first 410 cannot
  be suppressed by page code.
- Server fix requested in [requests/M-to-lead.md](requests/M-to-lead.md) §1.

## Commits
- `f8640cb` fix(kiosk): idle reset ignores main-thread stalls / a Try moves bake in progress
- `d5ea454` fix(kiosk): result card always shows the Try moves / store row in full
- `119b78a` fix(motion): ask once more for a cloth asset cancelled by another client's reset (410)
- `e993824` docs(requests): M to lead


# P2 — cloth-asset service speed: Skip → result (agent P2, 2026-11-13 ~01:30-05:15)

Owner paths:
- `garment/{simulation.py, service.py, workers.py (new)}`;
- `native_cache.py` (new; moved from app.py);
- `app.py`, `request_timing.py`;
- tests.

`shell.py` / `config.py` were not touched; proposals for them are in
[requests/P2-to-L3.md](requests/P2-to-L3.md).

## Breakdown (in-process first, no browser)
`.cache/p2/kiosk_seq.py` replays the kiosk's request sequence against a private service on
127.0.0.1:8021 (`SATISFY_TIMINGS=1`):
- Continue → `/body/fit`;
- then `/fit/garment` ×2;
- Skip 2.5 s after Continue → mesh, then both recommended cloth assets and their SDFs;
- then `DELETE /body` (reset);
- the next judge starts 1.5 s later, as in the soak.

The bodies are the kiosk-soak inputs. New opt-in `build_*` Server-Timing phases come from
worker/API stamps (`perf_counter` = QueryPerformanceCounter, one system-wide clock on Windows).
**All numbers are under shared load** from other agents (20–90 % CPU, stated per run). None is
a quiet-machine benchmark.

| Recommended-jacket build (median ms) | before, 1.5 s reset gap | before, 10 s gap | after (A/B, 1.5 s gap) |
| --- | --- | --- | --- |
| Skip → both assets parsed | **6538** | 2391 | **3175** |
| build started before Skip | 716 | 1164 | 1240 |
| waiting for the body prep (armpit + arm sections) | **3043** | 319 | 611 |
| waiting for a worker | 69 | 62 | 368 |
| worker body-section cache | 184 | 170 | 154 |
| `build_shell` | 3107 | 2578 | 2441 |
| rest of the asset (render data, lists, pydantic) | 136 | 124 | 126 |
| result back to the API (pickle + pipe) | 31 | 28 | 28 |
| JSON encode (5.0 MB) | 16 | 15 | 16 |
| SDF build | 5770 | 2451 | 3096 |

**Cause.** A kiosk reset replaced the whole `ProcessPoolExecutor`: it cannot address one
worker, and it was the only way to make workers forget a body. So the next judge's jackets
waited for four fresh processes to import torch/trimesh.
- A fresh worker takes 4.7 s to start (spawn + `import body_service.garment.simulation` 4.3 s:
  `pose` → torch 1.7 s, `fit` → anny/roma/`torch._dynamo` 1.4 s, trimesh 0.9 s).
- In the soak, the next Continue comes only ~1.5 s after the reset.
- With a 10 s gap (warm workers) the same code gives 2.4 s instead of 6.5 s.

Serialisation, JSON size, transfer and the client are not the bottleneck: JSON 16 ms,
pickle/pipe 31 ms, client geometry 32–51 ms (B4).

## What changed
1. **Addressable asset workers** (`garment/workers.py`, replaces the executor).
   - A reset cancels that body's queued jobs.
   - It terminates and replaces only the workers still running that body's jobs, which keeps
     `test_reset_stops_running_asset_process`.
   - Every other worker runs a forget call before its next job: drop the body's shell sections,
     then `gc.collect()`, as the API does for itself. Warm workers stay warm.
   - A worker that dies unexpectedly fails its job with `BrokenProcessPool` and is replaced.
   - Daemon processes keep `_exit_with_parent`. The pool is shut down at exit, before
     multiprocessing's handler.
   - Workers now live across judges, so they install the same rtree id adapter as the API (C's
     memory fix). It moved from app.py to `native_cache.py`.
2. **Priorities.**
   - Body prep first, then the shown jackets, then the collision field, then other sizes.
   - When workers are short (e.g. a reset just replaced some), the field is queued behind the
     prep, so it does not take the worker a shown jacket needs.
   - A request joining a queued build promotes it.
   - `warm_cloth`'s other sizes wait while **any** shown build is in flight; before, they
     waited only on active HTTP requests, so they could compete with the other jacket's
     recommended build during the scan dwell.
3. **Speculative garment fit reused.** The client's `/fit/garment` takes the very fit object
   speculation computed. Before, it was recomputed under the garment lock. A reset forgets
   unclaimed ones (`removed.speculative_fits`).
4. **Robustness.**
   - Jobs ship trimesh meshes as vertices and faces only.
   - A cached rtree index in the payload intermittently failed to load in a worker
     (`Index_Create: InvalidPageException: Unknown page id 0`). This hit the shared 8001 while
     it ran P2's work in progress. Fixed in `acf4e07`, with a regression test.
   - Any non-reset worker failure is rebuilt in the API process with the same pure function
     (`cd403d1`), so a judge gets the identical asset, never a 500. Test: a synthetic crash
     gives a byte-identical asset.
   - 8001 was restarted via `restart-api.ps1` after the fix was committed and green. Smoke
     test: both jackets 200; `api.err` clean.
6. **The waited jacket builds at NORMAL** (`c4033fa`).
   - When the client requests a fit's **recommended** size (the kiosk dresses it right after
     the scan), that build is raised from BELOW_NORMAL to NORMAL until it ends, whether it is
     running or still queued. The worker then returns to its base class.
   - Speculative builds during the scan dwell stay below normal, which is the scan's protection
     (cfdfea7). Other sizes stay below normal too.
   - Why: in the diagnostic soak below, the shell took ~4.5 s next to Chrome vs ~2.4 s
     in-process.
7. **Opt-in timing:**
   - `build_ahead`, `build_prep_wait`, `build_pool_wait`, `build_cache`, `build_shell`,
     `build_assemble`, `build_return`, `build_build`, `build_pose`, `build_sdf_build`,
     `build_prep_build` in `Server-Timing` (numbers only);
   - `SATISFY_TIMINGS=1` only; JSON and OpenAPI are unchanged.

Not done (measured or reasoned, not worth it now):
- **Binary/compact asset format.** JSON encode is 16 ms and client parse+validate ~0.17 s,
  against a 2.4 s shell.
- **Worker count.** Still 4; a 5th spare costs RAM on a 14 GB machine.
- **Raising all workers' priority while any client waits.** Rejected: the client's background
  precompute requests would also raise it during the result screen's fps window. Only the
  waited recommended build is raised (item 6).

## Identity proof
`.cache/p2/identity.py`:
- runs every size of both jackets on 7 bodies (soak cycles 1, 2, 6, 9, 12, 18 + 172/65 M)
  through `SimulationAssets` with workers: 77 cloth assets + 7 SDFs;
- uses two frozen source snapshots that differ only in P2's files: same `shell.py`/`config.py`
  hashes (`d2aaef63…`/`366ea104…`);
- hashes `model_dump_json(exclude={"build_ms"})` (a wall-clock timing).

Result: **84 / 84 hashes identical** (470 MB of JSON and field bytes).
`test_a_failed_worker_build_falls_back_in_process_with_the_same_asset` covers the fallback path.
The shell sweep cannot change: P2 changed no shell code, and the sweep (`scripts/shell_defect_sweep.py`)
calls `build_shell` directly.

## Kiosk soak (browser lock held; shared load, not a quiet machine)

| Run | Code | Cycles | Dressed | Console errors | Skip → result median (warm) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `kiosk-p2.json` | P2 (`acf4e07`) | 20 | **20/20** | 0 | 10.3 s | **Contaminated by P2 itself**: P2's pytest (2 workers) and the 8001 restart overlapped cycles 6–9 (cycle 8: 27.8 s). The machine sat at 96–98 % CPU throughout (another agent's Blender hood job + Chrome). |
| `kiosk-p2-8.json` | P2 (`7fdc899` snapshot) | 8 | **8/8** | 0 | 6.8 s (cycles 2–8; 5.9–8.3) | ~40 % background CPU; fps at result 81–124 |
| `kiosk-p2-hboost.json` | P2 + waited-NORMAL boost (`c4033fa` snapshot, same shell) | 6 | **6/6** | 0 | **5.7 s** (cycles 2–6; 4.7–6.9) | fps at result 90–149, scan 20–21 Hz (unchanged) |
| pre-P2 service snapshot, and a second `7fdc899` run | before / P2 | – | – | – | – | Both aborted in cycle 1 with "fit in motion not ready within 180 s" (motion state null). Each was the **first** soak of its lock hold, so this is flaky and not code-specific; it is a client/motion issue, not P2's. **No same-session browser before/after pair exists.** |
| B4 (CX, earlier) | before | 10 | 10/10 | 0 | 6.5 s | shared load, other session |

**Finding.** The in-process replay shows the gain (A/B 4.4 → 3.2 s, interleaved, same load). The
browser soaks give 5.7–6.8 s, against B4's 6.5 s from another session: no clear browser gain. In the browser context,
the build behind each jacket takes about 2× the in-process time (≈ 8.5 s from Continue vs ≈ 4 s).
The kiosk's `requestTimings` buffer (128 samples) is full before cycle 2, so the soak JSON carries
no per-cycle server phases. A diagnostic soak with a server-side phase log (private snapshot, not
committed) is described below.

**Diagnostic soak** (6 cycles, `7fdc899` + a stderr phase log in a private snapshot):

| Measure (cycles 2–6) | Value |
| --- | --- |
| Skip → result | 5.3–6.7 s |
| client cloth request after `/body/fit` (≈ Skip) | ~2.7 s |
| build started before that request | 0.8–1.2 s |
| prep wait | 0.3–1.1 s |
| pool wait | ~0.01–0.02 s, one 2.4 s |
| **`build_shell`** | **3.8–4.9 s** (in-process replay: 2.4 s) |
| assemble | 0.14–0.29 s |

So in the browser context, the shell itself runs ~2× slower: CPU shared with Chrome (scan,
render) at the workers' BELOW_NORMAL priority. The kiosk also re-fits and re-dresses the attract
reference body after every reset (cached assets), and the client's other-size precompute
follows each result.

With the boost (server log of the `hboost` soak, the waited builds of cycles 2–6):
- shell 3.5–5.7 s;
- built ahead of Skip 0.8–1.3 s;
- prep wait 0.3–0.9 s.

So the NORMAL boost did not measurably shorten the shell next to Chrome in 6 cycles; the
5.7 s median is within the spread of the other runs. It is kept because it is harmless (scan Hz
and result fps unchanged), but it is **not claimed as a gain**.

**Verdict.**
- The ≤ 2.5 s target is **not met**. In the browser the remaining time is the `shell.py` build
  itself (3.5–5.7 s next to Chrome, 2.4 s in-process). Before P2, the reset respawn added about
  3 s on top of that.
- Reaching 2.5 s needs `shell.py` faster (proposals 1–4 in
  [requests/P2-to-L3.md](requests/P2-to-L3.md), expected 0.5–0.9 s in-process), and/or the build
  started earlier than ~1 s before Skip.
- On a quiet machine with warm workers, the in-process replay with a 10 s reset gap already
  gave 2.4 s; the browser adds Chrome's CPU share on top.

## Memory (workers now live across judges)
In-process replay of the 20 soak bodies (frozen `c4033fa` snapshot), measured after every reset
(`.cache/p2/final-20.json`):
- **Skip → result median 2.96 s**, shell median 2.78 s;
- API private memory 1351 → 1386 MB;
- the two long-lived workers 1051 → 1138 MB and 1087 → 1106 MB;
- the two workers replaced each reset ~760 MB;
- tree working set 1444 → 1512 MB (+3.4 MB per judge).

`fix(body): rotate…` therefore replaces one idle worker that has lived through 8 resets, at a reset
where no other worker had to be stopped. The trend after that change has not been re-measured.
The C memory soak (40 cycles) was not rerun.

## Gates
- Full body pytest (`cb788ee`): **322 passed, 1 failed**, 465 s. The failure was the new priority
  test reading the class a moment before the pool set it; `ba3df0d` makes it poll, and it passed
  3/3 alone. Earlier full run: 318 passed + 1 (`test_product_collar_identity`, fixed in
  `e29a12e`'s follow-up `_speculative()`).
- `ruff check` / `ruff format --check`: clean.
- Asset identity: 84/84 (above).
- Shell sweep: unaffected by construction (no shell code changed); not rerun, because the live tree
  holds L3's uncommitted `shell.py` / `config.py`.
- `node scripts/handpull-e2e.mjs --build --port 5745`: **8/8 PASSED**, 0 errors
  (`docs/validation/handpull-e2e.json`). It ran against 8001 on `cd403d1`.
- No web files changed.

## Shared API
8001 had been started at 02:56 on P2's uncommitted work in progress. It returned 500s
(`InvalidPageException` in a worker). After `acf4e07` + `cd403d1` were committed and green, it was
restarted via `.cache/shell/restart-api.ps1` (03:49). Smoke test: both jackets 200; `api.err` clean.
It does not yet run `c4033fa` / the rotation fix. Restarting it now would load L3's uncommitted
`shell.py`, so the lead should restart it when that is committed.

## Next
- L3 proposals 1–4 (`shell.py` / `surface_query.py`).
- A quiet-machine browser soak, same session, before vs after. Note: the first soak in a lock
  hold failed twice at "fit in motion".
- A 40-cycle memory soak with the rotation.

## P2 round 2 (lead follow-ups, 2026-11-13 ~05:00-05:40)

**Proposal 5, lazy torch/anny imports (`f0bdfe5`).**
- `fit.py` and `pose.py` (given to P2 for this change) now import torch and `.model` inside
  `_fit` / `display_body` only. `neck_girth.py`, CX-A's file, gets the same import-only change:
  workers reached torch through `garment/fit_math`.
- `import body_service.garment.simulation`: 4.3–5.6 s → **1.4 s**; torch and anny are no longer
  loaded.
- A fresh worker is ready in **2.0–2.2 s** instead of 8–13 s (same ~90 % CPU load).
- Identity:
  - fit response, GLB, landmarks, rest mesh, display pose and the 8 cm neck girth of 7 bodies
    are hash-equal before vs after (**42/42**);
  - `tests/test_lazy_torch.py`: a worker-side load of a pickled body without torch, with
    bit-identical arrays, plus fit/pose determinism.

**Skip → result with L3's `a421ff2`.**
- In-process A/B, interleaved, 3 × 5 cycles each, same load, `shell.py`/`surface_query.py`/
  `config.py` before vs at `a421ff2`, everything else at HEAD:
  - median **3.59 s → 2.90 s**;
  - `build_shell` median 3.34 → 2.99 s;
  - prep wait 0.37 → 0.24 s.
- Browser, the 40-cycle soak below (HEAD `f0bdfe5` snapshot incl. `a421ff2`, 2 × 20 cycles):
  - Skip → result median **4.76 s / 4.88 s** per half (3.6–6.2 s; one 21 s outlier in half 1);
  - dressed 40/40, console errors 0;
  - result fps median 103 / 110, scan 20 Hz.
  This is better than the earlier P2 browser runs (5.7–6.8 s) and B4 (6.5 s), but not a
  same-session before/after pair.
- L3 later dropped the closest-point pruning (`88c0e28`, "no gain"); not re-measured.

**40-cycle memory soak.**
- `npm run kiosk:soak` × 2 halves of 20 (`kiosk-p2-mem-1.json`, `kiosk-p2-mem-2.json`), the browser
  lock taken per half (≤ 15 min).
- One persistent API (127.0.0.1:8031, `f0bdfe5` snapshot, `SATISFY_KIOSK_MODE=1`) served both
  halves. The soak reused it, so memory is continuous across all 40 cycles.
- Each process sampled every 5 s; table every ~23 s ≈ 1 cycle in `.cache/p2/mem.log`.
- After the first cycle, linear trend per cycle:

| Process | Slope / cycle | First 10 % → last 10 % (median) |
| --- | --- | --- |
| API private bytes | +0.21 MB | 1615 → 1655 MB |
| 4 workers, private bytes (sum) | −2.81 MB | 3694 → 3493 MB |
| whole tree working set | −7.2 MB | 1632 → 1238 MB |

**Flat.** Always 4 workers. Per-cycle values swing ±200 MB with builds and resets; there is no
upward trend.

**8001.**
- `git status services/body` was clean right before the restart.
- Restarted via `restart-api.ps1` at 05:37 on HEAD `5ec33c3`.
- Smoke test: both jackets 200 (4.9 / 4.3 MB), collision field 200; `api.err` clean.

## Commits
- `e29a12e` perf(body): the client's garment fit reuses the speculative one
- `acf4e07` perf(body): keep asset workers warm across kiosk resets; jackets first
- `cf2829a` docs(requests): P2 to L3
- `cd403d1` fix(body): a failed worker build falls back to an in-process build
- `7fdc899` perf(body): replacement asset workers import at the default priority
- `c4033fa` perf(body): the recommended jacket a shopper waits for builds at NORMAL priority
- `cb788ee` fix(body): rotate an idle asset worker after 8 kiosk resets
- `ba3df0d` test(body): the priority test polls

Local tools (gitignored, in `.cache/p2/`):
- `kiosk_seq.py`: request replay with phases and memory;
- `identity.py` / `identity.sh`: asset identity;
- `snapshot.sh`, `ab.sh`: frozen-source interleaved A/B;
- `shell_profile.py`: cProfile of `build_shell`;
- `soak-ab.sh`, `with-lock.sh`, `wait-run.sh`: soaks under the browser lock.


# Z — interactive zip and detachable hood (agent Z, 2026-11-12 23:00 – 11-13 ~05:30)

## Update ~05:30 (the lead's follow-ups). This supersedes the gaps, the hood resting place and the "fronts barely part" verdict below.
- **e2e:** `node scripts/interact-e2e.mjs --build --port 5745 --screenshots` → **8/8
  scenarios, `passed: true`, 0 console errors**, 0 non-loopback requests
  (`docs/validation/interact-e2e.json`). P2 fixed the shared API's 500.
  - The closed state is still bit-identical: parka `88e88dba`, puffer `559def21`, unchanged
    after the zip and hood runs.
  - fps p50 164 (idle 164).
  - Cloth latency p95: parka 58–75 ms, puffer zip 60–81 ms, hood 46–47 ms.
  - Split step p50: zip 20–24 ms, hood 12 ms.
- **Open fronts with a flat-pattern rest.** This applies to the split solver only, and only
  while the zip is open; it blends in and out over 0.5 s.
  - Flattening the solver's hinges did nothing: they are one triangle wide, where the worn curve
    is almost straight (2.76 vs 2.77 cm on the live puffer M). The curve lives at panel scale.
  - Instead, each front row is held softly at its flat (material-arc) length over 10 cm spans,
    one-sided. The fronts' soft tether supports let go. The two padded edges meet at the
    midline (half the loft each), because the region solver runs no cloth self-contact.
  - `ClothSolver` gets one method for this, `setSoftSupports` (`1e35c97`); it is never called on
    the base solver.
  - Closed hood teeth now hold the collar side at its attached place. Leaving it free let the
    funnel collar sag 12.8 cm; welding it to the moving hood dragged the collar.
  - **Physics with a flat-pattern rest, not measured against a real jacket.**

  | 100 % open, live M | collar top | upper chest | chest | waist | hem | e2e largest gap |
  | --- | --- | --- | --- | --- | --- | --- |
  | puffer (Node) | 0.5 cm | 1.0 cm | 2.7 cm | 2.7 cm | 6.8 cm | 8.2 cm |
  | parka (Node) | 3.1 cm | 1.0 cm | 1.0 cm | 1.9 cm | 9.5 cm | 12.5–12.7 cm |

  - No front particle inside the body.
  - The gaps reach their final values by ~1.5–2 s.
  - Residual motion: fronts ≤ 1.2 mm/frame. The collar shows 1.5 mm/frame, the same jitter
    the base solver has on L2's live collar.
  - Honest verdict: the fronts now visibly part. On the parka a strip of body shows,
    widening to the hem; on the puffer the lining shows down the front. They do not swing wide:
    with a hinge-only cloth model and gravity, a front lying on the chest stays on it.
- **Hood set-down.**
  - Let go fully off, H's padded hood eases (0.6 s) onto the floor beside the right foot,
    standing on its zip edge with the opening up (H's `restingTransform`; UX, not a simulated
    fall).
  - Picked up again, it travels from that pose to the hand's as the drag goes toward the collar.
  - The hood view is now a full-body view (2.9× the front framing's distance). The orbit keeps
    the kiosk's target, so the floor shows only that far out.
  - Picking H's mesh needed its bounding sphere and box refreshed, because H moves its vertices
    on the CPU, and a two-sided proxy, because a hood standing opening-up shows its lining.
- **Not done:** collision of the rigid hood against the body (it can still pass through the
  shoulder if dragged there).
- Commits: `1e35c97` … `66894df`. Screenshots: `docs/validation/interact-*-zip-{0,50,100}-*.png`
  and `interact-puffer-hood-{on,mid,off}.png`, all from this run.

**State.** On Feel the fabric, on both jackets (new jacket switch under the title), a judge
drags the zip pull with the mouse/touch or a webcam pinch: down opens the jacket to the hem, up
closes it. On the puffer the hood (agent H's padded hood) comes off its collar zip and goes back
on. Closed + hood on is the measured shell, **bit-identical**: the shown shell's hash is the same
before and after every interaction in the e2e (parka `88e88dba`, puffer `559def21`). The fit
numbers never change; while the jacket on screen is open the Feel card says "Jacket open, not
measured" and the standard pull and the fabric pull are off.

## Design
- **The measured solver is never touched.** The cloth worker keeps the base solver (the shell
  and the hand pull). The zip runs on a second solver built from a split copy of the asset
  (`engine/interact/seam.ts`): the CF line is duplicated (the wearer's right takes the copies),
  and so is the hood's collar line. Closed teeth are welded after every substep (`weld.ts`:
  mass-weighted midpoint, one velocity; a closing tooth moves ≤ 2 mm per substep, 1.2 m/s).
- **Same physics, unrolled.** The split solver runs the base config with `substeps 1, dt / 10,
  selfEvery × 10`, so h, gravity, damping and compliances are the base solver's and welds go
  between substeps. **`ClothSolver.ts` is not edited.**
- What the split copy drops, because an open jacket does not have it: tethers crossing the opened
  CF in front of the body, the closed neckline/chest/hem rings, the neck chords.
- A moving region (`setRegion`) covers fronts, yoke and collar; sleeves stay kinematic.
- **Display.** While something is open, the GarmentLayer's mesh is hidden and a split mesh with
  the same material is shown (attributes copied per source vertex). Open front edges get a band
  to the padding's depth (`EdgeWall`; parka black tape, puffer shell), so they are not a thin
  film. Once everything is closed and at rest (or after 2.5 s), the view **cross-fades in 0.3 s
  back to the measured shell (a visual blend between two simulated states, not physics)** and the
  split solver stops.
- **Hood = semi-rigid, never cloth** (lead's decision 2026-11-13). With H's `HoodLayer`
  (`docs/requests/H-to-Z.md`): pick `garment.hood.mesh`, `setState('detached', progress)` (H's baked
  peel keys), and near full detach `setRigidTransform(translation of the hand)` blended in over
  the last 30 %. The teeth strips use H's frontier (`liftedAt`, w 0.35). If H's hood is absent
  (load/fit failure), a stopgap moves the shell hood's own vertices as one rigid body (a turn
  about the zip's frontier, then a translation). Hood progress comes from hand travel (2 cm
  slack, fully off after 18 cm).
- **UX conventions (labelled, not physics):**
  - a hood let go fully off is **set down beside the wearer's right hip** with a 0.18 s ease
    (20 cm outside the jacket, 15 cm above the hem; lead's direction); it hovers there, since
    there is no surface; the hint reads "Hood off · drag it back to the collar to zip it on";
  - bringing it back follows the drag toward the collar on screen: the fraction of the way
    moves the hood that fraction home, since a screen drag cannot undo the depth part of the
    resting offset;
  - let go within 15 % of off it finishes coming off; bringing it back, within 50 % of on it
    zips on;
  - the slider let go within 4 cm of a stop runs to the stop.
- **Input.** `InteractController` raycasts what is shown. Pointer events are captured on the
  viewer, so orbit never takes them, and a release outside the canvas still ends the drag. A
  pinch goes through the hand-pull path: `HandPullController.handlePinch` tries the zip pull and
  the hood first.
- **Affordance.** A DOM glow ring round the pull (pulses faintly, bright on hover/grab),
  grab/grabbing cursors, and a green tint on the shell hood on hover. The puffer gets a gunmetal
  slider with a swoosh-shaped pull and silver teeth; the parka a black slider and pull.

## Asset contract used
- L2's paths, in the live shell: `paths.center_front` (collar top → hem) and `paths.hood_zip`
  (the puffer hood's collar row, right → left).
- Fallback: the CF found by |x| < 2 mm on the front panels, walked as one edge chain.
- H's API: `docs/requests/H-to-Z.md`. Z's requests: `docs/requests/Z-to-L2.md`.

## Numbers (frozen build on :5745, installed headed Chrome, RTX 3050, fake camera, reference 172/65 male, size M; machine shared with other agents)
Final run 2026-11-13 ~03:45 (`docs/validation/interact-e2e.json`): **scenarios 8/8 PASS**.

| | idle Feel fps p50 | fps p50 / p5 while interacting | cloth latency p50 / p95 ms (n) | split step p50 / p95 ms | cloth Hz | largest front gap |
| --- | --- | --- | --- | --- | --- | --- |
| parka zip, mouse | 164 | 164 / 161 | 37 / 52 (168) | 18.9 / 23.2 | 42 | 3.9 cm |
| parka zip, pinch | 164 | 164 / 161 | 40 / 55 (82) | 20.2 / 26.3 | 40 | 4.4 cm |
| puffer zip, mouse | 164 | 164 / 83 | 37 / 48 (179) | 17.4 / 22.2 | 45 | 7.6 cm |
| puffer zip, pinch | 164 | 164 / 82 | 50 / 68 (83) | 18.0 / 27.2 | 44 | 7.6 cm |
| puffer hood off + on, mouse | 164 | 164 / 82 | 35 / 48 (115) | 11.6 / 23.0 | 58 | — |
| puffer hood off + on, pinch | 164 | 164 / 82 | 35 / 53 (199) | 12.0 / 22.0 | 58 | — |

- The e2e reports `passed: false` for **one console error**: an HTTP 500 from the shared API
  during the run. Its URL is not in Chrome's console message, and it is not from the zip or the
  hood: no interaction request goes to the API. The zero-error gate counts it, so it is reported
  as such.
- No non-loopback requests.
- The shown-shell hash is identical before and after every interaction: parka `88e88dba`, puffer
  `559def21`.
- **Gates.**
  - fps p50 is unchanged, 164 (the display rate): the 90 % gate holds. Earlier runs on a busier
    machine saw 83 on hood runs once, and the e2e flags such runs.
  - The p5 dips are single frames: the split solver build (0.2–0.45 s in the worker) and the
    first swap.
  - Cloth latency p95 ≤ 68 ms in the final run, ≤ 94 ms in every run, under the 100 ms budget.
    The pull itself moves at render rate on the main thread.
- **Hand pull e2e** (`node scripts/handpull-e2e.mjs --build --port 5745 --out handpull-z`,
  with Z's code): **8/8 PASS**, fps p50 164, latency p95 33–35 ms.
- `ClothSolver.handpath.test.ts` is unchanged and passes.
- **Node, live shells (M).** In the closed state, after re-welding, the split solver differs
  from the base by at most 1.7–2.4 cm and 0.6 mm on average: the cross-fade covers that.

| Fully open zip, gaps along it | collar top | chest | hem |
| --- | --- | --- | --- |
| puffer | 6.2 cm | 0.3–0.8 cm | 6.9 cm |
| parka | 3.3 cm | 0.3–0.9 cm | 3.5 cm |

## Honest visual verdict
- **The zip works and is physical, but the fronts barely part.** The collar top flares and the
  hem parts by a few cm; across the chest the fronts stay together. The reason is not a bug:
  - the shell's rest shape is its worn shape (`rest == initial`: there is no flat pattern);
  - the solver's hinges and soft tether supports hold that shape;
  - so an unzipped front keeps its curve;
  - a held front edge follows the hand only ~1–2 cm, the same limit as the hand pull.

  Real fronts that swing open need flat pattern data (L2) or a solver change. That is a decision
  for the lead, not a look tweak.
- **Zip look.**
  - Parka: each half shows its black tape; the open seam reads as a dark line with a white gap.
  - Puffer: silver teeth show on the open part; the placket stays on the left front (a shader
    remap above the slider, a labelled visual approximation).
  - The pulls are ~1–3 cm, small at kiosk distance; the glow ring is what makes them findable.
- **Hood (H's padded hood).** It holds its form: a padded bowl, no shredding.
  - Held, it moves rigidly with the hand.
  - Let go, it eases to its resting place beside the right hip and hovers there. It does not
    fall: a stated demo convenience.
  - The peel between on and off is H's baked keys. Z assumes no shape: whatever H bakes is
    shown.
  - Dragged into the shoulder, it can intersect it (rigid, no collision).
- **Not the jacket's fault, but visible:**
  - the live puffer collar jitters even in the base solver (1.3–1.9 mm per frame, measured; for
    L2);
  - H logged "Hood seam has a gap over 3 cm" fit errors in some runs and fell back to the shell
    hood (for H).

## Known gaps
- No live-hand test of the zip or hood. The pinch is replayed synthetically through the same
  handlers.
- The e2e may correct like a person: up to 2 extra close drags and up to 4 aim nudges, counted
  in the JSON. The final run needed none (0 / 0 / 0).
- Agent H's "resting" baked key for the set-down hood is requested (`docs/requests/Z-to-H.md`).
  Until then the resting hood is the `detached` bowl, translated.
- Wide-open fronts need flat rest data (see the verdict).

## Tests and gates
- vitest 41 files / 232 tests. New:
  - `interact/seam.test.ts`: split, re-weld, contract paths, refusal;
  - `zipMath.test.ts`: slider → teeth, cursor → slider, hood state machine, frontier, texts;
  - `InteractDriver.test.ts` (P2 fixture): zip open/close, base solver bit-identical, hood
    off/on, the hood rigid and its transform.
- tsc clean; ESLint and Prettier clean on Z's files.
- e2e: `node scripts/interact-e2e.mjs --build --port 5745 --screenshots`. It writes
  `docs/validation/interact-e2e.json` (both jackets; `--jackets 1` for the puffer alone) and
  screenshots `docs/validation/interact-*.png`:
  - zip 0/50/100 % front and 3/4, both jackets, with close-ups;
  - hood on / mid / off.
- Minimal `KioskApp.tsx` hook (2cde918): Feel on either jacket. Only Z's hunks were committed;
  CX-B's working-tree edits were left untouched.

# Prompt 09 CX-B (B3 transitions, B4 Continue -> result breakdown; agent CX, 2026-11-13 ~01:00-02:10)

Numbers below were taken holding `.cache/locks/browser` with all benchmark ports free, but other
agents' non-browser work (and, in the first cycles, someone else's start-up) was running: labelled
**shared load, not a quiet-machine benchmark**. Evidence JSON: `docs/validation/kiosk-cx-b3.json`
(20 cycles), `kiosk-cx-b4.json` (10 cycles).

## B3: smooth transitions (Codex's work in progress, completed)

- **Camera.** `CameraRig` moves with a fixed 0.85 s smoothstep (frame-rate independent, starts and ends
  at rest) instead of the old exponential approach; `enterResult()` dollies 6 % toward the front pose as the
  result appears; a user orbit still cancels the move. Tested in `cameraTransitions.test.ts`.
- **Jackets fade in.** On the first dress of a view, a DOM copy of the naked body is laid over the canvas and
  fades out (420 ms) when the shell is on screen. It is a CSS dissolve over the canvas: no garment geometry,
  material, opacity or shader is touched. **Fix on top of Codex's version:** the snapshot was taken one frame
  after `showBody`, when the stage was still `hidden` (container width 0, second canvas still 300x150), so
  the cover was silently never created. A rAF opacity log (`kiosk-transition-shots.mjs`) showed no cover at
  any frame. `awaitLayout()` now waits (<= 600 ms, else no dissolve, never a stall) until the container is laid
  out and the canvas has its size. Measured after the fix: both covers exist during dressing and fade
  1.00 -> 0.02 in 0.2-0.9 s.
- **No layout jump.** The result cards appear in the area the "Dressing both jackets..." banner occupied
  (fixed-height collar line and a reserved loading line); cards fade/slide in over 320 ms.
- **Honest text.** Per-jacket line says `preparing cloth...` until the jacket has settled, then `settled`;
  the result card says `Cloth settling...`, `Cloth ready.` or `Cloth unavailable.`. No percentages, no fake progress.
- **Reduced motion.** `prefers-reduced-motion: reduce` (checked live): camera snaps, no dissolve, no turntable,
  no card animation. Verified with a reduced-motion run: no cover ever created, jackets and cards appear at once.
- **Watchdog unchanged**: `watchdog.test.ts` passes; no change to its code.

Soak, final code: `npm run kiosk:soak -- --cycles 20 --out kiosk-cx-b3.json`:

| Check | Result |
| --- | --- |
| Dressed | **20 / 20** (both jackets on the body at the result) |
| Console errors / non-loopback | 0 / 0 |
| Result-screen fps (1.5 s after result), median of 20 | **115.5** (range 96-154) |
| Fps during the session, median | 152 |
| Earlier soak, same machine, before the final fix | 119 at result, 149 in session (first CX run of the same code but without the layout wait) |
| Latest other soaks | `kiosk-w-mem.json` 5 cycles under load: 65 / 23 / 113 / 94 / 85 at result, 146-159 in session; `kiosk-wasm-w3.json` 141; `kiosk-l2-l2-17408.json` 111 / 127 / 124 |
| JS heap in session, first 3 -> last 3 cycles | 168.9 -> 155.2 MB (flat) |
| renderer.info after reset, cycle 1 vs 20 | geometries 9 -> 3, textures 13 -> 11, programs 16 -> 13 (flat) |
| Skip scan -> result, median of 20 | 7.2 s (the first three cycles 16-18 s under start-up load) |

`node scripts/handpull-e2e.mjs --build --port 5745` (own frozen build, working tree incl. other agents' dirty files): **8/8 PASSED** on the rerun of the final code (`docs/validation/handpull-e2e.json`), and 8/8 on an earlier run of the same B3 code before the layout-wait fix. One run of the final code failed a single replay (04-22-24 chest: the first pinch missed the jacket, `firstStartAsExpected` false, grabs 2 missed 1) while the other seven passed; it is not reproduced on the rerun, so I call it replay-timing flakiness under shared load, not proven unrelated. The rerun's 2 console errors are `Padded hood could not be fitted ... gap over 3 cm` from the hood/interact code in the working tree (not B3).

**Frame sequence.** `node scripts/kiosk-transition-shots.mjs [--reduced]` (CDP screencast, local JPEGs in
`.cache/kiosk-transition/{normal,reduced}/` with an `index.json` containing the dissolve opacity log). What I
saw in the normal run: two naked bodies under the banner "Dressing both jackets..." with `preparing cloth...`;
the puffer fades in over the body (frame at 35.8 s is half-transparent), then the parka (36.3 s, ghosted),
then the result cards fade up under the unchanged stage; no frame shows a flash, a blank canvas or the stage
resizing. In the reduced-motion run the jackets and cards simply appear. The screencast delivers only changed
frames (about 8 fps while the page is busy), so the dissolve itself is evidenced by the rAF opacity log rather
than by every intermediate frame.

## B4: Continue -> result breakdown (10 cycles, 2.5 s scan dwell, `SATISFY_TIMINGS=1`)

Stages, median of 10 (median of the 9 warm cycles in brackets). The body and both garment fits are already
prefetched while the scan screen is open, so after Skip:

| Stage | Median ms |
| --- | --- |
| Body fit (server) | 9 (9) |
| Skip -> body mesh on screen | 47 (45) |
| Recommended shell, parka, visible after body | 6233 (6366) |
| Recommended shell, puffer, visible after body | 5992 (5856) |
| of which cloth-asset request wait (parka / puffer) | 6124 / 5902 |
| of which shell geometry build on the client | 51 / 32 |
| of which morph | 0 / 0 |
| Skip -> result screen | 6517 (6412) |
| You "Continue" -> result (includes the 2.5 s scan dwell) | 9438 |
| Worker ready (cloth solver) after Skip | 6962 / 6520 |

Cycle 1 (cold) was 12.8 s Skip -> result and 27 s from Continue. Per-cycle values are in `kiosk-cx-b4.json`
(`recommendedDressPhases`, `requestTimings`).

**Conclusion.** About 95 % of Skip -> result is the service building the recommended cloth asset (the client
only waits for it; transfer + parse + validation is about 0.17 s for the 5 MB payload and the render submission is
about 0.12 s). The service starts that build speculatively right after `/body/fit`, so what remains after
the scan dwell is the shell build itself. Nothing in `apps/web/src/kiosk/**` can shorten it; the one thing
the kiosk could do, starting the fit before Continue, would spend a full fit per keystroke and is not done.

### Requests to Claude

- `garment/**` and the asset workers (shell.py is L2's): the recommended-size cloth asset takes about 6.0 s to
  arrive after Skip when the speculative build started 2.5 s earlier, i.e. roughly 8.5 s of build per jacket
  with two builds in parallel. This is the single dominant Continue -> result stage. Useful splits to take
  (not measurable from the browser): queue wait vs shell build vs SDF/collision-field build vs serialisation
  in `SimulationAssets`; `build_ms` is overwritten by the total (see `docs/look/result-timing.md`).
- `motion/**`: no request from this run.


# Prompt 07 B — Codex timing instrumentation (benchmark pending)

Opt-in `SATISFY_TIMINGS=1` + `/?kiosk&timings`: unchanged API JSON/schema,
numeric service dispatch/asset wait/JSON encode headers, bounded client body-read,
decode/parse/zod/byte-count samples and CPU first-render submission. Scoped tests:
Python 2/2, web 3/3; lint/format/typecheck pass. Details and measurement definitions:
[result-timing.md](look/result-timing.md). This is not a speed-up result. Historical
4.6 s / loaded P1 6.0 s remain historical; no after value invented. Dedicated
service/quiet frozen-build benchmark pending available RAM (observed 1.89 → 1.14
GiB). Shell-vs-queue and GPU-completion splits remain gaps, not mislabeled numbers.
No shared service restarted and no garment-owner path edited.

# Prompt 08 W3 — collider queries in WebAssembly, bit-identical (agent W, 2026-11-12 ~23:00–00:30)

**Result: every bake is now 24–33 % faster than JS and still bit-identical. 6 of 12 (motion, size)
cases are at or under 10 s (7.9–12.1 s).** Commit `09bceab`.

**What.** The ArticulatedCollider's queries now run in the kernels module, one instance per
collider (`motion/wasm/colliderKernels.ts`, collider section of `cloth/wasm/solver.as.ts`):
- `distance` with its per-pose linearised cache;
- `full`, `rigid` / `sampleSegment` / `trilinear`;
- the zone search, with the same cell order, hints and tie-breaks;
- `closestOnTriangle`, `exactDistance` and `surfaceVelocity`.

The collider's `Math.hypot` (zone gradient) is imported from JS; V8's hypot is not a plain
sqrt of the sum. `setFrame` stays in JS (`buildZone` uses `acos` and `hypot`) and copies its
pose in.

While attached, the query state (cache, hints, last winner) lives in the module. Detach copies it
back, so the relax cache's clone continues exactly. A pose whose zone grid outgrows the reserved
memory detaches to JS.

**Checks.**
- `bakeCheck.mjs`: **12/12 identical** at the commit, and 36/36 run pairs in the benchmark. The
  hashes differ from the W1/W2 runs only because the collider is back at HEAD (D2 above).
- **Worker self-check, on the body's own data at the `body` message** (`colliderCheck.ts`, about
  90 ms): a JS collider and a WebAssembly one answer the same query sequence. It covers two poses,
  distance with and without a gradient and threshold, cache neighbours, surface velocity at known
  and new points, and exact distance. It runs again after detach. Every float64 must match;
  otherwise the bake keeps the JS collider and logs once.
- `colliderKernels.test.ts`: nudging distance, surface velocity or exact distance by 1e-12 is
  caught, and a failure falls back to JS with one log line.
- `bake.test.ts`: the WebAssembly solver and collider equal JS with a fresh and a cached relax.

**Bake seconds, Node.** Taken under the machine-wide lock; JS and WebAssembly alternating, median
of 3, relax cached. CPU load median 18 % (1–76 %; other agents' CPU jobs, no browser).

| motion | size | JS s | WebAssembly s (W3) | change | JS ms/step | WebAssembly ms/step |
| --- | --- | --- | --- | --- | --- | --- |
| reach_up_both | S | 16.2 | 11.9 | −26 % | 70.1 | 51.2 |
| reach_up_one | S | 15.7 | 10.6 | −33 % | 67.7 | 45.3 |
| reach_forward | S | 12.9 | **8.9** | −31 % | 62.1 | 42.7 |
| sit | S | 15.9 | 12.1 | −24 % | 54.5 | 41.3 |
| bend_tie_shoes | S | 17.0 | 11.9 | −30 % | 63.6 | 44.6 |
| cross_arms | S | 13.4 | **9.6** | −28 % | 61.1 | 43.4 |
| reach_up_both | M | 13.7 | **9.9** | −28 % | 59.5 | 42.5 |
| reach_up_one | M | 12.3 | **9.0** | −27 % | 53.2 | 38.7 |
| reach_forward | M | 11.2 | **7.9** | −30 % | 53.9 | 37.7 |
| sit | M | 14.9 | 10.1 | −32 % | 51.1 | 34.4 |
| bend_tie_shoes | M | 15.8 | 11.2 | −29 % | 59.1 | 41.7 |
| cross_arms | M | 11.8 | **8.3** | −30 % | 53.7 | 37.5 |

The fresh relax (first motion of a size) drops from 1.65 / 1.63 s to 1.07 / 1.05 s.

**Kiosk soak with motions** (one cycle, 60 s dwell, under the lock, load about 10 % at the
start). Same command as the W2 A/B below; single sample.

| motion | JS (W2 A/B) | W2 | W3 |
| --- | --- | --- | --- |
| reach_up_both | 24 ms | 29 ms | 34 ms |
| reach_up_one | 26.8 s | 135 ms | 121 ms |
| reach_forward | 16.4 s | 6.9 s | **559 ms** |
| sit | 24.3 s | 17.0 s | 13.0 s |
| bend_tie_shoes | 26.5 s | 18.9 s | 13.5 s |
| cross_arms | 23.4 s | 12.2 s | 8.3 s |

- In the 60 s dwell the queue finished 3 pairs, against 1 (W2) and 0 (JS).
- Dressed 1/1, 0 console errors, 0 non-loopback requests. Report:
  [kiosk-wasm-w3.json](validation/kiosk-wasm-w3.json).
- **Chrome memory: fixed** (`696f3bd`). The solver and collider kernels now take their instance
  from a per-thread pool (`kernels.ts` `acquireInstance`). A free instance is zero-filled above
  `heapBase` and reset, so it behaves exactly like a fresh one. Each bake returns it in a
  `finally`. A worker now holds one solver memory (≈ 12 MB) and one collider memory (≈ 17 MB);
  before, each bake made up to four that only GC freed. Hashes are 12/12 identical with the pool,
  and `bake.test.ts` checks that the instances are reused and returned.

**5-cycle soak with motions, under the lock**
(`npm run kiosk:soak -- --cycles 5 --motion-cycles 5 --dwell 60 --out kiosk-w-mem.json`).
Dressed 5/5, 0 console errors, 0 non-loopback requests. Per cycle, at Try moves:

| cycle | Chrome working set at open → after the sweep, MB | main-thread JS heap in session, MB | cached bakes at open |
| --- | --- | --- | --- |
| 1 | 1216 → 1354 | 410 | 6 |
| 2 | 1671 → 1743 | 423 | 6 |
| 3 | 1608 → 1640 | 411 | 6 |
| 4 | 1664 → 1772 | 429 | 6 |
| 5 | 1754 → 1773 | 424 | 6 |

- **Flat after the first cycle.** Cycles 2–5 sit in 1.61–1.75 GB at open and 1.64–1.77 GB after the
  sweep, against 2.18 / 2.28 GB in the single W3 run before the fix. The JS heap stays at
  410–429 MB.
- **Ready-after-click, not yet baked:** 8.6–20.2 s. The machine had other load this time
  (render fps 23–113 at the result).
- **Hand pull e2e:** `node scripts/handpull-e2e.mjs --build --port 5745` gives **8/8 PASS**,
  errors 0, fps p50 164.

**Where the time goes now** (cross_arms M motion phase, 45 ms/step in the profile):

| part | share |
| --- | --- |
| Final and hot-list strain limit, WebAssembly | ≈ 18 % |
| Stretch, WebAssembly | ≈ 15 % |
| Zone search, WebAssembly | ≈ 13 % |
| `buildZone` per pose, JS (acos and hypot per corner) | ≈ 5 % |
| Hinges, contact, layer pairs, velocity, tethers, rigid cores, cache | ≈ 35 % |
| Metrics, skinning, snapshots, JS | the rest |

The largest parts are Gauss–Seidel chains and an ordered nearest-face search. Making them faster
would mean reordering, and reordering changes the results, so ≤ 10 s on the longest motions
(sit S 12.1 s; reach_up_both S and bend_tie_shoes S 11.9 s) is not reachable bit-identically on this laptop.

# Prompt 07 D2 — elbow zone: E5 applied as a lead-accepted exception (agent W, 2026-11-12/13)

**Update 2026-11-13 ~00:40: E5 is applied** (`696f3bd`, `MOTION_FIT.elbowZoneRings = 3`).
- **Lead's decision.** The lead accepted the exception. The extra penetration (+0.10 / +0.21 cm on
  cross_arms) sits in the elbow crease, which the arm itself hides. The strain gain is visible:
  the M outlier edge goes 3.00 → 2.10, and median frame-worst 1.33/1.28 → 1.21/1.26.
- **Re-run on the committed code.** `node scripts/motion-validate.mjs e5-final` reproduces the
  E5 row below exactly for all 12 cases. Per-case vs baseline (worst / median frame-worst /
  penetration):
  - reach_up_both S 1.66→1.68 / 1.316→1.320 / 1.46→1.49; M 1.40→1.58 / 1.236→1.250 / 1.56→1.50
  - reach_up_one S 1.54→1.54 / 1.263→1.270 / 2.58→2.63; M 1.48→1.45 / 1.179→1.172 / 3.29→3.20
  - reach_forward S 1.29→1.27 / 1.175→1.172 / 0.93→1.12; M 1.19→1.15 / 1.113→1.102 / 0.64→0.64
  - sit S 1.09→1.08 / 1.046→1.046 / 1.35→1.49; M 1.09→1.09 / 1.047→1.045 / 0.39→0.37
  - bend_tie_shoes S 1.48→1.48 / 1.282→1.309 / 1.23→1.26; M 1.35→1.32 / 1.185→1.187 / 1.07→1.04
  - cross_arms S 2.30→2.26 / 1.330→1.212 / 3.13→3.23; M 3.00→2.10 / 1.276→1.255 / 3.08→3.29
- **New JS ≡ WebAssembly baseline** (`bakeCheck.mjs`, E5 and the pooled instances): 12/12
  identical. The hashes changed from W3 because the collider topology changed.
- **The Python reference test** still uses P1's zone (`parseArticulatedSdf(…, 0)`). A new test
  checks the E5 topology: P1's faces first, two elbow zones, and their old borders interior.

The original findings follow.


**Result at the time: nothing committed to the collider** (superseded by the update above). `articulatedCollider.ts`, its test and
`motion/config.ts` are back to HEAD, which reads P1's `zone_border_edges` again. Codex's
work-in-progress is kept in `.cache/codex-d-wip.patch`, and W's variant implementation in
`.cache/d2-variants-w.patch`. `scripts/motion-validate.mjs` and its test are committed; the
validator now bakes with the bit-identical WebAssembly kernels. Re-running it on HEAD reproduces
the baseline hashes exactly (`d-before`, cross_arms S).

**Variants.** Each is P1's zone plus optional extra skin faces, and optionally a zone search
beyond the rigid-core distance:
- `arm`: rings over every arm zone.
- `elbow`: rings over the two elbow zones only. These are found as the zone components carrying
  both upper-arm and forearm weight.
- `unbound arm`: the extra search applies whenever an arm core wins the query.
- `unbound elbow`: the extra search applies within 3 cm of an elbow zone's border sphere.

Codex's tree state was "arm, 3 rings, unbound arm". The lead's `d-after` numbers came from an
earlier Codex variant.

**Measures.** Strain is woven shell edges with rest ≥ 3 mm (`motion-validate` `shellStats`).
"pen" is the bake's own check: the deepest particle, measured with the variant's own collider.
"ref pen" measures every variant with P1's collider, so all variants share one yardstick.

| cross_arms (S / M) | worst edge | median frame-worst | pen cm | ref pen cm |
| --- | --- | --- | --- | --- |
| **baseline (HEAD)** | 2.297 / 3.000 | 1.330 / 1.276 | 3.13 / 3.08 | 3.13 / 3.08 |
| Codex `d-after` | 2.590 / 2.672 | 1.965 / 1.859 | 3.58 / 3.54 | — |
| Codex tree: arm 3 rings, unbound arm | 2.279 / 2.581 | 1.604 / 1.781 | 3.58 / 3.49 | — |
| E1: arm 3 rings, bounded | 2.089 / 2.801 | 1.222 / 1.779 | 3.16 / 3.07 | — |
| E2: no rings, unbound arm | 2.454 / 2.482 | 1.460 / 1.345 | 3.49 / 2.18 | — |
| **E5: elbow 3 rings, bounded** (conservative) | **2.261 / 2.097** | **1.212 / 1.255** | 3.23 / 3.29 | 3.07 / 3.29 |
| E6: elbow 3 rings, unbound within 3 cm of the elbow | 2.644 / 2.196 | 1.674 / 1.531 | 3.56 / 3.53 | 3.24 / 3.16 |
| elbow 1 / 2 / 4 / 5 rings, bounded | S 2.27 / 2.03 / 2.68 / 3.33 | S 1.342 / 1.331 / 1.310 / 1.192 | M 3.29 / 3.25 / 3.39 / 3.36 | — |

**The best variant, E5, still fails.**
- **Every other case passes:** median frame-worst is within 1.05 × baseline, and penetration is
  within 0.2 cm. The largest penetration changes are reach_forward S 0.93 → 1.12 cm and sit S
  1.35 → 1.49 cm.
- **cross_arms strain improves:** the M outlier edge goes 3.00 → 2.10, and median frame-worst
  1.33/1.28 → 1.21/1.26.
- **Its penetration is slightly worse:** +0.10 cm (S) and +0.21 cm (M), so it fails "not worse".
- **Why:** `pendiag` (scratch) puts the deepest particles of the baseline in the left elbow
  crease, at P1 zone faces 3567–3681. E5's deepest are in the right elbow crease: 87
  particle-frames deeper than 2 cm, against 29, partly on the new faces. With the zone continuous
  over the crease, the sleeve is measured inside the collapsed LBS crease. The final strain
  limit then holds it there; by design the fabric limit wins over contact.
- **Timing:** within noise (+3–5 % under parallel load).

**Other variants:**
- Only the unbounded-arm variants fixed reach_up_one penetration (2.6/3.3 → 0.8/0.6 cm, per
  Codex). Each of them makes cross_arms worse.
- E5 leaves reach_up_one at 2.63/3.20 cm.
- So no variant both removes the elbow seam and keeps the crease honest. The real fix is upstream
  in P1's zone export: a zone that overlaps the forearm core, or a crease-aware skin. The
  solver-side limit (contact against the strain limit) is the other lever; it changes every bake.

**Decision for the lead:** E5 is the variant to take if a 0.1–0.2 cm deeper elbow-crease reading
is acceptable in exchange for the 3.00 → 2.10 outlier. It is a one-line config change once the
patch is applied.

# Milestone 08 — W: motion bake in WebAssembly, bit-identical (agent W, 2026-11-12 ~21:00–23:00)

**Result: every bake is 13–24 % faster and bit-identical to JS. The ≤ 10 s target is met for
only 1 of 12 (motion, size) cases on a quiet machine (9.7–16.3 s).** The remaining time is
mostly the body collider, which stays in JS: W3 (collider queries) waits for Codex's D2.
In the kiosk A/B (one soak cycle each), a motion the queue had not baked yet was ready 7–19 s
after the click, against 16–27 s with `&motionwasm=0`.
Commits: `897b7bc` (W1), `e814b6a` (W2), `92ae038` (DECISIONS), plus this documentation commit.

**What runs in WebAssembly** (`apps/web/src/engine/cloth/wasm/`, AssemblyScript 0.28.20, see
DECISIONS.md):
- **W1:** prediction (integration), stretch, hinges, tethers/collar supports/root anchors,
  particle self-contact, the hot-list strain limit, the final strain limit with its
  contact-depth credit, the velocity update with skin-relative Coulomb friction, and the
  hot-edge collection. Used for the relax and for the motion.
- **W2:** body contact (slack skip, per-pose tangent-plane reuse, compliant and hard push),
  cloth-on-cloth layer contact and the layer-pair rebuild (cell table, top-k per source).
- **Still JS:** exact collider queries (`ArticulatedCollider.distance` / `surfaceVelocity`,
  called from WebAssembly through imports, in particle order), collider posing, ring and cuff
  constraints, snapshots and the fit metrics.

**How.** `ClothSolver.attachKernels` moves the solver's hot arrays into the module's linear
memory and keeps typed-array views on it, so JS and WebAssembly work on the same numbers and a
substep copies nothing. `stepSmallKernels` mirrors the full-mesh branch of `stepSmall` call for
call. Each kernel repeats the JS expressions in the same order. WebAssembly f64 arithmetic is
IEEE-754 like JS numbers, there is no FMA or SIMD, and `Math.sqrt/min/max/abs/floor` compile to
their f64 builtins. `(x - q) ** 2` was checked to equal `x * x` in V8 (12 M random samples).
The memory is sized once and never grows, so the views stay valid. A region, grabs or a
collider without surface velocity run the unchanged JS step on the same views. **The hand pull
never attaches kernels.**

**Hash proof.** `node apps/web/src/engine/motion/wasm/bakeCheck.mjs` bakes all 12 (motion,
size) cases on the P2 fixture with JS and WebAssembly in the same process. It hashes
everything a bake returns: positions, strain, exposure, per-frame metrics, summary, checks.
- At W1: 12/12 identical.
- At W2: 12/12 identical, with the same 12 hashes as at W1.
- In the benchmark: 36/36 run pairs identical.
- The tree included Codex's uncommitted D2 collider files. They were unchanged during every
  run (md5 checked before and after).
- `ClothSolver.handpath.test.ts` is unchanged and passes (`5abf26c3` / `ae0742d3`).
- `bake.test.ts` adds a JS-vs-WebAssembly test with a fresh and a cached relax.

**Runtime self-check and fallback** (`cloth/wasm/selfCheck.ts`, `motion/wasm/motionKernels.ts`):
- At worker start (the `body` message), a tiny fixture runs with JS and with WebAssembly: two
  overlapping 8 × 8 sheets with tethers, a collar ring, an elastic row, layer pairs and self
  contact, stepped 8 steps against a moving sphere, in two configs. Every float64 of the cloth
  is compared after every step. It takes about 70 ms the first time, including the compile.
- On any difference, a compile or instantiation error, or a failed attach, the worker bakes
  with JS and logs one `console.warn`. The judge sees nothing.
- `?kiosk&motionwasm=0` forces JS (`MotionClient.motionWasmRequested`).
- `kernels.test.ts` disables each kernel in turn (11 kernels) and perturbs the pair rebuild;
  the self-check catches every one. A forced mismatch and a module that fails to compile both
  give JS with exactly one log line.
- The `.wasm` is embedded as base64 in `solverWasm.ts`, so the kiosk works offline.
  `npm run check:wasm` rebuilds it with the pinned compiler and must match byte for byte; a
  unit test checks the recorded source hash.

**Bake seconds, Node, quiet machine** (ports 5720/5730/5740/5745/5750/8011 free, ≥ 3 GiB free
at the start). JS and WebAssembly alternated in one process, order swapped every run; median of
3; relax cached, like the kiosk's later motions. CPU load over the run (whole machine, 12
logical cores, so one busy core ≈ 8 %): median 14 %, range 4–66 %. The spike came from another
agent; it hit bend_tie_shoes M run 3.

| motion | size | JS s | WebAssembly s | change | JS ms/step | WebAssembly ms/step |
| --- | --- | --- | --- | --- | --- | --- |
| reach_up_both | S | 15.2 | 12.3 | −19 % | 65.7 | 53.2 |
| reach_up_one | S | 13.9 | 11.1 | −20 % | 59.8 | 47.6 |
| reach_forward | S | 12.3 | 10.1 | −18 % | 59.3 | 48.2 |
| sit | S | 16.7 | 13.7 | −18 % | 57.3 | 46.9 |
| bend_tie_shoes | S | 18.8 | 16.3 | −13 % | 70.5 | 61.2 |
| cross_arms | S | 13.7 | 11.0 | −20 % | 62.6 | 50.0 |
| reach_up_both | M | 14.6 | 12.6 | −14 % | 63.4 | 54.7 |
| reach_up_one | M | 14.1 | 11.1 | −21 % | 60.9 | 47.9 |
| reach_forward | M | 12.7 | 9.7 | −24 % | 61.3 | 46.7 |
| sit | M | 16.5 | 13.4 | −19 % | 56.6 | 46.1 |
| bend_tie_shoes | M | 18.1 | 14.8 | −18 % | 67.8 | 55.5 |
| cross_arms | M | 13.9 | 10.9 | −21 % | 63.4 | 49.7 |

- **Fresh relax** (the first motion of a size): JS 1.72 / 1.56 s, WebAssembly 1.16 / 1.05 s
  (S / M). Particle self-contact dominates the relax.
- **JS today is slower than agent E's 11–17 s.** Same machine, quiet. The tree now has D2's
  extended arm zone (more exact zone faces per query), so both columns include it.

**Where the time still goes** (WebAssembly path, cross_arms M, motion phase, CPU profile, 51
ms/step):

| part | share |
| --- | --- |
| Collider, JS: zone search 23 %, zone grid rebuild per pose 5 %, rigid cores (sampleSegment + trilinear) 7 %, closestOnTriangle 3 %, cache/dispatch/surface velocity 3 % | ≈ 41 % |
| WebAssembly kernels: stretch 14 %, final strain limit 13 %, layer pairs and contact ≈ 12 %, hinges, tethers, velocity, self-contact | ≈ 50 % |
| Metrics, skinning, snapshots | the rest |

The WebAssembly loops run only 1.3–1.7× faster than the JS ones. They are Gauss–Seidel
chains: each edge reads the positions the previous edge just wrote, then needs a sqrt and two
dependent divisions. Neither engine can overlap them without reordering, and reordering
changes the results. Even with free kernels a step would still cost the ≈ 21 ms collider. So
≤ 10 s for every motion needs W3, the collider queries in WebAssembly.

**W3 not started.** Prompt 08 allows it only after D2 has landed or been abandoned. D2 is still
uncommitted: `articulatedCollider.ts` and `config.ts` were last modified at 18:20. A port also
has to import `Math.hypot` from JS (it is used in the zone gradient) and keep the zone cell
order and the linearised cache exactly.

**Hand pull end to end** (`node scripts/handpull-e2e.mjs --build --port 5745 --out handpull-wasm`, quiet slot, frozen build): **8/8 PASS**, errors 0. fps p50 164 / p5 161, latency p50 21–29 ms, step p50 3.8–9.4 ms, worst shell 1.613 (03-40-22 @shoulder). Report: [handpull-wasm.json](validation/handpull-wasm.json). The hand pull does not use the kernels; this checks that nothing else changed.

**Kiosk soak with motions** (`npm run kiosk:soak -- --cycles 1 --motion-cycles 1 --dwell 60`, installed headed Chrome, quiet slot, machine load about 20 %; single samples). The judge opens Try moves after a 60 s dwell and clicks every motion in button order, 4 s apart. The JS baseline is the same command with `SATISFY_KIOSK_EXTRA_QUERY=&motionwasm=0`, run right after it. Ready-after-click ("ready" = baked by the background queue before the click):

| motion | E2, after, 60 s dwell (JS, busy machine 35–76 %) | JS now (`&motionwasm=0`) | WebAssembly |
| --- | --- | --- | --- |
| reach_up_both | 180 ms | 24 ms (ready) | 29 ms (ready) |
| reach_up_one | 32.4 s | 26.8 s | **135 ms (ready)** |
| reach_forward | 23.6 s | 16.4 s | 6.9 s |
| sit | 37.0 s | 24.3 s | 17.0 s |
| bend_tie_shoes | 41.0 s | 26.5 s | 18.9 s |
| cross_arms | 29.6 s | 23.4 s | 12.2 s |

- In the 60 s dwell, the WebAssembly queue finished one more pair than JS: 4 cached bakes at the
  open, against 2.
- Both runs: dressed 1/1, 0 console errors, 0 non-loopback requests, agent profile not stored.
- Reports: [kiosk-wasm.json](validation/kiosk-wasm.json),
  [kiosk-wasm-js.json](validation/kiosk-wasm-js.json).
- **Caveat:** the JS run also reached the result later (Continue → result 9.8 s against 7.2 s),
  so part of the difference is run-to-run noise. The Node table above is the controlled
  comparison.

**Gates (web):**
- `tsc` clean.
- eslint and prettier clean on every file W touched.
- vitest: 34 files / 185 tests pass.
- `npm run check:wasm`: matches.

# Demo hardening 06 — E: motion bake speed (agent E, 2026-11-12 ~13:30–15:45)

**Target ≤ 10 s per (size, motion): not met.** Bakes are 3–5 % faster for the first motion of a
size and 10–15 % faster for the later ones (the relax is now done once per size). Every bake is
bit-identical to the code before E, so strain and the hand pull are unchanged.
Commits: `643883e`, `a2e5db3`, `72abd34`, `1183707`, plus this documentation commit.

**Where the time goes.** Profile of cross_arms M on the 07:32 fixture:
- about 1.7 s relax on the neutral pose;
- 216 motion steps at 52–60 ms each.

Each step is 10 substeps over 8,796 particles and 25,000 edges:

| part | share of a step |
| --- | --- |
| stretch | ≈ 13 % |
| final strain limit (16 passes, 2 full sweeps per substep, never converges early) | ≈ 15 % |
| body contact (≈ 7,700 exact articulated queries per step, mostly zone searches) | ≈ 25 % |
| hinges | ≈ 5 % |
| integration and friction | ≈ 7 % |
| layer pairs, tethers, self-contact, collider posing, metrics | the rest |

No single part dominates, and the loops were already tight. Code that keeps results identical
cannot halve them.

**What changed (bit-identical):**
- **Relax once per size.** Every contract motion starts from the same frame-0 pose, so the
  worker keeps the relaxed solver and collider (`BakeOptions.relaxCache`, `cloneState.ts`). Later
  motions copy this state (0.15–0.2 s) instead of relaxing again (1.6–1.9 s). The copy goes into
  objects made by the constructors: stepping a plain deep copy was 30–50 % slower per step,
  because its objects had other shapes.
- **`rebuildLayerPairs`**: a reused typed-array cell table and a top-k insert replace the Map and
  sort. Same pairs, same order; about 110 → 70 ms per call.
- **Hot loops**: the strain-limit, hinge and velocity loops read their arrays from locals.
- **Collider**: no per-face arrays when posing the zone grid. The skin velocity reuses the
  distance query just made at the same point.
- **Tried and reverted**: skipping zone cells farther than the best distance. Equally close
  faces then won in a different order, and all 12 hashes changed.

**Bake time, Node, one bake alone on an idle machine** (s). Same fixture as `motion-fit.md`;
before = `9faa6cf` code in the same session, interleaved:

| motion | size | before | after, first motion of the size | after, later motions (cached relax) |
| --- | --- | --- | --- | --- |
| reach_up_both | S | 15.6 | 15.3 | 15.1 * |
| reach_up_both | M | 15.3 | 14.3 | 13.0 / 14.3 * |
| reach_up_one | S | 14.3 | 13.8 | 13.0 |
| reach_up_one | M | 13.6 | 13.2 | 11.9 |
| reach_forward | S | 13.0 | 12.8 | 11.5 |
| reach_forward | M | 12.4 | 12.7 | 11.1 |
| sit | S | 16.5 | 15.6 | 14.8 |
| sit | M | 16.0 | 15.3 | 14.7 |
| bend_tie_shoes | S | 18.0 | 17.4 | 16.6 |
| bend_tie_shoes | M | 17.6 | 17.0 | 16.3 |
| cross_arms | S | 14.1 | 13.5 | 12.2 |
| cross_arms | M | 13.6 | 13.2 | 12.2 |

\* Measured in a busier window, when the same run's fresh cross_arms took 14.7–15.1 s instead
of 13.2–13.5 s. Run-to-run noise on this laptop is about ±0.5 s.

- **S and M baked at the same time** in two worker threads, as the kiosk does: reach_up_both
  wall 15.8 s (before 16.5 s), sit 21.5 s (before 18.5 s, noise). The two size workers do not
  slow each other much.
- **The kiosk's 24–42 s** for the first "Try moves" therefore comes from other load on the
  machine during the result screen (browser, service), not from the bake itself.
- **No new kiosk soak** was run for E. P1 was running its soak, and the bake changes cannot
  change the kiosk flow.

**Strain and fit numbers:**
- Unchanged and identical to `docs/validation/motion-fit.md`.
- All 12 bakes hash identical (positions, strain, exposure, metrics) to the `9faa6cf` bakes, with
  and without the cached relax. Examples: shell worst 1.662 / 267 edges for reach_up_both S, and
  3.000 / 43 for cross_arms M.
- Non-identical speed-ups were measured and rejected, because they made strain worse. The same 4
  hard cases were run with each setting:
  - 8 substeps: reach_up_both S 1.66 → 2.04, sit S 1.09 → 1.17;
  - 6 substeps: 1.66 → 2.02 and 1.09 → 1.38;
  - final strain passes 8: cross_arms M 3.00 → 4.07, reach_up_both S 1.91;
  - stretch iterations 1: reach_up_both S 1.91.

  They were only 10–20 % faster: the collider work per pose does not shrink with fewer substeps.

**Bit-identical proof:**
- **Hand pull.** `ClothSolver.handpath.test.ts` computes a checksum of every float64 after:
  - 20 full-mesh steps on the asset config;
  - three PullDriver pulls of 40 frames each, plus their releases, on DQ S and M.

  It equals the values recorded with the `9faa6cf` code (`5abf26c3` / `ae0742d3`). A sha256 over
  the same sequence was also identical between a copy of `9faa6cf` and the new code.
- **Motion.** `bake.test.ts` checks that a cached relax equals a fresh relax. Scratch runs of all
  12 bakes matched the `9faa6cf` hashes.

**Hand-pull e2e:** `node scripts/handpull-e2e.mjs --build --port 5745` → **8/8 PASS**, errors 0
(`handpull-e2e.json`). Worst scenario 04-23-26 @shoulder: 40 Hz, step p50 18.6 ms, over-clamp
2.5e-7, shell 1.579.

**Gates (web):** eslint and prettier clean, `tsc` clean, vitest 25 files / 121 tests pass. The
Python gates were not rerun: E changed no Python.

### The cross_arms M 3.0× outlier: a collider defect, not fabric physics

- **The edge.** It is one 3.5 mm woven edge (particles 5452–5453) on the lower left sleeve near
  the elbow, at frames 89.5–90. 43 edges are above 1.10 in the worst frame; this edge alone
  reaches 3.0. S has the same spike next to it: edge 5453–5454, 2.30.
- **What the collider returns.** Traced per solver phase:
  - p5453 and p5454 find the skinned elbow zone surface 13–17 mm inside the skin;
  - their neighbour p5452, 4 mm away, gets "closest point on the zone's open border". The
    collider then lets the rigid forearm core decide (P1 FORMAT.md step 2), and the core says
    0 to −5 mm.
- **Why that is a defect.** Under the deep elbow flexion of cross_arms, the zone surface sits
  about 12 mm outside the rigid core at the zone border. So the body distance field jumps by
  ~12 mm between neighbouring particles. A true distance field cannot change by more than the
  particles' separation.
- **How it stretches the edge.**
  - The contact's hard floor (−4 mm) pushes one particle out by up to 9–18 mm in a substep.
  - The sleeve is taut over the bent arm (the sleeve rides up 15 cm), so the 16 limit passes
    cannot spread that over neighbours.
  - The edge stays at 3×.
- **Real physics would spread it.** Real fabric shares the strain over the sleeve. So the 3.0 is
  an artefact, and "shell worst" for cross_arms overstates the sleeve strain.
- **Not fixed in E.**
  - The fix belongs in P1's zone export: extend the elbow zone, or make the forearm core meet
    the skin at the zone border.
  - Changing the border rule, or capping the contact push in the solver, changes every bake.
    Pushes above 10 mm per substep happen thousands of times in every motion (cross_arms M:
    6,576 particle-substeps), so a cap is not a local fix.
  - Prompt 06 forbids worse strain, and these bakes are chaotic: any change moves the worst-edge
    numbers by ±15–25 %.

**Still open:**
- ≤ 10 s needs a different cost structure. One option is multithreading: the contact queries
  are per-particle independent, but the collider's linearised cache makes their order matter,
  and the browser has no SharedArrayBuffer without COOP/COEP. The other is WASM/SIMD for the
  edge sweeps. Alternatively, accept non-identical numbers: fewer substeps or passes, which this
  run measured as worse strain.
- The zone-border fix above.
- The kiosk's "Try moves ready after click" under load is not re-measured.

# Demo hardening 06 — D, F1, F2, F4 (agent K3, 2026-11-12 ~10:45–12:30)

Agent K3 took over Codex's uncommitted D work (watchdog state machine) and finished it, then
did F1, F2 and F4. E (motion bake) and F3 (tension readout, agent H2) are not covered here.
Commits: `a1f8bbf` (watchdog), `766726e` (F1/F2), `5ea9e44` (F4), `784b370` (soak), plus
this documentation commit.

## E2 — background pre-bake of the other motions (agent E2, 2026-11-12 ~16:00-17:40)

**What.** After the first motion of the first jacket is baked, the kiosk bakes every other
(jacket, motion) pair in the background, with the same code path as a click
(`MotionClient.bake(size, motion, urgent = false)`; nothing is faked or placeholder).
- `apps/web/src/engine/motion/BakeQueue.ts`: `MotionBakeQueue` (one pair at a time, both sizes of a pair in parallel, one worker per size) and `BakeStore` (memory cap, LRU). Unit tests in `BakeQueue.test.ts` (7).
- Order, most likely clicked first: the first motion of the second jacket (what Try moves opens on), then the motions in button order, first jacket first. Opening Try moves on a jacket moves that jacket's pairs to the front (`focus`).
- Priority: a click is `urgent`: it jumps the worker queue, and the queue starts nothing while a click waits. The queue also starts nothing during a hand pull (screen `feel`), a size switch, an other-size build (`precompute`) or on any screen but result/tryon/board. Reset disposes the queue before the clients.
- **A running background bake is preempted when the hand pull opens** (`MotionClient.pauseBackground`): the solver loop is synchronous in the worker and cannot pause, so the worker is replaced, its body and garment re-posted, and the bake restarts after the pull (physics unchanged, same code). A judge's own click is never preempted. Without this, the first hand-pull scenario run with a bake in flight FAILED (first grab missed, latency p95 159 ms, fps p5 21).
- UI (`MotionStudio`): each motion button shows a "ready" tag once all its sizes are baked, and a bar with the real solver progress (mean over the sizes of done/total steps; 0 while the size is still relaxing) while it bakes. `?kiosk&nomotionqueue` switches the queue off (baseline measurements).
- Memory cap `MOTION_CACHE.capBytes` = 420 MB. A bake is 14-20 MB (typed arrays: positions, strain, exposure); 22 bakes = 351 MB, all 24 (2 jackets x 2 sizes x 6 motions) about 385 MB. The queue stops when one more largest bake would not fit; a click evicts the least recently used bake instead. Chrome working set of the soak profile: 1.32-1.37 GB at the result, 1.62 GB with 22 bakes cached; JS heap 464-483 MB at the board with 20-22 cached (193 -> 148 MB in the normal cycles with no motion clicks, after reset 55 -> 63 MB).

**Measured** (installed headed Chrome, RTX 3050, `scripts/kiosk-soak.mjs --motion-cycles 1 --dwell S`; evidence in `docs/validation/kiosk-e2-*.json`). The machine was shared with other agents (CPU load 35-76 %), and bakes took 23-41 s here, against 11-17 s measured by agent E on a quiet machine. Per-motion ready-after-click: the judge opens Try moves after the dwell and clicks each motion in button order, 4 s apart ("ms" = already ready):

| motion | before (queue off, 60 s) | after, 60 s dwell | after, 300 s dwell (cap 360 MB) | after, 360 s dwell (cap 420 MB, slower run) |
| --- | --- | --- | --- | --- |
| reach_up_both | 164 ms (prewarmed) | 180 ms | 58 ms | 198 ms |
| reach_up_one | 28.95 s | 32.4 s | 121 ms | 512 ms |
| reach_forward | 29.17 s | 23.6 s | 117 ms | 212 ms |
| sit | 36.5 s | 37.0 s | 145 ms | 211 ms |
| bend_tie_shoes | 41.2 s | 41.0 s | 134 ms | 3.3 s (was baking) |
| cross_arms | 27.5 s | 29.6 s | 26.1 s (cap 360 MB had no room; cap then raised to 420) | 34.7 s |

The queue only helps if the judge gives it time. Here one pair takes about 30 s, so 60 s of dwell
gives it one pair (no gain: the clicks outrun it, 4 s apart in the script), and about 5 minutes
finish 10-11 of the 12 pairs. On a quiet machine (11-17 s per bake) it is about twice as fast.
A click still waits for the pair of its own jacket that is already running (at most one bake).

**Hand pull** (`node scripts/handpull-e2e.mjs --build --port 5745`): 8/8 PASS, fps p50 164, p5 33-55, latency p50 27-45 ms (no bake running, `handpull-e2-e2e.json`). With `--queue-busy` (Feel pressed while the queue has a bake running; the bake is preempted): 8/8 PASS, fps p50 164, p5 41 (159 in the later scenarios), latency p50 23-49 ms, p95 40-97 ms, step p50 4.6-6.4 ms (`handpull-e2-queue-busy.json`, `preemptions: 2`).

**Size switch** (20-cycle soak, queue on): the first switch (to the other size, whose cloth is still precomputing) median 5.1 s (0.14-8.9 s), the same as the earlier soaks (3.2-12.1 s); the switch back, cached, median 90 ms (68-477 ms; earlier soak 251-4025 ms). The queue starts nothing during a switch or an other-size build.

**Gates.** `npm run typecheck` ok; `eslint apps scripts` and `prettier --check` ok; web vitest 30 files / 164 tests pass; 20-cycle soak (`kiosk-e2-soak20.json`): dressed 20/20, 0 console errors, 0 non-loopback requests, service RSS 497 -> 506 MB; hand pull e2e 8/8 (twice).

**Open.** (1) Under load the queue cannot finish before a quick judge: one pair per ~30 s. If that is not enough, the cost per bake has to drop (agent E's physics, bit-identical). (2) The 20-cycle soak does not click motions; the sweep runs were single cycles. (3) During one soak attempt, port 5720 was held by another agent's server for about 3 minutes; that run was stopped and nothing of theirs was changed.

## D — watchdog: service lost while the jackets are dressing

The health poll now also reads the launcher's restart counter (`/kiosk/status`). That catches a
restart that happens entirely between two polls. A health deadline is inconclusive and never
forgets a body on its own (`watchdog.ts`, `advanceWatchdog`).

**UX bug fixed.** The service died while the jackets were dressing. Each failed drape then marked
its jacket "The 3D drape is unavailable for this jacket.", and the result screen opened behind
"Reconnecting…" ([before](validation/kiosk-watchdog-reconnecting-before-fix.png), Codex's
mid-cycle check in [kiosk-hardening-watchdog-mid.json](validation/kiosk-hardening-watchdog-mid.json)).

Now any failed drape, body/garment fit or size switch asks the service why it failed
(`failureCause`, unit-tested):

| Service state | Path |
| --- | --- |
| Dead (the proxy answers 503), restarted (new generation) or already lost | Reconnect path |
| The same generation is healthy | Shown as the jacket's real error |
| Two health deadlines in a row | Treated as a real error, so a slow but alive service never costs a judge the session |

| Watchdog, service killed mid-cycle | Before (Codex WIP, 10:25) | After (K3 run 2, 11:16) |
| --- | --- | --- |
| Screen behind "Reconnecting…" | **result**, both jackets "3D drape is unavailable" | **fitting** ("Dressing both jackets…"), no result screen, no jacket error ([after](validation/kiosk-watchdog-reconnecting.png)) |
| Jackets on screen at the kill | not recorded | 0 of 2 (kill confirmed while dressing) |
| "Reconnecting…" shown after kill | 1.38 s | 0.44 s |
| Back at attract after kill | 12.9 s | 9.0 s ([recovered](validation/kiosk-watchdog-recovered.png)) |
| Old asset workers alive after recovery | 0 of 4 | 0 of 4 |
| New service process | yes | yes; Fit Agent still in kiosk mode, no stored profile |
| Remaining cycles after the restart | not run | 10 of 10 dressed |

The before/after timings are single samples. The 1.38 s vs 0.44 s gap is mainly the new
immediate failure path, not a tuned poll interval: the poll is still 2 s.

### `npm run kiosk:soak -- --cycles 20 --watchdog`

The soak kills the API process (`taskkill /f` on the listener, never the workers) in cycle 10,
as soon as the judge's body is on screen. It then requires all of the following:

- "Reconnecting…" is shown, and no result screen or per-jacket error is seen during the outage
  (a MutationObserver reports to Node).
- The old workers are gone.
- A new service PID is up.
- `/agent/profile` reports kiosk mode.
- The kiosk is back at attract.

If a kill lands after both jackets are already on screen, the cycle is retried, up to 3 times.

| Run | Window | Result |
| --- | --- | --- |
| 1 (11:09) | **minimized** (see throttling) | 19/19 completed cycles dressed; the kill landed after dressing finished (the PID lookup sat between body-visible and the kill), so it was **inconclusive** and is not counted. The harness was fixed: the PID is looked up before Skip, 10 ms polling, kill first. |
| 2 (11:16) | off-screen, normal | **pass**: kill while 0/2 jackets on screen, then the table above; 19/19 completed cycles dressed; 0 console errors; 0 non-loopback requests |

Run 2 summary: [kiosk-hardening-watchdog.json](validation/kiosk-hardening-watchdog.json) (32 KB).

## Throttling: the cause was a minimized window

During C, and in watchdog run 1, the soak recorded 1 Hz camera frames and render rates, and
~4 s cached switches. A Win32 check (`IsIconic`) showed that the soak Chrome window was
**minimized**. With `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`
and `--disable-backgrounding-occluded-windows`, the page still reported `visible` and focused.
But a minimized window gets no vsync, so rAF and camera frames drop to ~1 Hz.

A blank-page probe measured rAF at 108 Hz on-screen and 116 Hz off-screen (`-2400,0`), with or
without `--disable-gpu-vsync`.

The soak now does three things:

- It keeps the three flags.
- It puts its window off-screen by default, out of the operator's way; `--onscreen` opts out.
- It reads the OS window state per cycle through CDP and restores the window if it was
  minimized. Every cycle records the window state, visibility and focus, scan camera fps and
  render fps.

| Per completed cycle | Run 1 (minimized) | Run 2 (off-screen) |
| --- | --- | --- |
| Window state at start / at result | not recorded (minimized per Win32 from cycle 2) | normal / normal in 19/19 |
| Render fps in the session | 1 (cycles 2–20), 47 (cycle 1) | 91–110 at result, median 98 |
| Scan camera fps (Chrome fake source, 20 fps) | 1–2 | 19–21, median 20 |
| Scan pose inference | 1–4 Hz | 19–21 Hz |
| Cached switch back to the recommended size | 65 ms – 4.07 s | 39–434 ms, median 49 ms |

**Only run 2's timings are reported.** Run 1 is kept in `.cache/k3/` as the negative control.

## Run 2 timings: 20 cycles, warm, 2.5 s scan dwell, unthrottled

| Metric | min / median / max |
| --- | --- |
| Skip → result | 3.52 / **4.56** / 6.21 s |
| You "Continue" → result (includes the 2.5 s scan) | 6.13 / 7.15 / 10.28 s |
| Fitting start → body visible | 36 / 41 / 114 ms |
| Cloth settled after body | 2.99 / 4.19 / 5.92 s |
| First switch: to the contrast size, often not yet precomputed | 1.92 / 2.20 / 4.04 s |
| Switch back: cached | 39 / 49 / 434 ms |
| Try moves ready after the click (cycle 1, cold) | 22.3 s |
| JS heap after reset, first 3 → last 3 | 210 → 119 MB (no upward trend) |
| Service RSS, first 3 → last 3 | 766 → 786 MiB |
| Attract render fps | 120 |

The first switch, to a not-yet-precomputed size, takes ~2 s while the background precompute
runs. That is outside the cached-switch gate, but a judge can feel it.

## Dressed-rate and visual inspection (the centrepiece)

"Dressed" means both views show a garment mesh (8.5–11k vertices each) and neither jacket
reports an error, 1.5 s after the result screen appears.

- Run 1: **19/19**.
- Run 2: **19/19**.

All 19 run-2 result JPEGs (`.cache/k3/run2-shots/`, gitignored) were inspected by eye. Both
jackets are on both bodies in every cycle. Two visual defects stand out:

1. **Shoulder / upper-sleeve artefacts in 5/19 cycles** (01, 06, 09, 12, 18):
   - wing-like flaps sticking out at the shoulder tips (01, 06, 18; severe in 18, on both
     jackets);
   - dark inner-surface patches or a torn look at the upper sleeve (09, 12, parka).

   The money-shot X-ray shows the same flaps after settling (cycle-1 body:
   [kiosk-result-xray.png](validation/kiosk-result-xray.png)). The committed K2 X-ray from
   e125de9 already showed them, so this is **not a regression from this work**. It is
   body-dependent: 4 of the 6 female bodies, plus the 5'6"/133 lb male. Shell geometry
   (`shell.py`) was out of K3's scope.
2. **Frayed puffer hem in 7/19 cycles**: cycle 02 (XS) and every female body (03, 06, 09, 12,
   15, 18).

No other defects were seen. The cycle-1 screenshots were regenerated on the final code:
attract, scan, fitting, try-on, board, diagnostics, motion, X-ray.

## F1 — no default body shape

The You screen starts with neither Female nor Male pressed. "Continue →" is disabled, with the
hint "Pick a body shape to continue." ([kiosk-you-no-sex.png](validation/kiosk-you-no-sex.png)).
The chosen shape travels with the person (scan, fit request, cut badge, try-on).

The soak asserts the disabled state, the hint and zero pressed buttons in every cycle, then
picks explicitly: 40/40 cycles across the two runs.

## F2 — fullscreen by default

- `npm run kiosk` opens Chrome `--kiosk`.
- `npm run kiosk -- --windowed` keeps the old `--app` window. `--fullscreen` is still accepted.
- Attract only shows a small "Esc to exit" chip ([kiosk-attract.png](validation/kiosk-attract.png)).
  Esc quits only on attract, through the same `/kiosk/quit` as Ctrl+Shift+Q, so a judge's Esc
  mid-session never quits.

Not tested: launching real `--kiosk` Chrome by hand. The soak uses Playwright's own Chrome.

## F4 — the Fit Agent never stores a body profile in the kiosk

`scripts/kiosk.mjs` starts, and restarts, the service with `SATISFY_KIOSK_MODE=1`. An
already-running service is reused only if `GET /agent/profile` reports `kiosk_mode`, so a
plain `npm run dev` service is never reused.

The soak checks `GET /agent/profile` at the start, after the watchdog restart and at the end.
It requires `kiosk_mode: true`, `saved: false` and `profile: null`. The checks were 6/6 OK over
the two runs, including the restarted process.

## Final 20-cycle screenshot soak: not completed

`npm run kiosk:soak -- --cycles 20 --screenshots --cycle-shots --out kiosk-hardening-final.json`
was started at ~11:20. Claude Code stopped it after cycle 2 because the machine ran critically
low on memory. Other agents' Chrome/handpull runs and Codex's leftover frozen service (ports
5780/8026, ~800 MB, still running) were sharing the machine. K3 stopped its own orphaned soak
processes. No summary JSON was written.

Watchdog run 2 is itself a complete 20-cycle soak on the same code, unthrottled, with
per-cycle shots; the dressed-rate above comes from it. The cycle-1 screenshots from the
stopped run are committed.

**Done 2026-11-12 13:30 (Claude, after G3 `1edf01a`–`21ef49a`):** the final soak ran on the
G3 shell, `docs/validation/kiosk-hardening-final.json`:
- It dressed 20/20 with 0 console errors and 0 non-loopback requests.
- The agent profile was never stored, checked at start and at end.
- Heap after reset went from 79 → 94 MB, and service RSS from 498 → 519 MB.

Claude looked at the per-cycle shots, zooming in on cycles 1, 2, 6, 9, 12 and 18, the bodies
that showed wings or a frayed hem in watchdog run 2:
- no sleeve-cap wings;
- no dark inside-out patches;
- the puffer hem reads as a clean band.

**Regression: the G3 shell is slower.** Medians over cycles 4–20, compared with watchdog run 2 (cycles 4–20):

| | Watchdog run 2 (before G3) | Final (G3) |
| --- | --- | --- |
| Continue → result | 4.6 s | 7.1 s |
| Slower jacket settles after body | 4.4 s | 6.8 s |
| First switch to an unbuilt size | 2.2 s | 3.7 s |
| Switch to a built size | 46 ms | 69 ms |

**Open:** bring the shell build back to the before-G3 time, or hide the extra time, without
undoing the G3 look fixes.

## P1: shell build speed after G3 (2026-11-12 ~13:50–15:20, Claude)

**Root cause (cProfile, soak body 18, recommended sizes).** G3's `unfold` pass re-ran the
inverted-face test (a closest-point query per face centroid, 16 candidate triangles each) on
every garment face in each of its 6 passes: 2.9 s of a 9.0 s profiled 2-shell run. Its
re-checks of body clearance and the third `untangle` call (crossing test from scratch) added
the rest.

**Fix (`9faa6cf`, `services/body/body_service/garment/shell.py`):**
- `unfold` tests only faces that can feed a free vertex, then only faces with a moved corner;
- the three `untangle` calls share their crossing pairs, so later calls re-test only moved
  primitives;
- `clip_polygon_x` is vectorised;
- one build's clearance queries are memoised per exact point (30 % were bit-identical repeats).

The geometry is **bit-identical**. `initial`, `rest`, faces, panels, elastic, uv, quilt,
paths, landmarks and warnings are equal to HEAD `7bce94c` on 77 shells (7 soak bodies × every
size of both jackets). New unit tests cover the vectorised clip, the memo and the untangle
state.

**Shell build, in-process (same machine, interleaved runs):**

| | before G3 (`8920edb`) | G3 (`7bce94c`) | P1 |
| --- | --- | --- | --- |
| Recommended sizes, soak bodies 1/6/12/18, min of 2 | 2.18–3.25 s | 1.99–2.97 s | 1.73–2.15 s |
| Every size, 7 soak bodies (77 shells), mean | – | 2.6 s | 1.6 s (−38 %) |

Pre-G3 was not faster in-process: it spent the time untangling its crossings. So the kiosk
regression was not CPU in `build_shell` alone.

**Kiosk soak.** `npm run kiosk:soak -- --cycles 20 --cycle-shots`, run twice back to back in
the same machine state:
- `kiosk-perf-p1.json`: P1 code;
- `kiosk-perf-p1-baseline-g3.json`: the same tree with `shell.py` temporarily set back to
  `7bce94c`.

During both runs, another agent's Python job held about one core, and agent E's uncommitted
motion/ClothSolver edits were in the served web tree. Medians over cycles 4–20:

| | Watchdog run 2 (before G3) | Final (G3) | G3, same session | **P1** |
| --- | --- | --- | --- | --- |
| Continue → result | 4.6 s | 7.1 s | 6.6 s | **6.0 s** |
| Slower jacket settles after body | 4.4 s | 6.8 s | 6.2 s | **5.6 s** |
| First switch to an unbuilt size | 2.2 s | 3.7 s | 3.3 s | **2.6 s** |
| Switch to a built size | 46 ms | 69 ms | 61 ms | 65 ms |

Both runs: dressed 20/20, 0 console errors, 0 non-loopback requests, agent profile never
stored. P1 is 0.6–0.7 s faster than G3 on all three metrics in the same machine state. **It
does not reach the watchdog-run-2 numbers.**

The built-size switch does no shell work, yet it is also 33–50 % slower than in watchdog
run 2. That points to machine load as the larger part of the remaining gap.

Body-only prep in-process:
- fit ~1.0 s;
- armpit 0.45 s, in parallel with the arm sections 0.3 s;
- SDF 1.8–2.0 s, in parallel;
- section cache 0.18 s.

The shell starts after the armpit/arm prep, so the jacket critical path is about
fit + 0.5 s + shell (≈1.7–2 s at below-normal priority) + transfer.

**Look.** I compared the per-cycle shots of cycles 2, 12 and 18 with the G3 final run
(`.cache/p1/shots-g3` vs `.cache/p1/shots-p1`):
- no wings;
- no dark patches;
- clean puffer hem;
- cycle 18 looks the same by eye (the JPEGs are not byte-identical).

**Gates.**
- `pytest`: 209 passed, 1 failed in the full run, 304 s. The failure was
  `test_real_products_geometry_topology_collisions_cache_and_api`, on its `build_ms < 1500`
  timing assert for the pattern GLB, not the shell, while the machine was loaded. That test
  passes alone (`test_garment.py` 7/7 on rerun), and `test_shell.py` 14/14 passed.
- ruff check/format: clean.
- `npm run validate:realism`: all PASS.
- `scripts/shell_defect_sweep.py all`: **402/418**, with every summary figure and the 16-shell
  failing list identical to `docs/validation/shell-g3-sweep.json`.

**Still open:** the rest of the gap to 4.6 s. Candidates, unmeasured:
- worker priority while Chrome renders;
- ClothAsset JSON size and encode time;
- `SurfaceQuery.closest` (k = 16 candidates, about 1 s per shell, unchanged since before G3).

## Tests (K3, final code)

`npm run lint` and `npm run typecheck`: exit 0. `npm test`: web 24 files / 118 tests passed;
Python 203 passed, 1 existing warning, 179 s. The web tests include 12 watchdog / failure-cause
tests in `watchdog.test.ts`.

# Demo hardening 06 — Codex, 2026-11-12 (A–C complete; D/F done by K3 above; E pending)

Cached static shells now finish the visible switch without waiting for worker setup.
Physics initialisation overlaps the unchanged 400 ms morph. Hand pulling/relaxation
still await `ClothClient.ready()`. Superseded queued sizes are cancelled; the latest
shown size owns `ready()`. Background static-size preparation caches parsed shells
without constructing unused physics solvers, and yields to foreground displays.
Static snapshots explicitly mark gap/strain maps invalid until computed.

Two synthetic bodies, both products, headed Chrome, frozen frontend builds and the
same frozen API checkout (`657ae79`, private ports 5780/8026). No shared server was
restarted. These are measured display timings, not physical convergence claims.

| A metric | Before | After |
| --- | --- | --- |
| Cached switch, application wall time (29 samples each) | median 654 ms; 339–1,349 ms | median 413 ms; 31–443 ms |
| Geometry preparation, median | 15.2 ms | 16.2 ms |
| Physics ready from switch start, completed cached requests | median 637 ms; max 1,318 ms | median 510 ms; max 816 ms (overlaps display) |
| Trusted DOM click → completed frame, separate after check (12 cached samples) | not sampled | 61–477 ms |
| Morph schedule | 400 ms | 400 ms, unchanged |
| Browser errors / non-loopback attempts | 0 / 0 | 0 / 0 |

Raw rows and phase measurements: [kiosk-hardening-A.json](validation/kiosk-hardening-A.json).
The Playwright action/RPC wall time is also retained; it includes actionability and
driver overhead and is not substituted for the trusted input-to-frame measurement.
The cloth worker bundle is byte-identical (`cloth.worker-3Elz1h8a.js`). The new
transport regression verifies that stale sizes never start and `ready()` waits for
the latest size. Typecheck/lint pass; the complete web test run is recorded below
when the remaining hardening work finishes.

## B — scan scheduling and the partial-window counter

Only asset-worker processes now use Windows `BELOW_NORMAL_PRIORITY_CLASS` via a
checked `ctypes` initializer (OS query confirmed all four at 16384; the API stays
normal). Worker count, camera resolution, pose model, geometry and tape math are
unchanged. Scan diagnostics retain raw calls, frames processed and window length;
the first half-second's call count is now divided by its actual elapsed time.
Previously 10 calls in 500 ms appeared as “10 Hz”. Full one-second windows are
unchanged; this corrects reporting, not inference performance.

| B metric | Before | After |
| --- | --- | --- |
| Steady inference, 30 fps synthetic source, 4–8 s into scan while assets build | 28–30 Hz, median 30 | 27–30 Hz, median 30 |
| Skip → result, 2.5 s dwell, 6 bodies, median | 7.167 s | 6.662 s |
| Same, excluding first cold session, median | 7.135 s | 6.650 s |
| First cold session, 2.5 s dwell | 16.237 s | 17.517 s |
| Skip → result, 10 s dwell, 20 fps source, two warm bodies | 0.731–0.933 s | 0.782–0.912 s |
| Browser errors / non-loopback attempts (all completed runs) | 0 / 0 | 0 / 0 |

The default Chrome fake camera delivers only 20 fps: its full windows remain
19–21 calls due to frame/window boundaries. The separate matched 30 fps check
proves the ≥20 Hz throughput gate without that source cap. It does not claim a
speedup from changing camera FPS. The first cold session remains variable (one
after sample was 1.28 s slower); neither cold builds nor immediate Skip are
claimed to meet 5 s. The median Skip gate did not regress. No live person was
tested. Lint/typecheck pass; raw paired runs, startup windows, OS priorities and
the excluded operator-interrupted auxiliary run's explanation are in
[kiosk-hardening-B.json](validation/kiosk-hardening-B.json).

## C — bounded service memory (40 cycles complete)

The primary LRUs were already bounded: body/garment/posed-body preparation 16,
cloth assets 32, motion bodies 4, four asset workers with two body section caches
each. A six-cycle diagnostic found the same post-reset inventory every time:
1 reference body, 1 fit, 1 posed body, 7 assets, 1 SDF, 1 prep, 0 pending jobs.
Tracemalloc live growth stayed around 1 MB while native RSS continued to rise.

Three regressions failed before their fixes and now pass: `_gather` retained child
Futures through a callback cycle; `shutdown(cancel_futures=True)` left running
asset processes alive. The implementation now gathers indexed values without
capturing child Futures, terminates/joins only owned workers, and watches the API
parent's sentinel so a watchdog kill cannot orphan workers. Reset removes caches
under the same locks as stores, completes stale waiters with an explicit session
reset (HTTP 410), clears cyclic garbage, and forgets both scan/base motion data.
Unexpected geometry failures remain errors.

| C control, same 40 synthetic judge cycles | Reset RSS first 3 → last 3 | Slope over 40 | Main OS peak |
| --- | --- | --- | --- |
| After Python/resource cleanup, before native policy | 780 → 995 MiB | +5.67 MiB/cycle | 1,137 MiB |
| MKL buffer pools disabled | 769 → 816 MiB | +1.09 MiB/cycle | 1,017 MiB |
| Fixed rtree pointer type + MKL policy | 764 → 685 MiB | −3.08 MiB/cycle | 1,028 MiB |

The second control improved RSS substantially but is **not** counted as the
no-growth gate. MKL's per-thread pools are disabled before Anny/torch import
([Intel documentation](https://www.intel.com/content/www/us/en/docs/onemkl/developer-guide-windows/2024-0/avoiding-memory-leaks-in-onemkl.html)).
The remaining growing cache was traced to the pinned rtree 1.4.1 ID iterator:
`POINTER(c_int64 * result_count)` retains a ctypes class for every distinct
cardinality. An isolated probe grew from 18 to 346 pointer classes; using one
element-pointer type kept it at 18, with the same returned IDs. The API now
installs this narrow iterator adapter; signed int64 IDs, ordering, empty results,
early close and native `Index_Free` ownership are preserved and tested. No
dependency files or global ctypes caches are modified.

Arithmetic kernels, geometry and measurements are unchanged. A Windows heap
cache optimisation trial only freed a few MB and was not kept; a fixed-compute-
thread trial did not address the dependency cache and was also removed. No
working-set trimming or unrelated process changes are used. The final 40-cycle
run has 0 browser errors, 0 non-loopback requests, no upward RSS trend, and at
most six owned Python processes (API + small venv launcher + four workers).
The 1 s sampled aggregate RSS peak is 2,882 MiB; this sums per-process working
sets, including shared DLL pages. Main API peak is the OS cumulative peak,
1,027.68 MiB. Late private-commit samples span 1,510–1,750 MiB during builds and
return to 1,513.86 MiB idle. RSS depends on OS paging, so its downward slope is
not presented as the exact saving caused by the patch; the cache bounds and
constant pointer-type count are verified separately.

This was the **service-memory** acceptance run. Some UI intervals delivered only
1 Hz camera frames / ~4 s morphs; foreground state was unavailable to the OS
probe and user clarification is pending. Those timing samples remain in the raw
report and are **not** used to accept A/B or the final rendering gate. D must
still verify the UI. No body frames or personal measurements were used/stored.

Validation: `npm run lint` and `npm run typecheck` pass; `npm test`: 22 web files /
94 tests, Python 136 passed in 182.68 s (one existing Starlette/httpx deprecation
warning). Twelve scan/privacy/resource tests cover the new regressions. Frozen
backend/frontend on private 5780/8026; command:
`npm run kiosk:soak -- --cycles 40 --attach --port 5780 --api-port 8026 --out kiosk-hardening-memory.json`.
All complete controls, diagnostics, source hashes and 1 s samples are retained in
[kiosk-hardening-C-memory.json](validation/kiosk-hardening-C-memory.json), with
the standard raw [40-cycle run](validation/kiosk-hardening-memory.json) and
[comparison chart](validation/kiosk-hardening-memory.png). D and E remain.

# Milestone 3 — judge kiosk (agent K, 2026-11-12) — for merging into STATUS

Branch `worktree-agent-a5cfe619537d9d63c`, based on `3a7bcc4`. Prompt
`prompts/04-kiosk.md`, plus the coordinator's addition: "act on the recommendation"
store buttons. M4 (hand pull) was not started; its slot is a disabled
"Feel the fabric — coming next" button.

## Done

- **Part A**: `npm run kiosk` (see README "Demo day"). It copies or fetches the
  vision assets, does a production build, starts the body service with a
  restart-on-exit watchdog, serves a whitelist static server with an `/api` proxy on
  loopback, waits for `/health`, then opens Chrome (`--app` by default,
  `--fullscreen` for `--kiosk`) with a dedicated profile, camera auto-accept and
  loopback-only DNS. The warm-up progress bar covers the service, a reference fit
  (the dummy fit), pose and hand models (GPU) and shader compile. Hidden keys:
  Ctrl+Shift+R / D / Q, plus B for the board.
- **Part B**: attract → You (imperial default, cm/kg toggle, friendly ranges) →
  Scan (`createBodyScanner`, guidance text, Skip always, "Continue without scan"
  after 25 s, result ± σ for 2 s, camera errors never block) → Fitting (both jackets,
  background size precompute) → Result (size + one-line reason per jacket in both
  units, size tabs, automatic X-ray shoulder move, key 5, store buttons) → Try it on
  (predictions, tape instructions, optional measured values, opt-in board) → Board
  (MAE + n per metric, "No entries yet") → Reset by button, 90 s idle or
  Ctrl+Shift+R. Reset calls `DELETE /body/{id}` and reloads the page.
- **Part C**: `FitRequest.scan_measurements`, soft 1/σ² residuals anchored to the
  no-scan body, `FitResponse.scan` report (omitted when there is no scan), and
  scan-aware uncertainty bands shown as ± in the UI. Details and measured table:
  docs/MEASUREMENTS.md "Webcam scan constraints".
- **Part D**: `scripts/kiosk-assets.mjs` → `apps/web/public/vision/` (gitignored),
  `assetBase: '/vision/'`.
- **Store buttons**: "Open on Amazon in size M" (FB7675) and "Open store page (eBay)"
  (DQ4920). They open the catalogue URL in the operator's default browser through
  the kiosk server; the caption says "Choose size M on the page"; no URL is
  fabricated. See docs/DECISIONS.md.

## K2 fixes (2026-11-12 ~06:30–07:45, review 03 H3/H4/H5/M1/M3/M4/M5/L1/L6)

- **One number per quantity.** Card, Try it on and the 3D seam label show the fit engine's
  analytic value in the judge's units; the shown-shell value appears only as a labelled
  "3D drape (settled cloth)" detail; the cuff line names both (sleeve length past the wrist ·
  stacks at the hand on the 3D drape). Test: `apps/web/src/kiosk/fitNumbers.test.ts`. Example
  (5'9" / 160 lb male, FB7675 L): card "drops 3.6 in (9.2 cm)", label "Seam drops 3.6 in (9.2 cm)
  · 3D drape (settled cloth): +2.9 in (7.4 cm)"; Try it on "sleeve length 3.2 in (8.2 cm) past
  your wrist · stacks at the hand to +1.0 in (2.6 cm) on the 3D drape".
- **Unvalidated.** Try it on says "Not yet validated…" until the board has a measured entry.
- **X-ray contrast.** The neighbour whose computed zones differ most (FB7675 L vs XL: chest room
  +4.7 → +8.0 in, sleeve +3.2 → +4.6 in; seam nearly the same +3.6 vs +3.8 in), or "nearly
  identical" when every zone differs by < 1.0 cm. One large seam label (centred, 22 px); no hem
  or cuff chips; labels hidden on attract.
- **Waiting time.** The no-scan body and both garment fits start on the You screen's Continue
  (the scan fit is anchored to the same body, so nothing is wasted); the result shows when both
  recommended shells are on screen; the cloth settles and other sizes load behind a "Cloth
  settling…" line (size buttons wait for the settle).
- **Attract arms.** The shell's posed body is shown with the shell at once (the default-pose arms
  stuck out of the sleeves until the settle).
- **Try moves** on each card: MotionStudio on the judge's body and fit, recommended vs contrast
  size; the first jacket's first motion is pre-baked once the result has settled; the
  "indicative" note is kept.
- **Women's cut** / Men's cut badge from the catalogue title when it differs from the chosen
  body shape; the recommendation is unchanged.
- **Ports.** `npm run kiosk` reuses a healthy service of the same engine version on its API port
  (e.g. `npm run dev`), else starts its own on the next free port (README "Demo day").

### Continue → result, before and after
| Run | Skip → result | You Continue → result |
| --- | --- | --- |
| Before (review 03, dev servers, 5'9"/160 lb) | 18.0 s | — |
| Before, same walk on this code base at 06:30 (result waited for the settle) | 18.3 s (shell visible 11.3 / 16.7 s after the body) | — |
| After, dev walk, 6–8 s on the scan screen (`scratchpad k2/walk.mjs`), 3 runs | 0.88 / 1.03 / 1.21 s | — |
| After, dev walk, 2 s on the scan screen | 11.8 s | — |
| After, 20-cycle soak (own service on :8011, 2.5 s on the scan screen, 6 s in cycle 1) | min 6.6 / median 9.7 / max 13.5 s | min 9.2 / median 13.0 / max 16.1 s |

**The ≤ 5 s target is met only when the judge spends ≥ ~6–8 s on the scan screen.** The time is
the service building both jackets for a new body (about 9–16 s from the You screen's Continue on
this shared, loaded laptop: in the soak the shells became visible 6.2–13.1 s after the body);
the client shows the result at most a frame after both shells appear. A judge who skips the scan
at once waits for that build.

## Measured: 20-cycle soak on the final K2 code (installed headed Chrome, RTX 3050, fake camera)

`npm run kiosk:soak -- --cycles 20 --screenshots` → `docs/validation/kiosk-soak.json`, 10.5 min,
machine shared with agent G2 and the dev servers.

| Metric | Target | Measured |
| --- | --- | --- |
| GPU renderer | NVIDIA | ANGLE (NVIDIA GeForce RTX 3050 Laptop GPU, D3D11) |
| Warm-up (first load / after each reset) | — | 3.1 s / 2.0–3.8 s (median 2.8) |
| Attract render | ≥ 60 fps | 165 fps |
| Scan pose inference | ≥ 20 Hz | **10–21 Hz** (GPU delegate): 20–21 Hz in 9 cycles, 18 Hz in 1, 10–11 Hz in 6, not sampled in 4. The jacket build that now runs during the scan competes for the CPU |
| Continue → body visible | ≤ 2 s | median 0.10 s, max 1.77 s (the body is pre-fitted) |
| Skip → result | ≤ 5 s | **FAIL at 2.5 s scan dwell**: median 9.7 s (6.6–13.5) |
| Shells visible after body (slower jacket) | — | 6.2–13.1 s, median 9.1 s |
| Size switch, uncached (≈ 3.5 s into the result) | — | median 4.9 s (3.2–12.1) |
| Size switch, back to the cached size | ≤ 0.6 s | median 1.07 s (0.25–4.0); includes the 400 ms morph, while other sizes precompute |
| Try moves (cycle 1): first motion ready after click | — | 42.3 s (23.9 s in an earlier run); "indicative" note shown |
| Console errors (real) | 0 | 0 |
| Non-loopback requests | 0 | 0 (none attempted) |
| JS heap in session / just after reset | no growth | 143.5 → 145.4 MB / 74.3 → 73.3 MB (first 3 vs last 3 cycles) |
| renderer.info per view | no growth | identical every cycle (4 geometries, 16 textures, 16/15 programs) |
| Service RSS | stable | **608 → 1095 MB over cycles 1–18, then 811–833 MB**: grows while cycles run (the LRU caches fill with each judge's jacket sizes), drops at cycle 19; not proven bounded |

Screenshots: `docs/validation/kiosk-{attract,attract-early,you,scan,fitting,fitting-body,
result-xray,tryon,board,diagnostics,motion}.png`. The watchdog run was not repeated
(`kiosk-soak-watchdog.json` is from 02:05).

## Earlier soak (agent K, 02:05, before the night's changes; superseded)

Settled jackets 16.8–44.4 s after the body (median 23.1 s); cached size switch 0.67 / 0.78 s; the
watchdog showed "Reconnecting…" at 1.9 s and was back at attract after 14.5 s.

## Tests (K2, final code)

- `npm test`: web 21 files, 93 tests passed (new `fitNumbers.test.ts`: card == label in both
  units, cuff wording, contrast pick, near-identical case, cut note); Python 130 passed in 178 s.
- `npm run lint` and `npm run typecheck` pass.

## Tests (agent K, 02:05)

- `npm test`: 28 web tests (10 new kiosk tests: units, reasons, store labels,
  board MAE, scan guidance) and 82 Python tests passed, 1 skipped, in 117.65 s.
  New: `test_scan_fit.py` (validation; pull ∝ 1/σ²; σ = 1e4 gives the no-scan body
  within 0.05 cm and < 1 mm per vertex; tape overrides scan; band narrows from
  6.77 to 4.53 cm; API report + DELETE purge).
- `npm run lint`, `npm run typecheck` and `npm run build` pass.

## Known gaps

- **Result wait (K2, current):** Skip → result 6.6–13.5 s in the soak with a 2.5 s scan dwell;
  under 1.3 s when the judge spends 6–8 s on the scan screen. The remaining time is the
  service's per-body jacket build (agents G/G2).
- **Scan rate** drops to 10–11 Hz in some cycles while the jackets build during the scan.
- **Service RSS** grew 608 → 1095 MB over 18 cycles before dropping; watch it in a longer run.
- Cached size switch is 0.67–0.78 s against the 0.6 s target. The engine morph
  alone is 400 ms.
- Per-jacket recommendations for non-owned sizes are "estimated size grade". The
  UI says so in the reason line.
- `@mediapipe/tasks-vision` 1.2.2 has a built-in usage logger
  (POST `odml.pa.googleapis.com/v1/log`) with no opt-out. The kiosk window cannot
  resolve it (`--host-resolver-rules`), but `npm run dev` and the vision lab are
  unprotected. Reported to the vision owner.
- A real-person scan was not exercised: the soak uses Chrome's synthetic camera.
  The scan calibration is still `uncalibrated`.
- The accuracy board has no entries; none were invented.
- Reset reloads the page because engine caches (settled cloth, SDF fetches) are
  module-private. Measured cost: a 1.4–2.7 s warm-up between judges.
- The kiosk route under `npm run dev` works, but the board, store opener and quit
  need the kiosk server (`npm run kiosk`).

## Questions

See `docs/QUESTIONS-FOR-USER.md` ("From agent K").
