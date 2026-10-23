# Findings
Prior handoff is historical; current source must be checked. Existing watch issues around cursor/rest/close were previously addressed. Actual Git repository is source/.
## Current snapshot
- source/ HEAD 162a916f, working tree clean. Watch 0.6.8; frontend 1.6.2.
- Candidates under investigation: local coach async job ownership and forgetting; ignored pending-resolution failures; async storage/outbox assumptions; watch close-log growth and page lifecycle.
- Existing watch tests use synchronous fake storage, so persistence races need separate probes.
- Baseline focused Vitest command completed with exit 0; JSON report stored separately.
- Inspection found plan application has no proposal-ID idempotency; pending resolve is fire-and-forget.
- Watch protocol carries indices for edits and does not carry weight unit; cached-plan profile also skips lb-to-kg conversion when phone has no active session.
- One rg wildcard command failed under PowerShell; replaced with directory + glob flags.

## Follow-up findings (static review only)
- Calorie UI located at sheets.jsx:2541 and :3319; both plain `small muted` paragraphs, detail placement below continue action.
- Existing theme uses --label/--label-2/--fill/--sep/--r; Icon already includes flame/watch. Prefer shared calorie component over global .small changes.
- AI new candidates: native key fallback semantics and silent file persistence failures; IME Enter handling; routine scope prompt-only; payload parity/size; HTTP body timeout; exact proposal resolution ID; legacy duration handling.
- This turn only reads code and writes planning documents; no test/build/implementation executed.
- Confirmed static logic: lastReview.at is Date.now() but payload.build passes String(at).slice(0,10) to an ISO-day comparison (coach.js:579/592; payload.js:551).
- Coach bundle omits generation unit; plan-share deliberately treats absent unit as destination unit. Unit changes while proposal waits need protection.
- Detail sheet renders calorie values from its captured w prop, unlike FinishSummary's live saved selector; late summaries can remain invisible until reopened.
- Numeric calorie guard Number(null)/Number("") accepts unknown as zero. Add typed normalization; finite existing zero must remain valid.
- Current finish-workout deliberately sets end=start+elapsed for resumed/paused workouts; do NOT claim end-start currently includes pauses as a confirmed bug.
- App store update already stamps changed workouts via stampChange; no separate missing-stamp defect asserted.
