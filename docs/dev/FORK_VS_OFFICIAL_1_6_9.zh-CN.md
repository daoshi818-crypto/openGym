# 官方基线与定制版 1.6.9 功能对照

日期：2026-11-05。展示按「应用主要功能」和「我们基于官方所做拓展」两部分组织。

## 比较方法与版本
- 官方：DuarteSantos8/openGym 最新正式 Release `v1.4.4`（2026-11-03），固定 commit `5f5832db56080837b58342ff50f78631dcc63e07`，不是拿版本号大小比较产品优劣。
- 同日另核对官方 main `8fb98b16861a2728652302a7e6e30c50548493a0`：领先该 tag 11 个提交。涉及 README、网站、依赖/测试、API rate-limit/coach payload 等；本报告不声称已合入这 11 个提交，也不把它们算作我们新增。
- 定制版：本报告随手机 `1.6.9` / code `55`、BlueOS `0.6.15` / code `30` 的源码提交发布；确切 SHA 见 tag 和 Actions。API package 的 1.4.1 是独立包元信息，不用于手机检测更新。
- 原始依据：固定官方 README、`api/coach/prompts/ask.md`、`docs/WEAR_OS.md`、`frontend/ios/App/Watch/OpenGymWatchApp.swift`，以及本仓库对应源码。官方不是「没有手表/AI/中文/报表」；对外不得这样描述。

## 第一部分：应用主要功能（包含官方基础与适配功能）
| 功能 | 用户价值 | 本版入口/实现与归属 |
| --- | --- | --- |
| 训练计划与逐组记录 | 按周/轮换安排训练，记录重量、次数、努力程度，组间休息和历史回看 | Home、Workout；官方基础，保留本地定制 |
| 动作库与动作示范 | 搜索动作、肌群与器械，手机查看示范和文字要领 | 动作库、动作详情；官方基础 + 中文内容补充；不等于手表示范已上线 |
| 进步统计 | 训练容量、个人纪录、肌群目标和受支持动作力量等级 | Stats；部分官方 v1.4.4 选择性适配；不支持的动作不强行打分 |
| 周/月回顾、分享与报告 | 看阶段成果，生成分享图，系统打印保存 PDF | Reports、Recap、ShareCard；官方功能适配，非原创发明 |
| AI 教练 | 问答、训练复盘、计划生成和调整建议 | CoachChat；官方已有，普通对话可执行调整为本次拓展 |
| 数据自主与模块化 | 本地优先、离线训练、备份导入导出、可选自托管同步，按需开关功能 | 官方基础；模块/集成中心/动作合并/Webhooks 为官方选择性适配 |

Webhooks 不是「装 APK 就能自动发消息」：须更新 API、服务端显式启用、配置接收端且数据已同步。PDF 由系统打印对话框提供「另存为 PDF」，不是内置上传云端生成服务。

## 第二部分：我们基于官方功能所做拓展
| 主题 | 官方已有什么 | 我们实际扩展/修复了什么 | 源码证据 | 限制 |
| --- | --- | --- | --- | --- |
| vivo / BlueOS 手表 | Apple Watch 和 Wear OS；官方 Wear OS 明确仅文字与数字，Apple Watch 可选嵌入动画、表冠和选组等交互 | 另外实现 BlueOS `.ux` 工程、方/圆双包；以官方交互为参考适配动作切换、未完成组圆点、选字段后表冠调值、数字键盘、Last time 和统一结束确认 | `watch-app/src/{Workout,ExerciseList,Keypad,Summary}/index.ux`；`lib/value-step.js`、`lib/workout-interaction.js` | 不是移植官方 Swift/Kotlin 二进制；无手表动画，新 skip/hold 协议未启用 |
| 手机/手表可靠联动 | 官方已存在手机作为事实来源、同步与训练控制 | 保留本 fork 的 BlueX/DeviceRpc、outbox、业务 ACK、冲突/重放保护；本次修复 watch_start 持久化成功后手机导航训练页，取消编辑不写入、过期会话不落值、队列背压防误操作 | `frontend/src/lib/watch-commit.js`、`watch-start-flow.test.js`；`watch-app/src/lib/workout-interaction.js` | 新建会话只导航一次；未实现/验证 Android 后台强制拉起 |
| AI 普通对话到计划调整 | 官方 ask 提示词明确只是对话、不提出变更对象；复盘/改进计划已有结构化调整能力 | 普通对话返回 answer/clarify/proposal；统一服务端/BYOK/demo 校验合同；支持修订、白名单字段、精确动作范围、旧值检查；明确确认后改未来模板，不改本场和历史 | `api/coach/core/chat.js`、`api/coach/prompts/chat.md`、`frontend/src/views/CoachChat.jsx`、`lib/coach-chat-command.js`、`lib/coach.js` | 并非任意自然语言自动改库；服务端模式须部署匹配 API，旧服务端只读兼容 |
| 中文动作内容 | 官方已有中文界面和动作本地化资料 | 补充并校正简体中文名称和训练要领；此前发布记录为 5454 动作有中文要领，并保留待审冲突清单，不把未审项强行翻译 | `docs/dev/EXERCISE_NAMES_ZH_CN_REVIEW.md`、`docs/dev/RELEASE_1_6_6.zh-CN.md`、动作与要领生成资源 | 数量是此前内容快照；本次没有新增人工逐字医学/训练审校 |
| 手机更新与发布闭环 | 官方已提供 Android APK 和开源部署 | 本 fork 更新源指向自己的 Release；CDN + origin 元数据兜底、原生下载/校验再安装；本次固定提交、Linux 测试门禁、手机和两类 BlueOS 包同版发布，Release 成功才改 update.json | `frontend/src/lib/update.js`、Android Install plugin、`.github/workflows/build.yml` | 自动更新要网络可达、用户允许安装；签名/哈希不等于真机功能已验收 |

### 不单列为我们的原创拓展
每组备注、本周剩余训练数、上次对比、笔误提醒、模块预设、集成中心、动作合并、肌群目标、力量等级、回顾分享、PDF 和 Webhooks 的产品概念均来自官方或既有能力。本地工作是适配、兼容和扩展，并非从零发明。疲劳/力量功能官方同样存在；本仓库有自己的保留实现，不能用「官方没有」来宣传。

## 测试口径与宣传边界
- 本地前端 496 文件 / 6059 唯一用例是分批修复复测后的覆盖并集，不冒充一次全量全绿；发布门禁在 Linux 重新跑全量。
- Windows 6 个 POSIX 权限用例必须看此次 Linux 结果，不能删断言、skip 或说它们已经在 Windows 通过。
- 厂商方/圆原生 release 和布局检查通过不代表真机已验证。后台/锁屏/杀进程开练、外网投递、真实系统 PDF 保存与设备安装后完整流程仍需验收。
- 本次只发布 GitHub 安装包和源码，不自动部署任何生产 API 服务。

## 展示页编辑约束
1. 第一部分讲「这款应用能做什么」，第二部分才讲「我们的拓展」。
2. 官方适配功能不放到原创拓展清单，保留 upstream 与 AGPL-3.0 署名。
3. 手机截图来自本版本源码的演示环境，不是用户真实训练数据；手表如果使用 HTML 示意必须标注，不伪造真机截图。
4. 不宣传未上线的手表示范、任意AI自动改计划、后台强唤醒、全部语种已完整翻译。
