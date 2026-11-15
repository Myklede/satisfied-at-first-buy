# Studio judge Q&A — short, evidence-backed answers

Updated for the P34b redesign after FL RESULT 5 and ZB RESULT 3. [Current evidence](SUBMISSION.md), [rolling truth audit](requests/CX-DAY-truth-audit.md). Owner-reported scripted checks are distinguished from real-person acceptance, which remains TBD.

### 1. Isn't this just Decart?

Decart supplies the credited photoreal renderer. We built body/garment fit reasoning, the Three.js Fit Lab, see-through explanation, size comparison, gesture/state bridge, cloth interactions and local token service. Decart does not choose the size. [Architecture](../prompts/31-decart-pivot-plan.md)

### 2. How accurate is the fit?

There is no validated population accuracy number. Height/weight constrain an estimated body; density, surface landmarks, material and comfort assumptions need broader validation. Some garment sizes use estimated grades. Convergence is not proof of correct personal anatomy. [Sweep limitations](look/collar-sweep.md)

### 3. What is physics and what is generated?

Fit Lab owns the body/garment geometry, returned ease/offsets and cloth solver. Decart generates the large video image. Its discrete appearance updates do not reproduce the solver's continuous cloth, and hem pull is not sent as a cloud visual effect.

### 4. Does cloth follow my whole moving body continuously?

The ordinary preview follows tracked pose. Zip/hood/hem interaction switches to the static-body solver; live pose resumes separately. We do not claim moving-body cloth simulation on every frame. [FL/ZB results](requests/codex-sync.md)

### 5. What leaves the laptop?

Starting Decart sends camera video, garment references and the requested appearance prompt to Decart. Fit computation and pose/hand processing stay local. DC RESULT 5 observed `zeroDataRetention=false` in the token claims; do not promise zero provider retention or verified deletion. Without a started cloud session, these local fit checks do not send video to Decart.

### 6. Are inputs or recordings saved?

Body form fields can persist in localStorage. **Reference body** removes that form entry, not every backend cache or forensic trace. REC explicitly downloads the big video slot; it does not automatically record the whole two-panel page. Public footage needs separate approval. [Storage](../apps/web/src/studio/fitlab/personStore.ts)

### 7. What does it cost per person?

Actual spend per demonstrated round is **TBD**. Duration/rate budgeting is an estimate, not observed billing. Free credits come first; only the user approves and performs any top-up within the $30 total rule. No agent starts a cloud session. [Rules](USER-RULES.md), [budget implementation](../scripts/decart-budget.mjs)

### 8. Is the $30 cap impossible to bypass?

No certified provider billing ceiling is established. DC RESULT 4 reports fixes for the independent accounting/token/lifecycle findings with handler-level tests. DC RESULT 5 confirms that one real token echoes duration/model/origin limits, without starting a session. The lead must confirm the running server version; application checks are not a billing guarantee. [Historical review](requests/CX-DAY-decart-review.md), [latest results](requests/codex-sync.md)

### 9. Why not only use 3D?

Local RC5 AR did not meet the user's visual bar for wobble, turns and coverage. It remains a separate manual offline fallback. Decart supplies appearance while our engine keeps fit reasoning inspectable; RC5 is not claimed photoreal.

### 10. Does it work with arbitrary jackets or trousers?

We support the documented jackets and their sourced/estimated measurements. Visual plausibility cannot recover all hidden body or garment dimensions. The displayed trousers are visual styling following the fitted body; they are not another measured garment-fit result.

### 11. How is a size chosen, and why can a recommended size still have a tight zone?

The service ranks sizes using body/garment dimensions, layers and regional rules. Overall ranking does not guarantee that every zone fits. Read the selected size's actual zone notes and preserve the original recommendation, including XS/XL when outside Studio's S/M/L. The audit found a selected-word branch that can hide tight zones; its fix must be verified before claiming perfect agreement. [Truth audit](requests/CX-DAY-truth-audit.md)

### 12. Are all sizes measured, and are switches instant?

Owned tapes and estimated grades are distinct; the redesign's missing grade qualifier is recorded in the audit. FL RESULT 5 measured 3–20 ms for warm S/M/L switches in fitlab-dev, after all shells loaded. Cold loading, a different jacket and physics transitions are asynchronous. A pending selection can show the previous fallback garment beside the new verdict until the shell is ready; do not mistake that interval for a completed comparison.

### 13. What do the red regions mean?

Only engine tight/snug zones get light coral tint in see-through. Good/loose regions have no shell tint; space is visible geometrically. Ease-to-opacity is documented display mapping, not measured pressure, force or calibrated discomfort. The redesigned flow has no separate heatmap control. [Mapping and trace](requests/CX-DAY-truth-audit.md)

### 14. What happens when I scroll, and where do the notes come from?

Fit Lab opens on the opaque Look with the fitted body and trousers. Scrolling over it moves closer and reveals a translucent jacket; notes point to zones and use the selected size's returned ease/offsets. This is rendered geometry, not a camera seeing through clothes. FL RESULT 6 also verifies physics collar tint and its anchored note in a scripted run. Warm the shaders; current cold-load delay is TBD. [FL results](requests/codex-sync.md)

### 15. Is the body automatically scanned from the camera?

Not established by these Studio results. Use voluntary entered inputs or the labelled reference. Camera pose tracking does not itself establish absolute dimensions or an accepted full-body scan. Camera-based body integration remains subject to its own validation.

### 16. How reliable are pinch and hem pull?

ZB RESULT 4 used scripted hands/fake camera, Decart OFF: puffer zip/hood/hem and parka zip/hem worked. Puffer S follow was 0.4 cm (observed peak 0.6), parka S 0.36 cm (peak 0.52), both taut. These are simulated displacements in those pulls, not force measurements or universal give limits. Closed-shell hem stretch is separate from opened-jacket stiffness tuning. Release ends the pull; an opened split jacket can move without a fit-pull readout. Real-person success is **TBD**; use the zip slider/button if tracking fails. [Result log](requests/codex-sync.md)

### 17. Does every state reach the photoreal view?

Both jackets have closed/open references. Half/no-hood images are absent; the prompt-only no-hood candidate uses a hood-on image and needs separate visible verification. Puffer hood detach/attach in Fit Lab is scripted-verified; parka hood is bus-only. Decart ignores hem pull. Cloud set-to-visible delay remains **TBD**. [DC/ZB results](requests/codex-sync.md)

### 18. What if the network or Decart fails?

Studio falls back to plain camera, with Fit Lab useful while its local service is available. The operator may stop Decart and switch manually to frozen `/?rc5` with known limits. RC5 is not automatically embedded or visually equivalent to Decart.

### 19. How does the collar demonstration stay honest?

Close the zip before applying collar ease: S inner collar tape minus estimated neck section. Show the judge's actual result, even regular/roomy, then compare the real jacket without changing it. The synthetic BMI grid found tight/snug in 44/54 male and 25/54 female cases, not population rates. Height monotonicity has HIGH counterexamples. Boundaries are provisional comfort labels; missing M/L collar tapes do not prove relief from upsizing. Physics tint/notes need the integration check in the audit. [All synthetic cases](look/collar-sweep.md)

### 20. Where is the API key, and is the camera shared?

The permanent key stays in the loopback server; the browser receives constrained client tokens. One camera stream feeds local tracking and a cloned track feeds Decart. DC reports lifecycle/CSP fixes; architecture and a clean console alone do not prove perfect cleanup or privacy. [DC RESULT 4/5](requests/codex-sync.md)

### 21. Is Studio fully tested end to end?

FL RESULT 5 checks the redesigned development page; ZB RESULT 3 and FL RESULT 6 check scripted Studio interaction with Decart OFF. DC RESULT 4b's earlier separate shot had an empty Fit Lab area; FL RESULT 6's later physics image visibly contains the body, jacket, collar tint and notes. That later success does not establish real-camera Studio with Decart, which is **TBD**. Remaining truth/provenance findings retain their own status; no agent-run cloud session was added for this refresh.

### 22. Has it reduced returns?

We have not measured that. Explainable fit is the prototype's contribution; broader worn-garment and shopping-outcome validation comes next.

### 23. Is this solo work, and what is credited?

One developer with coding-assistant support. Decart, Anny, Three.js, MediaPipe and other dependencies are credited; we did not train their models. Publication still requires the owner's privacy/history cleanup. Nothing here uploads or submits the project. [Submission](SUBMISSION.md), [audit](AUDIT-demo-day.md)
