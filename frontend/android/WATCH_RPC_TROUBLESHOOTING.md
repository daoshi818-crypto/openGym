# 手机与手表 RPC 连接排查（2026-10-19）

当前应用版本：`1.5.15`，Android `versionCode=43`；手表源码版本 `0.5.0 / versionCode=12`。诊断标识：`bridgeVersion=2026-10-19.7`。

## 1.5.15 / 手表 0.5.0：界面、训练结束、热量和继续训练

- 以 390x450 为基准重构训练、休息、输入、动作和结算页面。训练主屏始终有动作/组数/更多入口，当前组完成后可以撤销。数字输入页增加取消/保存，避免关键操作只藏在手势里。
- 右滑原先触发系统默认返回。按 BlueOS 生命周期与 manifest 文档，为 Workout 设置 `router.pages.Workout.followHand=disable`，同步 `onBackPress` 返回 true 接管返回动作，打开训练操作面板。左滑保留组菜单入口，按钮提供等价操作。
- 表冠采用通用 rotation 事件、`requestFocus(true)`：训练屏切换组，休息时每格调 5 秒，输入页重量每格 0.5kg、次数每格 1；动作列表使用原生 list 的表冠滚动。结束旋转事件不重复应用，不用按键触发结束训练。
- 手机结束前发送带 sid/实际 endedAt 的 ended 消息，清除计划；全局 hello 对照持久化的手机当前训练和历史记录，手机重启、手表离线结束、切到设置页也可补发结束状态。手表在 RPC 层统一结算，不依赖当前页面，并持久化已结束 sid 防止旧 plan/sync 复活。
- 手表实时显示估算热量。任一端结束都通过持久化 outbox 回传本段 calories/avgHr/maxHr；手机全局接收并写入对应活动会话或历史记录，在结算和历史详情显示。重复回执不会累加，旧段回执不会结束继续后的新段。热量沿用项目心率/体重估算，无心率时使用默认活动强度；不是 vivo 运动健康系统测得的热量。
- 手机结算页与历史详情增加“继续本次训练”。保留原始动作、已完成组、日期、start、id，`elapsedBeforeMs + segmentStartedAt` 累计计时且不计中间间隔；再次结束替换原 id，保留媒体和重新计算训练量/PR，不追加第二条记录，也不再次推进训练轮转。历史 `end-start` 延续累计时长约定，另存 `finishedAt` 作为实际结束时刻，供断线手表结算。新 watchSid 区分每次继续，watchSids 保留段身份，迟到热量仍可合并。

设备复测：

1. 手动构建安装手机 1.5.15/code43 与手表 0.5.0/code12，确认 bridge .7 和 hello 版本。
2. 新开训练，核对首组和编辑；按“动作/组数/更多”操作，左滑应进组菜单，右滑应进训练操作而非首页。表冠切组；休息调时；输入页调数值，确认取消不写入。
3. 在手机结束，手表应进入结算；再新开训练，断开手表后在手机结束，重连并拉起手表，核对旧训练结束，时长不包含离线等待。
4. 分别从手机和手表结束，打开手机历史详情核对估算热量。重复拉起/连接不增加热量。手机停留设置页时，从手表结束也应保存。
5. 结算页点击“继续本次训练”，增加动作或组，确认计时接续旧时长；再次结束，历史只有原记录、累计时间和新动作正确。重复继续一次，核对旧离线消息不关闭新训练，迟到各段热量仍合并。

验证：15 文件、370 项专项回归通过；手机模式 Vite 构建通过（已有分包警告）。实际点击结算页继续按钮并再次结束、手表离线结束按原时间入库的集成回归通过。手表 end 携带已完成组明细，在手机未打开训练页时也补齐本次记录。用源码模板/CSS生成浏览器预览并截图检查五个页面、训练/休息态和操作面板的 390x450 边界；预览不是 BlueOS 渲染器。缺少 JDK/BlueOS 打包工具与真机，本地未构建 APK/RPK，也不能确认固件实际表冠或手势效果。GitHub APK 工作流不会生成手表 RPK；双端均须重新构建安装。

文档：BlueOS `/api/extend/lifecycle`、`/reference/configuration/manifest`（manifest 文件页）、`/component/common/ui-rotation/`、`/component/common/common-events/`。`onBackPress` 仅 followHand=disable 时生效；表冠组件必须获焦。

## 1.5.13 / 手表 0.4.3：接收解析兼容与内层诊断

17:36 真机日志已确认手表为 0.4.2，初始化和权限正常；plan、rest、sync 的 RPC 响应均为 code=0，但手表随后返回 `watch_rx status=invalid_message`，外层为 object、keys=[data]，没有页面处理回执。因此消息已经到达手表回调，失败发生在进入训练页面处理之前。现有日志没有记录 data 内层形态，不能认定真机一定采用双重 JSON 或 msg 包裹。

旧接收器只拆一次 data 并解析一次 JSON。本轮兼容已知 data/msg 包裹和多次 JSON 编码，最多检查 8 层，识别业务 t 后立即停止解包，保留业务自己的 data/msg 字段及文件消息。对不支持的二进制、畸形 JSON、无类型和层数超限分别报告原因，不猜测二进制编码。手机发送仍使用原始 JSON 字符串；参考 ZIP 的原生桥和 JS 模块均直接透传 JSON，手机 API 通用异步示例也允许业务字符串，目前没有证据要求改变发送协议。

失败回执新增 `reason`、`decodePath`、`layers`；layers 仅含各层类型、有限字段名、对象类型和字符串/数组长度，不包含训练原文。成功的 plan_ack/sync_ack 也报告 decodePath，手机文本日志增加该字段，完整结构保留在 lastWatchRx 中。

### 本轮复测

1. 在 GitHub main 手动运行 **Build signed APK**，安装手机 `1.5.13 / code41`，确认 bridgeVersion=2026-10-19.5。
2. 按现有 BlueOS 流程重新构建并安装手表 `0.4.3 / code10`，确认首页及 hello 的 watchVersion 都为 0.4.3。手机 APK 工作流不构建或更新手表 RPK，本轮未修改构建产物。
3. 设置页拉起手表，再回手机开始训练并保持会话。检查首页训练名称、动作数量和“进入辅助”；正常回执应为 `plan_ack status=applied page=Index exercises=5`（数量依当前训练），并包含 decodePath；进入辅助后检查动作、重量、次数和休息倒计时。
4. 若仍无动作，复制完整日志和诊断 JSON，尤其是 lastWatchRx 的 reason/decodePath/layers、lastPlanReceipt、lastSyncReceipt 和 watchVersion。仅 code=0 仍不足以认定页面已处理。

本轮专项回归 6 文件 / 65 项通过，手机模式 Vite 构建、双端版本元数据及诊断日志字段校验通过。回归使用实际手表 rpc/session/ux 脚本并替换设备 API，覆盖接收包裹兼容和页面处理；这不能替代健康转发、BlueOS 渲染或真机业务回执验证。当前环境没有 JDK 和 BlueOS 打包工具，未生成 APK/RPK，真实设备结果仍待用户构建安装复测。

## 1.5.12 / 手表 0.4.2：动作名称、接收回调和业务回执

用户已经将手表更新到 0.4.1，仍未收到动作。新附件中 17:15:54 拉起成功并收到 hello，17:15:56 发送 5 个动作返回 code=0，17:16:21 的 hello 后也能看到同一计划重发。因此，本次不能仅归因为旧手表版本或没有补发。日志只证明健康 RPC 请求获得响应，尚未证明计划到达手表页面；0.4.1 不含本轮新增的处理回执，现有日志不足以确定真机丢失边界。

本轮已用失败回归确认并修正两个本地问题：

- 实际会话构造器产生的训练条目只保存动作 id，没有 name。原计划和重连快照读取 e.name，动作名称为空。现在与手机界面一样从自定义动作或目录解析名称，计划和快照共用同一映射。此问题会导致名称缺失，但单独不能解释首页完全没有动作数量或按钮。
- 两个页面各自打包的 RPC 模块可能共享原生连接实例。旧 startServer 在已有实例时直接返回，返回页面后无法重新接管回调。现在每次页面 onShow 重新挂接接收回调并查询连接状态。模拟共享连接的实际脚本回归可复现旧行为，尚不能证明该机制就是用户此次设备故障的唯一原因。

重新对照参考 ZIP 的原生桥、RNvivoWatchModule 和 VivoTrainStartCoordinator：业务数据直接 JSON.stringify 透传；拉起后在 0/500/1000ms 探测应用就绪，收到业务就绪消息再发训练，并有 1800ms fallback。原生业务 request 的响应可以是占位字符串，和业务确认是不同层次。本项目已有 hello 补发，保留现有 plan/hello 协议和 JSON 形态，新增页面实际处理之后的回执；没有照搬参考应用私有 command/payload、凭据或超时参数。

手表 hello 现在报告 watchVersion 和 receipts；每次手机发布计划产生 planId。手表 plan_ack / sync_ack 报告页面、会话、动作数量与处理结果；仅匹配当前 sid 和 planId 的 plan_ack 才更新当前投递状态。解析失败返回 watch_rx，异常返回 error 回执。手机同时保留 lastPublishedPlan、lastPlanClear 和最近回执，区分会话已结束与正在等待接收。

| 诊断字段或回执 | 含义与下一步 |
| --- | --- |
| watchVersion=not_reported | 此次 hello 未报告版本；检查实际安装包。不能仅根据手机版本认定手表已更新。 |
| planDelivery=awaiting_receipt | 已尝试发送，尚无匹配业务回执；即便 RPC code=0 也不表示已应用。回执本身也可能丢失。 |
| planDelivery=transport_failed | RPC 请求失败，查看对应返回码；下次 hello/连接事件会补发。 |
| lastPlanReceipt.status=applied, page=Index | 首页处理完成；检查训练名称、动作数，并点击“进入辅助”。 |
| status=retained | 首页保留同一会话的本地训练，未声称应用新计划；检查继续训练内的数据。 |
| status=rejected, reason=session_mismatch | Workout 正在显示另一会话，查看 activeSid 与手机 sid，需检查权威 sync 是否到达。 |
| lastWatchRx.status=invalid_message | 已触发手表接收回调，但未识别消息；保留 envelopeType/keys。 |
| status=no_handler / error | 已收到计划，但无页面处理器或处理抛错；保留 page/error。 |
| planSid 为空，lastPlanClear 有记录 | 查看 reason=no_active_session/history_editor，及清理前 sid/planId，避免将结束会话当丢包。 |

### 当前版本复测与构建边界

1. 在 GitHub main 手动运行 **Build signed APK**，安装手机 1.5.12 / code 40，确认 bridgeVersion=.4。
2. 使用现有 BlueOS 构建安装流程重新打包并安装手表源码 0.4.2 / code 9，首页应显示 v0.4.2。手机 GitHub APK 工作流不构建手表 RPK；之前检查到的 0.4.0 RPK 不能当作本轮新包，本轮没有更新手表构建产物。
3. 在手机设置页拉起手表，确认收到含 watchVersion=0.4.2、receipts=true 的 hello。回手机开始训练并保持会话未结束，检查首页训练名称和动作数，再点“进入辅助”。
4. 另测先开始手机训练再切设置页拉起手表，以及手表训练页退回首页再拉起。若失败，复制完整日志和诊断 JSON，重点看 planId、planDelivery、lastPlanReceipt、lastSyncReceipt、lastWatchRx、lastPlanClear。

本轮专项回归 6 文件 / 55 项通过，涵盖真实会话构造、双端计划队列、回执匹配、实际手表 rpc/session/ux 脚本和设置页行为；手机模式 Vite 构建通过。脚本回归替换了设备 API，不验证真实 BlueOS 渲染或健康转发。当前环境没有 JDK 和 BlueOS 打包工具，未生成 APK/RPK，也未完成真机同步验证；下一次设备回执用于继续定位。

## 1.5.11：连接成功后的训练同步与拉起入口

用户 16:02 的 1.5.10 真机日志已经确认 `init success via 4-arg`、`DEVICE_INFO code=0`，诊断为 `initialized=true`、`permissionStatus=true`、`healthServiceConnected=true`、`watchConnected=true`。初始化顺序修复已获该设备验证。日志中的 `rpcServiceEnabled=false` 是静态组件信息；同时有运行时覆盖 `rpcServiceComponentState=1`、`rpcServiceResolvable=true` 及真实绑定成功，不能继续将这个 false 当作当前同步失败的证据。

本轮检查用户提供的 `Xunji_vivo_watch_reference.zip`，仅作为协议调用参考，没有执行其中脚本或采用其应用密钥/私有业务协议。参考桥用 `action_pull_up_watch`，向 `com.vivo.health` 发送包含 `package`、`router` 的 JSON。项目实际 AAR 的 `Constant.Action.ACTION_PULL_UP_WATCH` 与此一致。本轮新增同一调用，使用本项目手表 manifest 的 `com.zcode.gymtimer` / `Index`，通过异步 RPC 执行，在原有设置页的“连接手表”面板增加“打开手表应用”按钮。此拉起方式来自参考与实际 SDK 常量，不作为公开手机 API 页面已说明的能力。

同步路径中修正了以下确定的问题：

- 训练页卸载会清除保留计划，导致开始训练后切到设置页，再打开手表时无法补推。计划发布和清理改到全局 App Shell，以活动训练会话为生命周期。
- 发送标记在 await 后才设置，且发送中收到的新计划或 hello 没有继续排空；失败旧计划还可能覆盖新计划。现在串行处理最新待发计划，失败等待下一次连接/hello，不持续热重试，也不会复活已结束会话。
- 新打开的手表 hello 带空或旧 sid，被训练页拒绝，无法请求权威快照。hello 现在允许请求当前快照，其他业务写入仍要求会话 sid 一致。设置页时由全局缓存补推计划；完整快照及业务落库仍由活动训练页处理。

新增 `LAUNCH ...`、`RX business t=... sid=...`、`TX plan t=...`、`TX plan response code=...` 日志，以及 `watchPackage`、`watchRouter`、`lastRxType`、`lastPlanCode`、`lastLaunchCode`、`planSid`、`planPending`、`planPushInFlight`、`planLastError` 诊断。消息日志只记录类型、会话、数量和长度，不输出完整训练内容。RPC code=0 仅代表请求响应成功，不证明手表已展示或应用训练数据。

### 本轮真机复测

1. 在 GitHub Actions 手动运行 main 分支的 **Build signed APK**，安装 `1.5.11 / versionCode 39`，确认诊断标识 `.3`。
2. 运动健康中确认手表在线。在手机原有设置页打开“连接手表”，点击“打开手表应用”，确认手表出现训练助手首页。保留 `LAUNCH` 请求和返回码。
3. 回手机开始训练，检查手表首页是否显示训练名称与动作数，然后在手表点“进入辅助”。现有手表界面需要此操作进入训练详情。
4. 再检查“先开始手机训练，再切到设置页拉起手表”的顺序，确认计划仍可补发。
5. 如果仍不同步，发送完整诊断日志，重点保留 `LAUNCH`、`RX business`（有无 `t=hello`）、`TX plan` 和响应码，以及最终诊断 JSON。只有 ACTION_DEVICE_BUSINESS_DATA 行不足以判断负载是否被双方识别。

1.5.11 没有修改手表源码或已有 `watch-app/dist/`；拉起目标匹配手表 manifest。后续真机已确认拉起成功，同步问题继续按上方 1.5.12 / 手表 0.4.2 排查。

## 1.5.9 真机日志发现的初始化顺序缺陷

用户新日志：绑定计数为 1、健康能力版本为 5、服务存在但 `rpcServiceEnabled=false`；初始化和 REGISTER code=8 在同一秒发生。不能再只用“系统计数为 0”解释。

核对项目内 1.0.0.17 AAR，确认以下调用链：

1. `RpcClient.isConnected(pkg)` 在 `ChannelCore.c` 为空时创建 `client/b(DeviceRpcManager.getContext(), core)`，状态查询会改变 SDK 内部状态。
2. 初始化前 manager Context 为 null；客户端构造器把它保存在 `client/b.b`。
3. 后续 `DeviceRpcManager.init(...)` 写入 manager Context 和 ChannelCore Context，**没有替换已创建的客户端，也没有更新其 Context**。发送和状态查询共用该客户端。
4. 客户端用空 Context 读取绑定计数会抛异常，被 SDK 捕获并按计数 0 处理；vivo、非 VOS、startBind=false 时跳过绑定，直接返回 8。应用自己的 Context 仍可读出计数 1，二者并不矛盾。

旧代码的 `isSupported -> isConnectedInternal` 和 1.5.9 的初始化前环境诊断都存在这种提前查询。1.5.10 在连接状态读取入口检查 SDK Context；Context 尚未写入时直接返回 false，不访问 RpcClient。失败 REGISTER 探测也加同样检查，防止 init 在写入 Context 前抛异常时再次提前创建客户端。

这是已确认的软件缺陷和与日志吻合的失败机制，1.5.10 的用户真机日志已确认初始化和连接恢复。1.5.10 同时增加组件运行时覆盖状态和与 SDK 相同 Intent 的 `resolveService(..., 0)` 结果；不会尝试修改运动健康组件或系统绑定计数。

## 原始日志说明

`init(false, null)` 后 `REGISTER code=8/data=null` 表明需要优先检查手机到运动健康的 RPC 通道。仅凭这些日志不能认定 SDK 密钥错误。

文档 code=8 表示目标应用未安装或不支持 SDK；code=9 才是权限拒绝。项目实际使用的 device-rpc AAR 为 1.0.0.17。检查该 AAR 字节码后，还确认它可以在客户端直接返回 8：

1. 尚无运动健康服务 binder。
2. `Util.isVivoPhone()` 为 true，`Util.isVos()` 为 false。
3. `Settings.Global` 的 `com.vivo.health.watch.boundWatchDeviceCount` 小于等于 0（缺省或读取异常也按 0）。
4. `DeviceRpcManager.isStartBind()` 为 false。

满足上述条件时，SDK 跳过 `bindService`，最终返回 8。注意该计数是 SDK 客户端读取到的值，Context 被提前缓存为空也会走此路径。运动健康版本不支持、服务被禁用或绑定服务失败也可能产生 8。

SDK 初始化回调只传响应 data，不传 code，因此 8/null 最终会呈现 false/null。

## 已修正的本地问题

- 四参数初始化实际直接委托三参数；移除失败后的重复初始化，使用 application context。
- 自写 REGISTER 探测的 `encryVersion` 从 1 修正为该 AAR 实际使用的 0。它只用于失败诊断；原始 SDK 初始化本来就用 0，因此此修改本身不能证明初始连接故障已解决。
- 分别记录运动健康服务 binder 和设备连接；使用 `ACTION_DEVICE_INFO` 的 `device.connected` 及 `ACTION_DEVICE_DYNAMIC` 更新连接状态。SDK 自身的 `com.vivo.health:true/false` 通知只表示服务绑定。
- 设备信息解析 device 层级，断开时清除缓存连接标记，重连成功时清除旧错误。
- 接收器注册失败会报告初始化失败。
- 移除以手表包名查询 Android 安装包 metadata 的错误版本诊断。
- 增加健康应用版本、能力版本、启用状态、RPC 服务、绑定数量、包名和连接状态诊断；日志读取和写入加锁。
- SDK 已初始化但设备连接未确认时，设置页不再显示手表已连接。

## 1.5.10 初始化问题复测记录

1. 在 GitHub Actions 手动运行 **Build signed APK**，使用 main 分支。安装 `1.5.10 / versionCode 38` 的 release APK 后，在系统应用设置中强行停止手机 App 再重新打开，确保新进程中不保留旧 SDK 客户端。确认 Diagnostics 为 `bridgeVersion=2026-10-19.2`。无需清除应用数据。
2. 在 vivo 运动健康中确认手表已绑定、当前在线，再打开手表训练应用。系统蓝牙显示已配对，不足以证明运动健康已完成绑定。
3. 手机 App 点击连接，等待成功或失败后打开 Diagnostics，保留完整 `environment=`、`REGISTER probe code=`、`DEVICE_INFO code=` 和结尾 `diagnostics={...}`。
4. 按下表判断；不要通过修改系统绑定计数或强制 start_bind 绕过前置条件。

| 诊断字段或响应 | 排查方向 |
| --- | --- |
| 连接前 environment 的 sdkContextReady=false | 正常：SDK 还没有初始化，本版此时不访问 RpcClient。连接尝试后 Diagnostics 应为 true；若仍为 false，查看 init 异常和 REGISTER probe skipped。 |
| rpcServiceComponentState | 0=默认（跟随清单），1=显式启用，2=禁用，3=用户禁用，4=禁用至使用。与 enabled、healthEnabled、rpcServiceResolvable 一起判断。 |
| rpcServiceResolvable=false | 不带 MATCH_DISABLED_COMPONENTS 时系统无法解析 SDK 需要绑定的服务；仍有独立的健康应用服务可用性问题，保留健康版本和组件状态排查兼容性。即使为 true，也不等于 bindService 已成功。 |
| vivo=true、vos=false、startBind=false、healthServiceConnected=false、boundWatchDeviceCount=0 | 符合 SDK 跳过服务绑定的条件。先在运动健康内核实设备绑定状态；若健康中明明在线但计数仍为 0，保留 SDK 日志检查健康应用/固件兼容性。 |
| boundWatchDeviceCount=-1 和 boundWatchReadError | App 读取系统计数失败；SDK 此处异常也按 0 处理，可能触发同一门槛。 |
| healthDeviceVersion < 2 | 文档要求能力版本 >=2，核实当前运动健康版本是否支持该能力。此值是功能能力版本，不是商店版本号。 |
| rpcServicePresent=false，或 enabled/exported=false | 结合组件运行时覆盖值、rpcServiceResolvable 和 rpcServiceReadError 判断服务缺失、不可见或不可用，不能只凭 enabled 一个字段判断。 |
| REGISTER code=9 | 核对 vivo 开发者平台的 AppID、实际 APK 包名、签名指纹、SDK 密钥是否属于同一应用及授权配置。 |
| init=true、healthServiceConnected=true、watchConnected=false | SDK/健康服务通道已建立，设备连接尚未确认；继续查看 DEVICE_INFO 响应、健康中的手表连接和手表 App。 |
| DEVICE_INFO code=4 | 文档定义为设备未连接。 |
| watchTargetPackageMatches=false | 安装的是不同包名；debug 包名有 `.test`，与当前手表配置的 release 包名不匹配。 |

当前日志中的手机 SHA-256 与手表 rpc.js 指纹忽略大小写一致，Manifest appid 为 Integer 也符合该 AAR 的 Bundle.getInt 读取方式，不应为排查此问题改成字符串。开发者平台上对应的密钥/签名配置仍需核实，源码不能证明后台配置正确。

如有 ADB，可读取（只读，不修改）：

```powershell
adb shell settings get global com.vivo.health.watch.boundWatchDeviceCount
adb logcat -v time WatchRpc:I RpcLogger:V '*:S' | Select-String -Pattern 'WatchRpc|isHealthHasWatch|has no watch|ServiceConnection onServiceConnected|ClientImp callSync code|bindService'
```

`settings get` 返回 null 表示键不存在；该 AAR 的默认值为 0。上述过滤用于避免输出 SDK REGISTER 请求体中的密钥。

## 1.5.14 / 手表 0.4.4 组数与编辑修复

18:07 真机日志已经确认 `event.data.data` 业务解包成功，Index 和 Workout 都返回 applied，手表完成组也能到达手机。这轮根据用户确认的“手机第一组、手表第二组；手表重量修改后恢复旧值”排查业务状态，不再修改手机 SDK 初始化或业务封包。

- 手表训练页初始化和计划重发误用“当前组之后找下一组”的函数，导致第一组被跳过、补推再次前移。现在保留当前组，只在完成组后推进。
- 输入页可能具有独立的 RPC 模块实例，未初始化的 sendControl 会丢弃修改；提交还会把编辑前整份状态写回。现在只修改最新会话的目标字段，将编辑持久化交接给训练页可靠队列。编辑保留到手机回传对应时间戳的确认值，避免返回输入页后在途旧快照覆盖新值；输入页未键入直接确认保留原值。
- 手机处理手表完成/撤销时动作下标和原始组下标传反；现在按工作组编号排除热身映射到正确行，并读取当前状态。事件重发会确认且不重复应用，同组可撤销重做；手机完成组也会下发手表。
- 加减组携带结果组数避免重复应用；全局计划随实际计划内容更新，避免重连重放训练开始时的旧组数。手表未确认的编辑在重连后重新发送。
- 左右滑动原先依赖 touchend.changedTouches；现在兼容 touches 和最后一次 touchmove 坐标，取消触摸时清理跟踪。同步 refresh 不再关闭组菜单，避免划开后立即消失。实际固件触摸事件格式尚无设备日志，兼容回归不等于真机手势验证。

设备复测：安装手机 1.5.14/code42/bridge `2026-10-19.6` 与手表 0.4.4/code11，结束旧的测试训练后新开一场。确认两端从第一组开始；手表第一组改重量到 72.5、次数到 12，返回并重新打开后仍保留，手机相同行同步。分别在两端完成、撤销、重做第一和第二个动作的一组，含热身时也只影响对应工作组；加减组后重新拉起手表，核对总组数。训练页左滑打开组菜单，右滑打开训练操作面板，同步消息到达时菜单仍保持显示。保留最新日志中的 weight/reps/set/unset、plan_ack/sync_ack 和 watchVersion。

本轮专项 8 个测试文件、297 项全部通过，覆盖真实手表页面脚本、独立输入页模块、编辑确认与延迟快照、首组游标、热身映射、重复事件和触摸兼容；手机模式 `VITE_MOBILE=1 npm run build` 通过，仍有已有的大包和动态导入警告。

验证执行真实手表 JS/UX 脚本、会话存储和手机 React 事件处理的回归，不模拟 BlueOS 页面渲染或运动健康实际转发。本地无 JDK/BlueOS 打包工具，APK/RPK 构建及真机验证仍由 GitHub 手动构建和设备安装完成；不自动触发构建。

## 验证与限制

1.5.11 本轮专项验证：`npm test -- src/lib/watch-link.test.js src/lib/watch-workout.test.js src/views/Settings.connstatus.test.jsx src/views/Settings.gifsize.test.jsx`，4 个文件、19 项全部通过，覆盖拉起转发、发送失败/并发更新/hello 补发/结束会话清理、计划映射及现有设置页行为。手机模式 `VITE_MOBILE=1 npm run build` 通过，仍有已有的大包和动态导入警告。这是 Vite 前端构建，不是 Android APK 构建。当前本地仍无 JDK，原生编译及真实手表拉起/同步待 GitHub 构建和用户复测。

已有前端回归覆盖设备层级、连接残留、错误残留问题。本轮 1.5.10 复跑 `npm test -- src/lib/watch-link.test.js`，4/4 通过；`VITE_MOBILE=1 npm run build` 通过（仅 Vite 前端构建）。

上一轮（1.5.9）全量前端测试结果：393 个文件通过、14 个文件失败；4941 项通过、4 项失败（另有 11 个套件加载失败）。失败涉及稀疏检出未包含的目录/fixtures、Windows 脚本语法，以及日期和示例训练数据断言；本轮未修改这些模块，也未重复运行全量套件，不能将全量测试称为通过。

增加 Android 仪器回归 `WatchRpcInitializationTest`，直接使用实际 AAR，检查初始化前查询不创建客户端、写入 Context 后客户端拿到正确对象，并记录未保护查询缓存 null 的行为。它不连接运动健康或手表，不验证真实通信。

本地没有 Java/JAVA_HOME 或连接真机，尝试运行仪器测试在 Gradle 启动前即失败；Android 编译、该仪器测试执行和实际互联尚未验证。GitHub 的 release 构建不会执行仪器测试，真机/模拟器开发环境可运行：

```powershell
cd frontend/android
.\gradlew.bat :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=ch.duartesantos.opengym.WatchRpcInitializationTest
```

请以 GitHub 原生构建及上述真机复测结果为准。

参考：
- SDK 接入与密钥申请：https://blueos.niceshare.site/api/connect/development-guidance/rpc-sdk-guidance/
- 手机 API 与错误码：https://blueos.niceshare.site/api/connect/mobile-side/
- 项目 `frontend/android/app/libs/device-rpc.aar` 的实际字节码。
