# Offline Amazon Fit Agent

From the repository root: `npm run amazon-demo` (or `node scripts/amazon-demo.mjs`).
Requires the two real saved pages and their asset folders under
`data/amazon-pages/`. Nothing is fetched from Amazon. The demo builds a loopback
extension variant restricted to the demo loopback origin, starts its own local agent on 8013, serves pages on 5799 and
opens windowed installed Chrome with a fresh local profile. Production extension
matches remain Amazon-only.

Choose Profile & learning, enter a body and return to the saved product page.
Compare sizes, select a size on the page and try purchase/feedback. The page is
explicitly labelled an offline copy; Amazon's live selection/cart behaviour is
not verified. A chart-only product cannot provide measured 3D geometry.

Close this Chrome window to stop the demo. It automatically closes within
14 minutes to release the shared browser lock; rerun for another rehearsal.
It never stops ports 5711 or 8001. External page requests are blocked and counted.
Claude CLI and paid providers are disabled. No personal profile is preloaded.

Automated proof: `node apps/extension/e2e/fit-agent-overnight.mjs`. This waits for
the shared browser slot (bounded ten-minute attempt), then tests the learning
flow and both real saved pages at 100%/150%/200% native Chrome zoom, light/dark. A resource refusal is
not a passing e2e or a screenshot review; check STATUS-fit-agent.md before demoing.

Startup-only rehearsal: `npm run amazon-demo -- --smoke`. It uses the exact demo
launcher, checks the panel, offline note and every saved stylesheet on both pages,
checks that the throwaway body form is empty, then closes its own resources.
It uses the same shared lock and resource guards as the interactive command.

The studio link transfers the same canonical body, measured product and selected
size in a fragment. The studio clears it immediately and validates it before
fitting. Invalid catalogue identity, size or body inputs are refused.
Zones absent from the Fit Agent API are shown as unknown, never calculated from
unrelated measurements. All chart-derived garment estimates and provisional
personal preference adjustments are labelled on screen.

## Round 2: the exact 60-second judge script

Run `npm run amazon-demo -- --rehearse` to perform these same actions, time every
step, enforce every budget and the 60-second total, and fail on external traffic.
Startup/model loading is outside the timed moment. The rehearsal uses a labelled
synthetic body and hypothetical purchase feedback, not a claim of a real purchase.
The interactive launcher starts empty; enter your own details if preferred.

| Step / clicks in order                                        | Say this                                                                                               | Budget |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| Profile & learning; 70 in, 160 lb, male; opt in; Save         | These are demo inputs; the body is computed locally, and storage is opt-in.                            | 8 s    |
| Return to first saved page; reload; read the recommendation   | This size is computed from the printed chart; a compromise is named plainly.                           | 12 s   |
| Tap shoulder; scroll to neighbouring sizes                    | These are engine values, with tight on the left and roomy on the right; unknown is never called a fit. | 5 s    |
| Select size; Add to compare                                   | The extension uses the page control; this offline copy cannot prove live Amazon selection.             | 5 s    |
| Open the second saved page; Add to compare; Compare these two | A body chart is different from garment measurements, and estimates are labelled.                       | 15 s   |
| I bought this size; suppose chest felt loose; send feedback   | This is hypothetical feedback; the provisional local preference is reversible.                         | 8 s    |
| Open local /catalogue; Try in 3D; check fitted size           | This is a real measured catalogue jacket, with the same local body and size.                           | 15 s   |
| Open the profile; Delete everything                           | Body entries and learned preferences are removed in one action.                                        | 5 s    |

Recovery: if the service is not ready, close this demo window and rerun the command.
A resource guard refusal means another agent or insufficient RAM; wait and rerun,
never stop another service. If a chart lacks units, expose one cm/inches label;
otherwise refusal is correct. If Amazon's saved selector does not react, explain
that only the click is verified offline and use the explicit check-size notice.
If a step or the total exceeds budget, the rehearsal exits with failure and saves
actual timings in `docs/validation/fit-agent-r2-rehearsal.json`; do not claim a pass.

The real studio is served on the same demo port. For a measured catalogue item,
Try in 3D transfers body/product/size through a fragment, removes it immediately,
and uses the existing body-fit path. It refuses an invalid product/size/body.
The two saved Amazon products are chart-only. A separate clearly labelled local
catalogue demonstration is available at `http://127.0.0.1:5799/catalogue` and used
by G7 for the real 3D hand-off. It reads genuine local tapes and graded estimates
from the existing service, with the genuine Amazon ASIN; it is explicitly not a
saved or live retailer page. The current Amazon-linked jacket has no collar tape.

CX-FIT fixed the catalogue ASIN name and added catalogue/studio helper hashes.
Final browser/rehearsal results are recorded in docs/STATUS-fit-agent.md.

Final-source automated rehearsal (CX-FIT): eight steps including fitted 3D and deletion passed in 11.22 s; 3D step 3.63 s; zero completed external requests. This is automation time, not a human benchmark. G7's strict all-page empty-console requirement remains a separate gate; saved retailer scripts emit errors offline, preserved in the report.
