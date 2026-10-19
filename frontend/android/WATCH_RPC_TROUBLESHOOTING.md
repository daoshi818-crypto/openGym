# 手机与手表 RPC 连接排查（2026-10-19）

应用版本：`1.5.11`，Android `versionCode=39`。本次诊断标识：`bridgeVersion=2026-10-19.3`，位于连接日志的 `environment=` 和设置页诊断 JSON 中。

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

本轮没有修改手表源码或已有 `watch-app/dist/`；拉起目标匹配当前手表 manifest。真机拉起与同步结果仍待安装新版手机 APK 后验证。

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
