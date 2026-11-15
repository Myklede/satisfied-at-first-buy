# Studio judge Q&A — short, evidence-backed answers

Updated 2026-11-15 for `/studio.html`. Measured results and conditions: [claim register](submission/claim-register.md). RC5 is the manual offline fallback; pending integration is not a successful real-user demo.

### 1. Isn't this just Decart?

Decart supplies the photoreal renderer, and we credit it. We built body/garment fit reasoning, the Three.js Fit Lab with X-ray and heatmap, gesture-to-state bridge, cloth interaction and local token service. Decart does not choose the size. [Architecture](../prompts/31-decart-pivot-plan.md)

### 2. How accurate is the fit?

We have no validated population-level accuracy number. Body shape remains uncertain, material/comfort assumptions need calibration, and some sizes are estimated grades. Treat zone results as sourced model estimates, not a fit guarantee. [Body limitations](validation/body-fixes-review.md), [physics limits](STATUS-tryon-physics.md)

### 3. What is physics and what is generated?

Fit Lab has our body/garment geometry, heatmap and cloth interaction. Decart generates the large camera image. Its discrete appearance updates are not the continuous cloth state. Neither a good-looking frame nor a size word proves exact physical fit.

### 4. Does physics follow my full moving body continuously?

The ordinary Fit Lab follows the tracked pose as a skinned preview. Zip/hood interaction switches to static-body solver mode and pauses live pose, which resumes separately. We do not claim moving-body cloth simulation on every frame. [FL/ZB notes](requests/codex-sync.md)

### 5. What leaves the laptop?

When the user starts Decart on the trial or Studio page, camera video, garment references and the requested garment/size appearance prompt go to Decart. Fit computation and pose/hand processing run locally. The legacy main app keeps its local policy. Provider retention/deletion has not been verified; we do not promise zero cloud storage.

### 6. Are body inputs or recordings saved?

Studio body fields can persist in browser localStorage. **Reference body** removes that entry, not necessarily every backend cache. Our Studio does not automatically record video; REC explicitly offers a local download of the big video slot. Private test imagery is never part of this submission. [Storage](../apps/web/src/studio/fitlab/personStore.ts), [REC](../apps/web/src/studio/shell.ts)

### 7. What does it cost per user?

The repo budgets standard 720p Lucy VTON at $0.02 per active-generation second: an estimated $3.60 for 180 active seconds and $14.40 for four rounds before rehearsals. These are calculations, not observed spend or a universal price. Fast mode and future prices differ. Free credits come first; only the user may approve and perform a top-up within the $30 total rule. [Repository rate](../scripts/decart-budget.mjs), [Decart pricing](https://docs.platform.decart.ai/getting-started/pricing)

### 8. Is the $30 cap impossible to bypass?

Not established. The server implements reservations and limits, but our independent review found accounting/token and lifecycle issues. Do not call it a guaranteed provider billing ceiling until the fixes and provider restrictions are verified. [4 HIGH / 2 MEDIUM findings](requests/CX-DAY-decart-review.md)

### 9. Why not only use 3D?

We tried local RC5 AR. Wobble, turn artifacts and coverage failures did not meet the user's visual bar. We froze it as the offline fallback and use Decart for appearance while retaining inspectable fit reasoning in our engine. We do not claim RC5 reached photoreal quality.

### 10. What if the person's existing jacket is different?

Visual replacement can be plausible without measuring the hidden body or reproducing the garment exactly. Our fit engine needs supported garment data and body constraints. Missing measurements remain unknown; two supported jackets do not establish arbitrary-catalogue support.

### 11. How is a size chosen?

The local garment service compares body dimensions with garment data, layer/insulation assumptions and regional ease/offset rules. Studio displays the returned numbers and ranking. The recorded reference-body result was S tight / M good / L loose for both jackets; that does not prescribe M universally. [FL RESULT 1](requests/codex-sync.md), [adapter](../apps/web/src/studio/fitlab/verdict.ts)

### 12. Are all sizes physically measured?

No. Owned tapes and estimated grades are labelled separately. A larger drawing does not prove that physical size was taped. Keep the `est. grade` label visible and explain its source.

### 13. What is the heatmap measuring?

Modelled body-to-garment gap and fit flags, not pressure or calibrated discomfort. FL's development-page parka M check reported 10.9% tight / 62.8% good / 26.3% loose. Those are rest-gap shares for that model, not real-body accuracy. [FL RESULT 2](requests/codex-sync.md)

### 14. What is the X-ray?

A translucent rendered jacket around the fitted body. It exposes the estimated spatial relationship; it is not a camera seeing through clothes or a medical scan.

### 15. Is this body automatically scanned from the camera?

Not in the verified Studio path. It uses entered inputs or the labelled reference. P32a's saved clips crop the head/feet, so its strict pipeline has no accepted absolute scan; a new full-height recording is needed for that calibration. Offline body/face work is pending integration. [CX-TRY result](requests/codex-sync.md)

### 16. How well does pinch work?

ZB's replay used eight recorded hand clips aligned to a synthetic body, with at most 0.0039 normalized zip-travel discrepancy in the first grab. ZB also verified puffer zip/hood and parka zip in scripted Studio with fake camera and Decart off. Real-hand Studio success is `TBD (measured at <next user-present Studio test time>)`. Use the slider/button if tracking fails. [ZB results](requests/codex-sync.md)

### 17. Does every state reach the photoreal view?

Closed/open reference images now exist for both jackets; half/no-hood images do not. DC RESULT 3b adds a **prompt-only no-hood candidate using a hood-on image**; visible success is unverified. Our puffer hood detach/attach is a separate scripted Fit Lab action. The parka hood is bus-only. Set-to-visible latency is `TBD (measured at <next user-present Studio test time>)`. [DC/ZB results](requests/codex-sync.md), [mapping](../apps/web/src/studio/decartViewMap.ts)

### 18. What if Decart or the network fails?

Studio falls back to plain camera; Fit Lab stays useful when its local service is available. The operator can stop Decart and switch manually to frozen `/?rc5`, with its known limits. RC5 is not a photoreal equivalent or an automatic Studio embed.

### 19. Is the camera shared?

Studio shares one live camera stream: trackers read its video and Decart receives a cloned track. The clone prevents an SDK disconnect from stopping the local track. This architecture alone does not establish zero lag or correct cleanup. [Camera code](../apps/web/src/studio/camera.ts)

### 20. Where is the API key?

The permanent key stays in the loopback Node server; the browser receives short-lived client tokens. Host/Origin checks and CSP add defenses. The budget/lifecycle findings remain open; a short-lived token alone is not a spending guarantee. [Review](requests/CX-DAY-decart-review.md)

### 21. Is Studio fully tested end to end?

The development page and form were checked. Scripted Studio verifies puffer zip/hood and parka zip with Decart off. DC's mounting/layout test reported body-only shots without the jacket; ZB also saw an intermittent disappearance. Real-person Studio with Decart remains `TBD (measured at <next user-present Studio test time>)`. A clean console or working bus alone is not visual acceptance.

### 22. Has it reduced returns?

We have not measured that. It is an explainable fit prototype; broader real-wear and shopping-outcome validation is future work.

### 23. Is this a solo project, and what is credited?

One developer with coding-assistant support. Decart, Anny, Three.js, MediaPipe and other dependencies are credited. We did not train their models. Existing license decisions remain in the repo; publication also requires privacy/history cleanup. [Submission](SUBMISSION.md), [audit](AUDIT-demo-day.md)
