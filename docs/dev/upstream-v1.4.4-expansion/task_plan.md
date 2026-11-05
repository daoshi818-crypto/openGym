# Official v1.4.4 expanded integration — 2026-11-05

## Scope
Webhooks; module controls; integrations hub; exercise merge; visual refresh; weekly muscle targets; per-exercise strength levels; week/month recaps, share images and PDF reports.

## Acceptance criteria
- [x] Inspect official v1.4.4 at pinned commit 5f5832db56080837b58342ff50f78631dcc63e07 and local extension points.
- [x] Retain local BlueOS integration, Chinese exercise catalogue/instructions, fatigue/strength models, calendar, app identity, update and signing configuration.
- [x] Implement backwards-compatible module defaults and actual side-effect gates, including watch work-in-flight protection.
- [x] Add integrations hub and server-opt-in Webhooks with authenticated configuration, signing, encrypted secrets, destination validation, delivery queue and tests.
- [x] Add exercise merge with reference migration, impact preview, backup confirmation and helper-level undo coverage. The UI does not offer undo.
- [x] Add muscle targets, supported-exercise strength levels, recap/share/report surfaces and regression tests.
- [x] Adapt the shared visual refresh while retaining fork-specific workout controls and screens.
- [x] Run frontend batches, focused regressions, API/MCP checks, strict locale validation, web/mobile frontend builds and browser smoke checks. Record failures and validation limits.

## Phases
1. Inspect upstream and fork — complete.
2. Implement and adapt features — complete.
3. Fix regressions and verify browser surfaces — complete within the recorded platform limits.
4. Document implementation, evidence and remaining limits — complete.

## Delivery limits
Changes are in the working tree, uncommitted. No push, deployment, APK/native build, physical-device check or actual system PDF save was performed. Existing Windows permission-test failures remain; see findings.md. No real external Webhook receiver was configured.

## Workspace safeguards
Preserve the pre-existing untracked docs/dev/AI_COACH_CHAT_ACTIONS_DEEPSEEK_TASKBOOK.zh-CN.md and root planning files. Logs/builds/cache are on D:. No commit/push/release requested.
