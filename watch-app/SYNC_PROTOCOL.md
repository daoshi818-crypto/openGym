# Sync protocol: watch 0.6.13 / phone 1.6.5

## Commit boundary

Watch commands remain in the persistent outbox until a precise terminal event receipt.
Only IDs in the successfully written outbox batch may be transmitted. Transport code=0
is not a business commit.

The Android receiver saves supported business messages to an AtomicFile inbox before
notifying JS. The inbox preserves arrival order, deduplicates identities and refuses new
messages on overflow rather than evicting pending work. Limits: 512 items, 2 MiB total,
128 KiB per message. Drain returns at most 32 items. A failed read/write is reported;
the watch retains its original command.

The global JS coordinator claims messages synchronously and processes them serially.
Nested workout updates, finish/history and the exact decision are collected in one
store transaction. The coordinator checkpoints localStorage and the serial native file
mirror before completing the native inbox entry and sending replies. Android state files
use AtomicFile as well. Failed checkpoints retain the staged head and block outgoing
plans/snapshots; retry does not repeat finish/rest effects. A persisted decision is replayed
after duplicate delivery or restart. The decision window is 4000 events.

`received` means the native inbox contains the command. It never clears the watch outbox.
`committed` names exactly one event and returns applied/conflict/rejected with commitRev.
A rejected/conflicting edit is archived on the watch before its outbox entry is removed.
Unreviewed conflicts are never evicted; at 100 unresolved records, removal stops until
records can be reviewed. The phone retains conflict details and offers keeping the phone
value or submitting the watch value again against the current revision.

## Negotiation and reconciliation

The watch hello advertises protocolVersion=3, durableCommit, snapshotChunks and deltas.
The phone switches only when the required capabilities are present. The watch switches
its outgoing commands after receiving a validated v3 snapshot. Old phones and old watches
continue using precise v2 ACKs and full snapshots.

Stable entryInstanceId/setId identify targets. A session sid is also its epoch; resumed
segments already have distinct sid values. Phone commits increment per-session syncRev.
Each changed field records its revision and actor. Commands carry baseCommitRev and an
installation identity/device sequence; event IDs also contain a boot nonce to avoid reuse
if the device clock or identity storage rolls back. Device sequence is never a cumulative
ACK watermark and is never compared across actors.

Weight, reps, done, effort and set structure detect intervening changes by another actor
in the same field. Different fields and ordered edits by the same watch actor merge.
The phone resolves incoming v3 edits by revision, without comparing phone and watch wall
clocks. Display timestamps and absolute rest deadlines still require reasonably aligned
device clocks; this release does not implement a clock-offset estimation protocol.

Snapshots retain a bounded 128 recent event IDs on v3. Committed pending edits additionally
carry committedRev, so older receipt IDs do not need to remain in every snapshot. Pending
local edits, rest, pause and focus are replayed over the phone baseline until confirmed.
RPC and page objects share a persistence cache; reconciliation reads that cache to avoid
reintroducing pending edits from a stale page object.

Deltas reference both baseline commitRev and content hash. The phone bases a delta only
on a snapshot explicitly acknowledged by the watch. Missing revisions, mismatched targets
or checksum failures request a full snapshot. Full/delta payloads over the normal budget
are split and only applied when every fragment is present and the checksum matches.
Receiver bounds: two in-progress transfers, 128 KiB per transfer, 132 fragments,
30-second expiry. Transfers larger than the bound fail visibly rather than allocating
unbounded memory. The hash is an integrity check, not authentication.

Watch retries and phone snapshot retries back off to approximately 60 seconds. The watch
uses one command at a time after v3 negotiation to preserve dependencies. Snapshot retries
stop on the exact matching business receipt. Disconnect/closed sessions cancel stale
pending snapshots. Reconnect and foreground drain recover pending native work.

## Verification and limits

Tests run actual watch modules with fake device APIs and the actual phone reducer/store.
Coverage includes storage failures, callback loss, batch durability, native restart/FIFO/
overflow, atomic finish decisions, lost ACKs, snapshot/receipt reordering, delta gaps,
Unicode chunk ordering/corruption and same/different-field conflicts. Compiled square and
round layouts are checked with BlueOS Studio's compiler.

The native inbox makes receipt recoverable while JS is unavailable. Business changes still
run in JS after it resumes; no new native business executor or background service is added.
Physical WATCH GT background, force-stop, power-loss, latency, battery and clock-adjustment
acceptance remains necessary. New phone features require the production APK signed with
the existing production key; the local .test APK has a different pairing identity.


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
