## Inspiration

I own a cream Nike puffer in size S. Online it looked perfect. In real life, when I zip it all the way up, the funnel collar squeezes my neck. I measured it with a tape: the collar is **35 cm around** when it is closed. No product photo, size chart or virtual try-on told me that before I bought it.

Virtual try-ons help answer _"how will it look?"_. I also wanted to ask _"will it fit, and where might it feel tight?"_. **Satisfied at First Buy** pairs a photoreal try-on with an inspectable fit estimate.

## What it does

Pick a jacket from the picture cards, then press **Start** to begin the live photoreal try-on. **Stop** returns to the plain camera.

The Studio puts two views side by side:

1. **The look (left).** A photoreal live try-on of the jacket on your camera feed, rendered by Decart's Lucy V-TON model.
2. **The Fit Lab (right). This part is ours.**
   - An estimated 3D body built from your height, weight and sex, wearing the jacket in the size you pick and following your pose live.
   - **Scroll in to look through the jacket.** The shell turns into clear glass, so you can see the gap between your body and the fabric.
   - Only zones the engine flags **tight or snug** receive a light coral tint; good and loose regions stay untinted.
   - Notes point to the selected size's regions and explain returned ease or shoulder/cuff offsets.
   - Switch **S → M → L** after the size shells have loaded to compare the same estimated body.
   - **Keep scrolling into a CT scan.** The view turns smoothly to the right, and seven horizontal cross-sections, from hem to collar, slide out of the body one after another. Each layer shows the estimated body and jacket outlines. Hover a layer to light it and read the engine's verdict for that zone. Scrolling back turns to the see-through view, then out to the look.
   - The wheel moves in notches: three to see through the jacket, three more to reach the CT scan.
   - Drag to rotate the Fit Lab and inspect the back; double-click to face the front again.
3. **Physical interaction.** Pinch your thumb and index finger in the air in front of the camera:
   - **pull the zipper** down or up;
   - **take the puffer's hood off**, and put it back on;
   - **pull the closed jacket's hem** and see how far the simulated fabric follows before resisting.

   Cloth interaction uses a static fitted body; the pose-following preview resumes separately. Zipper and hood state are mapped to discrete Decart appearance updates. Hem pull stays in our local simulation, and its readout describes displacement rather than a measured pulling force.

   Closing the puffer activates the collar check: the engine compares the measured collar ring with the estimated neck section. It highlights the collar only when that result is tight or snug. You can then try the real jacket and compare the prediction with what you feel, including any mismatch. Comfort thresholds still need broader validation, and missing collar measurements for other sizes remain unknown.

## How we built it

- **Body model.** We fit the open-source **Anny** parametric body (Apache-2.0, MakeHuman CC0 assets) to the shopper's inputs in a local **FastAPI + PyTorch** service.
- **Garment data.** We keep brand body-size charts separate from garment dimensions. Our two jackets combine owned tape measurements with explicitly estimated size grades, and each value records its source.
- **Fit engine.** For circumference zones it computes inner ease, the room left after the body and under-layer are accounted for:

  `ease = inner garment girth − body girth − 2 × π × under-layer thickness`

  An inner garment measurement is used when available; otherwise the engine estimates it from outer girth and insulation loft. Shoulder and cuff checks use offsets rather than circumference ease. The collar compares the fitted neck section with the measured inner collar ring only when zipped closed. The engine ranks sizes from regional rules; a recommendation can still have a local problem. The generated video never decides fit.

- **Fit Lab.** A framework-agnostic **Three.js** engine renders the posed body, the jacket, the see-through shader with zone tints, and on-image annotations.
- **Physics.** A cloth solver runs in a **Web Worker**, splitting the jacket at the zipper and detaching the puffer's hood. After stiffness tuning, scripted browser tests with a fake camera measured pinch-frame-to-cloth-on-screen latency of **puffer p50 109 ms / p95 134 ms** and **parka p50 72 ms / p95 96 ms**. These are scripted-test measurements, not a real-person success rate.
- **Perception.** **MediaPipe** pose and hand tracking run locally on the shared camera stream. Gestures are mapped in body space (shoulders and hips), not screen pixels.
- **Bridge.** One camera stream feeds our trackers and, when started, Decart. A state bus turns the continuous zip value into discrete renderer updates, with hysteresis and debouncing. A loopback token server keeps the permanent API key out of the browser and applies session reservations and limits; those application checks are not a certified provider billing ceiling.
- **Privacy.** Typed body measurements, fitting and pose/hand processing stay local. Starting the cloud try-on sends camera video, garment reference images and appearance prompts to Decart. We do not promise zero provider retention. Body form fields can persist locally until reset.

## Challenges we ran into

I first tried to build the photoreal look myself: a fully local 3D jacket overlaid on the camera. It tracked the body, but still looked like a 3D model. Sleeves detached during turns and the parka wobbled "like jelly". Before the final demo, I moved the appearance to Decart and focused the remaining work on **fit you can inspect and physics you can interact with**.

Other challenges:

- **Matching the garment states.** Decart changes are discrete, so we map a continuous zipper to stages.
- **Instant size switching.** We preload all three sizes instead of rebuilding.
- **Honesty about uncertainty.** Height and weight do not fully determine body shape. We preserve measured-versus-estimated data provenance and treat fit and comfort as predictions that need worn-garment validation.

## Accomplishments that we're proud of

- Regional fit explanations tied to sourced garment data.
- A collar check activated by closing the zip, with a warning when the estimate is tight or snug.
- A CT-style stack of cross-sections that shows, layer by layer, where the jacket sits close to the body.
- Pinch-to-zip, puffer hood removal and hem pull in a browser cloth simulation.
- A clear distinction between Decart's generated appearance and our geometry-based fit estimates.

## What we learned

Looking good and fitting well need different evidence. A beautiful generated jacket cannot prove a size, and a size chart cannot show how a collar will feel. Pairing appearance with an explanation makes it possible to question the prediction and compare it with the real garment.

## What's next

- Expose the engine's T-shirt and hoodie layer presets in the Fit Lab so shoppers can compare room for different under-layers.
- Measure the collar at several heights before adding a zipper marker for where it begins to squeeze.
- Add per-pose cloth simulation to check hem rise with raised arms and wrist exposure when reaching forward.
- Compare a candidate with a jacket the shopper already owns, building on the engine's owned-size anchor.
- Validate camera body scanning as an alternative to typed measurements.
- Measure more garments and calibrate comfort thresholds with more wearers.
