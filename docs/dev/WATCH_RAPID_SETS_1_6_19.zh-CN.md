# 5＋2 组同步与重新训练故障：修复记录

## 用户报告与边界

手机 1.6.18 / 手表 0.6.21：快速完成和跳过休息，第 3 组漏同步，随后组恢复，再跳回第 3 组；第二动作卡住/退出。手机结束再开训练，手表从第一动作第二组开始，随后黑屏、短暂系统无响应及断连。底部圆点难以选中。

基线 e38f5f3fcb39359342d873a9ae0e0f9449d4c5fb。只在 D:\gym\openGym 修改/构建。保留 api/coach/prompts/ask.md、frontend/ios/App/Podfile 原有修改，不纳入提交。无 adb 实体设备，未清应用数据、Outbox、pendingEdits 或关闭日志。

## 已证实的代码问题（不等于已证实的固件崩溃原因）

1. **页面代理破坏草稿隔离。** BlueOS SDK 框架 lt() 的 Proxy setter 不使用 receiver，且定义方法绑定到 live ctx。原 Object.create(page) 写 state/sessionActionDraft 实际触及 live page，不能替换绑定的 refresh/helper。随后草稿标志残留使 commitPageAction 直接执行操作，跳过落盘边界。普通对象测试未覆盖该平台语义。独立 facade 和原始 pageDefinition 方法解决这一隔离问题；SDK 语义模拟测试在旧实现失败，修复后通过。
2. **快照写盘重入。** commitWireSnapshot 在 writeStoredAtomic 变换中调用 applySync → persist → writeStored，另起普通写并提前发布候选。新增测试发现同 key 两个未完成 SDK 写，失败快照已经改缓存。persist 遇到 sessionDraft 返回，快照只由同一原子文档提交。
3. **新 sid 污染。** 旧实现复制 inactive 旧文档，将旧 focus intention 重放到新 sid，实际测试复现从第二组开始，同时继承 HR/rest。新 sid 从 blankState 开始，旧未确认事件原样保留（无 sid 的旧格式附原 sid），仅同 sid 或当前会话旧格式事件可重放/参与依赖。
4. **可靠状态与页面脱节。** 持久化接收器安装新 sid 后，Workout 只接受与旧 this.state.sid 相同的文档；后续 applySync 拒绝不同 sid，页面继续显示旧会话。已持久化通知标明内部 persisted 选项，页面只采纳可靠文档，跨 sid 清除交互层/临时休息状态。迟到旧 sid 通知不能覆盖新页面。
5. **已完成组被禁止选择。** pickSetDot 显式拒绝 done 行；解除该限制，保留稳定 setId 定位，选择不自动撤销。可见圆点由 10/14px 调到 18/22px，点击区不小于 44px；编译布局检查改为新尺寸精确断言，仍验证圆点无数字、点击区与标题动作列表入口。

原有 loadState() 在事务中返回 sessionDraft，是正确的机制，不是缓存覆盖根因。保留 700ms 完成防连击；测试采用真实时间推进/触摸清除自动焦点抑制，不删防护以让测试通过。

## 修改边界

watch-app/src/lib/local-action.js、session.js、rpc.js；Index/Workout 页面；verify-layout.cjs；新增 watch-rapid-sets-regression.test.js 及现有 watch-interaction.test.js 的已完成组选中断言。其余为双端版本号、协议/发布文档与现有发布 workflow 的说明路径。无手机 reducer/Native 业务变更、无额外网络并发、无 wire 格式变更。

## 验证证据

诊断目录 D:\gym\diagnostics\watch-rapid-sets-crash-20261108：regression-before*.log、new-session-before.log 记录修复前失败；proxy-sequence.log、frontend-full.log、watch-build-final.log 等记录修复后执行。

新增 10 个回归覆盖单次私有快照写、失败不发布、新 sid 隔离、连续 5＋2 组、已完成点选与撤销、代理页面隔离、可靠新会话通知、代理实际渲染与延迟盘/旧下行交错、失败重试、无 sid 旧 pending 兼容。纯主机模拟只替换设备 API，执行实际 session/RPC/Workout 模块；不提供真机延迟、内存峰值、p50/p95 或系统崩溃修复承诺。

本地验证：全量前端 507 文件 / 6185 项通过；手表专项 32 文件 / 408 项通过；手机模式启动 2 项通过；Android compileDebugJavaWithJavac / testDebugUnitTest 成功；移动 bundle、18 语言与源码字符串检查、coach 生成资产/API 文档/core 加载检查通过；方屏/圆屏 0.6.22 实际编译及编译布局检查通过。全量测试出现 MaxListenersExceededWarning 但退出码为 0，无失败；未为消除警告调整监听器上限。初次手表编译被旧圆点最大尺寸门槛拦截，已按用户要求的新精确尺寸修订检查并重新构建通过。云端发布及下载验证在完成后补充。本次目标是移除已复现的数据/页面错误，并交付可进行相同现场测试的新双端版本，而非把模拟通过当成真机验收。
