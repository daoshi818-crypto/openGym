# Watch 0.6.32：官方方屏 UI 移植审阅版与下行优化

本次修改得到用户最新指令授权，先前“只读性能审计”阶段已经结束。本文件记录实际代码与验证边界，**当前版本尚未满足“整套 UI 百分百复现”验收**，不可据此宣称闪退已解决或真机流畅度已达标。

目标为 vivo WATCH GT / BlueOS，390×450、用户提供的 BES2700IBP。修改位于 D:/gym/openGym；保留原有 api/coach/prompts/ask.md 和 frontend/ios/App/Podfile 修改。构建版本为 0.6.32 / code 47，仅支持方屏包。

## 固定官方来源

2026-11-19 再次请求 GitHub releases/latest，最终跳转仍为 [v1.4.5](https://github.com/DuarteSantos8/openGym/releases/tag/v1.4.5)。GitHub API 因匿名额度耗尽未取得结果，版本结论来自官方网页重定向。固定 tag commit 为 `2d70e026effc6602f513555166a97443520f0572`，不跟随未发布 main 分支。

来源均在 `frontend/android/wear/src/main/`：

| 官方文件 | 本地对应 | 已实现的范围 |
|---|---|---|
| java/ch/duartesantos/opengym/wear/ui/Screens.kt StartScreen / TodayCard / LogoMark | watch-app/src/Index/index.ux | 今日计划、动作/组数、计划行、胶囊开始、官方杠铃图形、空态 |
| Screens.kt SessionScreen / SetPanel / OverviewPage | watch-app/src/Workout/index.ux | 概览 / 当前组 / 统计 / 媒体四页；箭头、数值框、上次记录、当前动作边框 |
| Screens.kt RestView / UpNext / EffortChips | Workout/index.ux | 大倒计时、进度条、−15 / 跳过 / +15、下一组、RPE/RIR 官方四快捷项 |
| Screens.kt KeypadView | watch-app/src/Keypad/index.ux | 4×3 键盘、退格、取消箭头、确认图标；保留原子提交与目标校验 |
| Screens.kt MetricsPage / EffortPage / MusclesPage | Workout/index.ux；lib/official-metrics.js | 训练统计、最近四个已评分动作、真实肌肉加权组数；方屏左侧分段条 |
| ui/ZonesPage.kt；wear/WatchLogic.kt Metrics | Workout/index.ux；lib/official-metrics.js | 年龄合法性、Tanaka 最大心率估计、区间边界、真实区间时长、缺年龄空态 |
| Screens.kt SummaryScreen | watch-app/src/Summary/index.ux | 保存标志、计划、黄色时长、组数/容量、HR/热量、同步、完成按钮首秒保护 |
| ui/Components.kt Glyph / NumberBox / HoldToFinish / PrimaryButton；ui/Theme.kt | 各页样式、common/icons/wear-*.svg | 官方几何、颜色、圆角、按住结束 1 秒及进度内 ink 文字 |
| res/values-zh/strings.xml；手机 locales/zh.js | 各页中文；official-metrics.js 中文肌肉名 | 官方已有中文含义；平台专有错误/保留操作使用现有业务文案 |

上游是 **AGPL-3.0** 系列许可证；本项目保持现有 AGPL-3.0-or-later 许可证，不改成 MIT。移植文件中保留官方来源注释。`wear-undo-ink.svg` 是为保留本地撤销功能重着色的原有资源，不能称为官方新增图标。

颜色使用上游默认 Lime `#A3E635`、ink `#0C0E12`、Surface `#1C1C1E`、Surface2 `#2C2C2E`、Yellow `#FFD60A`、Red `#FF453A`、Orange `#FF9F0A`、Teal `#40C8E0`、Purple `#BF5AF2`。半透明灰在黑底上合成为 Label2 `#8D8D93`、Label3 `#4C4C4F`。

当前以 1 源码 dp/sp = 1.6 BlueOS design px 移植尺寸，48dp 触摸高度取整为 77px。**这个比例是移植选择，不是从真机屏幕密度测得的结果**。仍使用 BlueOS 系统中文字体，Android Compose 的字形、基线、动画、行距和动态尺寸尚未在同条件官方方屏截图上逐像素比对。

## 下行改造与证据

BlueOS 不提供 Wear OS Data Layer 的 DataItem / MessageClient，不能直接搬 Android 通道。保留手机端权威训练状态，使用现有协商式 v3 全量/delta 和持久分片协议：

1. 手机保存活动传输与最新排队快照；已开始传输的内容不因每秒时钟变化被反复取消。
2. 只有对端明确支持时才使用持久分片；旧端继续兼容原通路。本次没有重写 sender API 或协议格式。
3. 手表分片落盘成功后才 ACK；缓存仅保存最多两个任务的分片字节数、count、总字节数，不复制 payload。
4. begin/resume 从磁盘重建进度；终包逐片校验、整包 bytes/hash、JSON、sid/revision，再原子提交训练与 transfer marker。损坏片允许修复，重复合法片不重复提交业务。
5. commitRev 优先判断新旧；相同业务版本再比较已有 rev 快照时间戳。旧包持久记录 retained，既不覆盖训练，也不提升为 delta 基线。较高业务版本即使时间戳回退仍生效。
6. 已持久应用的下行通知在 Workout 隐藏时延后派生 UI，返回 onShow 再加载。旧命令仍执行实际业务，不吞指令。

主要代码为 `watch-app/src/lib/persistent-transfer.js`、`watch-app/src/lib/session.js`、`watch-app/src/Workout/index.ux`。

确定性 fake durable store 探针如下；比较口径均为收到 N 个 chunk 的阶段，不混入 begin 扫描：

| 分片数 | 改前 chunk 阶段读盘调用 N²+3N | 改后 chunk 阶段 3N | 改后包含 begin 的全过程 4N+1 |
|---:|---:|---:|---:|
| 5 | 40 | 15 | 21 |
| 17 | 340 | 51 | 69 |
| 65 | 4420 | 195 | 261 |

这些是调用量，不是实机时间、CPU 降幅或 FPS。仍需设备验证存储回调、蓝牙发送节奏及进程销毁后的恢复。

## 真实统计与交互修正

手机 watch-workout.js 统一为计划、快照、目录补充真实 muscles 权重和合法 birthYear；watch-link.js 的计划白名单同步透传。手表按已完成工作组加权计算肌肉组数，缺元数据时明确提示“该动作暂无肌群数据”，不再显示错误的“还没有组”。

心率维护 min 和有上限的 per-bpm 时长表（整数 30…220，最多 191 个桶）。时长按官方规则记在前一个样本，间隔限 0…30 秒，最后一个样本不外推；更改出生年份可重新分区。它不替代原有热量 sampledDurationMs 规则。表从升级后新采样开始，旧会话没有的最低心率/时长不能补造。图形曲线仍未移植，不拿直方累计伪装逐点曲线。

已修复隐藏页/结束表冠事件仍切 Metrics、暂停主按钮文案与行为不一致、跨动作下一组编号沿用旧动作组号、撤销图标对比度、按住结束填充内文字对比度，以及末组评分入口丢失。保留原有动作详情、精确评分、暂停、加减组、撤销、同步诊断和冲突处理入口；这些本地保留入口属于差异，不能包装成官方原页。

## 未完成的官方能力和视觉差异

| 项目 | 当前情况 | 不能宣称的结论 |
|---|---|---|
| count-in、weigh-in、timed HoldView、fix 保存、warmup/side/superset 状态 | 现有 BlueOS 业务模型未完整表达，上游状态机尚未完整移植；定时动作仍走现有记录路径 | 不能说所有官方状态已覆盖 |
| Pulse | 真实平均、最高、最低；没有完整 sparkline | 不能说完整复现心率页 |
| Media | 官方控件外形，当前禁用；未找到经验证的 BlueOS 系统媒体控制接口 | 不能说可控制播放，不能显示虚构歌曲 |
| 热量 | 保留既有估算；官方 Wear OS 使用 Health Services 条件展示 | 不能说等价于系统运动热量 |
| 原有扩展页面/确认 | 动作详情、精确评分、关闭冲突、诊断、全部完成保护保留现有业务并统一官方组件样式 | 不能说上游存在完全相同的页面 |
| 字体、密度、动画、滑动反馈、息屏 | 系统与渲染栈不同，缺官方同尺寸截图和真机逐状态比对 | 不能说像素/动效 100% 一致 |

若要达到用户要求的完整验收，必须继续补齐上游状态机和跨端协议映射，完成原生图形/媒体能力验证，再逐状态对照官方方屏界面。禁用按钮、空态和桌面预览均不算补齐。

## 验证方式与交付

测试命令：在 frontend 执行 `node node_modules/vitest/vitest.mjs run src/lib/watch --reporter=json --outputFile=<外部记录目录>/tests-final.json`。范围是 watch 匹配测试，不是全仓测试。包括持久分片落盘/重启/损坏修复/线性预算、相同业务版本乱序、时钟回退、HR 边界、肌群、隐藏页、暂停和跨动作。

手机执行 `npm run build` 验证新增数据映射的生产构建。手表执行 `watch-app/scripts/build-release.ps1`，通过本机 BlueOS pack 1.0.12-beta.13 编译和五页面产物校验。Tailwind 旧配置警告保留，不将其描述成零警告构建。

`preview-gt1.mjs` 从实际 .ux 产生 66 个中文场景；`capture-gt1.cjs` 通过 Edge 检查边界、字形裁切和控件重叠。预览使用保守 80px 圆角遮罩与桌面字体，**不是 BlueOS 模拟器或真机截图，也不是官方截图**。示例数据均是明确的测试夹具。

最终结果、日志、拼版、预览、SHA256 位于 `D:/gym/diagnostics/watch-official-wear-migration-20261119/`；安装包位于 `watch-app/releases/opengym-watch-0.6.32.rpk`。没有自动安装、发布或提交 Git。

本次最终检查结果：watch 范围 **616 项通过、0 失败**；66 个桌面预览场景、0 个布局检查错误；手机生产构建及手表五页面编译验证通过。RPK SHA256 为 `0976f675f4eb35b3a4345dc23e867b59b84305c77e4a7dc2993a3ff4c921df4c`。

肌肉元数据和出生年份需要同时使用本轮修改后的手机代码。只安装 RPK、手机仍使用未更新的旧 APK 时，这些字段仍可能缺失。已验证手机 web 生产构建，没有另行产出或安装手机 APK。

## 分阶段后续验收

1. **通信真机验收**：5/17/65 片、乱序、重复、断连、接收中杀进程、磁盘失败、断电重启、旧同版本包晚到；确认无丢组、无旧状态覆盖、训练可离线操作。记录每个阶段单调时钟及本地/业务 ACK，不用 SDK send success 代替业务提交。
2. **补齐官方状态**：count/weigh/hold/fix/warmup/side/superset 的持久状态、事件映射及全部转移；完成心率曲线和媒体 SDK 验证。保留原有功能，禁止靠占位空态通过。
3. **视觉逐状态验收**：同主题、同字体倍率、同数据、方屏截图逐一对照；核对四页导航、选中/禁用/离线/错误/长名/极值/完成态，再真机调密度与基线。
4. **稳定性专项**：按上一轮审计处理 legacy ACK/peerProtocol 屏障、依赖链增长及队列容量导致关闭失败等未完成 P0。本次下行工作没有解决它们。
5. **30 分钟实机测试**：冷启动/切页/按钮 p50/p95、HR 连续更新、倒计时与连续多组、200 次切页、断连重连与同步失败、0/10/20/30 分钟内存。没有原生帧率/堆指标工具时只报告视频逐帧响应和重启/异常日志；不编造 FPS/峰值 RAM。
