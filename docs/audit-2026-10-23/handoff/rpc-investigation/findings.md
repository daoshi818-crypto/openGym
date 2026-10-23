# 证据

- Phase11: 手机clearWatchPlan仅清缓存，无ended消息，hello无会话核对；手机end仅训练页处理，切设置页后丢失；手表Summary不接管RPC，跨页结束缺统一处理。BlueOS lifecycle文档明确onBackPress仅router.pages当前页followHand:disable生效；当前manifest未设置。表冠通用rotation事件有delta/direction/state，必须requestFocus(true)。采用显式控件、页面返回拦截和表冠焦点；UI CLI已有不可用证据，不重复安装。
- Docs read: /api/extend/lifecycle, /component/common/ui-rotation/, /component/common/common-events/, manifest文件。继续历史训练保留原始start/id，使用elapsedBeforeMs与segmentStartedAt累计时长，以新watchSid区分继续前后的离线回执。

- 第三次真机日志 init success、permissionStatus=true、healthServiceConnected=true、watchConnected=true，说明 .2 的 SDK Context 修复有效。rpcServiceComponentState=1/resolvable=true，不能凭静态 enabled=false 归因服务禁用。
- 参考 ZIP 静态解压检查：RNvivoWatchModule.AwaitWatchUp 使用 action_pull_up_watch，data 为 package/router；本项目 AAR 确认 Constant.Action.ACTION_PULL_UP_WATCH 存在。我们的包名 com.zcode.gymtimer，manifest 入口 Index。
- 业务数据参考直接 JSON 字符串透传，协议为该应用私有 command/payload，不复制。文档设备侧 send 接受对象，onMessage.data 是业务数据；当前传输形态符合文档，不凭单个 msg 示例增加不确定包裹。
- 本地已证实：Workout 卸载 clearWatchPlan 导致设置页拉起时无法补推；flushPendingPlan 并发控制在 await watchPlugin 之后，可能重复发且漏掉 in-flight 中到达更新；失败会用旧计划覆盖新计划；hello 的 sid 初始为空，Workout 无条件 sid 检查会阻止权威快照。
- UI CLI 因 registry EACCES 退出，按现有 Button 和状态文本实现最小 UI。

- 实际 Git 仓库在 source/；开始时仅 watch-app/dist/ 未跟踪，源码干净。
- 用户日志对应 WatchRpcPlugin.ensureInit/failInit/probeRegistration。
- 当前代码先用四参 init(context, com.vivo.health, SDK_KEY, callback)，失败立即重试三参。两次失败 message 均为空后手动探测 REGISTER。
- 用户文档初始化例子为 init(getApplicationContext(), encryStr, initCallBack)，Manifest 要求 health.device.manager.version 和 appid。
- 文档提供 vivo 官方 AAR 下载 h5.vivo.com.cn/health/rpcsdk/new/device-rpc.aar。
- Manifest 的 appid 为 Integer；其是否错误必须核对实际 SDK，不能直接假定应改为 String。
- 日志 SHA-256 与手表 rpc.js 的 PHONE_FINGERPRINT 忽略大小写一致。release 手机包名 ch.duartesantos.opengym 与手表目标一致；debug 添加 .test，因此不匹配。
- RpcClient.isConnected(com.vivo.health) 被当作手表连接状态，需核对该 API 实际语义。

实际 AAR（1.0.0.17）字节码已核实：
- 四参 init 仅设置健康包名后调用三参，失败重试没有兼容性收益。
- appid 使用 Bundle.getInt，Integer 正确。SDK REGISTER 使用 encryVersion=0；当前探测写 1 是明确不一致。
- SDK 初始化回调丢弃响应 code，只传 data，因此本地 code=8/data=null 会显示 init(false,null)。
- client/b 在 vivo && !isVos && boundWatchDeviceCount<=0 && !isStartBind 时直接跳过 bindService；后续无 binder 返回 NO_BUSINESS=8。计数读取失败也按 0 处理。
- 计数来自 Settings.Global: com.vivo.health.watch.boundWatchDeviceCount。三次同秒失败支持此假设，但没有真机证据不能定案。
- RpcClient.isConnected 只检查健康服务 binder；手表连接应查询 ACTION_DEVICE_INFO 的 device.connected，并处理 ACTION_DEVICE_DYNAMIC。
- 动态通知既有 device JSON，也有 SDK 自身的 com.vivo.health:true/false 文本，后者仅表示 binder 状态。
- getDeviceVersion(pkg) 查 Android 已安装包 metadata，不能用手表包名获取手表版本。
- 健康应用 capability 应看 health.device.manager.version，文档要求 >=2；仅已安装不足以确认支持。

计划修复：保留有效四参初始化但去除重复重试；探测版本改 0；补充环境诊断与明确失败提示；使用设备信息判断连接并修复前端状态残留。
# 第二次真机日志与确定缺陷（2026-10-19）

- 新日志 boundWatchDeviceCount=1、能力版本5、rpcServiceEnabled=false、init/REGISTER 8 同秒。不能用诊断的计数1认定 SDK 读取计数成功。
- AAR RpcClient.isConnected(pkg) 在 ChannelCore.c==null 时创建 client/b(manager.getContext(), core)。构造器将 context 存入 client/b.b，之后不再赋值。
- DeviceRpcManager.init 写 manager.context 和 ChannelCore.a，不重置 ChannelCore.c。发送与状态查询共享 ChannelCore.c。
- SDK 使用 client/b.b 读 Settings，null 会被 catch，计数仍0，vivo/!vos/!startBind 时跳过 bindService，返回8。这是由字节码确认的缺陷机制，真实设备上可能还存在独立服务禁用问题。
- 旧版 isSupported -> isConnectedInternal 在 init 前访问 RPC；1.5.9 environmentDiagnostics 也在 init 前访问。必须在 healthServiceConnected 中检查 manager Context，failInit 的手写探测也需同样防护。
- rpcServiceEnabled 来自 MATCH_DISABLED_COMPONENTS 查询，追加组件覆盖开关值及无 MATCH_DISABLED_COMPONENTS 的 resolveService 结果，避免单凭一个字段归因。


## 第四次真机：业务链路
- 发5动作计划code0、之后hello未补发、最终planSid空；不能证明手表已接收。clearWatchPlan只由Shell在active不存在/历史编辑时调用，未发现路由自动清理，可能用户已结束会话，需记录清理原因与前次sid。
- session-start真实条目为id/sets/target，无name；计划和hello快照读e.name为空，已确认数据映射缺陷。
- 本地原有dist RPK确为0.4.0/code7，编译时间2026/10/18；不代表手表实际安装版本。其接收函数与当前源码相同；不能凭stale文件判定设备版本。
- 重新读取文档：实际设备侧URL /api/connect/interconnect/；onMessage.data传业务数据，send接受Object，与当前形态一致，暂不改msg包裹。Index绑定仅onInit，Workout亦然，恢复页面缺少重绑和hello。
- 工具错误：错误pages/Index路径、update在根目录非public、device-side URL404，均已定位正确路径。

- 用户已确认实际手表版本0.4.0。真实builder回归复现名称缺失；模拟两份页面RPC模块共享原生实例时，旧startServer提前return无法恢复回调（回归先失败后修复）。这证明代码缺陷机制，尚不能证明真机本次训练缺失就由此触发。
- 增加planId对应的页面处理回执、watch版本/解析诊断及会话清理原因。保留原协议包裹格式，未把传输code0当页面已应用。

## 用户更新0.4.1后的新日志与ZIP深入比对
- 新附件17:15:54 hello后17:15:56发送5动作code0，17:16:21 hello后同sid计划重发两次；因此不能将本次归因为未补推或仍安装0.4.0。未有业务回执，尚无法定位手机→健康→手表→页面的具体丢失边界。最终planSid为空需新清理原因诊断。
- 设备包{device:...}在业务action出现，不含t，当前不修改训练数据；不能认定是计划被改写。
- 深入读取ZIP VivoTrainStartCoordinator（VivoSendMsg_15161790.js）：0/500/1000ms发does_watch_app_run和Is_app_up探测；收到app_is_up/watch_app_is_running/agree_policy/app_up_done则发送Train_Start，1800ms fallback；不是以RPC成功作为页面已显示证据。RNvivoWatchModule_15163571.js对业务直接JSON.stringify透传，并将native事件data直接JSON.parse，不额外增加msg包裹。
- ZIP原生接收用固定占位字符串响应业务request；传输响应与业务回执不同。保留本项目plan/hello格式，引入planId对应页面处理回执；没有根据不确定的dataChars7或私有command猜测修改传输格式。
- 回归执行真实watch rpc/session与ux脚本，但不模拟真实BlueOS渲染或vivo健康转发，不能称真机同步已修复。

## 17:36 device evidence
- hello identifies watch 0.4.2, phone bridge .4, connection and permissions healthy.
- plan/rest/sync trigger watch_rx invalid_message with envelopeType=object, keys=[data]; page ACKs absent. This locates failure before page handlers. Exact inner data type remains unknown.
- Re-read phone docs: raw custom string in generic async sample; specific request example uses JSONObject with msg. Reference ZIP sends JSON.stringify(command object) directly. Neither proves actual watch inner envelope.
- Bundled watch types omit business data type; local cache contains built app pages, no runtime implementation.

- Phase9：已复现旧解析器对嵌套data/msg和重复JSON兼容不足。新解析最多8层，识别业务t后停止；失败分类和结构路径已覆盖回归。实际真机内层仍未知，不将兼容测试当成设备格式证明。

## Phase10: confirmed source defects and user clarification
- User confirms phone is on first set while watch is on second; edited watch weight immediately reverts.
- Workout.onInit and onPlanUpdate use nextUndone (after-current search), unconditionally advancing unfinished cursor.
- Keypad imports sendControl without ever starting its page RPC instance; separate module instances silently drop edit. Keypad saves stale state and untouched confirmation clears values.
- Phone watch set/unset calls toggle(rawSetIndex, workOrdinal) instead of toggle(exerciseIndex, rawSetIndex), corrupting mapping especially after warmups.
- Regressions will execute shipped UX/session/transport scripts and real React event handlers.

Phase10 最终结论：真机已证实 event.data.data、plan/sync applied，不改既有传输封装。首组跳到第二组源于训练页初始化/重推计划调用 nextUndone；编辑输入页独立 RPC 未初始化且保存旧快照。改为当前游标保留、最新会话单字段保存、pendingEdits 持久化至手机 editAt 回传确认，可靠 outbox 重连重发；迟到快照在输入页返回前后均保留本地编辑。手机完成组的动作/行下标传反已修正，排除热身，支持完成/撤销/重做和重复事件确认。手机结构消息带结果组数，计划缓存随实际内容更新。左右滑动补 touchmove/末次坐标兜底，refresh 不再强制关闭组菜单；实际固件触摸事件形态仍需设备复测。
验证：专项8文件297项通过，手机模式Vite构建通过（已有动态导入/大包警告）；版本元数据及git diff --check通过。手机1.5.14/code42/bridge.6，手表0.4.4/code11。本地无JDK/BlueOS打包工具，未构建APK/RPK及真机验证。
