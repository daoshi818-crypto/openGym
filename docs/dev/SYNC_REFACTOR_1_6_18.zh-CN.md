# OpenGym 双端同步实施与验收记录

## 1. 范围与基线
2026-11-08，仓库 D:/gym/openGym，基线 main / 5552b34d98a6e1a29a2eda81fe653666af35627b。基线手机1.6.17、watch manifest0.6.20；发布手机1.6.18/code64，watch0.6.21/code36。保留未提交的 ask.md 与 iOS Podfile，不混入本次提交。布局模板/样式不变，不恢复动作演示，不更换DeviceRpc/BlueOS Interconnect。

## 2. 旧架构问题与证据
以下相对于上述Git基线，可用 `git show 5552b34d9:<路径>`复核：
- watch-app/src/lib/rpc.js 的 flush 只取队首；失败事件退避阻塞无关事件；sendControl另有发送出口；同类型/位置/毫秒时间的去重可能吞掉不同eventId。
- watch-app/src/lib/persistence.js 的 writeStored 先发布缓存再异步写盘；session.save 与页面完成/返回的成功语义不能证明可靠存储。
- frontend/src/lib/watch-revision.js 按到达生成字段版本，同watch actor也不能据此无条件接受旧base；必须结合显式因果依赖。
- frontend/src/lib/watch-commit.js 的回复流程 await sendSync，快照大包阻塞业务Coordinator。
- 旧 sync-wire.js 块只在内存保留且30s过期，不能覆盖60s退避；重启丢进度。
- WatchRpcPlugin.java 中原生received直发，绕过JS发送串行控制。

## 3. 新调用链和提交边界
手表页面 → commitPageAction/commitSessionAction：基于最新sid和关闭状态创建候选，将业务变更与稳定eventId/payload/dependsOn写入同一session_state → storage成功后发布缓存/成功UI → 后台补Outbox。重启从pendingEdits恢复，不能把缓存命中当可靠保存。Crown慢写保留后续输入并按新generation继续提交。

结束：冻结closeIntent及先决操作/汇总 → close-journal可靠 → tombstone/summary_last → 清session；journal可靠后可离开，后续失败可恢复，最终关闭只等待必要业务裁决，不等物理传输成功。

手机实际链：WatchRpcPlugin接收 → WatchInbox AtomicFile落盘 → 原生received入同一WatchSendGate → JS drain → App/useStore Durable Coordinator → watch-events/session reducer事务及字段/依赖裁决 → checkpoint持久化训练和watchCommits → 精确completeInbox → committed（sid+eventId+终态）→ watch先保存精确决定及pending/关闭日志再清对应Outbox。snapshot注册不await整份传输。

watch所有connect.send共一出口；Native所有RpcClient.callAsync共一出口。控制/业务/快照优先级与公平上限、token/generation、逻辑超时/退避及App所属定时器协作。SDK实际发送串行，未启用多SDK并发。

依赖以setId/字段足迹为基础：重量/次数/强度可独立；完成/取消、rest/focus、结构、未知事件、不同sid按保守屏障。独立可绕过退避，同字段和多字段依赖必须得到精确applied。父冲突/拒绝连同后继载荷先归档，归档失败或容量满不删除事件。原生received/SDK成功均不代表业务committed。

## 4. 持久化传输、容量与恢复
双方独立协商dependencyEvents/selectiveChunkAck/persistentTransfers等能力，重连重新协商。新持久化路径只发FULL；旧v3 Delta保留并基于已确认应用基准。未开始快照合并；活动任务稳定推进，显式cancel可靠确认后重建，不随每次操作频繁取消。

TX保留相同序列化内容、transferId和ACK bitmap；RX逐块及元数据落盘后ACK，不逐块重写大session。全收齐验证UTF8字节数、fnv1a-utf16-v1（完整性而非认证）、sid/revision/基准；业务快照与transfer marker同事务后applied。ACK丢失可安全重发，不能保证物理零重复。旧revision保留有效状态，pending意图不被覆盖。

边界：单快照128KiB/132块/24h，1000 UTF16单位安全分块；RX两固定slot/264块key；TX一活动+一合并待发；重试2～60s；旧内存块180s。Native Inbox512条/2MiB/单条128KiB，每批32；Native TX元数据1MiB。Outbox新入队4096条或2MiB拒绝而不删旧数据，旧超限队列保留；session pending256；依赖256；close-journal128条/1MiB，仅裁决完成终态可裁剪；watch精确decisions4096（待发/本地意图/关闭先决被pin），phone裁决4000；冲突100未审核+20已审核，满则保留业务并报错。普通冲突审核也走同atomic/serial链。

## 5. 兼容与迁移
- 无清数据迁移；既有Outbox/Inbox/pendingEdits/close-journal继续重放。只按精确eventId确认，无累计ACK。
- 旧v2原载荷发送FIFO语义保留；新冻结意图接旧手机时保留载荷/eventId并严格前项精确确认，不能投影/重签身份。旧手机的精确ACK可持久化为内部applied，但不伪造wire committed。
- 新手机读旧persisted ACK-only裁决，只有有效原sid/eventId才可证明applied；未知/缺失/循环依赖不冒充成功。
- 旧v3无新能力仍走原路径；收到v2辅助ACK不能清v3业务。新扩展取双方能力交集，不只判断protocolVersion>=3。

## 6. 自动化与构建证据
诊断日志 D:/gym/diagnostics/sync-refactor-20261108（日志不含认证token）：
- frontend-full-21.log：506文件/6171测试通过；frontend-final-34.log：最终代码506文件/6175测试全部通过（498.95s）。
- watch-full-30.log：31文件/396通过；review-33.log：11通过，覆盖重连协商和慢写冲突审核+新归档并发。
- android-build-32.log：compileDebugJavaWithJavac、testDebugUnitTest（含6个新门禁故障/公平测试）、assembleRelease通过（434任务）。本地unsigned release不是生产签名交付。
- mobile-build-31.log：mobile Vite、6554静态+6554动画资源、cap sync android、bundle检查通过。未同步iOS。
- watch-build-35.log：最终方/圆编译与五页布局契约、manifest/VRU/CERT验证；正式包在watch-app/releases。
- API本地669项，663通过、6个POSIX权限语义用例在Windows失败；保留测试，正式Linux CI必须全通过。此前错误工作目录和缺TZ导致的fixture失败已定位，未弱化断言。
- 故障覆盖：本地失败/断连/立即重启、关闭分步故障、精确ACK丢失、父失败及独立推进、20+块指定丢失/乱序/重复/双方重启、损坏/旧基准/取消回退、大快照不阻塞业务、SDK迟回调及门禁公平/容量。

## 7. 主机模拟性能（不是真机）
可重放：frontend/scripts/watch-sync-probe.mjs；performance-simulation.json。Windows单进程真实业务模块+mock存储/SDK，performance.now单调时钟；注入存储1ms/RPC2ms，Windows实际timer约15ms。30个操作/30快照，每次固定丢第6块、两端重启、虚拟65s重连间隔（不是墙钟65s）。

|指标|样本|p50 ms|p95 ms|
|---|---:|---:|---:|
|点击→存储回调成功|30|15.599|16.376|
|点击→UI回调（非呈现帧）|30|16.109|17.238|
|RPC callback|32|15.676|16.387|
|队列等待|30|46.964|63.067|
|入队→committed|30|77.801|94.068|
|快照总耗时|30|1511.166|1532.225|
|重启恢复主机耗时（不含虚拟65s）|30|1030.698|1048.831|

每快照TX写50次/RX块+元数据23次（p50/p95相同）；watch Outbox61/session120/decisions30次。660次块发送，30次重复，按attempt计重传4.545%。宿主进程maxRSS90964KiB，最终RSS93143040bytes。以上是模拟边界和调度路径成本，不代表watch flash、BLE速率或设备RAM。最终验收另记录运行日志。

## 8. 剩余风险与未测项
无真实BlueOS/手机连接：未测固件断电durability、flash耗时、BLE丢包与后台存活、真实UI帧和设备内存。JS/SDK watchdog为逻辑取消，不能阻止固件已发起的物理写/发送迟到；仍需真机断电、息屏、杀进程验收。依赖父裁决被有界保留淘汰时保守拒绝，不推测成功；冲突/容量满需要用户核对，绝不清数据解堵。持续sid错误的快照可保持退避直到新有效源，不宣称无限故障下必收敛。Hash不是认证。生产签名APK、GitHub Linux结果、release和实际客户端CDN metadata均须另行实下载核验，不能以本地构建冒充发布完成。

## 9. 实际改造/交付文件
完整范围（不含两处无关修改；生成的本地构建中间产物未提交）：
- `.github/scripts/ci-build.sh`
- `.github/workflows/build.yml`
- `docs/dev/RELEASE_1_6_18.zh-CN.md`
- `docs/dev/SYNC_REFACTOR_1_6_18.zh-CN.md`
- `frontend/android/app/build.gradle`
- `frontend/android/app/src/main/java/ch/duartesantos/opengym/WatchRpcPlugin.java`
- `frontend/android/app/src/main/java/ch/duartesantos/opengym/WatchSendGate.java`
- `frontend/android/app/src/test/java/ch/duartesantos/opengym/WatchSendGateTest.java`
- `frontend/package-lock.json`
- `frontend/package.json`
- `frontend/scripts/watch-sync-probe.mjs`
- `frontend/src/App.jsx`
- `frontend/src/lib/watch-atomic-storage.test.js`
- `frontend/src/lib/watch-backlog.test.js`
- `frontend/src/lib/watch-commit.js`
- `frontend/src/lib/watch-dependencies.test.js`
- `frontend/src/lib/watch-durability.test.js`
- `frontend/src/lib/watch-effort.test.js`
- `frontend/src/lib/watch-gesture.test.js`
- `frontend/src/lib/watch-hr-session.test.js`
- `frontend/src/lib/watch-interaction.test.js`
- `frontend/src/lib/watch-link.js`
- `frontend/src/lib/watch-link.test.js`
- `frontend/src/lib/watch-local-transaction.test.js`
- `frontend/src/lib/watch-persistent-transfer.test.js`
- `frontend/src/lib/watch-receiver.test.js`
- `frontend/src/lib/watch-revision.js`
- `frontend/src/lib/watch-rpc-diagnostics.test.js`
- `frontend/src/lib/watch-start-flow.test.js`
- `frontend/src/lib/watch-test-harness.js`
- `frontend/src/lib/watch-touch-lock.test.js`
- `frontend/src/lib/watch-uplink.test.js`
- `frontend/src/lib/watch-v3.test.js`
- `frontend/src/lib/watch-wear-ui.test.js`
- `frontend/src/lib/watch-wire.test.js`
- `frontend/src/store/useStore.js`
- `watch-app/SYNC_PROTOCOL.md`
- `watch-app/package.json`
- `watch-app/releases/opengym-watch-0.6.21.rpk`
- `watch-app/releases/opengym-watch-0.6.21.rpk.sha256`
- `watch-app/releases/opengym-watch-round-0.6.21.rpk`
- `watch-app/releases/opengym-watch-round-0.6.21.rpk.sha256`
- `watch-app/src/ExerciseList/index.ux`
- `watch-app/src/Index/index.ux`
- `watch-app/src/Keypad/index.ux`
- `watch-app/src/Workout/index.ux`
- `watch-app/src/lib/close-journal.js`
- `watch-app/src/lib/event-dependencies.js`
- `watch-app/src/lib/local-action.js`
- `watch-app/src/lib/persistence.js`
- `watch-app/src/lib/persistent-transfer.js`
- `watch-app/src/lib/rpc.js`
- `watch-app/src/lib/session.js`
- `watch-app/src/lib/sync-wire.js`
- `watch-app/src/lib/version.js`
- `watch-app/src/manifest.json`
