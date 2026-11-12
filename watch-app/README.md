# opengym for BlueOS

BlueOS watch companion for openGym. Display name: `opengym`; package identity:
`com.zcode.gymtimer`. The circular launcher icon is in `src/assets/images/logo.png`.

## Training

Watch 0.6.29 / phone 1.6.26 package the November 12 UI update, enlarging text and touch targets across all
five routes. Current-set, rest and weight/reps editor screens never scroll;
secondary pages use native lists. Complete and undo remain vector-only buttons.
Last-time summaries and their read-only detail entry remain available.
Both native watch targets pass compiler-output layout checks. See
[release scope](../docs/dev/RELEASE_1_6_26.zh-CN.md) and
[large UI scope and verification](../docs/dev/WATCH_LARGE_UI_20261112.zh-CN.md).

The earlier Watch 0.6.17 / phone 1.6.11 rebuild established the GT1 390x450 viewport
and the V3/V4 hierarchy for prescription, countdown and summary. Set dots have no numeric labels:
white outline=current, white fill=completed, dark fill=unfinished. Exercise navigation
uses title-tap, with a separate disclosure button to expand each exercise's sets.
Every route fills the viewport. Current-set and rest contents have fixed height
budgets; secondary lists absorb overflow and leave fixed actions reachable. See
[historical GT1 rebuild and acceptance](../docs/dev/WATCH_GT1_UI_REBUILD.zh-CN.md).

- Swipe left to switch between training and operations; swipe right to open the exercise list.
  Vertical gestures scroll secondary pages only. Tap the exercise name to open the exercise list and jump to its first unfinished set.
- Tap a set dot to select it, including a completed set for undo.
  The source update shows up to five dots at once; larger plans use three-dot
  windows plus two navigation targets, each 48px. Selection keeps stable session and row IDs.
  As of 0.6.26, repeat nodes retain stable keys, current-set taps do not write, and
  rapid taps coalesce for 120ms before committing only the latest unaccepted target.
  Accepted durable events remain intact; leaving the page cancels uncommitted input.
- Tap weight/reps once to select the field. Rotate the crown to adjust the selected field only;
  tap the selected field again for the keypad. Rest retains its own 5-second crown adjustment.
  The keypad shares one draft between digit entry, +/- and crown; cancel does not save.
  Both quick adjustment and the complete twelve-key keyboard fit one screen,
  with fixed Save/Cancel buttons and no vertical scrolling.
- Last time appears before completion, when matching history exists. Tap the small
  summary to open read-only history details. Current training and rest never scroll;
  training statistics remain on the operations page.
- Heart rate stays on the training screen, including rest. Calories are estimates. Healthy sync
  diagnostics do not occupy the main training area; connection failures remain visible.
- Phone-started workouts open the training page directly, including an active session restored
  at launch. A newly committed watch start opens the phone workout route once while the phone
  app is running. This is not an Android background/lock-screen Activity launch guarantee.
- Training shows completed/remaining sets; tap completion again to undo. Operations shows the
  clock, elapsed time, completed volume, calories and heart rate, with add/remove set and
  pause/resume controls. Save/end uses the same confirmation flow from every entry point;
  completion alone never silently saves. Conflicting-session and abandon confirmation remain.
- Plans sent from the phone are cached for offline starts. AI plan changes affect routine
  templates only: they must not truncate an active workout or rewrite logged history. The
  phone must confirm conflicts before an offline watch save changes an already closed record.
- Unsaved watch sessions expire after six hours from the current training segment's start.
  Previously saved history is retained. The close event is queued for reconnection.
- Watch exercise demonstrations were removed in 0.6.17: no frame requests, native
  extraction plugin, player or demo file capability. Phone exercise videos remain.
  Old demo cache files are not actively deleted; training storage is untouched.

## Transport and Persistence

Watch 0.6.28 / phone 1.6.25 fix a set-dot queue that never ran on the BlueOS
timer bridge: native timer callbacks now use an ordinary Function wrapper.
Unsaved crown rest previews survive unchanged echoes only; a phone rest skip or
changed round cancels the obsolete preview. Page adoption and callback failures
have bounded diagnostic records separate from durable transfer receipts. See
[evidence and verification scope](../docs/dev/RELEASE_1_6_25.zh-CN.md).

Watch 0.6.27 / phone 1.6.24 preserve interaction evidence against reconnect traffic
within the existing 64-event / 24KB diagnostic journal, report eviction counts, and
record why set-dot actions are blocked. This improves diagnosis; the reported native
second-set touch failure still needs device evidence. See
[release scope and capture steps](../docs/dev/RELEASE_1_6_24.zh-CN.md).

Watch 0.6.25 / phone 1.6.22 negotiate inline canonical command corrections. Ordinary
commands can converge through one durable committed reply plus a small applied ACK;
startup, structural changes and baseline gaps retain reliable snapshot transfer.
See [command flow and measurements](../docs/dev/WATCH_COMMAND_SYNC_1_6_22.zh-CN.md).

Watch 0.6.13 pairs with phone 1.6.5 for durable inbox/commit receipts, negotiated
revision deltas, bounded checksummed snapshot chunks, explicit field conflicts and
adaptive retry. Old peers keep the v2 path. See [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md).
The connection recovery and rest-screen fixes from 0.6.12 are included.

Watch 0.6.12 restores uplink after an SDK error or missed `onOpen`: valid incoming
messages and periodic readiness checks resume the durable outbox. Delayed probes are
scoped to the connection generation. The rest screen reserves space for the effort
entry, skip button and two-line exercise names on square and round targets.

The active transport is vivo DeviceRpc via vivo Health and BlueOS interconnect, implemented
in `src/lib/rpc.js`. The old BLE/Worker design is historical and is not the active protocol.
Events carry persistent IDs; the outbox retries until business acknowledgement. Snapshots
confirm applied edits, and closed-session tombstones reject stale plans. Data and navigation
are independent. Rest uses an absolute deadline, current-round target, ID and version.

The phone responds while its process and RPC service remain available. If the OS kills it,
the watch continues with cached data and uploads after the phone is available again. Sensor
sampling and background delivery depend on the watch firmware and require device testing.

## Build

Use BlueOS Studio's **blueos-pack** compiler, not the generic hap-toolkit. The latter produces
a different package format. With Studio installed:

```powershell
$env:BLUEOS_PACK = 'path/to/blueos-debugger/node_modules/blueos-pack/bin/index.js'
./scripts/build-release.ps1
```

The script builds both `watch-square` and `watch-round` targets, verifies each VRU payload,
and writes both RPKs/checksums into `releases/`. The square layout uses the 390x450 baseline;
larger devices still require physical-device verification. The round target adds a circular safe-area
layout for vivo WATCH 4/5. Watch-only releases can ship independently of the phone APK.
Development keys and Studio output are ignored. Current validation uses blueos-pack
`1.0.12-beta.13`.

Install the matching RPK through BlueOS Studio's watch debugging/install flow. Validate 390x450,
432x514 and round 466x466 layout, gesture/crown behavior, sensor permissions, sleep/resume,
offline uploads and phone conflicts on physical vivo watches. HTML layout previews are approximate,
not a device runtime test.
