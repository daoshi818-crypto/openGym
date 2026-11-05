# v1.4.4 expanded integration: implementation and verification

Date: 2026-11-05. Baseline: fe596bb77; frontend version remains 1.6.8.
Official source: DuarteSantos8/openGym v1.4.4, tag object 6391ab6b37c8cb4c4627a369b58fdf7cba30fc8f, commit 5f5832db56080837b58342ff50f78631dcc63e07. Sparse source checkout: D:/openGym-upstream-v144-expansion.

## Feature map
| Feature | Entry / behavior |
| --- | --- |
| Modules | Settings > Modules (#/settings/modules). Three presets and grouped switches. Disabling retains data and pauses implemented side effects; old profiles retain enabled defaults. Active workouts/pending watch sync prevent pausing watch integration. |
| Integrations hub | Settings > Integrations (#/settings/integrations): watch, health, Coach, import/export and Webhook configuration/status. |
| Webhooks | Authenticated create/edit/pause/disconnect, event selection, one-time secret, delivery test/retry/log. Events: workout.finished, workout.pr, weighin.logged. |
| Exercise merge | Settings > Merge exercises (#/exercise-merge): localized search, impact preview, backup confirmation, workout/routine/PR and related reference migration. Blocked during an active workout. Undo helper is tested but no UI undo is offered. |
| Visual refresh | Shared styles, typography, cards, buttons, sheets, Home/Stats/Settings and new pages. Fork-specific set rows and effort controls retained. |
| Weekly muscle targets | Stats card with editable per-muscle weekly ranges, reusing this fork's workout-day and muscle contribution calculations. |
| Strength levels | Stats summary and exercise detail block for supported standardized lifts. Uses profile/body data and recorded performance; unsupported exercises are not assigned a grade. Existing fatigue/strength systems retained. |
| Recaps | Report page > Your week / Your month: previous calendar period, workout counts, volume, records, main muscle groups and streaks. |
| Share images | Recap > Share as image, with format/theme options; locally rendered canvas. Long values and RTL rendering covered by tests. |
| PDF reports | Settings / Stats > Performance report (#/reports), 7 days / 4 weeks / 3 months / custom up to 10 years, plus recap PDF action. Local printable document; system print dialog supplies Save as PDF. |

The earlier selective integration already contained set notes, workouts-left, set trends and typo checks. This expansion adds the features above. It does not replace the entire fork with upstream or change the application version.

## Webhooks operation
A Webhook sends an HTTP event to a receiver selected by the user, for example an n8n workflow or a personal service after a completed workout. The receiver implements its own automation.

The server must explicitly enable INTEGRATIONS=webhook and be restarted with that environment setting. Then sign in and configure the receiver in Settings > Integrations. Events are detected when profile data reaches the server; a purely local workout cannot trigger a server delivery before syncing.

The implementation uses HMAC-SHA256 signatures, encrypted stored destinations/secrets, authenticated routes, destination/DNS validation, durable queueing, retries and rate limits. The existing server secret supplies encryption key material. Default destinations require HTTPS and reject private addresses. Turning the integrations module off pauses queued delivery and blocks manual tests/retries. Missing, malformed or unreadable server profile state fails closed. No real external receiver was configured or sent user data during verification.

## Compatibility and scope
Retained local BlueOS watch flows, Chinese catalogue/instructions, fatigue and strength models, training calendar, identity, signing and update configuration. Module settings and muscle targets merge per key; exercise redirects merge with timestamps in frontend/API sync. Exercise-merge coverage includes malformed/cyclic redirect handling and stale undo protections. Warmup generation retains its configuration when its module is disabled and restored.

18 locale files each contain 2,600 matching keys under strict validation. Some locales, especially Traditional Chinese, retain English fallback text; key parity does not imply every translation is complete.

## Verification evidence
Logs and generated outputs: D:/openGym-expansion-cache-20261105.

- Web frontend and VITE_MOBILE=1 frontend production builds completed with exit 0 after the final fixes: build-web-final3.log and build-mobile-final3.log. Existing ineffective dynamic-import/chunk-size warnings remain. The mobile result is a Vite build only, not the complete build:mobile / Capacitor / APK pipeline.
- Frontend full collection: 488 files, 17 separate Vitest processes to limit memory. Initial pass: 5,946 passed, 1 failed (pt-BR inherited-translation fingerprint). The wording was moved into the explicit Brazilian override and its focused 5-test rerun passed. Final focused recap-card / pt-BR / report / print-doc rerun: 4 files, 33 passed, including four newly added long-label/value/RTL canvas cases (recap-locale-final.log). The entire collection was not rerun after that correction.
- Webhook unit/server checks: 24/24 passed (api-integrations-final2.log).
- Focused API rerun for bad input, email and first-user-admin: 23/23 passed (api-recheck-final.log), resolving memory-related earlier failures. Full API runs were not all green: six persistent tests depend on POSIX chmod/file-mode behavior unavailable on this Windows host (credential, durable, unreadable DB, writable health check, media permissions, push prune/save). No unrelated permission tests were changed.
- MCP tools: 87/87 passed under TZ=Europe/Zurich (mcp-tools-zurich-final.log). Node import-graph check passed (mcp-load-final.log). Earlier full MCP attempts also exposed Windows fs.watch EPERM and a remaining POSIX chmod expectation in state.test.js; do not describe the full MCP suite as green.
- Strict locale check: 18 locales, 2,600 keys each (locales-final.log). Focused CSS, warmup/media and core regressions also passed; see cache logs.
- Browser smoke checks with demo data: Home/calendar, weekly targets, Settings/Modules, integrations authentication guard, exercise merge impact preview, reports, weekly/monthly recap and square/light share image. Long volume values fit after the canvas fix. Browser console was clear in the final report/recap check. No destructive merge was executed against real user data.
- PDF action was clicked without a browser console error, but native print interaction and actual PDF save were not verified. No physical phone/watch run, native build/APK, deployment or real external delivery was performed.

## Disk handling
K: ran out of space during the initial fetch. Builds, caches, logs and the upstream checkout use D:. The original generated frontend/dist was preserved at D:/openGym-expansion-cache-20261105/frontend-dist-original. Removal of the incomplete .git/objects/pack/tmp_pack_nN4biL fetch artifact was not verified and must not be reported as completed.

Changes remain uncommitted. The pre-existing untracked Coach taskbook and root planning files were preserved.
