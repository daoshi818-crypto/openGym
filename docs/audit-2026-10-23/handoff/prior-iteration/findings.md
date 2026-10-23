# Findings

## Implementation inspection
- Official watch compiler: E:/BlueOSStudioAAAAAA/resources/app/extensions/blueos-debugger/node_modules/blueos-pack/bin/index.js (bot release --device-type watch-round). The unrelated extensions/node_modules/hap-toolkit generates incompatible JS RPK, not watch VRU format; do not publish that output.
- Actual clean repository is source/; only watch-app/dist/ is untracked. Main uses GitHub Actions signed APK publishing and then update.json refresh/CDN purge.
- Existing createWatchLifecycle handles hello/end globally, but edits currently depend on Workout route. Extend this global layer for reliable background and offline replay.
- applySync overwrites cursor; pendingEdits protects only weight/reps and is not version-confirmed. Rest messages incorrectly send remaining as total.
- Preserve com.zcode.gymtimer identity/signature compatibility; change display name/icon only.

## User's final requirements for the handoff document
- Watch UI must expose both “结束训练” and “放弃训练”.
- “放弃训练” discards the current unsaved session and must not write a workout record.
- “结束训练” must offer a save/discard choice; saving writes the summary, discarding closes without saving.
- Weight and reps/set-count edits on the watch take effect immediately and do not wait for phone confirmation. They still emit sync events when connected and persist locally when offline.
- Add a quick “唤起手表训练/在手表继续训练” action to the existing phone training UI, visually integrated with the original controls.
- Exclude movement animation from this scope.
- Include the previous optimization roadmap and reference-document findings so the next development conversation can start from one document.

## Repository facts
- Current watch app is source/watch-app; package com.zcode.gymtimer; design width is 390; current version in source is 0.5.2.
- Watch state persists in session_state; RPC has an outbox and handles plan, sync, set, unset, weight, reps, add_set, remove_set, ended.
- Watch training page already has weight/reps keypad, crown rotation, add/remove set, rest timer, completed-row disabling, summary and calorie estimation foundations.
- source/watch-app/DESIGN.md is an earlier BLE design draft and must be treated as historical/alternative design, not the current vivo RPC transport.

## Reference archive findings
- rpc-investigation/reference/Xunji_vivo_watch_reference/README.md describes Xunji’s com.trainnote.rn -> RNvivoWatchModule -> vivo DeviceRpc/Binder -> com.vivo.health -> watch app chain.
- Required concepts: ACTION_THIRD_REGIST, ACTION_DEVICE_INFO, ACTION_DEVICE_BUSINESS_DATA, action_pull_up_watch, exported DeviceRpcService/IDataReceiver, and JS event onVivoReceiveRequestEvent.
- Xunji’s payload examples use Train_Start, Change_Move_Data, On_Set_Done, On_Timer_Finished, On_Finish chunking, On_Finish_Ack, and start-to-sync-local.
- 协议速查.md lists error codes: 0 success, 4 disconnect, 5 data timeout, 7 request timeout, 8 no business/RPC unavailable, 9 permission denied.
- Reference app requires its own vivo appid/EncryStr; never copy Xunji credentials.
- source/watch-app/DESIGN.md contains a BLE alternative with JSON events (plan, set, end, hello, ack, rest, weight) and local outbox/retry semantics. It is useful as state/event design inspiration only; current implementation uses vivo RPC, based on the current logs and source/watch-app/src/lib/rpc.js.

## Design decisions for the document
- Define explicit session states: planned, active, paused, ending, completed_saved, completed_discarded, abandoned, offline_pending.
- “放弃训练” is a destructive action with confirmation; it clears active state and pending workout events for that session, but may retain diagnostics/audit metadata locally.
- “结束训练” opens a choice: 保存并结束 / 结束但不保存 / 返回训练. “结束但不保存” must not create or overwrite the phone workout record.
- Weight/reps/set-count edits are optimistic local writes. The local watch state is immediately authoritative for the current screen; RPC sync is best effort. Phone must accept events without a confirmation round trip and must not overwrite newer watch revisions with stale snapshots.
- Quick wake button belongs in the existing phone training header/action area, with connected/disconnected status and fallback instructions.
- User added action/set navigation regression: ExerciseList writes the cursor, but watch applySync takes exIdx/setIdx from the phone snapshot, and phone snapshot chooses the first undone set. Keep explicit user focus separate from data synchronization.
- User added current rest duration requirement. Phone useUI timer has total and endsAt; watch restTotalLabel currently reads cumulative session restTotalSec; both directions send totalSec equal to leftSec. Fix per-rest total and present it beside remaining time on both devices.
# Watch 0.6.2 final findings (2026-10-20)

## 0.6.6 investigation
- Recalled prior interaction/layout evidence from handoff. ExerciseList opens during touchMove but backToExercises/onBackPress lack the guard already used by save/abandon; trailing gesture events can immediately dismiss the panel. Add a reproduction before patching.
- Workout computes allFinished but never renders a completion choice. Centralize the completion boundary in refresh so local completion, sync, restore and plan edits share it.
- Native countdown has font-size 62 in height 68 without explicit line-height, and rest panel uses distributed free space; reserve a taller digit box plus explicit separation from the time-adjustment row. Browser preview currently hides overflowing text, so add a glyph-line-height check.
- nextUndone advances beyond the current cursor; after completion already advances the cursor, rest context must use the current incomplete row first.
- Rest header names the last completed exercise; repeat its name only when the upcoming exercise changes.
- Hidden training pages ignore crown rotation; rest rejects paging but keeps crown time edits and right-swipe exercise access.
- Wall-clock HH:mm updates separately from paused elapsed training time.
- Published watch-v0.6.2 matches verified local RPK bytes and SHA256; phone latest/update discovery remain v1.6.2.

