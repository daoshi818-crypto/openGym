# WATCH GT 0.6.36：同页输入与通信解耦

## 官方参照与本次范围

2026-11-19 核对官方最新发布仍为 [v1.4.5](https://github.com/DuarteSantos8/openGym/releases/tag/v1.4.5)，tag 提交 `2d70e026effc6602f513555166a97443520f0572`。其 main 领先两次提交，但此次对照的 Wear/通信源码没有变化。

官方 `Screens.kt:489–528,544,601–616`：点击未选字段先选中，再点已选字段在 SetPage 内切换 KeypadView；不是新 Activity/路由。`WearStore.kt:346,447–485`：表冠仅更新本组 draft，完成组用最终 w/r/sec 生成 setDone；已完成组修正另走 saveFix。此次落实当前未完成组的同页草稿和键盘，保留原色、十二键、退格、返回箭头及绿色保存胶囊。

官方 `PhoneLink.kt:94–108` 对事件逐项发送、逐项捕获异常；`SessionCore.kt:459–520` 按事件到期退避，区分 delivered 与 applied。下行 DataItem 保留最新快照，Message 加速，400ms 合并与 stamp 防旧状态。BlueOS 使用 vivo SDK RPC，无法直接调用 Wear Data Layer；这里保留平台可用的持久分片和精确业务回执，落实相同的最新状态优先与按项恢复原则。

官方 `watch-sync.js:858–867` 在 handler 第三次异常后仍标 applied 并继续。该做法可能吞掉失败操作，本次没有照搬：只对已确认回滚的业务异常保存 rejected 决策，手表先归档原操作及真正依赖项；存储失败不能放行成成功。

## 根因、调用链与修改

### 1. 表冠每格执行完整持久事务

原链路：`Workout.adjustSelectedField → commitPageAction → commitSessionAction → setRowValue → session_state 写入 → pendingEdits → replay → refresh`。一次存储尚未结束时，`local-action.js` 会拒绝下一次提交，造成转动丢步和频繁全状态处理。二次点字段还会 router.push('/Keypad')，增加页面进出、初始化与恢复。

现链路：`adjustSelectedField → numberDraft/changeNumber → weightNum 或 repsNum`。`number-draft.js` 只保留当前组的身份、两个数值及两个 dirty 标志。它放在 `staticData.sessionModel`，避开 BlueOS Page 强引用代理；键盘指针同样保留原始对象，避免代理改变身份造成无法保存。键盘是 Workout 内条件视图，Keypad 路由和独立源码已删除。

`onComplete` 冻结这几个输入标量，在同一 durable transaction 中验证 sid、entryInstanceId、setId、位置和单位，再应用 dirty 字段、完成组、生成 set 事件。set 事件携带最终 weight/reps；原本的 focus 事件仍保留。没有生成每格 weight/reps 事件。落盘失败，完成效果不发布，草稿可重试。

未触及字段继续接收手机值；明确编辑过的字段保留草稿。换目标/单位、行已完成、暂停、休息、结束意图使草稿失效；暂时隐藏恢复保留，销毁/强退不保证恢复未提交草稿。完成后的纠正逻辑与其他业务入口维持已有实现，不借本次输入优化删除业务。

### 2. await 回执使后续业务队首堵塞

`frontend/src/lib/watch-commit.js` 原先在 checkpoint 后逐条 await sendAck/sendEnded/send，再移除队首。网络调用永不返回的回归用例会超时，后续 unset 无法持久完成。

现仍串行处理业务和 checkpoint；状态、决策一起持久后才调用回执发送，但不等待传输 Promise 才处理后续业务。watchCommits 保留准确结果，重复事件直接重放。原生 `WatchSendGate` 的 6500ms 超时及迟到回调令牌继续生效。inbox 删除只作落盘后的垃圾回收。磁盘错误仍阻塞状态提交，避免后续全局 checkpoint 掩盖未保存结果。

重复业务 reducer 异常：真实 store 仅在 reducer 抛错、回滚 S 后标记 `watchReducerRolledBack`；业务重试三次后才持久记录 rejected、failedEvent 和依赖。其他传输/发布/存储异常没有这个证明，不被隔离成已处理。手表收到 rejected 时先将原操作和真正后继归档 sync_conflicts，再释放队列；不得改成 applied。原有冲突容量保护继续保留。

### 3. 展示意图成为全局依赖屏障

`event-dependencies.js` 之前已能让不同 row 的独立编辑继续，但 focus/rest 是全局屏障。新增协商 capability `narrowDependencies`，只给新接受事件冻结标志：focus 写 focus，rest 写 rest；set/unset 与这些字段冲突，继续保持顺序。pause、结构变更、开始/关闭、跨 sid 和旧格式继续保守排序。旧事件的 dependsOn 与字节不被升级改写。

### 4. active 分片或取消回执丢失阻挡最新 queued

`persistent-transfer.js` 的 sync 与 catalog 本来各有独立命名空间，并各保留 active + 最新 queued；问题在 active 无 applied、取消又无精确证明时不能推进。

新增 `snapshotGenerations` 双方协商。只有到期同帧已尝试三次且存在更新快照或卡住的取消任务时，发送端才用有完整基线的全量生成新代次；正常分片仍利用原 bitmap 恢复，不每个时钟刷新就取消。接收端先把新 fence 和任务原子写入各自 rx 索引，之后才 begin_ack；低代次 begin/chunk/resume 和同代次不同 ID 被拒，水位跨 TTL/重启。只有实际全量 sync/plan_catalog 可成为 fence，delta 仍需已确认的完整基线。代次丢失后通过接收方持久水位提高代次，训练状态的 sid/commitRev/关闭日志校验仍照常执行。

代次只废弃过期传输字节，不清理业务 outbox、pendingEdits 或关闭日志，不伪造事件成功。旧版本未协商时沿用取消精确回执路径，不单边遗弃。

## 验证证据

- `watch-device-regression.test.js`：实际 UX、session 持久层与 BlueOS Page 代理契约；200 次表冠加键盘零 session 写盘，完成组一次写盘、一个 set 含最终值，无 weight/reps 事件；失败保留草稿；未触及字段更新，隐藏恢复，原始草稿对象不进入强代理 Map。
- `watch-interaction.test.js`：400 次连续输入、同页返回/取消、滑动隔离，以及会话/单位/组删除/完成/暂停/休息造成的失效。
- `watch-commit.test.js`：回执 Promise 永不完成时后继仍持久提交；checkpoint 失败仍不 ACK；重启精确重放；回滚异常三次隔离、原事件保留、无成功 ACK。
- `watch-persistent-transfer.test.js`：旧任务丢回执、最新全量替换、重启及 TTL 后旧帧拒绝、落盘前不回执、未协商继续旧路径、发送端代次丢失恢复。
- `watch-link.test.js`：新 capability 协商及降级关闭；原设备选择、目录/今日计划、确认链路测试继续执行。
- BlueOS 原生四页编译与 verify-layout.cjs；RPK 外层/证书层 RSA 签名、负向篡改和 payload SHA256 校验。
- 编译后模板 + SDK 字体 + 390×450 + 保守 100px 圆角的 80 场景，检查数字/字形/触点安全边界、重叠、意外滚动、底部可达；不是模拟器帧，也不是真机截图。

全量测试、语言检查、生产构建和发布资产校验的最终结果记录在对应发布过程；不从自动化结果推断设备 FPS/内存/无死机。

## WATCH GT 真机验收

1. 配套安装手机 1.6.33（79）和方屏 0.6.36（51）；从手机选择具体已绑定手表，双向确认在线，推全量计划目录和今日训练。
2. 点重量/次数选中，快速正反转 200 格；再点打开键盘，输入小数、退格、取消、保存；确认没有路由往返，最终完成组时两端数值一致。
3. 草稿期间手机更新另一字段、暂停、改单位、删当前组、切组；旧输入不得写到邻组。暂时息屏返回；强退应明确区分未完成草稿与已完成记录。
4. 断连后连续完成/撤回多组、休息和结束；重连后核对全部事件。制造旧帧/取消回执丢失，再推更新计划，确认最新全量恢复，迟到旧帧不回滚。
5. 检查当前组、休息、概览、强度、键盘、详情、结束/放弃及总结在 390×450 无遮挡；重复切页 100 次，持续心率及休息倒计时运行 30 分钟。
6. 记录冷启动、点击至回显、页面切换的真实时间和前后日志。可用外部录像逐帧测时；若没有 BlueOS profiler/堆接口，则仅报告观测，不能捏造 FPS、内存峰值或芯片级故障结论。BES2700IBP 真机的稳定性最终以设备测试为准。
