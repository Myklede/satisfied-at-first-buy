## Inspiration

I own a cream Nike puffer in size S. Online it looked perfect. In real life, when I zip it all the way up, the funnel collar squeezes my neck. I measured it with a tape: the collar is **35 cm around** when it is closed. No product photo, size chart or virtual try-on told me that before I bought it.

Virtual try-ons today answer *"how will it look?"*. Almost none answer *"will it fit, and where won't it?"*. **Satisfy at the First Buy** answers the second question with a real fit engine, and still gives the shopper the first.

## What it does

The Studio puts two views side by side:

1. **The look (left).** A photoreal live try-on of the jacket on your camera feed, rendered by Decart's Lucy V-TON model.
2. **The Fit Lab (right). This part is ours.**
   - A 3D body built from your height, weight and sex, wearing the jacket in the size you pick, and following your pose live.
   - **Scroll in to look through the jacket.** The shell turns into clear glass, so you can see the gap between your body and the fabric.
   - Zones the engine computes as **tight are tinted red**: collar, shoulders, chest, bicep, hem and cuffs. Loose and good fit are not coloured; you can see them through the glass.
   - Notes are drawn as labelled lines on the 3D view, for example: *"Collar tight when fully zipped: 35.0 cm vs your neck ≈ X cm."*
   - Switch **S → M → L** and compare instantly.
3. **Physical interaction.** Pinch your thumb and index finger in the air in front of the camera:
   - **pull the zipper** down or up;
   - **take the puffer's hood off**, and put it back on.

   Our cloth solver moves the fabric in the Fit Lab, and the same garment state drives the photoreal view.

   When you zip the puffer all the way up, the collar zone turns red, because the engine compares the measured collar ring with your estimated neck. Then you can put the real jacket on and feel the same thing.

## How we built it

- **Body model.** We fit the open-source **Anny** parametric body (Apache-2.0, MakeHuman CC0 assets) to the shopper's inputs in a local **FastAPI + PyTorch** service.
- **Garment data.** Measurements come from the brands' size charts and from my own tape measurements of the two jackets. Every value records its source.
- **Fit engine.** For each zone it computes ease, the room between the garment and the body:

$$
e = C_{\text{garment}} - C_{\text{body}} - 2\pi t
$$

  Here \\(C\\) is a circumference and \\(t\\) is the thickness of the layer worn underneath. The collar uses the neck cross-section of the fitted body against the measured collar ring, and it only counts when the zip is closed. The engine ranks sizes from these ease values; the generated video never decides fit.
- **Fit Lab.** A framework-agnostic **Three.js** engine renders the posed body, the jacket, the see-through shader with zone tints, and on-image annotations.
- **Physics.** A cloth solver runs in a **Web Worker** with **WebAssembly**. It splits the jacket at the zipper and detaches the hood. In our scripted browser tests, the time from pinch to cloth motion was about **56–66 ms** (median).
- **Perception.** **MediaPipe** pose and hand tracking run locally on the shared camera stream. Gestures are mapped in body space (shoulders and hips), not screen pixels.
- **Bridge.** One camera stream feeds both our trackers and Decart. A small state bus turns the continuous zip value into discrete renderer states, with hysteresis and debouncing. A loopback-only token server keeps the API key out of the browser and enforces session and spending limits.
- **Privacy.** Body numbers and fitting stay on the machine. Only the camera stream goes to Decart, and only on the Studio page while a session is running.

## Challenges we ran into

For two days I tried to make the photoreal look myself: a fully local 3D jacket overlaid on the camera in real time. It tracked the body, but in the end it still looked like a 3D model. Sleeves detached during turns, the parka wobbled "like jelly", and it never looked like real fabric. The night before the deadline I made a hard call. I moved the look to Decart and spent the remaining time on what makes this project different: **fit you can see and physics you can touch.**

Other challenges:
- **Matching the garment states.** Decart changes are discrete, so we map a continuous zipper to stages.
- **Instant size switching.** We preload all three sizes instead of rebuilding.
- **Honesty about uncertainty.** Height and weight don't fully determine body shape, so we label estimates as estimates.

## Accomplishments that we're proud of

- A fit verdict that points at the exact part of the body, rather than "true to size".
- A collar warning tied to a real interaction: zip up and see it turn red.
- Pinch-to-zip and hood removal running on real cloth physics in the browser.
- An honest split between generated pixels (Decart) and measured fit (ours).

## What we learned

Looking good and fitting well are different problems and need different evidence. A beautiful generated jacket cannot prove a size, and a size chart cannot show you what "+2 cm at the collar" feels like. Putting the two next to each other is what builds trust.

## What's next

- Camera body scanning, so shoppers don't have to type measurements (prototyped offline).
- More garments measured.
- Calibrating comfort thresholds with more wearers.
- A browser extension that brings the Fit Lab to any product page.
