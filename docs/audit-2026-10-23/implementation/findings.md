# Findings

Existing specification contains root cause evidence for C01/C02, A01-A14 and W01-W05. Relevant current data: watchSegments keyed by sid; WorkoutDetail uses stale prop for calories; requestDebrief already accepts an id; shared core is imported by phone and server. Legacy sync identity is available in sync-merge and should be reused for no-id workouts.

Early scaffold defects to address before testing: calories component passes a number to kcalText expecting a view; picker initially fires without preview; plan single/multiple payload shape, provenance and validation are incomplete; old server must refuse incompatible selection instead of silently handling latest. Card snapshots must not recompute against current records.

Final: the early defects above are resolved. Shared debrief v2 refs/inputHash preserve selection after new records arrive and reject edits/deletions. Plan filtering uses routine identity before slicing N; mixed records require action ownership and exclude whole-session calories/time. Server real-queue mock HTTP integration validates exact targets, scope rejection and stale decision retries without invoking a paid provider.

Watch runtime must be shared across independently bundled pages, not merely module-local. The implementation binds runtime to app ownership and tests separate bundles. Writes are serialized per storage key and events send only after durable completion. Missing send callbacks recover on a watchdog; permanently missing native storage callbacks intentionally do not trigger unsafe concurrent overwrites. Hardware callback/kill/power-loss recovery still needs device evidence.

Heart-rate ownership belongs to the training session. Tests cover single subscription across pages, stale-page saves preserving newer samples, pause/resume/end; firmware background/screen-off capabilities remain unverified. Closed session retention protects pending work while bounding ordinary records; expired offline start events cannot resurrect evicted sessions.

Device-native storage, cross-device merge/idempotency and actual model narrative quality cannot be established by browser/VM/mock tests. Full test failures include Windows permission/shell assumptions, missing sparse files, timezone/date fixtures, preexisting signup error-spec mismatch and a Vitest checker load issue. Native mobile output checker passes; build concurrency caused allocation failures, so production mobile was rebuilt separately.
