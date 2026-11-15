# Satisfy at the First Buy — Devpost draft

Prepared 2026-11-15 for the Studio pivot. Copy the story sections after the owner's review; this is not a submitted entry. Evidence and pending claims are in the [claim register](claim-register.md). No real-user camera imagery or body values belong in this text.

## Inspiration

Buying a jacket online often means guessing whether the shoulders, sleeves and room for layers will work. A convincing product picture does not answer those questions. I wanted shoppers to see both the look and the reasons behind a size recommendation before purchasing. Reducing returns is the motivation, not an outcome we have measured.

## What it does

Satisfy at the First Buy puts a photoreal try-on beside an inspectable fit model. Studio supports a white Nike parka and a cream Nike puffer. Decart Lucy VTON renders the camera view; our Fit Lab shows the fitted body and garment in 3D, with X-ray, a tight/good/loose heatmap and a computed S/M/L comparison.

The local fit engine compares body estimates with sourced garment measurements, size charts, insulation and layering assumptions. It reports regional ease and shoulder/cuff offsets, distinguishing measured garment data from estimated grades. The recommendation comes from that engine, never from the generated video.

Pose and hand observations feed the same garment state. A pinch can move the zipper or remove the puffer's hood in our Fit Lab, with sliders and buttons as fallbacks. Our cloth interaction handles continuous motion in static-body physics mode. Decart receives discrete garment-state/reference updates; half-zip and no-hood reference images remain missing. A new prompt-only no-hood candidate uses a hood-on image and still needs visual validation. The parka's hood is not removable solver geometry. Live posed preview resumes separately; we do not claim a full moving-body cloth solve on every camera frame.

The current body is either a labelled reference or is built from entered height, weight and body-shape selection. Automatic camera-derived body/face integration remains pending and is not part of the verified Studio claim. The frozen local RC5 preview remains an offline fallback.

## How we built it

I built the project as a solo developer with coding-assistant support. Our code combines an Anny parametric body fit, a local FastAPI/PyTorch service, garment measurements and fit-ranking logic, and a framework-independent Three.js engine. TypeScript connects the Studio interface, local MediaPipe pose/hand processing, X-ray and heatmap views, and worker-based cloth interaction.

We built the shared-camera bridge, garment-state bus, reference selection, zipper-state hysteresis and debounced renderer updates. Decart is the external photoreal renderer, not our model or fit engine. Its appearance can follow our requested size category, but generated pixels do not verify physical ease or preserve exact garment geometry.

A loopback token service keeps the permanent Decart key off the browser and implements reservations and duration limits. Its hard-cap review has identified issues requiring fixes; we do not claim a proven non-bypassable billing limit. Camera video, garment references and the requested appearance prompt go to Decart for the enabled Studio/trial experience. Body fitting runs locally; entered body fields can persist in browser localStorage until reset. We make no claim about unverified provider retention.

## Challenges

We first pursued a fully local RC5 camera overlay. Turning could expose gaps and detached sleeves, and the jacket could wobble or grow unnaturally. The user's visual bar was not met, so we froze that path as a fallback and moved photoreal rendering to Decart. This let us focus the submission on our fit reasoning and interaction while crediting the renderer openly.

Other boundaries remain: height and weight do not uniquely identify body shape; garment grades are not all physically measured; heatmap gaps are model estimates, not pressure sensors; and physics interaction pauses the live pose. Decart state changes are discrete, some references are missing, and the network can fail. Integrated real-camera hand interaction and state-change latency still need a user-present check.

## Accomplishments

We connected local body fitting, sourced garment data, regional fit reasoning, X-ray and heatmap inspection, and physical zipper/hood interaction through one garment state. Fit Lab browser checks show pose changes, size switching, X-ray and physics entry/exit. A scripted Studio check verifies puffer zip/hood transitions and parka zip transitions with fake camera input and Decart off. A separate hand-clip replay verifies that the gesture bridge follows normalized hand travel.

These scoped checks are recorded in the repository; they are not a population fit-accuracy study or an integrated real-user demo pass. A missing-jacket discrepancy in another Studio run and an intermittent disappearance still need resolution.

## What we learned

Appearance, fit inference and physical simulation need separate evidence. A beautiful generated jacket cannot validate a size. A useful product should credit its renderer, expose provenance and uncertainty, and retain fit reasoning when the network fails. Client countdowns and accounting estimates also need adversarial review before they support a spending guarantee.

## What's next

Complete the real-camera Studio and security checks, validate body/garment predictions with more wearers, calibrate material and comfort assumptions, improve state-specific references, and broaden the measured catalogue. Camera-derived body and face work is a separate pending integration. We have not measured fewer returns or established population-level fit accuracy.

## Built with

**Decart Lucy VTON / @decartai/sdk** (external photoreal renderer), TypeScript, Three.js, React, Vite, MediaPipe, Anny/MakeHuman assets, Python, FastAPI, Pydantic, PyTorch, Web Workers, WebAssembly/AssemblyScript, Blender, Vitest, pytest and Playwright.

## Editorial evidence — remove before pasting

The contribution and boundaries come from [prompt 31](../../prompts/31-decart-pivot-plan.md), [FL/ZB/DC results](../requests/codex-sync.md), [security review](../requests/CX-DAY-decart-review.md) and [claim register](claim-register.md). Dependency and asset decisions remain in the repo. Body/physics limitations remain in `docs/STATUS*.md`.

Integrated real-camera Studio, real-hand success and Decart set-to-visible latency: `TBD (measured at <next user-present Studio test time>)`. Replace only with the tested build, conditions and result. Public footage and repository publication require the owner's privacy/history review. Nothing has been submitted by this task.
