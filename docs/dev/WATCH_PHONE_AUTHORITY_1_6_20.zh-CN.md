# 手机权威同步与第五组回归：1.6.20 / 0.6.23

## 可复现原因及证据
1. `useUI.followWatchRest` 跳过休息时把 timer 清空且丢掉来源，`App` 随后按手机操作更新 restVersion 并回传。RED：rest-origin-red.log。修复：保留 restStopSource，通过 broadcastPhoneRest 检查来源。
2. 已持久化快照保留未确认覆盖；否决回执随后移除 pendingEdits，但旧代码只通知页面读取，实际 rows/focus 仍保留覆盖。RED：authority-red.log。修复：在同一个 session_state 原子候选中重放已提交快照和剩余操作，再通知页面读取。
3. 手机 reducer 可处理消息中附带的 weight/reps，而旧校验只检查消息名对应字段。RED：durability.log，手机重量80被捆绑消息覆盖为65。修复：校验所有实际写入字段。

## 数据流与边界
操作仍先可靠保存，再刷新手表并上传；received 仍仅表示 Native Inbox 收到，只有精确 committed 才能退出对应 Outbox 项。手机的并发字段裁决保持 status=conflict 兼容原协议，新增 resolution=phone；持久化决策和 resolved=phone 后才回复。手表可靠保存裁决与重建后的会话，成功后才消费精确事件。新裁决不批量丢弃依赖事件，依赖手机已裁决的父事件可以提交，但每个子事件仍检查版本与所有写入字段。

旧手机没有 resolution 时仍走原有依赖归档分支，原始未确认内容保留且不受已裁决20条保留窗口清除。新手机重连将旧手工待选记录标为以手机为准，经 checkpoint 成功后才发 conflict_reviewed。旧重复裁决保持原样重放；没有伪造已应用 ACK。跨训练保护、close-journal 和结束/汇总提交边界保留。

## 实际修改范围
- 手机：App.jsx、store/useUI.js、lib/watch-rest-broadcast.js、watch-commit.js、watch-revision.js、views/Settings.jsx。
- 手表：lib/session.js、rpc.js、event-dependencies.js、Workout/index.ux、Index/index.ux。
- 回归及夹具：watch-rest-broadcast.test.js、watch-rapid-sets-regression.test.js、watch-v3.test.js、watch-dependencies.test.js、watch-test-harness.js。
- 版本、正式发布说明和发布流程；方屏/圆屏原生编译包及 SHA256。

## 验证与限制
诊断目录：D:/gym/diagnostics/watch-fifth-set-conflict-20261108。

- 定向回归：5 文件 / 47 测试通过（durability-fixed.log）。手机模式启动：1 文件 / 2 测试通过。
- 首次完整前端测试：508 文件，6194 通过 / 3 失败。三项均为日期夹具，机器时区与 CI 的 Europe/Zurich 不同；按 CI 时区重跑对应三文件为33/33通过。未修改断言或排除测试。完整 CI 时区复跑结果：508 文件 / 6197 测试全部通过，退出0（frontend-full-ci-tz.log）；测试进程出现 MaxListenersExceededWarning，未产生失败。
- Android：testDebugUnitTest 和 assembleRelease 成功；20 项原生测试，0 失败、0 错误、0 跳过。
- 手机 Vite 构建、Android-only Capacitor 同步和 mobile-bundle 检查成功；未修改 iOS Podfile。
- BlueOS 方屏/圆屏原生编译及每目标五路由布局门禁成功。包 SHA256：方屏 f45f3c9136f6b57affc8c128a9c344308a4bd372f204ac27656ddb3f98dca7a7；圆屏 5fd03716dd1a1d47f62eb70cd8d96d5bab0f2bc83276eec1eb098ae82f9b0229。
- 18 语言 / 2619 键、2045 条源码翻译检查通过；生成教练资源、API 文档、plain-node core-loadable 和 git diff --check 通过。

本次没有实体设备，未采集真实点击至UI/落盘、通信/恢复延迟p50/p95、内存峰值、物理写盘次数及黑屏固件日志。不得把定时器模拟和桌面编译当作真机性能测量或系统崩溃修复证明。此前两份无关本地修改须保持原SHA256、不进入提交。
