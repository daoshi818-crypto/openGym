# 手机与手表 RPC 连接排查（2026-10-19）

应用版本：`1.5.9`，Android `versionCode=37`。本次诊断标识：`bridgeVersion=2026-10-19.1`，位于连接日志的 `environment=` 和设置页 Diagnostics JSON 中。

## 原始日志说明

`init(false, null)` 后 `REGISTER code=8/data=null` 表明需要优先检查手机到运动健康的 RPC 通道。仅凭这些日志不能认定 SDK 密钥错误。

文档 code=8 表示目标应用未安装或不支持 SDK；code=9 才是权限拒绝。项目实际使用的 device-rpc AAR 为 1.0.0.17。检查该 AAR 字节码后，还确认它可以在客户端直接返回 8：

1. 尚无运动健康服务 binder。
2. `Util.isVivoPhone()` 为 true，`Util.isVos()` 为 false。
3. `Settings.Global` 的 `com.vivo.health.watch.boundWatchDeviceCount` 小于等于 0（缺省或读取异常也按 0）。
4. `DeviceRpcManager.isStartBind()` 为 false。

满足上述条件时，SDK 跳过 `bindService`，最终返回 8。用户日志中多次同秒失败与此相符，但只有真机数据可以确认具体路径。运动健康版本不支持、服务被禁用或绑定服务失败也可能产生 8。

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

## 复测步骤

1. 在 GitHub Actions 手动运行 **Build signed APK**，使用 main 分支。工作流会编译 release APK。请使用新构建并确认 Diagnostics 出现本次 bridgeVersion。
2. 在 vivo 运动健康中确认手表已绑定、当前在线，再打开手表训练应用。系统蓝牙显示已配对，不足以证明运动健康已完成绑定。
3. 手机 App 点击连接，等待成功或失败后打开 Diagnostics，保留完整 `environment=`、`REGISTER probe code=`、`DEVICE_INFO code=` 和结尾 `diagnostics={...}`。
4. 按下表判断；不要通过修改系统绑定计数或强制 start_bind 绕过前置条件。

| 诊断字段或响应 | 排查方向 |
| --- | --- |
| vivo=true、vos=false、startBind=false、healthServiceConnected=false、boundWatchDeviceCount=0 | 符合 SDK 跳过服务绑定的条件。先在运动健康内核实设备绑定状态；若健康中明明在线但计数仍为 0，保留 SDK 日志检查健康应用/固件兼容性。 |
| boundWatchDeviceCount=-1 和 boundWatchReadError | App 读取系统计数失败；SDK 此处异常也按 0 处理，可能触发同一门槛。 |
| healthDeviceVersion < 2 | 文档要求能力版本 >=2，核实当前运动健康版本是否支持该能力。此值是功能能力版本，不是商店版本号。 |
| rpcServicePresent=false，或 enabled/exported=false | 运动健康 RPC 服务缺失、不可见或不可用，结合 rpcServiceReadError 检查。 |
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

新增前端回归已复现旧代码的设备层级、连接残留、错误残留问题，并验证修复。手机模式前端构建已通过。

全量前端测试结果：393 个文件通过、14 个文件失败；4941 项通过、4 项失败（另有 11 个套件加载失败）。失败涉及稀疏检出未包含的目录/fixtures、Windows 脚本语法，以及日期和示例训练数据断言；本次没有修改这些模块，不能将全量测试称为通过。

本地没有 Java/JAVA_HOME 或连接真机，Android 编译和实际互联尚未验证；请以 GitHub 原生构建及上述真机复测结果为准。

参考：
- SDK 接入与密钥申请：https://blueos.niceshare.site/api/connect/development-guidance/rpc-sdk-guidance/
- 手机 API 与错误码：https://blueos.niceshare.site/api/connect/mobile-side/
- 项目 `frontend/android/app/libs/device-rpc.aar` 的实际字节码。
