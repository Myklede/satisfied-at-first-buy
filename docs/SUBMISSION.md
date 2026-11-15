# Satisfy at the First Buy — Studio submission pack

Updated 2026-11-15 for prompt 32b. Devpost deadline: **08:00 local**. Draft only; nothing has been uploaded or submitted.

The current presentation is **Decart large + our Fit Lab at the side**, at `/studio.html`. The user approved Decart's appearance at 02:14; that does not establish fit accuracy or integrated Studio acceptance. [Pivot](../prompts/31-decart-pivot-plan.md), [result log](requests/codex-sync.md)

Use the [Devpost text](submission/devpost-draft.md), [3-minute spoken script](DEMO-SCRIPT-2MIN.md), [shot list](submission/video-shotlist.md), [judge Q&A](JUDGE-QA.md) and [claim register](submission/claim-register.md). The script keeps its historical filename for links; its duration is **180 seconds**.

## Contribution and attribution

Our work: Anny body fitting; sourced garment/size-chart measurements; regional ease and size ranking; the Three.js Fit Lab with X-ray and heatmap; local pose/hand processing; cloth zipper/hood interaction; the shared-camera/state bridge; and the loopback token/budget service. **Decart Lucy VTON renders the photoreal video.** We did not train or build Decart. Its pixels do not measure fit. [Architecture](../prompts/31-decart-pivot-plan.md)

Studio uses a labelled reference body or the **Your body** form. Camera-derived body/face work is pending CX-TRY P32a; cropped source clips have not supplied an accepted absolute scan. Live posed preview and static-body interactive cloth are different modes. [FL/ZB/CX-TRY results](requests/codex-sync.md)

## Available evidence

| Evidence                                                                                  | Exact scope                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both jackets: reference-body S tight / M good / L loose, M recommended                    | FL RESULT 1, 01:48. These are that body's computed results, not universal size labels.                                                                       |
| Fit Lab pose, X-ray, size change and physics entry/exit browser-checked                   | FL RESULT 2, 02:19; development page, stub bus and synthetic pose.                                                                                           |
| Parka M rest-gap shares: 10.9% tight / 62.8% good / 26.3% loose; L: 10.2% / 54.2% / 35.6% | Same FL RESULT 2; model gaps, not measured pressure or personal accuracy.                                                                                    |
| Your body form and reference reset checked; 22 targeted tests green                       | FL RESULT 3, 02:27; stored form fields are local browser data.                                                                                               |
| Gesture bridge discrepancy at most 0.0039 normalized zip travel                           | ZB RESULT 1, 01:08; eight recorded hand clips aligned to a synthetic body, first grab.                                                                       |
| Puffer solver zip/hood transitions; parka zip transitions                                 | ZB RESULT 2, 02:40; scripted hands, fake camera, Decart OFF. Parka hood is bus-only.                                                                         |
| Studio camera/perception/Fit Lab/bridge mounted, 0 console errors                         | DC RESULT 3, 02:36; fake camera, Decart OFF. Its shots show a missing jacket; ZB also saw one intermittent disappearance. Visual discrepancy remains open.   |
| Real-camera Studio, real pinch/hood success, Decart set-to-visible                        | `TBD (measured at <next user-present Studio test time>)`.                                                                                                    |
| Non-bypassable spending limit                                                             | Not certified: [4 HIGH / 2 MEDIUM findings](requests/CX-DAY-decart-review.md). Do not advertise the configured $30 ceiling as a proven provider billing cap. |

All result numbers above come from [codex-sync](requests/codex-sync.md). Historical `STATUS*.md` numbers keep their original build and endpoint scope; they do not fill a missing Studio measurement.

Closed/open references now exist for both jackets. Half/no-hood images remain absent. DC RESULT 3b (02:41, 71aff5c) adds a **prompt-only no-hood candidate using a hood-on image**; visual success needs the user. Show the verified scripted hood action in our puffer Fit Lab and describe the cloud result only if actually seen. Studio defaults to Puffer S; this UI default is not a recommendation.

## Owner preparation

1. Reconcile the latest DC/FL/ZB results, missing-jacket discrepancy and security fixes before speaking or publishing.
2. On AC, warm the existing Studio and local assets before starting the timer. Select **Reference body** to clear a previously saved profile. Read actual size results and preserve loading/estimation labels.
3. Only the user starts Decart. Use free credits first; any later top-up requires the user's decision and is performed by the user within the authorized $30 total. Agents do not top up or start cloud sessions.
4. Prepare `/?rc5` as the manual offline fallback with its known visual limits. Studio's automatic fallback is plain camera, not embedded RC5. Stop Decart before switching pages.
5. Capture only a separately approved public take. Keep the Camo corner logo visible. Do not upload private faces, body fields, references, diagnostics, `.env` or test recordings. Studio REC records the big video slot, not the whole dual-panel page; a full demo needs an explicit screen recording.
6. Repository publication still needs the owner's historical-image/privacy cleanup in [AUDIT-demo-day](AUDIT-demo-day.md). A clean current diff does not clear Git history. This task does not push or upload the working tree.

No reduction in returns, population accuracy, zero jitter, guaranteed hand tracking or measured 3-minute human completion is claimed.
