# Task plan

## Watch 0.6.6 completion and rest correction (2026-10-20)
- [x] Reproduce end-panel flashback from trailing back/click events; guard the gesture transition. Long swipes stay locked until release/cancel, then 400ms.
- [x] Prompt once when all nonempty planned sets are done; save or continue, re-arm after undone/new sets. 95 business regressions pass.
- [x] Give rest digits explicit native line-height and spacing; 17 layouts include long names, maximum rest, font stress and footer spacing.
- [x] Run 95 business regressions, 17 layout previews and official signed rectangular RPK build; embedded X509 signer matches 0.6.4.
- [x] Push commit 40683b8c and RPK/screenshots to GitHub main; upload RPK and checksum to release draft 418167988.
- [x] Publish watch-v0.6.6 and download/verify public assets. Public RPK is 78,281 bytes and equals local build byte-for-byte; checksum matches. Phone latest remains v1.6.2. Prior approval/network failure resolved through an approved retry.
- Acceptance: no unintended save/exit, no repeated prompt while continuing, no clipped countdown or overlapping footer.

## Watch 0.6.3 refinement (2026-10-20)
- [x] Compact values without redundant labels; 上/下 beside completion; remove exercise links and restore right-side dots.
- [x] Exercise-list right swipe opens complete/cancel/back panel; preserve save/abandon, back and crown isolation.
- [x] 104 regression tests, 13 layout states and official watch-square build passed; 0.6.3 RPK published and downloaded bytes/SHA256 verified. Final code: 7110511b; latest phone remains v1.6.2.
- [x] Default visual enhancement preserves current type scale and palette while improving spacing.

## Watch Layout Follow-Up (2026-10-20)
- [x] Confirm symptoms are watch-only; inspect source and native compiler output.
- [x] Fix rectangular viewport, page bounds and oversized round-screen margins.
- [x] Enter phone-started workouts automatically while preserving conflict/close confirmation.
- [x] 95 watch regressions, 14 layout previews, native compiled-layout checks and official 0.6.1 VRU build passed.
- [x] Source 6e2b4831 and watch-v0.6.1 standalone release published; downloaded RPK bytes/SHA256 verified. Phone latest remains v1.6.2.

## Current Implementation Goal (2026-10-20)
Implement WATCH_NEXT_ITERATION_HANDOFF.md and the user's watch UI requirements in source/, verify both sides, build RPK and publish code/APK/RPK with working update metadata.

## Watch UI iteration (2026-10-20)
- [x] Remove watch settings entry and make the home screen centered and readable.
- [x] Simplify training controls, completion toggle, crown routing, and end actions.
- [x] Redesign rest screen: deduplicate names, announce exercise changes only, disable paging, preserve crown rest adjustment.
- [x] Add action-list exit/save controls without duplicating session semantics.
- [x] Add local HH:mm alongside elapsed time on the main training/rest screen; move normal page indicators upper left.
- [x] 102 focused tests, 12 layout previews, official square build; source pushed and watch-v0.6.2 published with downloaded bytes/hash verified.

## Watch UI confirmation pass (2026-10-20)
- [x] Route touch gestures directly from the exercise list and expose save/abandon actions at list bottom and in the right-swipe panel.
- [x] Add completed/remaining set progress to training page, compact operations, and center the home content.
- [x] Improve completed-set markings and swap heart-rate/calorie order on operations page.
- [x] 62 watch business tests, 15 screenshot/layout states, 390x450 clipping checks, and official watch-square build passed.
- [x] User requested packaging; released watch 0.6.4 / code 19 at c3fec82e, tag watch-v0.6.4. Official square build, 62 tests, 15 layout states, signing certificate continuity, and downloaded bytes/SHA256 verified. Phone latest remains v1.6.2.

## Watch interaction/layout correction (2026-10-20)
- [x] Move end-panel swipe handling to the page, detect swipe while moving, and retain list-level fallback.
- [x] Cross exercise boundaries with up/down group navigation; queue focus reliably and verify phone current action/set state.
- [x] Separate rest skip button from set progress; enforce minimum 6px distance in layout QA and pairwise element-overlap checks.
- [x] 80 watch tests, 15 layout cases, official watch-square RPK build and compiled-layout checks passed; local release 0.6.5 code 20, commit 29f9ba3a, SHA256 515b3813ba9dd6e578bafe84dc42c39f9cb32dd56126f4e4d41dcf6620f82a60.
- [ ] GitHub push/release blocked by automatic approval service busy; no alternate upload path used.

## Implementation Phases
- [x] Inspect state, RPC, plan creation, UI and release tools
- [x] Fix cursor/local edits/rest; durable global event handling and close semantics
- [x] Plan catalogue/watch start, pause/resume, phone watch shortcut
- [x] Two watch pages, safe bounds, opengym name and circular icon
- [x] Regression tests, watch/mobile builds and visual checks
- [x] Publish GitHub code/release assets; verify RPK bytes/hash and APK availability/digest
- [x] Final live verification: original 1.5.17 and new detectors both discover 1.6.2 on two consecutive runs; prior CDN HTTP 403 recovered.
- [x] Document remaining physical phone/watch validation boundary.

## Implementation Acceptance
- Stable explicit focus; optimistic persistent edits survive stale snapshots/reconnect
- Correct per-round rest remaining/total; save/discard/abandon never revive a closed session
- Offline watch start and retries create one phone session; background route handles events
- Both watch pages usable in rounded 390x450 viewport; previous/next and exercise list retained
- New signed RPK/APK downloadable; update.json points to published newer APK

## Prior Goal
Create a handoff specification document for the next development conversation, covering watch end/abandon semantics, immediate watch edits, quick wake integration, prior optimization points, and relevant vivo RPC/reference material.

## Phases
- [x] Inspect repository, existing docs, and reference archive
- [x] Capture authoritative API/reference findings
- [x] Draft Chinese handoff specification
- [x] Verify document completeness and save final artifact

## Acceptance criteria
- Explicitly states watch has both abandon and end; end offers save/discard
- Weight and set count edits take effect immediately without phone confirmation
- Defines quick wake/watch-training entry integrated with original UI
- Includes prior optimization roadmap, action/set cursor fix, per-rest total duration, and sync/conflict rules
- Includes reference document/API content with source paths/links
- Can be pasted into a new development conversation

## Errors
- First combined inspection command failed because of JavaScript string quoting; rerun with PowerShell Set-Location succeeded.
