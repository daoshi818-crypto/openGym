# 2026-10-23 implementation

Authorized by user: implement the existing AI coach / calories / watch plan locally.
Repository: ../source (HEAD at start: 162a916f). Initial source working tree clean.

Acceptance: C01/C02 shared readable calories with honest missing/partial states; B2 exact historical target/date/IME; A14 explicit single/plan selection with frozen identity, bounded data, report scope and no plan mutation; B3-B6 storage/jobs/decisions/scope/units/undo protections; B7 compatible watch changes with device-only checks explicitly outstanding. No paid model, publishing, push or installation.

Phases:
- [x] B0 read existing specification and current implementation; baseline evidence available from prior audit.
- [x] B1 calories selector, ingestion, three UI entries, translations and regressions.
- [x] B2 date/IME/precise historical context.
- [x] B3 credentials, durable serialized storage, shared consent/preflight.
- [x] B4 local task ownership/cancellation/recovery/deadline.
- [x] B5 decision idempotency/outbox, scope, units/context, undo.
- [x] B2a/B5a complete single and plan debrief selection/report paths across modes.
- [x] B6 deterministic preference/quality constraints.
- [x] B7 compatible watch fixes and documented physical-device matrix.
- [x] Final targeted tests, mobile/web/watch builds, diff review, implementation report. Full suite failures are documented, not treated as passing.

Resolved initial missing API adapters via exact existing Git blobs and installed lockfile dependencies. Initial UI-skills CLI emitted no context, so repository design tokens were reused. Early scaffold has been replaced with shared version 2 typed/frozen selection. Local implementation is ready for review; hardware acceptance, real-provider quality evaluation and deployment remain outstanding as explicitly documented in IMPLEMENTATION_REPORT.md.
