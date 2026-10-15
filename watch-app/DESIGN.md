# 手表联动方案（手机 ⇄ 手表，蓝牙直连）

> 交接文档。目标读者：接手这个功能的开发者。读完应该能直接开工，不需要重新调研。
> 现状：手表端骨架已写好（`watch-app/`），走的是**云端**路径；本文档描述的是要改成的**蓝牙**方案。

## 1. 目标

在 vivo 手表（蓝河系统）上做一个极简训练伴侣：

- 手机上打开今天的训练 → 自动推送到手表
- 训练中**抬腕点一下**就记一组（不用掏手机）
- 组间休息在手表上倒计时，**结束震动**
- 全程记录心率，训练结束估算热量
- 手表上的完成动作**立即回传到手机**，进 openGym 的训练记录

明确不做：手表上编辑计划、手表上看历史/图表、手表独立账号。手表只是手机的"手上终端"。

## 2. 为什么是蓝牙，不是云端

国内同类产品（练练健身、训记）的机制都是：**手机 App 推送计划 → 手表点完成 → 立即回传**，链路是蓝牙。原因很实际：

| | 蓝牙直连 | 云端中转 |
|---|---|---|
| 手表需要联网 | 不需要 | 需要（WiFi/eSIM，很多型号没有） |
| 延迟 | 毫秒级 | 秒级到分钟级 |
| 息屏后可靠性 | 系统级连接，稳 | 应用后台被挂起就断 |
| 数据落点 | 手机本地，直接进 openGym | 中转服务器 + CSV 导入 |

云端方案（`worker/`）保留但**降级为备选**：适合"只带手表没带手机"的场景，不再是主路径。

> 关于 vivo 官方的「设备互联能力」（BlueXlink）：手表侧有"穿戴业务 Kit"，手机侧要装 **vivo 运动健康**做桥。那是 vivo 自家生态的数据通道，第三方应用塞不进任意数据结构，所以不走它。

## 3. 架构

```
┌─────────────────────────┐                    ┌──────────────────────────┐
│  openGym 手机 App        │                    │  训练助手（手表 App）      │
│  (Capacitor + React)     │                    │  (BlueOS 蓝河)            │
│                          │                    │                          │
│  JS 层                   │                    │  页面层                   │
│   ├ 训练页（已有的休息条） │                    │   ├ Index（开始/继续）     │
│   └ watch-bridge.js  ◄───┼── 新增             │   └ Workout（完成一组）    │
│                          │                    │                          │
│  原生层（Java 插件）       │   BLE (GATT)       │  原生/框架层              │
│   └ WatchBlePlugin  ◄────┼═══════════════════►│   └ GattServer           │
│      · 扫描/连接          │   手机=中心设备      │      · 广播（可连接）      │
│      · 写"计划"特征值      │   手表=外围设备      │      · 接收计划（写）      │
│      · 订阅"完成"通知      │                    │      · 通知完成（notify）  │
└─────────────────────────┘                    └──────────────────────────┘
```

**角色分配的依据**：蓝河的 BLE API（`@blueos.bluetooth.ble`）**只完整实现了 `createGattServer()`**（外围设备/GATT 服务端）；中心设备（扫描、连接）的接口在文档里只列了名字没有实现说明。所以手表做外围设备、手机做中心设备——这刚好也是 Android 侧最成熟的方向（`BluetoothLeScanner` + `BluetoothGatt`）。

## 4. BLE 协议

### 4.1 广播

手表启动后开始广播，手机按服务 UUID 过滤扫描：

| 项 | 值 |
|---|---|
| Service UUID | `0000a100-0000-1000-8000-00805f9b34fb`（自定义，避开 SIG 保留段） |
| 广播内容 | `serviceUuids: [上面这个]`，`manufactureData` 放 4 字节设备标识（可选） |
| 广播参数 | `interval: 150`、`connectable: true`（txPower 文档范围 -127~1，草稿里的 60 超范围，不传用默认值） |

### 4.2 服务与特征值

一个主服务，三个特征值：

| 特征值 | UUID 后缀 | 属性 | 方向 | 用途 |
|---|---|---|---|---|
| 计划 | `...a101...` | write | 手机 → 手表 | 写入今天的训练（JSON） |
| 完成 | `...a102...` | notify | 手表 → 手机 | 每完成一组推一条（JSON） |
| 状态 | `...a103...` | read / write | 双向 | 握手、心跳、时间同步、会话结束 |

> 手表侧在 `addService` 时给出 `characteristics` 数组；写用 `subscribeCharacteristicWrite`，通知用 `notifyCharacteristicChanged`。手机侧写特征值用 `BluetoothGatt.writeCharacteristic`，订阅通知用 `setCharacteristicNotification` + `writeDescriptor(CCCD)`。

### 4.3 消息格式

统一用 **UTF-8 JSON**，单条不超过 512 字节（BLE 单包 MTU 限制，分片逻辑先不做，够用）。

**手机 → 手表：今天的计划**（写"计划"特征值）

```json
{
  "t": "plan",
  "v": 1,
  "sid": "20261015-背-1",
  "workout": "背",
  "exercises": [
    { "name": "反手高位下拉", "sets": 4, "reps": "12", "restSec": 60, "weight": "35" }
  ]
}
```

**手表 → 手机：完成一组**（notify"完成"特征值）

```json
{ "t": "set", "sid": "20261015-背-1", "ex": 0, "set": 1, "reps": "12", "weight": "35", "at": 1760000000000 }
```

`ex` 是动作在 `exercises` 数组里的下标（比传名字省字节且不怕改名）。

**手表 → 手机：会话结束**（notify"完成"特征值）

```json
{ "t": "end", "sid": "20261015-背-1", "minutes": 42, "avgHr": 128, "maxHr": 156, "calories": 312, "sets": 12 }
```

**双向：状态/握手**（读写"状态"特征值）

```json
{ "t": "hello", "v": 1, "battery": 68, "pending": 0 }   // 手表→手机，pending = 本地未回传的条数
{ "t": "ack", "upto": 1760000000000 }                  // 手机→手表，确认收到该时间戳之前的记录
```

**双向：实时同步**（2026-10 增补；rest/weight 走各自的特征值，任何一方改动，另一方立即跟上）

```json
{ "t": "rest",   "sid": "…", "leftSec": 42, "totalSec": 60, "seq": 3 }            // 休息调整（双向）
{ "t": "weight", "sid": "…", "ex": 0, "set": 2, "weight": "37.5" }               // 某组重量修改（双向）
{ "t": "plan",   "sid": "…", "v": 1, "workout": "背", "exercises": [ … ] }        // 计划变更重推（手机→手表，训练中途加/删动作后整包热替换）
```

`seq` 只在 `rest` 上递增（发送方维护），接收方忽略比自己记录小的序号，防止两端互相跟风造成回环。
`rest`/`weight` 是控制消息，**不进**手表的待发队列（发不出去就丢弃，重连后旧倒计时/旧重量回放反而错）。

### 4.4 时序

```
手表                              手机
 │ 开始广播                        │
 │                                │ 扫描到 → 连接 → 发现服务
 │ ◄──────────────────────────────│ 写"计划"特征值（今天的训练）
 │ 显示"背 · 5 个动作"             │
 │                                │
 │ 用户点"完成一组"                 │
 │ 本地落盘（防闪退）               │
 │ ──────────────────────────────►│ notify set → 手机立即写入 openGym
 │                                │
 │ … 重复 N 次 …                   │
 │ 用户点"结束训练"                 │
 │ ──────────────────────────────►│ notify end → 写时长/心率/热量
 │                                │
 │ 断连（离开范围）                 │
 │ 本地 pending 累积               │
 │ 重新连上                        │
 │ ──────────────────────────────►│ 重发 pending（幂等：手机按 sid+ex+set 去重）
```

**关键**：手表端**不假设手机一定在线**。所有事件先落本地，连上就发，发过的打标记，没发成功的下次连上重发（幂等去重由手机侧按 `sid+ex+set` 做）。

## 5. 手表端要做什么

> **2026-10-15 更新：本节已实现。** `src/lib/ble.js`（GATT 服务端 + 收发分片重组 + 待发队列）、
> 两个页面的 BLE 接入、manifest 蓝牙权限都已落地；收发消息统一为"UTF-8 JSON 以 `\n` 结尾"，
> 收发两个方向都按 20 字节分片/重组。剩余工作是第 6 节的手机端插件和真机联调。

现有代码在 `watch-app/`，已经实现的部分**可以直接复用**：

| 文件 | 现状 | 蓝牙方案要改的 |
|---|---|---|
| `src/lib/session.js` | ✅ 会话状态机 + 每次事件落盘 + 绝对时间戳休息 + 心率累计 + 待发送队列 | ✅ 已完成：补 `sid`/`profile` 字段，状态与落盘逻辑不动 |
| `src/lib/sensors.js` | ✅ 心率订阅 + 震动（连震三下） | 不动 |
| `src/Workout/index.ux` | ✅ 完成一组 / 倒计时 / 心率热量显示 / 恢复逻辑 | ✅ 已完成：完成/结束时 BLE 回传 + "未同步 N 条"提示 |
| `src/Index/index.ux` | ✅ 开始/继续 | ✅ 已完成：计划来源改为 BLE 收包，云端降为兜底；有"等待手机推送"状态 |
| `src/lib/ble.js` | ✅ **已新增**（GATT 服务端：广播、收计划、回传事件、分片重组、待发队列） | cloud.js 保留为备选 |
| `manifest.json` | ✅ 权限/路由 | ✅ 已完成：`blueos.permission.BLUETOOTH` + feature `blueos.bluetooth.ble` |

`src/lib/ble.js` 需要实现：

```js
import bluetooth from '@blueos.bluetooth.ble'

// 启动广播 + 建服务；收到"计划"写入 → 回调 onPlan(json)
export function startServer({ onPlan, onAck }) { ... }

// 回传一条完成事件（notify"完成"特征值）；失败就留着，下次连上重发
export function sendEvent(obj) { ... }
```

要点：
- `createGattServer()` → `addService(service)` → `startAdvertising(...)`，顺序不能反（先有服务再广播）
- 写回调里拼包：BLE 一次写入可能只有 20 字节（默认 MTU），**必须做分片重组**（按长度前缀或 `\n` 结尾判断一条 JSON 结束）——这是最容易踩的坑
- `subscribeConnectStateChange` 里判断连接状态，断连时把"已发送"标记清掉，重连后重发 pending

## 6. 手机端要做什么

openGym 是 Capacitor 应用，加一个原生插件（**照抄 `HealthConnectPlugin.java` 的结构**）：

**新增 `WatchBlePlugin.java`**（`frontend/android/app/src/main/java/ch/duartesantos/opengym/`）

| JS 方法 | 作用 |
|---|---|
| `isSupported()` | 蓝牙是否可用/已授权（`BLUETOOTH_SCAN`/`CONNECT`，Android 12+ 需运行时申请） |
| `startScan()` | 按服务 UUID 扫描，回调 `deviceFound` |
| `connect({id})` | 连接 + 发现服务 + 订阅"完成"通知 |
| `sendPlan({json})` | 写"计划"特征值（分片写） |
| `onEvent(cb)` | 收到手表 notify 时把 JSON 交给 JS |
| `disconnect()` | 断开 |

**Manifest 追加**：

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
```

**JS 桥接 `frontend/src/lib/watch-bridge.js`**（新增）：

- 训练开始时：把当前 routine 转成 `plan` 消息 → `sendPlan`
- 收到 `set` 事件：写进 openGym 的会话状态（走 `useStore` 里已有的"记录一组"路径，和手动点完成同一条代码）
- 收到 `end` 事件：结束时补上时长/心率/热量（openGym 的 workout 对象里有 `end`/`minutes`，热量可以进备注）

> 手机侧写数据**不要另开一套存储**：直接调 `useStore` 现有的 action（`logSet` 之类），这样手表记的和手点的完全等价，同步、撤销、编辑历史全都白送。

## 7. 关键约束（踩过的坑）

| 约束 | 说明 | 对策 |
|---|---|---|
| **没有屏幕常亮 API** | 蓝河的屏幕管理只有只读接口（`getScreenOffTime`/`getAodStatus`），没有 keep-screen-on | 靠结束震动 + 抬腕点亮；不要指望倒计时一直可见 |
| **心率传感器不在后台接口清单** | 蓝河后台运行只允许：音频/录音/网络上传/定位/BLE。心率订阅息屏后可能停采 | 训练中本来就频繁抬腕（每组点一次），采样密度够；热量是估算值 |
| **BLE 是后台许可接口** | `blueos.bluetooth.ble` 在后台可运行清单里 ✅ | 保持连接期间应用可后台存活，这对我们有利 |
| **手表应用会闪退** | 常态，不做假设 | 已有方案：每个事件落盘 + 启动恢复 + 绝对时间戳倒计时（见 `watch-app/README.md`） |
| **MTU 分片** | 默认 20 字节 | 写回调里按 `\n` 拼包重组 |
| **电量** | 持续心率 + BLE 连接 | 训练时才订阅心率、才保持连接；平时断开 |

## 8. 验收标准

按这个清单测，全过就算完成：

- [ ] 手机打开今天的训练，手表 3 秒内显示动作清单
- [ ] 手表点"完成一组"，手机上**立即**出现该组（不用刷新、不用等）
- [ ] 手表休息倒计时结束震动；此时手机锁屏、App 在后台，功能仍然正常
- [ ] 训练中手表**故意退出应用**（模拟闪退）再打开 → 位置、已完成组、倒计时全部接上
- [ ] 手表离开手机范围（比如手机放更衣室）继续记 → 走回范围后自动补齐，手机上的记录没有重复
- [ ] 心率与热量在手表和手机上都有值，且一致
- [ ] 整个训练过程手表耗电可接受（目标：1 小时训练 < 15%）

## 9. 任务拆分

| # | 任务 | 预估 | 依赖 |
|---|---|---|---|
| 1 | 手表端 `ble.js`（GATT 服务端 + 分片重组 + 重发） | 1.5 天 | 无 |
| 2 | 手表端页面接上 BLE（计划来源、未同步提示） | 0.5 天 | 1 |
| 3 | 手机端 `WatchBlePlugin.java`（扫描/连接/读写/订阅） | 2 天 | 无 |
| 4 | JS 桥接 `watch-bridge.js` + 写进 openGym 状态 | 1 天 | 3 |
| 5 | 真机联调（两端一起调协议、MTU、断连重连） | 2 天 | 1-4 |
| 6 | 文档/收尾（更新 README、录一段演示） | 0.5 天 | 全部 |

合计约 **7.5 人天**。任务 1 和 3 可以并行。

## 10. 环境与工具

**手表端**
- [BlueOS Studio](https://studio.blueos.com.cn/install)（官方 IDE，Windows/macOS）+ Node.js
- 打开 `watch-app/` 目录 → 装依赖 → 右侧模拟器跑界面逻辑
- 真机：构建 `rpk` → 调试包安装到手表（个人使用走调试安装；对外分发需在 vivo 开放平台签名）
- 机型要求：**跑蓝河系统的手表**（WATCH 3 / WATCH GT 等），手环不支持第三方应用
- API 文档：官方 <https://developers-watch.vivo.com.cn/>（离线镜像见 <https://github.com/Sein925/blueos-dev-skill>，173 篇已核对）；第三方整理 <https://blueos.niceshare.site/> 可交叉参考
- 工程结构（2026-10-15 已按官方规范修正）：`manifest.json` 必须在 `src/` 下，根目录必须有 `package.json` + `jsconfig.json`，否则 BlueOS Studio 不识别（提示"未打开蓝河应用项目"）

**手机端**
- Android SDK + JDK 21（本机已有：`C:/Android`、Temurin 21）
- 构建：`bash build-apk.sh`（仓库根目录，会做前端构建 → cap sync → Gradle → zipalign → 签名，输出 `openGym.apk`）
- 只改原生代码时：`cd frontend/android && ./gradlew assembleRelease --init-script ../../gradle-mirrors.init.gradle`
- 调试：`adb logcat | grep -i "WatchBle\|RestTimer"`；BLE 调试建议先用 nRF Connect 确认手表广播正常

## 11. 已知限制与风险

- **蓝河 BLE 文档不全**：只有 `createGattServer` 有完整说明，`createGattClientDevice` 等只在表格里列了名字。手表端只做服务端就避开了这个坑；如果以后需要手表主动连手机，要先去官方文档确认中心设备能力是否可用
- **系统杀后台**：蓝河的"后台运行"需要 manifest 声明 + 至少一个后台接口在跑（BLE 算），连接断开后应用可能被挂起——这是为什么所有数据必须先落盘
- **不同手表型号的 BLE 行为差异**：WATCH 3 与 GT 系列可能不同，联调阶段要在目标机型上验证
- **手机端权限**：Android 12+ 需要 `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` 运行时授权，Android 11 及以下走旧权限模型

## 12. 现有代码地图

```
watch-app/                          手表端（本方案的主体，已可运行）
  manifest.json                     路由/features/权限
  src/app.ux                        入口
  src/Index/index.ux          开始页（计划来源待改成 BLE）
  src/Workout/index.ux        训练页（完成一组/倒计时/心率）
  src/lib/session.js                ★ 防闪退核心：落盘 + 恢复 + 待发送队列
  src/lib/sensors.js                心率订阅 + 震动
  src/lib/cloud.js                  云端上传（保留为备选路径）
  README.md                         构建与安装说明

worker/                             云端中转（备选路径）
  src/index.js                      /config /session /export.csv /update
  test-local.mjs                    全链路本地测试（npm test）

frontend/android/app/src/main/java/ch/duartesantos/opengym/
  HealthConnectPlugin.java          ★ 原生插件范例，照它写 WatchBlePlugin
  RestTimerService.java             休息计时前台服务（悬浮窗也在这里扩展）
  RestAlertPlugin.java / RestAlert.java / RestAlertReceiver.java
  MainActivity.java                 插件注册处

frontend/src/lib/
  rest-alert.js                     休息提醒（原生闹钟 + 通知栏倒计时）
  update.js                         应用内更新检查（可走 Worker 代理）
```

## 13. 相关 API 速查（已核实）

```js
// 手表：BLE 服务端
import bluetooth from '@blueos.bluetooth.ble'      // feature: blueos.bluetooth.ble
// permission: blueos.permission.BLUETOOTH
const server = bluetooth.BLE.createGattServer()
server.startAdvertising({ interval: 150, connectable: true },   // txPower 范围 -127~1，勿传 60
                        { serviceUuids: ['0000a100-0000-1000-8000-00805f9b34fb'] })
server.addService({ serviceUuid, isPrimary: true, characteristics, includeServices: [] })
// 注意实际顺序：先 addService 再 startAdvertising（先有服务再广播）
server.notifyCharacteristicChanged(...)           // 回传完成事件
server.subscribeCharacteristicWrite({ callback })  // 接收计划
server.subscribeConnectStateChange({ callback })   // 连接状态

// 手表：心率（permission: watch.permission.READ_HEALTH_DATA）
import health from '@blueos.health.health'
health.subscribeSample({ dataType: health.DATA_TYPES.HEART_RATE, callback: (s) => s.value })
health.unsubscribeSample({ dataType: health.DATA_TYPES.HEART_RATE })

// 手表：震动
import vibrator from '@blueos.hardware.vibrator.vibrator'
vibrator.start({ priority: 1, duration: 400, interval: 200, count: 3 })  // 连震三下
vibrator.vibrate({ mode: 'short' })

// 手表：本地存储（同步读，异步写；delete 不叫 remove）
import storage from '@blueos.storage.storage'
const v = storage.getSync({ key: 'session_state' })
storage.set({ key, value, fail: (d, c) => {} })

// 手机：Android BLE 中心设备（原生 Java，插件里用）
BluetoothLeScanner.startScan(filters, settings, callback)
BluetoothDevice.connectGatt(ctx, false, gattCallback, TRANSPORT_LE)
gatt.discoverServices() → gatt.getService(uuid).getCharacteristic(uuid)
gatt.writeCharacteristic(c) / gatt.setCharacteristicNotification(c, true) + CCCD 描述符写入
```
