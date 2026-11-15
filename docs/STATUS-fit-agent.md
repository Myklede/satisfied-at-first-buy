# Fit Agent overnight — prompt 10

## Agent A (Claude, 2026-11-13) - catalogue jackets ranked by the full engine

**Defect.** For the tape-measured parka (FB7675-100, ASIN B0C9TQTNYH) the panel recommended **S** while the studio it opened said "Best available: **M**". Cause, measured: `recommend.py` ranked even a matched catalogue jacket from the printed chart. That chart path ranks on chest, shoulder and sleeve only: the page has no hem or upper-arm column. It also uses the generic "regular" chest design ease of 10.0 cm, and it allows no shoulder drop for a loose design. `GarmentService.fit` ranks on 5 zones with the jacket's own chest design ease of 15.2 cm (owned-size tape against Nike's body chart) and its "loose" intent. On the e2e profile the chart path's S scored 28.6 and its M 28.5; the engine gives M 89.7. The chest itself was known on the chart path, because the catalogue loft of 1.0 cm is applied.

**Change.**

- When `catalogue_match(asin)` matches and the garment service is available, the ranking and every zone, collar included, come from `GarmentService.fit(GarmentFitRequest(body_id, product_id, layer_cm, preference))`. This is the studio's own request. `layer_cm` comes from `config.LAYER_PRESETS_CM`, the table the studio reads through `/garment/options`.
- The chip reads "Tape-measured catalogue · full engine" (`three_d.basis`, no API schema change). The trace says "full engine (GarmentService.fit, the 3D studio's computation)".
- "How I decided" keeps the printed chart as one line, "Cross-check only, not the basis: the printed chart alone would pick S …".
- Non-catalogue products are unchanged.
- **Learned offsets** still apply, with the `apply_offsets` semantics. A catalogue jacket's target ease is its owned-size inner girth minus the brand's body chart, so the body chart shifts with the owned size and the jacket's design ease stays the target. Tested: only the offset zone moves, by exactly −X; design ease and every other zone stay the engine's. On the e2e profile a +4 cm chest preference moves the pick one size up on both paths (chart S→M, engine M→L), and both say "Without it we would pick …".
- (Superseded by the follow-up below: the hand-off now carries layer and preference, and the panel note is removed.)

**Agent pick = studio pick** (`tests/test_agent_engine_ranking.py`, real Anny, t-shirt 0.3 cm, regular):

| Body                                              | Agent (router) | Studio `GarmentService.fit` | Printed chart alone |
| ------------------------------------------------- | -------------- | --------------------------- | ------------------- |
| e2e profile, male 177.8 cm / 72.6 kg / chest 96.5 | M              | M                           | S                   |
| female 165 cm / 58 kg                             | S              | S                           | XS                  |
| male 185 cm / 95 kg                               | XL             | XL                          | L                   |

**Gates.**

- Python: `tests/test_agent_*.py tests/test_fit_agent*.py` **88 passed** (78 earlier + 10 new), with the one existing Starlette warning. Ruff check and format pass on the touched files.
- Extension: `node apps/extension/check.mjs`, tsc plus **28 tests** pass. ESLint and Prettier pass on the touched files.
- **e2e:** `node apps/extension/e2e/fit-agent-r2.mjs` gave **46/46 checks** (2026-11-13T15:50:16Z–15:51:41Z) [JSON](validation/fit-agent-r2-e2e.json):
  - own-code console errors 0;
  - 0 completed external requests, 334 blocked attempts;
  - 401 retailer errors from the saved pages, recorded separately.
- New e2e checks:
  - the catalogue chip shows the full-engine basis;
  - "How I decided" shows the cross-check line;
  - the panel's M equals the studio's "Best available: M";
  - the studio is captured only after the drape settles ("Drape preview · 30.86 s compute", 41.4 s after the studio showed "Best available").
- Screenshots inspected: [studio](validation/fit-agent-r2-studio-handoff.png) shows the draped parka in M; [panel](validation/fit-agent-r2-catalogue-panel.png); [How I decided](validation/fit-agent-r2-catalogue-decided.png). This replaces the "Draping fabric" limit noted under prompt 13a below.

**Known gaps.** The collar of the parka stays unknown because it has no collar tape.

### Agent A follow-up (lead request) - hand-off carries layer and preference; catalogue chart printed to 0.1 cm

- **Hand-off.**
  - The private `#handoff=` fragment now carries the profile's "Under it" and "Fit" choices: the same stored choices the panel's `/agent/recommend` used.
  - `apps/web/src/handoff.ts` checks their shape. `knownChoices()` refuses any value that is not a `/garment/options` preset, in `App.tsx` before the body is built and again in `FitStudio.tsx`. A fragment without them is refused too; nothing is guessed.
  - The studio preselects "Worn underneath" and "How you like it" in the same batch that loads the options. Its first and only `/fit/garment` request already uses them.
  - Kiosk mode still ignores hand-offs.
  - The panel note about studio defaults is removed: every extension choice is a studio preset.
  - The profile page now shows the stored choices, so a re-save no longer silently resets them to regular/t-shirt.
- **Catalogue page.**
  - `scripts/amazon-demo-catalogue.mjs` prints 0.1 cm (was e.g. `53.11701293320805`) and states that "the fit engine uses the unrounded values".
  - The cross-check line now reads "the printed chart alone, at its printed precision, would pick S".
  - The ranking basis is unchanged: the full engine on the unrounded catalogue data.
- **Agent = studio for non-default choices** (new test, e2e profile body):
  - hoodie/relaxed: agent and studio both give the same size;
  - t-shirt/fitted: agent and studio both give the same size.
- **Gates.**
  - Python: agent tests **90 passed** (2 new), with the one existing Starlette warning. Ruff passes.
  - Extension: `check.mjs` tsc plus **28 tests** pass.
  - Web: strict tsc passes; `handoff.test.ts` **3/3**, including refusal of missing, unknown and malformed choices.
  - ESLint and Prettier pass on the touched files.
- **e2e:** `fit-agent-r2.mjs` gave **61/61 checks** (2026-11-13T16:06:25Z–16:07:42Z) [JSON](validation/fit-agent-r2-e2e.json):
  - own-code console errors 0;
  - 0 completed external requests, 340 blocked attempts;
  - 407 retailer errors from the saved pages, recorded separately.

  Two hand-off passes on the same profile:

  | Choices           | Panel | Studio "Best available" | Studio selectors  | Every studio `/fit/garment` request |
  | ----------------- | ----- | ----------------------- | ----------------- | ----------------------------------- |
  | t-shirt / regular | M     | M                       | t-shirt / regular | 0.3 cm, regular                     |
  | hoodie / relaxed  | L     | L                       | hoodie / relaxed  | 0.9 cm, relaxed                     |

  Both studios were captured only after "Drape preview". The profile page showed the stored hoodie/relaxed after a reload.

- **Screenshots inspected:**
  - [studio hoodie/relaxed](validation/fit-agent-r2-studio-handoff-hoodie-relaxed.png): draped L, hoodie · 0.9 cm, relaxed;
  - [panel hoodie/relaxed](validation/fit-agent-r2-catalogue-panel-hoodie-relaxed.png): L and the 0.1 cm table;
  - [How I decided](validation/fit-agent-r2-catalogue-decided.png);
  - [studio default](validation/fit-agent-r2-studio-handoff.png): draped M;
  - [deleted profile](validation/fit-agent-r2-deleted.png): empty, choices back to defaults.

## Prompt 13a - lead console ruling

Lead decision: "Gate = 0 console errors from our own code." This includes extension content/background/profile, local catalogue and studio. "The saved retailer page's own errors are expected." They remain recorded in retailer_console with a count and do not fail G7. This supersedes the historical literal raw-console gate below. Background console/unhandled errors are now observed at BrowserContext level as well as pages.

Resume: `node apps/extension/e2e/fit-agent-r2.mjs` after the single shell resource wait (up to 60 minutes). Final result: **G7 passed 42/42** on 2026-11-13T15:27:05Z (46.931 s after resource wait). Own-code console errors 0 (including background context), completed non-loopback requests 0; 338 blocked attempts; 405 expected retailer errors retained. [Passing JSON](validation/fit-agent-r2-e2e.json). Browser lock and own ports released; no reacquisition.

## Current CX-FIT result (prompt 12a)

**R1/R2/R3 complete; R4 rehearsal passed; G7 passed under prompt 13a ruling.** Prior sessions below are historical. The final-source G7 resource refusal is [here](validation/fit-agent-r2-blocked.json); the final retry also exhausted ten minutes under the unchanged guard.

| Item                 | Status                        | Evidence and limit                                                                                                                                                                     |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 explanation       | passed code / partial browser | Plain closest-fit reason; round before signed formatting; real-engine grid regression                                                                                                  |
| G2 bars / comparison | passed code / partial browser | 27 extension tests; one label per comparison row; keyboard and marker checks                                                                                                           |
| G3 diagram           | partial                       | All 14 failed-run screenshots individually reviewed; attached leaders, no overlap; native 100/150% light/dark both pages                                                               |
| G3b onboarding       | passed code / partial browser | Private canonical/original fields, exact 70 in / 160 lb, light/dark card                                                                                                               |
| G4 full handoff      | partial proof                 | Fixed ASIN/category/live-Location bug; web typecheck + 2 handoff tests; rehearsal reaches fitted studio with recommended size; detailed same-body/product/size proof passed (G7 42/42) |
| G5 collar            | partial data                  | Existing service reuse/tests retained; Amazon-mapped product lacks collar tape                                                                                                         |
| G6 rehearsal         | passed                        | 8 steps in 11.2205 s, fitted 3D step 3.6319 s; deletion; 0 external completed; fit-agent-r2-rehearsal.json                                                                             |
| G7 final proof       | passed                        | Prompt 13a: 42/42 checks; same body including chest/product/size; fragment cleared; compare/undo/delete; own-code console 0; external completed 0; retailer errors 405 recorded        |
| R6 optional wow      | skipped                       | R1-R5 are not all green                                                                                                                                                                |

Gates: extension strict tsc + 27 tests; Python 78 passed with one existing Starlette warning; web strict tsc + 2 handoff tests; scoped ESLint/Prettier/Ruff pass. No dependencies, paid API, real Claude CLI or live website calls.

Incomplete-run evidence is clearly named [failed report](validation/fit-agent-r2-failed-e2e.json) and `fit-agent-r2-failed-*.png`. Reviewed all 14 images plus two round-1 comparisons: recommendation and reason lead; original entries remain exact; no negative zero; diagram leaders attached; comparison labels occur once per row. At 150% lower panel content scrolls vertically; neighbour table scrolls horizontally. No detailed-run studio/deletion image was reached. Rehearsal proves those actions separately, not every G7 assertion.

**Known gaps:** literal raw console is not empty: saved retailer JS errors from blocked CDN/chunk/service worker/hydration are preserved separately, not suppressed. The old raw-console gate below is superseded by prompt 13a: retailer errors do not fail G7. Unmeasured insulation stays unknown; collar needs real tape; no invented body/fit values.

Resume: `node apps/extension/e2e/fit-agent-r2.mjs`, inspect every new image and hashes, then `npm run amazon-demo -- --rehearse`. Requires free RAM >=2.5 GiB and shared browser slot; never stop foreign processes. Demo command: `npm run amazon-demo`; measured local catalogue: `http://127.0.0.1:5799/catalogue`.

User-present follow-ups: real subscription Claude CLI smoke; optional live Amazon rehearsal. Historical notes below are superseded by this table.

## Round 2 — prompt 11

G1: ranking explanations now have one headline and at most two supporting lines.
They use the same adjusted status as the panel rows. Physical numbers stay
unshifted; body-chart distance is explicitly presented as range margin, with
room-positive direction. No engine ranking or body calibration was changed.
Real-engine grid tests cover tight/fit/roomy, garment/body charts, preferences on/off.
Initial G1 gates: Python 73 passed (one existing Starlette warning); extension
21 passed plus tsc. Final round-2 gates and evidence follow below.

### Decisions, round 2

1. Keep the stricter 15-minute browser lease and all prompt-10 safety boundaries.
   Preserve the initial foreign dirty engine/kiosk/schema paths; work alone.
2. Explain the actual ranked compromise rather than changing ranking to make
   copy sound nicer. Distinguish physical room from provisional preference;
   mention the baseline pick only when it differs. No invented fit numbers.
3. G2 bars use deltas and tolerance widths supplied by the existing fit engine,
   including preference adjustment, not thresholds copied into the UI. Bring
   agent-only type generation forward for those two optional display fields;
   the generated diff is confined to ZoneView. Schema content diffs are empty
   and schema files are not staged. Unknown rows become one quiet sentence.
   Move learning below the recommendation and decision disclosure. G2 gates:
   extension 22 passed + tsc; Python 73 passed; scoped lint/format passed.
4. G3 uses hand-drawn male/female/neutral SVG outlines with attached leaders,
   bands and keyboard-focusable zones. Only the coarse illustration choice is
   supplied by the private worker; body measurements are not exposed to Amazon.
   The geometry is explicitly an illustration, never a scan. Missing bands are
   dashed and labelled. Extension 23 tests + tsc/lint pass; browser critique is G7.
5. G3b keeps verbatim unit-specific entries alongside canonical cm/kg in private
   extension storage. It writes them to local storage only after the consented
   profile save succeeds; session entries stay in session storage. Deletion clears
   both. No body entry is returned to content scripts. Unit drafts restore exact
   typed strings rather than converting rounded kg back to pounds. The stored-data
   disclosure is a readable table, not JSON. Gates: extension 24 + tsc, Python 73,
   scoped ESLint/Prettier/Ruff pass.
6. G4 clears the fragment before parsing or any request, validates strict API
   ranges and catalogue size membership, then submits the studio's existing body
   build path. Invalid input stops automatic fitting. Kiosk ignores and clears
   it at module entry. The private worker creates the fragment; Amazon content
   never receives body numbers. The own-port demo mounts the existing studio API
   on 8013 with one shared Fitter, and serves the real studio via Vite middleware
   on the existing 5799 listener; it never uses 8001/5711 or a second model.
   G4 web typecheck and all 264 web tests passed; extension 25 tests passed.
   The mounted-route/cache test and full agent suite pass (74 tests). Align chest
   entry validation with the API's 45–200 cm range. In kiosk mode, the worker does
   not read saved original-entry data. Browser hand-off proof is included in G7.
7. G5 reuses GarmentService.fit for neck/collar metrics and its existing comfort
   bands. Collar is informative, excluded from ranking and uncalibrated learning.
   Generated diffs are limited to agent Zone types; schema content is unchanged.
   Data blocker: the Amazon-mapped jacket has no collar tape. The only current
   collar tape is the Nike/eBay size S (35 cm inner, 8 cm height), with no Amazon
   identity. Do not invent an ASIN, tape, or edit product files. Tests use a clearly
   synthetic identity carrier with the real measured catalogue/service, verify
   exact metric reuse and chart-only unknown. Gates: Python 76, extension 25,
   web tsc, scoped lint/format pass. A real Amazon collar demo needs matching tape.
8. G6 defines the exact clicks and one-line narration in docs/demo/amazon.md.
   --rehearse executes that script on both real saved pages, records every step,
   fails a per-step or total 60-second budget, and rejects completed external
   requests. The first actual guarded run passed all seven steps in 5.84 seconds
   of automation (not human demo time), with zero completed external requests.
   Hypothetical feedback and synthetic body inputs are explicitly labelled;
   model/browser startup is outside the timed moment. See fit-agent-r2-rehearsal.json.
9. The stored-profile disclosure includes every leaf of the original entry and
   service profile, including default density, shape choice, preferences and date.
   Keep them as readable table rows, not an abbreviated summary. Hide the legacy
   units select from layout; the visible control is the segmented toggle. Follow-up
   extension tests: 26 passed with tsc/lint/format. G7 is waiting for S's browser
   lease and the unchanged 2.5 GiB minimum; no guard is bypassed.
10. The saved pages do not match the measured catalogue. Provide a separately
    labelled local catalogue page at /catalogue, using the real service's tapes,
    graded estimates and genuine Amazon identity. Never rewrite a saved page's
    ASIN to pretend it is measured. G7 will use this page for the studio hand-off.
11. The first browser run caught a leftover PRE container around the stored-data
    table. Replace it with a real collapsed disclosure, rather than weakening
    the test. Unit edits invalidate only the edited field's converted counterpart;
    changing height or clothing preference must not corrupt the original weight.
12. The next guarded browser run passed onboarding, keyboard access, native size
    selection, comparison, feedback and all eight saved-page light/dark 100/150%
    configurations. It failed before the studio: the local catalogue input has
    id="ASIN" but lacks name="ASIN", which pageAsin requires. The narrow pending
    fix is to add that name in scripts/amazon-demo-catalogue.mjs, then rerun G7.
    Do not change the extractor or the saved retailer pages to hide this defect.
13. Automatic approval review could not execute the fix/check/browser command:
    its access token could not be refreshed after logout/account change. The
    entire requested command was not executed. This was a review infrastructure
    failure, not an unsafe-action determination. Do not bypass approval. Record
    the blocker and preserve the uncommitted evidence; signing in again is needed
    before the blocked action and final git writes can resume.

## Current round-2 validation

- Extension: 26 tests plus strict tsc pass.
- Python Fit Agent: 76 tests pass; one existing Starlette deprecation warning.
- Web: strict tsc and all 264 tests pass.
- Scoped ESLint, Prettier and Ruff pass.
- Exact judge rehearsal: seven steps pass, 5.84 seconds automated, zero completed external requests.
- G7 browser/evidence: 32 checks passed, then failed at the local catalogue's missing ASIN input
  name before studio hand-off. The JSON explicitly has passed=false. No complete
  round-2 e2e or final deletion proof is claimed. The interrupted run observed
  zero completed external requests and cleaned up its own 8013/5799 listeners.
- Current data gap: Amazon-linked catalogue jacket has no measured collar tape.

### Visual critique and before/after evidence

Inspected all 14 images generated by the latest run individually: both real
saved pages in light/dark at native 100/150%, both diagram views, light/dark
onboarding, comparison and learning. Recommendation and reason are prominent;
there is no contradictory baseline pick. Colours and onboarding share the kiosk
palette. The panel itself stays inside the viewport at 150%; lower content uses
its vertical scroll. Attached diagram leaders do not overlap. Remaining polish:
the body-chart explanation prints negative zero, diagram secondary labels are
small, and comparison repeats zone names. These are observed issues, not a claim
that G7's final visual rubric is fully green. Studio and deletion screenshots
were not reached. The images below are partial evidence, not a passed e2e.

| Before (round 1)                                                                  | After (round 2, partial G7)                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ![Old body-chart decision](validation/fit-agent-overnight-02-body_html-sizes.png) | ![Consistent decision and attached zones](validation/fit-agent-r2-failed-02-body-light-1.png) |
| ![Old garment panel](validation/fit-agent-overnight-01-garment_html-light-1.png)  | ![New garment recommendation](validation/fit-agent-r2-failed-01-garment-light-1.png)          |
| ![Old profile](validation/fit-agent-overnight-profile.png)                        | ![Private profile card](validation/fit-agent-r2-failed-profile-light.png)                     |

### Morning checklist / resuming the blocked finish

1. Restore the tool sign-in/automatic approval session. Read git status again;
   retain all concurrent engine/kiosk/schema changes and stage only owned paths.
2. Add name="ASIN" to the genuine local catalogue input. Include the catalogue
   and studio middleware helpers in the G7 source-hash manifest.
3. Rerun scoped checks, then node apps/extension/e2e/fit-agent-r2.mjs with the
   unchanged browser lock/resource guard. Complete studio and deletion proof,
   inspect every new screenshot and address the visual issues listed above.
4. Rerun npm run amazon-demo -- --rehearse against the final source. The recorded
   5.84 s is an earlier successful automated rehearsal, not a human performance
   claim or proof of the later catalogue fix.
5. Commit the owned G7 scripts, evidence, UI polish and report in small green
   commits. The current failed proof and pending G7 scripts remain uncommitted.
6. For a user-present follow-up only: real Claude subscription CLI smoke test
   and optional live Amazon rehearsal. No paid API or real CLI was called here.

Run `npm run amazon-demo`. For the timed script, run
`npm run amazon-demo -- --rehearse`. The real measured catalogue demonstration
is at `http://127.0.0.1:5799/catalogue` once the launcher is running.

## Round 1 archive (prompt 10)

Historical evidence below is retained for comparison. The old hand-off/API-type
ownership blockers were lifted by prompt 11; refer to the round-2 report above.

### Result and scope

Worked through F1 → F6 as one agent. Preserved Claude's inherited changes and
commits. Only prompt-10 paths were edited, plus the explicitly allowed one-line
`amazon-demo` script in a separate root-package commit. No dependencies added.

| Item                | Result                                        | Evidence / limitation                                                                                                                             |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 offline launcher | Passed: exact-launcher smoke                  | `npm run amazon-demo`; own ports 8013/5799, fresh store/profile, saved assets, demo-only loopback injection                                       |
| F2 panel            | Visual/keyboard passed; API zones partial     | Big recommendation/reason, illustrative zone map, neighbouring sizes, source chips, trace, compare/learning; unavailable API zones remain unknown |
| F3 studio bridge    | Partial, blocked at existing web-app boundary | Validated catalogue `?product=` link; chart-only disclaimer; body/size must be re-entered in the studio                                           |
| F4 onboarding       | Functional proof passed                       | Live assumptions, metric/imperial conversion, optional chest, opt-in persistence, one-click delete including extension state                      |
| F5 chart robustness | Passed                                        | Expanded merged headers, multirow recognition, fractions/ranges, regular-size filtering; missing/ambiguous units refused                          |
| F6 final proof      | Passed: 61/61 checks                          | Both pages at native 100/150/200% light/dark, neighbouring sizes, keyboard and complete deletion checks                                           |

### How to run

From the repository root: `npm run amazon-demo`.

Requires the two saved HTML pages and their `_files` folders in
`data/amazon-pages/` (read-only, gitignored). The launcher waits up to ten minutes
for the shared browser slot/resources, opens windowed installed Chrome with a
throwaway profile, blocks non-loopback page requests, and closes its own service
and page server when Chrome closes. A 14-minute lease releases the browser for
other agents. It never stops ports 5711 or 8001.

Startup-only check: `npm run amazon-demo -- --smoke`.
Full proof: `node apps/extension/e2e/fit-agent-overnight.mjs`.
See `docs/demo/amazon.md` for operation and limits.

### Validation

| Gate                                            | Measured result                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `node apps/extension/check.mjs` (tsc + Vitest)  | 5 files, 21/21 tests pass                                              |
| Python `test_fit_agent*.py` + `test_agent_*.py` | 69/69 pass in 6.60 s; one existing Starlette/httpx deprecation warning |
| `ruff check` agent package + new chart test     | All checks passed                                                      |
| `ruff format --check` same paths                | 16 files already formatted                                             |
| ESLint extension + `scripts/amazon-demo.mjs`    | Pass                                                                   |
| Prettier changed extension/harness paths        | Pass                                                                   |
| Final browser proof / exact launcher smoke      | 61/61 browser checks pass; exact launcher smoke passes                 |

Python tests were selected explicitly with PowerShell `Get-ChildItem` because
Windows does not expand shell glob arguments for pytest. No `uv sync` or install
was run. No paid API or real Claude CLI was called. Full-repository gates were
not run across concurrently edited foreign paths; these results cover this task.

Browser proof reached 61/61 checks on both real saved pages, with 33/33 local
stylesheets each, native Chrome 100/150/200% light/dark, keyboard zone access and
horizontal size comparison, source/estimate badges, compare/learning/undo, and
complete profile deletion including browser state. Observed non-loopback completed
requests: 0, with 358 blocked attempts; console empty. The final neighbour layout is verified; all nine recorded source hashes match
the current files.

The exact launcher smoke passed on both pages: panel + offline note + 33 local
stylesheets each, fresh body form empty, observed external completed requests 0
and 392 blocked attempts. Ports 8013/5799 were verified released after shutdown.
Resource refusals are recorded separately in `fit-agent-overnight-blocked.json`;
they preserve the other agents' browser lock and processes.

### Evidence and visual review

Final browser report: [61/61 checks](validation/fit-agent-overnight-e2e.json),
finished 2026-11-13T07:53:59.183Z. Both own ports (8013/5799) were verified
free after shutdown, and the owned browser lock was released. Build isolation
also passed: [demo vs production manifest](validation/fit-agent-overnight-builds.json).

Reviewed both saved pages in light/dark at native 100/150/200% zoom, plus the
computed diagram details, profile deletion and final adjacent-size tables.
The panel stays in the viewport and scrolls; at high zoom its lower content
requires scrolling. Original unsaved remote Amazon banners/scripts remain blocked.
Shipping/account labels are hidden only during captures; the panel stays visible.

- [Garment page, light 100%](validation/fit-agent-overnight-01-garment_html-light-1.png)
- [Garment page, dark 150%](validation/fit-agent-overnight-01-garment_html-dark-1.5.png)
- [Body-chart page, light 200%](validation/fit-agent-overnight-02-body_html-light-2.png)
- [Garment neighbours](validation/fit-agent-overnight-01-garment_html-sizes.png)
- [Body-chart neighbours M/L/XL](validation/fit-agent-overnight-02-body_html-sizes.png)
- [Deleted profile](validation/fit-agent-overnight-deleted.png)

There are 21 PNGs (12 zoom/scheme views, two diagrams, two size strips, five flow
screens). The real-page proof includes the earlier synthetic purchase feedback's
computed +2.0 cm chest preference; it is labelled provisional. The interactive
launcher starts with an empty profile and no learned preference.

### Known gaps

- **F3 cannot transfer the same body/size with the existing route.** FitStudio
  accepts only `?product=` and takes the body from its own app state/service.
  Standalone port 8013 has separate in-memory state. The UI explicitly says to
  re-enter the body and choose the recommended size. No ignored URL parameters
  are advertised as working. The measured URL is unit-tested; a complete studio
  round trip is blocked by the prohibition on web-app changes.
- **F2 zone API coverage is partial.** The current generated Fit Agent Zone enum
  exposes shoulder/chest/hem/sleeve/bicep. Collar, waist, hip and vertical length
  markers show unknown where no zone is returned. Hem circumference is not
  relabelled as vertical length. Shared generated types/web/garment changes are
  outside the assigned paths. The diagram is labelled illustrative, not a scan.
- The saved Amazon copies have blocked original scripts/CDNs. Fixture tests prove
  selector state changes; real-page tests prove finding/clicking their selectors,
  not Amazon's current live response, purchase or cart behaviour.
- Insulated garment inner girths stay unknown without measured loft, even when
  an outer chest chart exists; this is an engine limitation, not missing DOM data.
- Body-chart garment values are estimates. Personal feedback uses the existing
  provisional learning rule; the panel discloses this and supports undo/deletion.
- The 20-second setup is a design target, not a timed human benchmark. No body
  accuracy improvement or preference calibration is claimed by this milestone.
- Browser proof uses synthetic body inputs (70 in / 160 lb, male), converted to
  177.8 cm / 72.6 kg; every displayed fit is computed by the real engine. The
  interactive launcher starts empty and does not preload this test profile.
- A real Claude CLI smoke test and live Amazon rehearsal require the user present;
  both were intentionally omitted. Missing evidence remains a visible refusal.

### Decisions made overnight

1. Use prompt 10 as the only assignment; unfinished prompt 09 belongs to Claude
   CX. No subagents were restarted and no foreign dirty path was touched.
2. Choose the stricter 15-minute lock bound over the user's 20-minute maximum.
   The proof uses a 13-minute lease and the interactive launcher 14 minutes.
   Refuse a busy port or insufficient RAM; never remove a foreign lock or process.
3. Use fresh repo-local build/profile/store directories instead of deleting or
   reusing inherited outputs. The demo variant injects only on its loopback
   origin; the production extension remains Amazon-only.
4. Disable real Claude CLI and paid providers in demo/test child environments.
   Block external page requests rather than fetching live Amazon or CDNs.
5. Reject unit inference from number magnitude. Require printed cm/inches
   evidence and explain a missing/ambiguous unit; expand merged headers first.
6. Keep absent collar/waist/hip/vertical-length zones unknown rather than inventing
   fit values, substituting hem girth, or editing shared generated API types.
7. Keep F3 a disclosed partial bridge rather than pretending ignored body/size
   URL parameters work or modifying the out-of-scope web app.
8. Fix native form validation after unit conversion with `step="any"`; the API
   conversion still rounds to 0.1 cm/kg and enforces physical bounds. A 0.1 input
   step had rejected the converted 159.99 lb value in the actual browser.
9. Canonically decode saved asset URL keys and serve `.js.download` as JavaScript.
   Visual review caught missing saved-page CSS that an early panel-only assertion
   missed; the proof now requires every local stylesheet to load on both pages.
10. Use Chrome's actual tab zoom, not CSS zoom, for 100/150/200% evidence. Keep
    viewport checks consistent with DOM coordinates and respect reduced motion.
11. Hide saved shipping/account labels during evidence capture; commit only the allowed saved
    page/extension renders, never user photos or source HTML/assets.
12. Show engine tradeoffs as a best-available compromise when tight/too-large
    zones remain. Collapse old learning history so the recommendation is primary;
    newly submitted feedback opens its result and states the rule is provisional.
13. Delete the extension's compare/preferences/session body and reset visible
    form inputs after successful deletion, in addition to backend profile/learning.
14. Add a startup-only smoke mode to test the exact interactive launcher without
    preloading a body or leaving a browser/service running.

15. An extra real-page chest assertion was wrong: insulated girth is unknown
    without loft. Test an actually computed diagram zone and prove missing collar
    remains unknown; do not change the engine to satisfy a test assumption.
16. Privacy rectangles covered the panel at high zoom. Replace those rectangles
    with screenshot-only opacity on the account/shipping elements, preserving
    layout and the panel. Verify the exported images, not only DOM bounds.
17. Visual review of the size strip showed it starting at XXS, hiding the selected
    size off-screen. Show the selected size and immediate printed neighbours,
    retain all-size tabs, wrap numeric cells, and test keyboard scrolling in a
    narrow viewport. No measurement or ranking changes.
18. Saved Amazon scripts cannot prove the live selection reaction. A successful
    selector action now asks the shopper to check the page's size, rather than
    claiming that a click necessarily changed Amazon's selected state. Fixtures
    still verify the actual native selector state change.

### Commits

- `7999213` offline launcher and initial documentation.
- `7fd4f96` diagram and size comparison panel.
- `d0c71b4` catalogue route validation and honest transfer limitations.
- `176022f` profile assumptions and input tests.
- `321f3b1` merged charts and evidence-only unit parsing.
- `8024b0a` the single authorized root script line.
- `09c9a89` demo variant, actual-browser form fix, UI/privacy polish and smoke mode.
- `9a464ee` recognise multirow headers before opening another chart.
- `d2d245c` sticky header layering and top-level-only offline note.
- `fa85868` adjacent-size comparisons, keyboard access and honest selector feedback.
- `c69f7e2` locked browser proof, 61 checks and the final 21 evidence images.

### Morning demo checklist

1. Read the final browser/smoke result above and the known gaps; do not present
   a pending or blocked item as passed.
2. Ensure both saved pages/assets exist and close unnecessary applications. The
   command will wait for the shared browser lock, free ports and RAM ≥2.5 GiB.
3. Run `npm run amazon-demo`; Profile & learning starts empty. Enter sex, height,
   weight and optionally a chest tape; persistence is opt-in.
4. Show the recommendation reason, source/estimate chips, tap a zone for cm/in,
   compare neighbouring sizes, select a size, compare products, then give/undo fit
   feedback. Use both saved pages; the offline note must remain visible.
5. A catalogue studio link needs manual body/size setup there. Chart-only pages
   do not offer measured 3D. Unknown zones mean missing data, not good fit.
6. Delete everything and close this demo Chrome window to release its resources.
7. Only when present: decide whether to run the real subscription Claude CLI
   smoke and rehearse on live Amazon. No paid provider/extra usage was enabled.

### CX-FIT takeover (prompt 12a)

R1: reviewed inherited diffs and three proof scripts; retained failed G7 evidence uncommitted. Extension check: 26 passed; Python: 76 passed, one existing warning; scoped ESLint/Prettier/Ruff passed. Sandbox spawn/temp permission errors were rerun through approved escalation. No foreign work staged.

### CX-FIT R2 decisions and gates

- Fixed only the genuine catalogue input name; saved pages/extractor unchanged.
- Rounded before signed formatting in explanation, removed ranking jargon and reduced neighbour prose to one selected-zone line. Ranking and calibration unchanged.
- Unknown girths now distinguish printed outer circumference with unmeasured insulation from genuinely absent measurements. Service and presentation regression tests added.
- Zone labels appear once per comparison row; diagram retains inherited 12/10 px labels and discloses inner-fit unknown on tap.
- G7 manifest includes catalogue/studio helpers and explanation/service sources. Added undo and all-page application-error checks; blocked resource net errors are not application errors.
- Extended rehearsal with real fitted catalogue handoff (15 s step budget); total remains 60 s. Automated execution is not human timing.
- R2 gates: extension strict tsc + 27 tests; Python 78 passed (one existing Starlette deprecation); web tsc and handoff test pass; scoped ESLint/Prettier/Ruff pass. Browser proof pending resource guard (2.02 GiB free at first attempt).

R3 follow-up: the proof found an additional real handoff bug: history.replaceState mutates live Location.hash. Capture encoded input in memory before clearing, still parse only after URL removal. Added a mutating-Location regression test (2/2 handoff tests pass). Undo proof now opens Profile's learned-preferences disclosure; the headline shortcut exists only when feedback changes ranking. Preserve all retailer-console messages separately; never claim the raw saved-page console is empty.

Catalogue follow-up: after ASIN recognition, rules correctly refused a title containing only brand/style with no supported top category. Render the genuine product.category alongside style; do not relax extraction. The first expanded run proved undo but stopped before studio for this refusal. All eight screenshot configurations were inspected: prominent S/M and reasons, no negative zero, labels attached without overlap; 150% uses panel scrolling. Full raw console includes saved Amazon script failures under blocked internet and is not empty. Awaiting S browser lease before final run.

R4 final rehearsal passed on 2026-11-13T14:44:31Z: all eight steps, 11.2205 s automated total; real measured catalogue to fitted studio 3.6319 s; deletion passed; 0 external completed, 433 blocked attempts. Both child servers and browser shut down. G7 retried after this newly available slot, then exhausted another ten-minute resource wait; no final detailed run started.

Final handover: all own processes stopped; own ports 8013/5799 released. Final G7 resource refusal is recorded in fit-agent-r2-blocked.json. R3 remains blocked and R6 was not started. Resume with `node apps/extension/e2e/fit-agent-r2.mjs` after RAM >=2.5 GiB and browser slot are available. Shared-tree dirty files outside CX-FIT are preserved, not a clean-repository claim.

### Prompt 13a final visual inspection and limits

Inspected all 16 new screenshots once: both saved pages light/dark at native 100/150%, both diagrams, light/dark profile, compare, learning, studio and deletion. Panel recommendation/labels are readable and remain within viewport; lower content scrolls. Deleted form is empty. Source hashes checked against final files; original failed evidence remains untouched.

Studio screenshot proves selected catalogue/body/size plus analytic fit metrics, but capture occurs while the cloth is still labelled "Draping fabric" and no jacket is visible yet. Therefore it is **not** evidence of a fully rendered garment. Studio separately recommends M while the transferred chart pick is S; the selected tab correctly stays S. G7 proves the handoff, not ranking equivalence between the printed-chart and full-catalogue engines. These visual limits are explicit; no extra browser run was taken after release.

Final validation for this narrowly scoped proof: extension tsc + 27 tests pass, scoped ESLint/Prettier pass, G7 42/42 pass. Earlier 78 Python and 2 web handoff tests remain the unchanged application baseline; not rerun for this harness-only edit.

Resume: no further G7 run required for prompt 13a. Optional user-present work remains real subscription Claude CLI smoke and live Amazon rehearsal. Demo: `npm run amazon-demo`.
