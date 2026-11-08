# Sync protocol: watch 0.6.22 / phone 1.6.19

## Durable local actions and exact commit boundary

The phone remains authoritative. Watch interaction follows **local durable document →
publish success UI → background upload**, without waiting for phone ACK. `commitSessionAction`
uses the existing per-key storage gate to atomically write the business change AND frozen
`pendingEdits` in `session_state`. Candidate data is not visible in the shared cache until
`storage.set.success`. Errors retain prior effective state and show a save failure. Concurrent
ordinary HR writes are rebased; stale page objects cannot roll back newer input or snapshots.
The 5 s watchdog is a logical timeout: firmware writes cannot physically be cancelled, so
late physical writes after timeout remain a device/SDK verification boundary.

Outbox insertion happens after the local commit. Boot/page replay reuses the exact persisted
intention if the process died between session write and Outbox write. A stable eventId and
frozen target/base/dependency payload are never regenerated for retry or capability downgrade.
Outbox entries become sendable only after their batch is durable (or their close-journal
source is durable). SDK success / RPC code=0 merely releases the transport gate.

Local end freezes prerequisites, close event and final summary. Once close-journal is durable,
the UI may leave. Closed-session tombstone and last summary are saved before clearing session;
failures retain `closeIntent` for boot recovery. Close and summary have distinct exact receipts.
A close ACK never clears an uncommitted summary. Blocked descendants retain a journal/archive
record; no app-data reset or cumulative ACK is used.

Actual receive chain:
`WatchRpcPlugin.emit → WatchInbox.put/AtomicFile → received → watch-link → global Durable
Coordinator → watch-session/watch-events reducer → Store.withWatchTransaction → checkpoint
(localStorage + serialized native mirror) → complete exact Inbox ID → exact committed`.
The two storage media are NOT claimed to form a cross-medium ACID transaction. Checkpoint
failure retains the staged decision, retries without repeating finish/rest effects, and holds
new outbound plans/snapshots. Snapshot registration does not await the transfer, so subsequent
business transactions and committed replies keep progressing.

`received` never deletes business. `committed` names exactly one event and is applied,
conflict or rejected with commitRev. V3 ignores auxiliary v2 ack/start/effort/rejection as
terminal proof. Legacy exact ACKs first persist a local decision and pending-state change.
Conflict/rejection and transitive dependent payloads must be durably archived before removal;
if the archive is full/fails, pending business stays queued. Reviewed conflicts are separately
bounded. No sequence or timestamp maximum is an ACK watermark.

## Dependency scheduling and field conflict checks

`dependencyEvents` is independently negotiated in both directions, not inferred from v3.
Every new local intention freezes sid/epoch, eventId, installation actor, device sequence,
baseCommitRev, stable entryInstanceId/setId, structure revision, and dependsOn before upload.
All pending parents (including committed but not yet included in the authoritative baseline)
participate. Different row fields weight/reps/effort can be independent. Completion writes
row done+weight+reps plus rest/focus; unset writes done+rest/focus. Rest, pause, focus,
structure, start/close, unknown types and missing stable IDs are conservative barriers.
Different sid values never become independent merely by comparing revisions.

The watch can select a durable ready independent event while another is backing off. It
requires exact applied decisions for parents. Conflict/rejection archives all dependents;
unknown parents wait on the watch, not on the phone's queue head. The phone rejects invalid,
missing/evicted, cyclic/self, cross-session or non-applied dependencies with an exact terminal
reason before mutation. Phone field revisions include actor AND exact eventId; a newer field
from the same actor still requires an explicit parent when extensions are used. Different
fields merge; same-field and multi-field operations maintain the dependency order.

Pre-upgrade intentions are not rewritten: a legacy prefix drains first. Non-negotiated v3
is strict head-first; newly frozen extension intentions also drain head-first on a v2 phone,
using legacy exact ACKs. Original v2 payloads retain their established FIFO send-order pipeline.
The phone stores internal exact decisions for legacy events without inventing wire committed
receipts, and can infer applied from old persisted ACK-only records. An expired unknown parent
is rejected, never assumed applied. Clients must review such retained conflicts.

## One physical send gate per endpoint

Watch: all connect.send calls (including controls) pass one App-lifetime gate. P0 control /
P1 business, after 8 ready controls a ready business event gets a turn; 120 ms business pacing;
6 s callback timeout; generation/token rejects stale callbacks; failure backoff 2–60 s.
Dependency-blocked work sleeps at least 1 s instead of a hot retry loop. Page navigation only
replaces UI subscribers; application timers own retries, replay and storage watchdogs.
Hello is queued before reconnect persistence can flush a business batch.

Android: every RpcClient.callAsync, including native received, passes WatchSendGate. P0
control, P1 training and P2 snapshot; fairness after 8 high-priority or 16 non-P2 sends;
128 waiting + one active; 6.5 s timeout and connection generation. Each chunk releases the
SDK gate and priority is re-evaluated. Callback completion cannot remove business records.
Native Inbox/received does not depend on React page mount. No 2–3 SDK concurrency is enabled.

## Negotiation matrix / snapshots

Three paths remain: v2 full snapshots/exact ACK; existing v3 chunk/delta+durable committed;
new persistent extension. Watch hello advertises durableCommit, snapshotChunks, deltas,
dependencyEvents, selectiveChunkAck and persistentTransfers. Phone hello_ack echoes each
extension independently. Persistent transfer needs durableCommit + snapshotChunks + BOTH
selectiveChunkAck and persistentTransfers. One flag alone does not enable it.

Snapshots preserve pendingEdits and committedRev overlays until a matching/newer authoritative
baseline includes them. Same-sid revisions are ordered; different sid values are not compared
as one counter. Deltas reference both persisted baseline commitRev and hash, never an optimistic
page value. Old-v3 Delta remains supported. The new persistent phone path currently sends FULL
snapshots only (no unproven persistent-Delta optimization). Missing base/hash/target triggers
safe full fallback, never partial application. Absolute rest deadlines still rely on reasonable
clock alignment; no clock-offset estimation or cross-device timing subtraction is implemented.

## Persistent selective transfer

Messages: sync_begin / sync_begin_ack, sync_chunk / sync_chunk_ack, sync_resume, sync_applied,
sync_cancel / sync_cancel_ack, unknown_transfer, sync_error. Metadata carries exact transferId,
sid, revision, generation, count, UTF-8 bytes, hash, encoding=json-utf8 and
hashAlgorithm=fnv1a-utf16-v1. JSON serialization is frozen once; chunks are at most 1000 UTF-16
units without splitting surrogate pairs; byte limit is UTF-8. FNV-1a iterates UTF-16 code units,
matching old wireHash compatibility. This is integrity protection, NOT authentication.

TX persists byte-identical snapshot/chunks, metadata and ACK bitmap before sending. One active
and one coalesced queued job; same-revision changed content gets a new generation, without
repeatedly cancelling active work on every clock update. Each next() yields one application
message through the gate (window 1). Only unconfirmed blocks are selected. Lost ACK can cause
safe duplicate transmission; sync_resume reports the receiver's actual durable bitmap.

RX uses two fixed slots with 132 chunk keys each, separate from training state. Metadata/chunk
writes must succeed before their ACK. Identical valid duplicate chunks do not rewrite storage.
After full count/order/UTF-8/hash/sid/revision/Delta-base validation, atomic session apply includes
the transfer marker; then RX metadata records applied before replying sync_applied. Last 8
training markers close the apply-success/index-failure crash window. Retained (stale) snapshots
persist retained status and never become the sender's Delta baseline.

Non-transient errors persist a cancel reason and retry exact sync_cancel across restart until
cancel_ack/unknown_transfer. Only that transfer is removed. Afterwards queued full content is
promoted, or an exact full source is rebuilt with new generation and backoff. If no full source
exists, the cancel/error task remains (full_snapshot_required); business is never deleted.
Temporary storage/capacity failure retains the same task/backoff. TTL is 24 h, including retry
and restart, rather than the incompatible old 30 s. Legacy in-memory chunks expire after 180 s
(to cover the 60 s backoff); they do not promise restart continuation. Manual disconnect stops
the phone pump without discarding its persisted task; a new hello resumes it.

## Bounds and retention

- Local active pending intentions: 256; overflow rejects the local operation before success UI.
- Outbox: 4096 / 2 MiB for new insertion, refuses overflow; existing oversized legacy data is
  retained, not trimmed. Source intentions/journal remain available for later replay.
- Phone Native Inbox: 512 / 2 MiB / 128 KiB per message, drain batches of 32; no pending eviction.
- Phone exact decisions: last 4000; missing old parents yield explicit rejected decisions.
- Watch exact decisions: 4096, pins include Outbox, pendingEdits and close prerequisites;
  if all are pinned at capacity, receipt processing stops safely instead of evicting parents.
- Conflict archive: 100 unresolved + last 20 reviewed, refuse removal at unresolved overflow.
- Close journal: 128 entries / 1 MiB UTF-8; only terminal delivered/discarded AND close-committed
  entries may be pruned; pending/blocked training never silently removed.
- Snapshot: 128 KiB / 132 chunks / 24 h, RX two slots (264 fixed chunk keys), TX active+queued;
  native TX metadata AtomicFile is separate from Inbox/training and limited to 1 MiB.
- Legacy v3 snapshot history: 8; recent acknowledged event IDs in snapshot: 128.

## Verification and limits

Host regression covers atomic failure/late callbacks, close crash windows, immediate restart,
E001 backoff/independent E002-E003/dependent E004, exact ACK loss and decisions, multi-field
conflicts, real chunk drop/lost ACK/reordered duplicates/both-endpoint restart, corrupt/expired
snapshots, cancellation/full fallback, same-revision coalescing, new/old protocol combinations,
page lifetime and Native gate fairness/tokens. Native JUnit tests are part of the release build.
`frontend/scripts/watch-sync-probe.mjs` reports 30-sample host timings with monotonic clock,
write-call counts and process RSS high-water; mock callback delays are NOT physical flash/BLE
or displayed-frame measurements. No physical watch was attached for this implementation.

## On-demand uplink diagnostics

Transport metadata is kept in memory only (latest 40 entries), separately from the durable
outbox. It records enqueue, connection/readiness, send attempt/success/failure/exception/
callback timeout, and received/committed stages. Event/session identities and bounded error
strings are retained; workout payload fields are not copied. SDK callbacks that return an
error object or separate message/code arguments are supported. Logging failures are ignored
and no extra training-storage writes, ACKs, retry-policy or ordering changes are introduced.

Opening the phone watch-log panel issues `watch_diagnostics_request` with a unique requestId.
The watch replies with `watch_diagnostics` over the existing control path, not the durable
training queue, so a blocked queue head does not suppress the diagnostic attempt. Replies
include queue/head/readiness state and up to eight recent entries, trimmed oldest-first to
fit the existing 6000-byte UTF-8 wire budget. Phone export includes `lastWatchTransport`
with receivedAt and `watchDiagnosticRequest` with sentAt/status/completedAt. Only a matching
requestId confirms the probe; SDK send success alone does not. After 2.5 seconds without
a reply, the probe times out and the phone still displays its local native logs. Older
watch builds do not implement this request; timeout alone cannot distinguish an old build
from an unavailable uplink. Diagnostics are not dispatched as training events.

If the uplink is unavailable, tap the sync status at the top of the watch workout/rest
screen to view a fixed local snapshot, then use Next page to photograph the entries. Times
are UTC (Z), two entries per page. Back exits without changing the session. This fallback
is necessary because a diagnostic response uses the same potentially failing transport.
Memory traces are lost if the watch process restarts; preserve screenshots before restarting.

These paths require new phone/watch builds containing the diagnostic changes. They are not
retroactively available in already installed 0.6.13 release packages. To investigate, keep
both applications in the foreground, record the time, complete one set on the watch and
skip rest, then collect same-session phone logs and watch diagnostic pages. Do not clear
app data or delete pending records. Mock transport tests are not real-device confirmation.


## Optimistic rest and per-set effort display

A pending set completion replays both the completed row and its embedded rest event over
the phone snapshot. This preserves the local rest deadline while the phone commits the
completion; an older snapshot must not briefly remove rest and advance the displayed set.
Rest version guards and event order still apply, so a later local skip is not undone by
replaying the completion. A pending unset clears the rest started by that completion,
matching the local undo operation. No transport timing, queue, ACK or commit rule changes.

The training effort entry targets the displayed set; the rest entry targets the latest
completed set. Scores are never copied from the previous set. The picker pins its target
by entryInstanceId and setId even if the timer expires or exercises are reordered. A
removed target, or an undo of a target that was completed when the picker opened, closes
the editor. An unfinished training set may be rated without completing it or starting
rest. RPE/RIR explanations appear only inside the picker after a rating is selected;
training/rest entries show only the score or an unregistered state.

Regression tests cover delayed/repeated snapshots, completion then skip/undo, current-set
effort isolation, timer expiry while editing, reorder and RIR zero. Compiled square and
round panel heights are checked statically; real-device transport delay and rendering
remain device acceptance checks rather than outcomes proven by these tests.


## BlueOS Page transaction isolation (0.6.22)

BlueOS binds definition methods to its live Page context and its Proxy setter ignores the
receiver. A draft must NOT inherit from that context with Object.create(page): writes can
reach the live page and method assignments do not replace the bound methods. Workout now
passes its raw definition into commitPageAction; an independent facade stores own writes
and resolves raw helpers against the draft, deferring native effects and UI publication
until storage confirms. No draft flag is ever published to the live Page.

While commitWireSnapshot builds its candidate, persist() does not issue an ordinary write;
the atomic session document and applied-transfer marker remain the only storage commit.
Durable receiver/commit notifications carry an internal (not wire) persisted option, so
pages adopt the committed document rather than reapplying/re-saving the snapshot. A changed
sid resets old session-only overlays, touch guards and rest scratch state. Different-session
pending edits remain queued but cannot change the new session or become its dependencies.
Legacy edits lacking a sid are treated as current within their original document, and are
labelled with its sid when carried across a new session. No protocol capability is changed.

Set dots select both completed and unfinished rows using stable row identity; selection
alone does not complete/unset a row. Dots are 18px (current 22px), in unchanged 44px hit
regions. They represent sets; the exercise-title/list route still selects exercises.
Host regression tests model SDK Proxy/bound-method semantics and the actual render method;
they do not prove freedom from physical-watch black screens, firmware hangs or disconnects.


## Phone authority (phone 1.6.20 / watch 0.6.23)

For concurrent field edits the durable exact committed receipt retains `status: conflict`
for compatibility and adds `resolution: phone`. The phone checkpoints that decision before
replying. The watch archives that exact event as automatically settled, rebuilds the
projection from an adequately new committed snapshot plus surviving pending edits, then
acknowledges only that event locally. If the snapshot is missing it requests a full sync.
An exact same-session parent with conflict + resolution=phone permits child delivery;
each child still undergoes dependency, identity and complete payload field validation.
Legacy conflict/rejected receipts keep their conservative dependency archival semantics
and retain unreviewed original payloads. Neither a received receipt nor transport success
is promoted to an applied decision. No manual field conflict prompt is shown.
