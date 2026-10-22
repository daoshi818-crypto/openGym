# opengym for BlueOS

BlueOS watch companion for openGym. Display name: `opengym`; package identity:
`com.zcode.gymtimer`. The circular launcher icon is in `src/assets/images/logo.png`.

## Training

- Swipe up/down between training and operations. Two dots at the right show the page.
- Swipe right to select any exercise/set. Previous/next buttons
  and the crown move within the current exercise; the crown adjusts rest in 5-second steps.
- Heart rate stays on the training screen, including rest. Calories are estimates.
- Phone-started workouts open the training page directly, including an active session restored
  at launch. End/abandon and conflicting-session confirmation remain in place.
- Training shows completed/remaining sets, calories and heart rate; tap completion again to undo.
- Operations shows the clock, elapsed time, completed volume, calories and heart rate, with
  add/remove set and pause/resume controls. Swipe right again from the exercise list for
  save/end, abandon and return; save/end and abandon also appear at the list bottom.
- Plans sent from the phone are cached for offline starts. The phone must confirm conflicts
  before an offline watch save changes an already closed phone record.
- Unsaved watch sessions expire after six hours from the current training segment's start.
  Previously saved history is retained. The close event is queued for reconnection.

## Transport and Persistence

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
and writes both RPKs/checksums into `releases/`. The square layout keeps the 390x450 baseline
and scales naturally to the 432x514 vivo WATCH GT 2. The round target adds a circular safe-area
layout for vivo WATCH 4/5. Watch-only releases can ship independently of the phone APK.
Development keys and Studio output are ignored. Current validation uses blueos-pack
`1.0.12-beta.13`.

Install the matching RPK through BlueOS Studio's watch debugging/install flow. Validate 390x450,
432x514 and round 466x466 layout, gesture/crown behavior, sensor permissions, sleep/resume,
offline uploads and phone conflicts on physical vivo watches. HTML layout previews are approximate,
not a device runtime test.
