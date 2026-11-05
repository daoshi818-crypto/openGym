# 官方 openGym v1.4.4 选择性合入说明

日期：2026-11-04
执行仓库：`K:\gym\openGym`（fork `daoshi818-crypto/openGym`）
前序记录：`UPSTREAM_V1_4_3_REVIEW.zh-CN.md`、`UPSTREAM_V1_4_3_INTEGRATION.zh-CN.md`（v1.4.3 时的结论，本轮已重新核验，未沿用）

## 1. 比较区间与基线

| 项 | 值 |
|---|---|
| 官方仓库 | `https://github.com/DuarteSantos8/openGym.git` |
| 比较区间 | `v1.4.3..v1.4.4`（官方 tag，非 `main`） |
| v1.4.3 tag 对象 | `02634fd21285537cd6a1466716a77fcd260a6659` |
| v1.4.3 peeled commit | `7c8290ca20cb619bf6baa6830ea864d283df305a` |
| v1.4.4 tag 对象 | `6391ab6b37c8cb4c4627a369b58fdf7cba30fc8f` |
| v1.4.4 peeled commit | `5f5832db56080837b58342ff50f78631dcc63e07`（与任务书要求一致，已用 `git ls-remote` 核验） |
| 区间规模 | 1841 个文件，+132429 / −6185 |
| 本地执行前 HEAD | `88dbb955981745a24e975ae6c880bd43d032c71f`（`main`，与任务书记录一致，未 reset） |
| 本地执行后 HEAD | `88dbb955981745a24e975ae6c880bd43d032c71f`（未提交、未推送、暂存区为空） |

本地 fork 版本身份全部保留：`frontend/package.json` 1.6.7、`api/package.json` 1.4.1、`watch-app/package.json` 0.6.14、Android applicationId/签名/更新源未动。

## 2. 统计

| 口径 | 数量 |
|---|---|
| 官方 changelog 原始条目（`## v1.4.4` 段落内的独立条目 73 行，去掉 `**Fixes**` 标题与 `#788` 的续段） | 71 |
| changelog 未列但 tag diff 实际存在的变更（按目录/主题归并成组） | 14 组 |
| 拆分后账本行数（混合平台条目已拆开：C 行 72 + X 行 14） | 86 |
| 适配 | 4 |
| 本地已有 | 8 |
| 排除 | 31 |
| 不适配 | 43 |
| 合计 | 86 |

本轮实际改动 31 个文件（+858 / −21 行），新增 9 个文件，全部在前端/API/MCP 的非受保护路径内。

## 3. 本轮适配的四项（含调用链与旧数据兼容）

### 3.1 每组备注（changelog「A note on any set」，D-01）

- **本地现状（部分已有）**：`frontend/src/sheets.jsx` 的 `SetNote` 组件能写 `set.note`，`frontend/src/lib/notes-render.test.jsx` 有渲染测试；`finishedRow`（`lib/finish-workout.js`）不裁字段，所以组备注本来就随训练进历史。但**没有任何入口打开它**（`setNoteSheet` 只有测试引用，`openSetMenu` 无该行），**历史里不显示**，也**不进出 CSV / MCP / Coach**。
- **官方目标行为**：点组号 → Note；写入 `set.note`；历史中显示；CSV 有 `set_note` 列；MCP `get_workout` 的 `sets[].note`；Coach 载荷携带；备注长度受限。
- **缺失部分**：入口、展示、`set_note` 导出/导入、MCP 字段、Coach 字段。
- **调用链**：`views/Workout.jsx` 组菜单 → `sheets.jsx setNoteSheet` → `store.update` 写 `active.entries[i].sets[j].note` → `lib/finish-workout.js buildCompletedWorkout` → 历史 `workouts[].entries[].sets[].note` → `lib/export-csv.js` / `mcp/src/tools.js` / `api/coach/core/payload.js`。
- **改动**：
  - 新增 `frontend/src/lib/set-notes.js`：`SET_NOTE_MAX`（沿用本地 `history.js NOTE_MAX = 500`，不改成官方 140）、`setNoteOf`、`withSetNote`（控制字符扁平化、空白即删键、不就地修改）。
  - `sheets.jsx`：`SetNote.save` 统一走 `withSetNote`；历史详情（`WorkoutDetail`）在其动作的组行下显示 `Set N · 备注`。
  - `views/Workout.jsx`：组菜单新增 `Note`（第一位，携带当前备注为副标题）；组行下方显示可点的备注行。
  - `lib/export-csv.js`：新增末列 `set_note`（per-side 组只写在 L 行一次，cardio 行同样携带）。
  - `lib/import-csv.js`：识别 `set note`（`set_note` 归一化后同名）并写回该组行；单一 `Note` 列仍按老规则归为动作备注。
  - `mcp/src/tools.js`：`get_workout` 的每组附 `note`（缺失则无该键）。
  - `api/coach/core/payload.js`：`cleanSet` 携带 `note`（`NOTE_MAX` 截断）。
- **旧数据兼容**：字段早已存在且可选；无备注的旧组无新键；单 `Note` 列的旧文件行为不变；导出列追加在末尾，既有列序号不变。

### 3.2 本周剩余训练数（changelog「Workouts left this week」#753，D-02）

- **本地现状**：Home 有连续训练卡，用 `lib/queue.js weekTally` 显示「本周已练 / 计划」；无「还剩几次」；本地无 `S.weekTarget`、无「每周训练次数」设置。
- **官方目标行为**：固定周用同一 tally 倒数；轮换无自身周，按「每周训练次数」目标倒数，未设则不显示。
- **调用链**：`views/Home.jsx` → 新增 `lib/week-left.js workoutsLeft(S)` → `queue.js weekTally` / `rotation.js scheduleModeOf` / `format.js weekKey, weekStartOf`；设置项写入 `S.weekTarget`（1–7 或 off）。
- **改动**：新增 `frontend/src/lib/week-left.js`；`Home.jsx` 在连续卡下增加一行「本周还剩 X/Y」或「本周已经全部完成」；`Settings.jsx` 计划页新增「每周训练次数」(`SelectRow`，Off/1–7)。
- **旧数据兼容**：`weekTarget` 缺省为 undefined → `weekTargetOf` 返回 null → 不显示；新标量由 `sync-merge` 的通用 `edited` 机制自动逐字段合并，无需 schema 迁移；关闭（Off）即删除该键。
- **未做**：官方「widget snapshot 也带上它」——本地无原生 widget 实现（见 X-05），此项排除。

### 3.3 每组对比上次（changelog「Every set against last time」#907，D-03）

- **本地现状**：只有每次动作一条趋势（`lib/finish-compare.js` 在完成摘要列出 Up/Down/Same），没有逐组箭头、没有「和上次同一组」的配对规则、没有 e1RM 判定、没有该开关。
- **官方目标行为**：已完成组在组号上标 ↑/=/↓；工件顺序为重量→次数，冲突时用估算 1RM 定；辅助器械「少帮忙算进步」；静态保持按秒、有氧按分钟再按速度；历史中与「上一次训练」比较；读屏念出文字；设置可关。
- **调用链**：`views/Workout.jsx`（`ExerciseBlock`，已有 `last = lastEntryFor(sessionHistory(S), …)`）→ 新 `lib/set-trend.js setTrendsFor` → 渲染为组号上的 `.trendmark`，并把同一句话并入组号按钮的 `aria-label`；历史侧 `lastTimeBefore(S, w, entry)`。
- **改动**：新增 `frontend/src/lib/set-trend.js`（`setTrend`、`setTrendsFor`、`lastTimeBefore`、`trendGlyph`、`trendLabel`、`setTrendOn`）；`Workout.jsx` 计算并对齐到 `entry.sets` 渲染箭头与读屏文字；`index.css` 增加 `.trendmark` 样式（浅色/深色可读、已完成行可见）；`Settings.jsx` 工作页新增「对比每组与上次」开关（`S.setTrend`，默认开）。
- **旧数据兼容**：纯函数、不落库；没有上次/没有完成/热身/无对手组 → 不显示；历史比较只取「该训练之前」的记录（`workoutAt` 过滤），绝不与更晚的训练比较；开关关闭时不留视觉也不留 ARIA 文本。
- **明确沿用**：历史匹配规则仍是本地 `lastEntryFor`（同 routine 优先），未替换。

### 3.4 疑似笔误确认（changelog「"Is that right?" before a likely typo」#811，D-04）

- **本地现状**：打勾即写 `done` 与 `at`，没有任何超常值确认；该值会成为「上次数据」「下次目标」与可能的 PR。
- **官方目标行为**：手打勾时，若重量超历史最好两倍且差 ≥10 kg/20 lb，或次数超两倍且差 ≥10；或低于上次同组三分之一（重量差 ≥10、次数差 ≥5），先问一次；「Fix it」保留未勾，「Log as typed」照记；只对手动勾选：取消勾选、计时组自动完成、手表打勾、首次、辅助器械重量都不问。
- **调用链**：`views/Workout.jsx toggle()`（唯一打勾入口）→ 新 `lib/typo-check.js oddValues`（配合 `bestsFor` / `lastRowFor`）→ `sheets.jsx confirmSheet`（`Fix it` / `Log as typed`）→ 选择「Log as typed」后带 `typedOk` 重入 `toggle`。
- **改动**：新增 `frontend/src/lib/typo-check.js`；`Workout.jsx` 增加守卫与 `typoOdds` 读取（历史用 `sessionHistory`，与"上次"同一口径），手表事件走 `{ fromWatch: true }` 永不提问。
- **旧数据兼容**：无历史即无比较（首次不提问）；取消勾选不问；`quiet`（计时组自完成）不问；辅助器械重量不问；历史编辑（`editing`）不问。

## 4. 变更账本

状态取值：`适配` / `本地已有` / `排除` / `不适配`。`排除` 后括号注明排除类别（iOS、Wear OS、其他穿戴平台、受保护资源、部署/商店身份、依赖）。

| ID | 官方条目 | 官方改动路径/符号 | 本地实现/测试证据 | 状态 | 变更路径 | 验证命令/结果 | 未做原因/风险 |
|---|---|---|---|---|---|---|---|
| C-01 | **Modules: as much app as you want** | 新增 `src/lib/modules.js`、`modules-copy.js`、`views/Modules.jsx`；Home/Stats/Settings/搜索按模块隐藏；通知/健康/手表/webhook/Coach 暂停 | 未找到：本地无 `modules*.js`、无模块设置页 | 不适配 | 无 | — | 本地六类副作用各自受既有契约管辖（`lib/watch-link.js` 属受保护同步契约、`lib/health-sync.js`、Coach consent v2）。要做必须在这几处引入统一 gating 与旧 profile 「全部维持启用」迁移；只做导航隐藏会直接违反「关闭必须暂停副作用」的验收要求。需单独立项设计暂停语义 |
| C-02 | **Integrations, all in one place** | 新增 `views/Integrations.jsx`、`lib/integrations.js`、卡片「works with」文案 | 未找到；本地导出/导入入口分散在 Settings「数据与备份」 | 不适配 | 无 | — | 依赖 C-01 的模块框架；单独复制会造出与模块开关脱节的第二套入口 |
| C-03 | **Webhooks**（`INTEGRATIONS=webhook`） | 新增 `api/integrations/*`、`api/net-guard.js`、`docs/INTEGRATIONS.md`；HMAC、幂等、~1h 重试、`INTEGRATIONS_ALLOW_LAN=1` | 本地 `api/` 无出站 webhook 子系统；`api/net-guard.js` 默认拒绝私网是既有安全约束 | 不适配 | 无 | — | 唯一合法路径是新增「受限 opt-in 出站」通道，而任务书明确「不得为了 LAN 目标放行而削弱默认防护」。该通道需要出站执行器、签名密钥存储、幂等投递账本与 DNS rebinding 二次校验的整体评审，属独立安全任务（遗留 R-01） |
| C-04 | **On its way to F-Droid**（无 GMS 变体、应用内扫码、About 说明） | `frontend/android` flavors、`scripts/android/*`、Barcode 依赖替换 | 本地 `lib/apk-variant.js` 仅识别既有变体；无 flavor | 不适配 | 无 | — | 新 flavor 会改动 `android/app/build.gradle` 的签名/applicationId/更新源体系（第 7 节禁止项），且需替换 MLKit 扫码为应用内实现（新增原生依赖） |
| C-05 | **openGym on Amazfit (Zepp OS)** | 新增 `watch-zepp/**`、`views/ZeppSettings.jsx`、`api/watch-relay.js`、`docs/ZEPP_OS.md` | 本地无 Zepp 工程 | 排除（其他穿戴平台） | 无 | — | 本轮不扩展新平台；BlueOS 现有 DeviceRpc/outbox 协议不得改写 |
| C-06 | **A fresh coat of paint**（整站视觉/排版/Stats 四段/库筛选/结束页整合） | `index.css` 大改、`components/CardHead.jsx`、`StatBars.jsx`、`EmptyState.jsx`、`Stats.jsx` 分节 | 本地 `index.css`、`views/Stats.jsx`、`sheets.jsx` 有自己的布局与 IA | 不适配 | 仅取「组对比箭头用抬起小片」一格（并入 D-03 的 `.trendmark`） | D-03 测试通过 | 任务书禁止「顺手做全站重设计」；官方版是成套设计系统替换（rem 类型标尺、表面层级、强调色可读色、按压手感），与本地桌面/窄屏布局直接冲突 |
| C-07 | **openGym on Garmin (Connect IQ)** | 新增 `frontend/garmin/**`、`docs/GARMIN.md` | 本地无 Garmin 工程 | 排除（其他穿戴平台） | 无 | 本地 `lib/fit-export.js` 的 .fit 导出保留不动 | 同上 |
| C-08 | **Every set against last time** (#907) | 新增 `src/lib/set-trend.js`、`sheets.set-trend.test.jsx`、`Workout.set-trend.test.jsx` | 本地仅有每次动作级 `lib/finish-compare.js`；逐组无实现 | 适配 | `frontend/src/lib/set-trend.js`（新）、`frontend/src/lib/set-trend.test.js`（新）、`views/Workout.jsx`、`views/Settings.jsx`、`index.css`、`views/Workout.test.jsx` | `npx vitest run src/lib/set-trend.test.js` 10/10；`src/views/Workout.test.jsx` 228/228 | 历史侧箭头未接入历史详情（仅工作台），见 R-02 |
| C-09 | **Workouts left this week** (#753) | 新增 `src/lib/week-left.js`、`Home.week-left.test.jsx`；`S.weekTarget` 设置 | 本地 `queue.js weekTally` 已有同源分数，无倒数 | 适配 | `frontend/src/lib/week-left.js`（新）、`frontend/src/lib/week-left.test.js`（新）、`views/Home.jsx`、`views/Settings.jsx`、`views/Home.queue.test.jsx` | `npx vitest run src/lib/week-left.test.js` 7/7；`src/views/Home.queue.test.jsx` 通过 | widget 快照部分排除（无原生 widget） |
| C-10 | **Spoken cues**（语音提示） | 新增 `lib/speech.js`、`voice.js`、`spoken-cues.js`、`views/VoiceShortcuts.jsx` | 未找到：本地无语音适配层 | 不适配 | 无 | — | 语音只在真机可验（任务要求"不宣称设备验证通过"）；且触发点必须插在 `useUI` 计时器与 `lib/watch-link.js` 的 rest deadline 推送之间，属受保护同步路径。本轮无设备验证手段，无法完成闭环 |
| C-11 | **Merge two exercises into one** (#656) | 新增 `lib/exercise-merge.js`、`views/ExerciseMerge`、`api/sync-stamps` 迁移、MCP 读取 | 未找到；本地无合并入口 | 不适配 | 无 | — | 合并要迁移 history/routines/PR/别名/收藏/器械/视频并隐藏被合并动作，而 `catalogue/**`、`exercise-names/**` 与别名体系属受保护资源；隐藏动作还会改变本地 catalogue 语义。需独立设计幂等迁移与 Undo |
| C-12 | **A note on any set** | 新增 `lib/set-notes.js`、`sheets.set-note.test`、CSV `set_note`、MCP `sets[].note`、Coach `cleanSet` | 本地有编辑器（`sheets.jsx SetNote`）与渲染测试，但无入口/展示/导出 | 适配（部分已有，补缺失） | `frontend/src/lib/set-notes.js`（新）+ 测试 2 个、`sheets.jsx`、`views/Workout.jsx`、`lib/export-csv.js`、`lib/import-csv.js`、`mcp/src/tools.js`、`api/coach/core/payload.js` | `set-notes` 6/6、`set-notes-csv` 5/5、`export-csv` 21/21、`import-csv` 16/16、API `payload*.test.js` 47/47 | 备注上限沿用本地 500（非官方 140）；MCP 套件未执行（见 5.3） |
| C-13 | **Weekly sets per muscle, against a target range** | 新增 `lib/muscle-targets.js`、`components/WeeklySets.jsx`、`Stats` 卡、Settings 子页、Home 一行 | 未找到；本地有自有肌肉映射与疲劳口径（`lib/muscles.js`、`lib/recovery.js`、`docs/dev/FATIGUE_SETS_MODEL.md`） | 不适配 | 无 | — | 官方口径「主肌群计满、协同肌不足一半、热身不计」依赖其 muscle map/fatigue 权重；本地模型与统计口径不同，直接移植会与 `Stats.jsx` 既有周容量/恢复数字互相矛盾。需先统一口径再实现 |
| C-14 | **Strength level per lift** | 新增 `lib/strength-level.js`、`components/StrengthLevel.jsx`、`lib/strength-exercises.js` 标准表、性别/出生年 | 未找到；本地无 sex/birthYear 资料字段 | 不适配 | 无 | — | 需新增 profile 字段（schema+同步迁移）与第三方力量标准数据表；缺资料时官方选择"隐藏"，本地则无该资料维度可依 |
| C-15 | **Your week, your month**（回顾卡/分享图/PDF） | 新增 `lib/recap.js`、`recap-card.js`、`components/Recap.jsx`、`share-image.js` | 未找到；本地只有 CSV 导出（`lib/export-csv.js`） | 不适配 | 无 | — | 需要卡片渲染、图片分享与 PDF 报告三层新基础设施，且分享图涉及隐私字段取舍评审 |
| C-16 | **openGym on Wear OS (beta)** | 新增 `frontend/android/wear/**`、`WatchBridgePlugin/Listener`、Tile、Complication、`docs/WEAR_OS.md` | 本地无 Wear 工程 | 排除（Wear OS，仅保留专题文档） | 无 | — | 按任务书：本轮只维护 `WEAR_OS方案与操作说明.zh-CN.md`，不新增 Wear 工程/依赖/Tile/complication；不得接 GMS Data Layer 到 BlueOS |
| C-17 | **Warm-ups that build themselves** (#156) | 新增 `lib/warmup-ramp.js`、`WarmupConfig.jsx`、`session-start.warmups.test.js` | 本地已有深度定制热身：`lib/history.js buildSets/rerampWarmups/MAX_PLANNED_WARMUPS`、`warmupRestSecFor`、`WarmupConfig` 类设置 | 不适配 | 无 | — | 自动 ramp 改变训练处方语义（progression 属受保护），且要与 6 种 set 类型、器械库存向下取整、单侧/器械台交互；本地热身语义已有回归基线，替换风险高于收益 |
| C-18 | **Your own warm-ups, kept** (#525) | `lib/routines.js` 热身行、`session-start` 「Your last session」携带 | 同上，本地无「My own」热身行模型 | 不适配 | 无 | — | 依赖 C-17 的热身模型与 routine 优先级；单独引入会造出两套热身语义 |
| C-19 | **Ask the Coach mid-workout** | 新增 `components/WorkoutCoachSheet.jsx`、Coach 提议类型（swap/sets/reps/weight/add/skip/rest） | 本地 Coach 有 consent v2、decision ID、outbox、撤销封印（受保护） | 不适配 | 无 | — | 新提议类型必须嵌入上述受保护机制（幂等、撤销封印、安全裁剪）并覆盖"只改未完成部分"的不变量，属 Coach 核心改造，需独立设计与回归 |
| C-20 | **The Coach does more**（warm-ups、programmes、恢复/周组数上下文） | `api/coach/core/*`、`lib/coach-insights.js` | 本地 `lib/coach-*.js` 已有自有上下文与安全裁剪 | 不适配 | 无 | — | 依赖 C-17/C-18/C-31 的能力与数据；本地 Coach 上下文为 fork 定制 |
| C-21 | **Film a set (form videos)** | 新增 `lib/set-videos.js`、`components/SetVideo.jsx`、媒体上限扩展 | 本地 `lib/media-*` 管理训练照片/GIF，无视频通道 | 不适配 | 无 | — | 视频会改变媒体配额、同步与删除级联语义，且必须证明"永不进 Coach/MCP/分享/PDF"；无设备验证手段（录制/回放只在真机可验） |
| C-22 | **Each gym keeps its own equipment** (#808) | 新增 `lib/gym-inventory.js`、`gym-auto.js`、`gym-places.js`、`components/GymMap.jsx` | 本地 `lib/equipment.js` 有 equipProfiles，但杠片/哑铃库存是全局 `S.plates/S.dbLoad`（`sync-merge` 的 stamped map） | 不适配 | 无 | — | 把库存搬到 profile 属数据迁移，且 `plates/dbLoad` 的逐键时间戳合并是受保护同步语义；自动切换依赖原生定位权限 |
| C-23 | **Christmas, with an advent calendar** | 新增 `seasonal/christmas*`、`advent.js`、节日图标 | 本地有季节主题框架 `lib/seasonal.js`、`components/Seasonal.jsx`（万圣节） | 不适配 | 无 | — | 新增节日主题需大批量资源（图标/插画）与 24 门日历 + 跨设备同步；任务书禁止"大批量资源生成" |
| C-24 | **Weigh in as often as you like, with the time** (#859) | 新增 `lib/weigh-ins.js`、`sheets.weighin-times.test.jsx`、CSV/健康/图表改造 | 本地 `S.bodyweight` 为每天一条 `{d,w}`，`sync-merge` 按天合并 | 不适配 | 无 | — | 一天多条会改写 `sync-merge` 的 bodyweight 天级合并与 `resetIds` 语义（受保护），且旧客户端同步需保证不丢记录。需要 schema 迁移 + 旧 schema fixture 后才可做 |
| C-25 | **Monthly challenges** | 新增 `lib/challenges.js`、`challenge-copy.js`、`components/Challenges.jsx` | 未找到；本地无 badge 体系 | 不适配 | 无 | — | 需新计算引擎 + badge 持久化 + 同步 + widget 展示，属独立功能域 |
| C-26 | **A kind word about recovery on Home** | 新增 `lib/recovery-hint.js`、`components/RecoveryHint.jsx` | 本地 `lib/recovery-view.js` 已有恢复阶段口径（`docs/dev/FATIGUE_SETS_MODEL.md`） | 不适配 | 无 | — | 官方提示文案依赖其 muscle map 口径；本地恢复阶段划分不同，直接移植会与本地疲劳数字不一致 |
| C-27 | **Your year in openGym (Wrapped)** | 新增 `lib/wrapped*.js`、`components/Wrapped*`、`api/wrapped.js`、`docs` | 未找到 | 不适配 | 无 | — | 故事流 + 分享图 + 通知 + 隐私取舍，同 C-15 的基础设施缺口 |
| C-28 | **Share a workout as a picture** | 新增 `lib/share-image.js`、`components/ShareCard.jsx` | 未找到；本地有"复制为文本"（`lib/workout-text.js`） | 不适配 | 无 | — | 同 C-15 |
| C-29 | **Widgets you set up yourself（Android/iOS widget）** | `frontend/android` AppWidget、`frontend/ios` WidgetKit、`lib/widget-links.js` | 本地无原生 widget | 排除（原生 widget 未在 fork 实现；iOS 部分排除） | 无 | — | 需 Android AppWidget + 原生配置 Activity；iOS 部分一律排除 |
| C-30 | **Streak with backup（freeze、badges）** | `lib/streak.js`、`components/Streak.jsx` | 本地 `lib/history.js streakWeeks` 为纯连续周数 | 不适配 | 无 | — | 冻结/徽章会改变"连续周"的历史解释与既有 `streakWeeks` 语义（多处 UI 与统计依赖） |
| C-31 | **Share a routine with a friend** | 新增 `lib/routine-link.js`、`components/RoutineShare.jsx`、网站落地页 | 本地 `lib/plan-share.js`（bundle 编码/解析/打印）+ `sheets.share` 入口、`plan-share.test.js` | 本地已有 | 无 | — | 差异：官方新增"链接落地页 + Add to my routines"网页端流程；本轮不引入 website 落地页 |
| C-32 | **Watch on YouTube, for every exercise** | 新增 `lib/youtube.js`、`components/YouTubeVideo.jsx` | 未找到 | 不适配 | 无 | — | 内嵌播放需自托管 CSP 增加 `frame-src youtube-nocookie.com`，本地 `web/nginx.conf.template` 的 CSP 属部署配置，改动需部署侧同步生效 |
| C-33 | **Tidier menus** | `lib/menu-items.js`、菜单重排、`sheets.workout-options` 收拢 | 本地菜单已是分组结构（`menuSheet` + `sections`），`Workout.test.jsx`「groups the set menu…」断言既有分组 | 本地已有 | D-01 在组菜单首位加入 `Note`（与官方"note 优先"一致） | `src/views/Workout.test.jsx` 228/228 | 官方项顺序（swap/rest/history 提前）未调整：本地菜单项由 fork 决定 |
| C-34 | **Timed holds that run themselves** | 新增 `lib/auto-holds.js`、`store/useUI.auto-holds.test.js`、锁屏/手表联动 | 本地有计时组与 `useUI` work 状态，无自动连发 | 不适配 | 无 | — | 自动连发跨越 rest 计时、通知与 BlueOS 手表 rest/version 推送（受保护契约），需双端时序回归 |
| C-35 | **A 1-minute tour, and four tutorials** | 新增 `lib/tour.js`、`components/Tour.jsx`、沙盒练习会话 | 未找到 | 不适配 | 无 | — | 需沙盒会话（不得写库/同步）+ 大量新文案 + 无障碍/减少动态适配；属独立引导系统 |
| C-36 | **Pictures on the printed plan** (#817) | 新增 `lib/print-pictures.js`、`components/PrintPlanSheet.jsx` | 本地已有打印：`lib/plan-share.js printPlan/planPrintHTML`、`RoutineEdit.print.test.jsx` | 本地已有 | 无 | `RoutineEdit.print.test.jsx` 通过（既有） | 差异：官方新增"带图片"选项与记忆开关 |
| C-37 | **Programmes** (#159/#679) | 新增 `lib/programmes.js`、`views/Programmes.jsx`、`api` 同步、MCP `get_programme` | 本地计划模型是固定周 `S.week` + 轮换队列 `S.queue/rotation`（`lib/rotation.js`） | 不适配 | 无 | — | 新实体要"接管计划"，与本地 rotation/queue 语义冲突（Home 的"Week 2 of 6"、progression 覆盖规则都要重定义），且需迁移与手表语义设计 |
| C-38 | **kg and lb in the same gym** (#657) | 新增 `lib/ex-unit.js`、按动作单位贯穿读数/记录/图表/手表/计划 | 本地单位是全局 `S.unit`，`sync-merge` 有 `convertStateUnit` 规则（受保护） | 不适配 | 无 | — | 每动作单位会重写单位换算与合并规则、以及 volume/PR/历史/图表/手表/共享计划的解析，属跨系统语义改造 |
| C-39 | **Your own app icon on Android too** | `frontend/android` 图标资源、`components/Icon` 选择器 | 本地有应用图标与签名身份（受保护） | 排除（Android 原生资源 + 发布身份） | 无 | — | 图标切换需原生 Activity 别名与资源变体，触及包身份/发布配置 |
| C-40 | **Back to the top, fast** | 新增 `lib/scroll-top.js`、`components/ScrollTopButton.jsx`、`App.scroll-top.test.jsx` | 本地有 `App.scroll.test.jsx`，但无"重点当前 Tab 回顶/再点进搜索"行为 | 不适配 | 无 | — | 需要对本地 `TabBar`/各视图滚动容器逐页接线，并与 `WorkoutScrollAnchor` 的锚定逻辑协调；属交互微调，本轮未纳入（R-03） |
| C-41 | **Adding your gym works like a maps app** (#614) | 新增 `lib/gym-places.js`、`components/GymMap.jsx`、原生定位 | 未找到 | 不适配 | 无 | — | 需地图/地点搜索服务与原生定位权限；iOS 部分（Apple Maps）一律排除 |
| C-42 | **AI Coach works with picky OpenAI-compatible gateways** (#804) | 新增 `lib/coach-adapt.js`、`api/coach/core/adapters` 退化重试与记忆 | 本地已有：`api/coach/core/adapters/openai.js`、`compatible.js` 使用 `max_completion_tokens` 与退化重试；`frontend/src/lib/coach-local.test.js` 覆盖 | 本地已有 | 无 | `node --test test/adapters*.test.js` 通过（既有） | 差异：官方"按 endpoint+model 记住成功形态"的持久记忆未逐字对齐 |
| C-43 | **"Is that right?" before a likely typo** (#811) | 新增 `lib/typo-check.js`、`views/Workout.typo.test.jsx` | 未找到 | 适配 | `frontend/src/lib/typo-check.js`（新）、`frontend/src/lib/typo-check.test.js`（新）、`views/Workout.jsx`、`views/Workout.test.jsx` | `npx vitest run src/lib/typo-check.test.js` 8/8；Workout 228/228 | 阈值与官方一致；文案为本地新增（18 语言已补键） |
| C-44 | **Dates pick like the rest of openGym** (#809) | 新增 `components/DateField.jsx`（跨平台自绘日期字段） | 未找到 | 排除（iOS 专属问题的修复：iOS 27 日期字段溢出） | 无 | — | 官方动机是 iOS 27 的 sheet 横向滚动缺陷；非 iOS 部分的自绘字段属 UI 重做 |
| C-45 | **The installed iPhone web app fills the screen** (#810) | iOS WebKit 视口补丁 | — | 排除（iOS） | 无 | — | 仅 iOS/WebKit |
| C-46 | **Tap the picture in a past workout for the how-to** (#805) | `WorkoutDetail` 缩略图点击改为动作说明 | 本地 `WorkoutDetail.entryRow` 整行（含缩略图）打开动作历史：`sheets.jsx` | 不适配 | 无 | — | 与本地既有交互冲突：整行点击进历史是 fork 的既定入口，拆出缩略图会分裂点击语义 |
| C-47 | **Discarded means discarded, in Apple Health** (#776) | HealthKit 删除联动、手表撤稿 | — | 排除（iOS/Apple Watch） | 无 | — | 仅 HealthKit |
| C-48 | **Server dependencies patched** (#806) | `api/package.json`、`mcp/package.json` 升级 body-parser/fast-uri/qs/zod | 本地 `api` 仅 2 个直接依赖，版本由 fork 维护 | 排除（依赖升级） | 无 | — | 任务书禁止依赖大版本/锁文件变更；安全补丁应由 fork 自行安排 |
| C-49 | **How long each exercise takes** (#812) | 新增 `lib/exercise-time.js`、`Stats.exercise-time.test.jsx`、历史计时 | 本地每组有 `at`（打勾时刻），但该字段同时被 `finish-workout` 会话结束推算与手表事件（`watch-events.js` 写 `at`）使用 | 不适配 | 无 | — | `at` 是跨（手机打勾/手表事件/完成推算）复用的时间戳，直接当"组用时"会与手表事件时间混淆；需新增来源字段并改手表协议容忍度（受保护） |
| C-50 | **Pull-ups count your body weight** (#794) | 新增 `lib/bw-load.js`、单位设置开关 | 本地已有 `lib/bodyweight.js`、`relative-strength.js`（相对体重强度）与 `workoutVolume/sessionVolume/lifetimeVolume` | 不适配 | 无 | — | 改 `workoutVolume` 会改变历史总量、累计容量、导入体积与手表/统计口径；本地已有相对体重口径，需先统一"体积是否含体重"的定义 |
| C-51 | **Every exercise under the muscle it's known for** (#788) | `catalogue/exercises` 668 项主肌群改动、`catalogue/i18n` 2 项 | 本地 `catalogue/**`、`frontend/src/exercise-names/**` 为受保护资源（含中文优化） | 排除（受保护资源） | 无 | — | 会改写动作主肌群并连带改变本地恢复/疲劳数字；任务书禁止覆盖 catalogue 与批量资源生成 |
| C-52 | **"Your last session" brings your warm-ups too** (#525/#658) | `lib/session-start.js`、「Your last session」携带自设热身 | 本地 `session-start.js` 有「Your last session」与 `carried` 标记（`Workout.jsx planLine`） | 不适配 | 无 | — | 依赖 C-17/C-18 的热身模型（本地无"自设热身行"） |
| C-53 | **YouTube demos play right in the app** (#613) | 内嵌 `youtube-nocookie` 播放卡与 CSP 说明 | 未找到 | 不适配 | 无 | — | 同 C-32 的 CSP 约束 |
| C-54 | **Swap suggestions** (#674) | 新增 `lib/exercise-substitutes.js`、`sheets.swap` 建议区、gym 过滤 | 本地已有同肌群替换：`lib/similar-exercises.js sameMuscleFirst`、`sheets.swap-same-muscle.test.jsx` | 本地已有 | 无 | `sheets.swap-same-muscle.test.jsx` 通过（既有） | 差异：官方的"按器械/动作模式排序 + 每次替换的 gym 过滤"未实现 |
| C-55 | **AirPods Pro 3 heart rate (iPhone)** | iOS 会话与 HealthKit | — | 排除（iOS/HealthKit） | 无 | — | 仅 iOS |
| C-56 | **Tap your phone on a sticker (NFC)** | 新增 `lib/nfc.js`、`nfc-tags.js`、`components/Nfc.jsx`、原生 NFC 插件 | 本地 Android 工程无 NFC 插件（Capacitor 原生依赖） | 不适配 | 无 | — | 需新增原生依赖与权限，并写 NTAG 标签；属原生能力扩展，与"不扩展依赖"约束冲突 |
| C-57 | **Hey Siri, log my weight (iOS)** | iOS Intents/Shortcuts、Siri 文案 | — | 排除（iOS） | 无 | — | 仅 iOS |
| C-58 | **Android 长按图标快捷方式（Siri 条目内）** | `android/app/src/main/res/xml/shortcuts.xml` | 未找到 | 排除（Android 原生资源） | 无 | — | 原生资源与清单变更 |
| C-59 | **Exercise names in PT-PT and Swedish** | 新增 `exercise-names/pt.js`、`sv.js`（5632 条） | 本地 `exercise-names/**` 受保护（含中文优化）；`pt-br` 翻译另存 | 排除（受保护资源/大批量生成） | 无 | — | 任务书禁止覆盖/批量重生成动作名资源 |
| C-60 | **Safer servers: push subscription caps + nudge state** | `api/server.js` 订阅大小校验、`api/queue.js` nudge 序列化 | 本地 `api/server.js` 已有 SSRF/私网防护与 durable write；订阅/nudge 具体加固未对齐 | 不适配 | 无 | — | 需审计本地 push 订阅持久化与 nudge 路径并做真实推送回归；属安全加固，独立评审后落地（R-04） |
| C-61 | **Self-hosting: containers report healthy in half a minute** (#844) | `api/Dockerfile`、compose/helm healthcheck | 本地 `docker-compose.yml`、`helm/values.yaml` 由 fork 维护 | 排除（部署配置） | 无 | — | 部署与镜像健康检查属发布配置 |
| C-62 | **Fix: rest timer starts after the last set, also when the next exercise opens with warm-ups** (#853) | `views/Workout.jsx` 移除 `restBeforeWarmup` 抑制 | 本地仍有该抑制：`Workout.jsx` `restBeforeWarmup` + `warmupRestSecFor` | 不适配 | 无 | — | 本地休息由 `useUI` 计时器驱动并同步到 BlueOS（rest deadline/version 推送属受保护契约）。改此处会改变手表 rest 时序，需双端时序回归后另行实施（R-05） |
| C-63 | **Fix: a per-side set's own "Rest after this set" between its sides** (#853) | `Workout.jsx` 换边休息取该组 rest | 本地已有换边短暂休息：`SWITCH_SIDES_SEC` 分支（仅 timed per-side） | 不适配 | 无 | — | 需按组自带 rest 重算并重发手表 rest seq；同上属受保护时序 |
| C-64 | **Fix: Ask the Coach for more core/arms… gives a real choice** (#829) | `api/coach/core` 候选建议多样性 | 本地 Coach 建议候选由 `lib/coach-context.js`/`coach-insights.js` 生成 | 不适配 | 无 | — | 属 Coach 核心行为，需与本地 consent v2/裁剪规则一起回归 |
| C-65 | **Fix: iPhone rest sound no longer pauses music** | iOS 音频会话 | — | 排除（iOS） | 无 | — | 仅 iOS |
| C-66 | **Fix: Searching a muscle shows the lifts people do** | 新增 `search-popular` 排序表 | 本地 `lib/exercises.js searchExercises` 无热度排序 | 不适配 | 无 | — | 需要官方"热门动作"数据源；凭空排序会改变既有搜索结果顺序与测试断言 |
| C-67 | **Fix: Apple Watch forgotten-workout check** (#904) | watchOS 会话判定 | — | 排除（iOS/Apple Watch） | 无 | — | 仅 Apple Watch |
| C-68 | **Fix: Freestyle tells the truth about progression** (#910) | `Progression` 文案与 `No rule` | 本地已有：`lib/session-noprog.js`、`Workout.noprog.test.jsx`、`Not counted for progression` 标示、`progression-copy.js` | 本地已有 | 无 | `views/Workout.noprog.test.jsx` 通过（既有） | 差异：官方新增"添加动作时不再提示线性进阶"的文案细节 |
| C-69 | **Fix: AI Coach `max_tokens` with newer models/Azure** (#869) | `api/coach/core/adapters/openai.js` 使用 `max_completion_tokens` 并记忆 | 本地已有 `max_completion_tokens`（`api/coach/core/adapters/openai.js`、`compatible.js`）与 `coach-local.test.js` 覆盖 | 本地已有 | 无 | `node --test test/adapters*.test.js` 通过（既有） | 差异：Azure Responses URL 归一化提示未逐字对齐 |
| C-70 | **Fix: the phone's own Coach can talk plain http:// to a model on the home network** (#913) | `lib/coach-cleartext` 校验、私网放行 | 本地已有：`views/CoachSetup.jsx` 明文/私网判定 + `CoachSetup.cleartext.test.jsx` | 本地已有 | 无 | `src/views/CoachSetup.cleartext.test.jsx` 通过（既有） | 差异：官方覆盖 172.16–31 与 Tailscale 100.x 的具体网段清单需逐一比对（R-06） |
| C-71 | **Fix: cards and rows with their own button stop fighting it (ARIA)** | `components/*` 卡片结构、`card-dismiss.test.jsx` | 本地卡片结构不同（`Button`/`Row`/`Tile`） | 不适配 | 无 | — | 需要逐卡片重构交互与 ARIA 结构，属无障碍专项 |
| C-72 | **Fix: Done is right under the numbers when a workout ends** | `sheets.jsx` 结束页布局重排 | 本地结束页为 `FinishSummary`（BodyMap + LastAndNext + CardioDone + 媒体 + 按钮）：`sheets.jsx` | 不适配 | 无 | — | 属结束页布局重设计，与本地新增的组对比/组备注展示位置相互影响 |
| X-01 | tag diff 新增 `docs/WEAR_OS.md`、`docs/ZEPP_OS.md`、`docs/GARMIN.md`、`docs/APP_STORES.md` | 官方文档 | 本地已有 `watch-app/SYNC_PROTOCOL.md` 等自有文档 | 排除（平台文档，随 C-16/C-05/C-07 一并排除） | 无 | — | — |
| X-02 | tag diff `catalogue/exercises/**` 668 项、`catalogue/i18n/**`、`catalogue/README.md` | 动作主肌群与文案 | 受保护资源 | 排除（受保护资源） | 无 | — | 同 C-51 |
| X-03 | tag diff `frontend/src/exercise-names/pt.js`、`sv.js` | 新语言动作名 | 受保护资源 | 排除（受保护资源） | 无 | — | 同 C-59 |
| X-04 | tag diff `fastlane/metadata/**`（80 文件）、`assets/screenshots/**`、`assets/readme/**` | 商店素材 | 本地发布身份/素材由 fork 维护 | 排除（商店/发布身份） | 无 | — | 不覆盖 fork 的商店素材 |
| X-05 | tag diff `frontend/android/app/src/main/res/xml/shortcuts.xml`、AppWidget 相关 | 原生快捷方式与 widget | 本地无 | 排除（Android 原生资源） | 无 | — | 同 C-58/C-29 |
| X-06 | tag diff `frontend/ios/**`（91 文件） | Swift/SwiftUI/Xcode/HealthKit/Live Activity | — | 排除（iOS） | 无 | — | 任务书要求全部排除 |
| X-07 | tag diff `watch-zepp/**`（57 文件）、`frontend/garmin/**`（35 文件）、`scripts/android/build-wear.sh` | 平台工程 | 本地无 | 排除（其他穿戴平台） | 无 | — | — |
| X-08 | tag diff `.env.example`、`helm/values.yaml`、`web/Dockerfile`、`web/nginx.conf.template`、`kubernetes/**`、`docker-compose.yml` 相关 | 部署/镜像/环境变量 | 本地部署配置由 fork 维护（`INTEGRATIONS*`、healthcheck 等新变量） | 排除（部署配置） | 无 | — | 新环境变量随未实施功能（C-01/C-03）一并排除 |
| X-09 | tag diff `website/**`（含 `r/`、`nfc`、`.well-known`、`about/privacy/docs/api/index.html`） | 官网落地页（分享链接、NFC、隐私说明） | 本地 `website/` 为 fork 版本 | 排除（站点/品牌身份） | 无 | — | 不覆盖 fork 站点 |
| X-10 | tag diff `api/watch-relay.js`、`api/media.js`、`api/wrapped.js`、`api/queue.js`、`api/sync-stamps.js`、`api/openapi.yaml` | 服务端新路由与 schema | 本地 `api/server.js` 为自托管路由表 | 排除/不适配（随 C-05/C-27/C-60 与平台功能） | 无 | — | 新增路由服务的都是未适配功能；`watch-relay` 属 Zepp 中继 |
| X-11 | tag diff `mcp/package-lock.json`、`mcp/README.md`、`scripts/build-*` | 依赖/脚本 | 本地 MCP 版本由 fork 维护 | 排除（依赖/构建脚本） | 无 | — | 不做依赖升级 |
| X-12 | tag diff `frontend/vite.config.js` | 构建配置（viewport/worker 相关） | 本地 `vite.config.js` 独立 | 排除（构建配置） | 无 | — | 与 C-06/C-45 的 Web 行为绑定 |
| X-13 | tag diff `frontend/src/components/{Tour,Wrapped,Challenges,Recap,RecoveryHint,StatBars,CardHead,EmptyState,DateField,GymMap,Nfc,ShareCard,SetVideo,StrengthLevel,WeeklySets,WorkoutCoachSheet,YouTubeVideo,LiveHeartRate,ScrollTopButton,RoutineShare,WarmupConfig}.jsx` 及对应 lib | 新组件/新 lib | 本地均未找到同名实现 | 排除/不适配（已逐项见 C-01…C-72） | 无 | — | 本行是目录级汇总，处置以上述逐条为准 |
| X-14 | tag diff `docs/{MODULES,INTEGRATIONS,DATA_IMPORTS,GARMIN,AI_COACH,MOBILE,ARCHITECTURE,SELF_HOSTING*}.md`、`CLAUDE.md`、`CHANGELOG.md`、`ROADMAP.md`、`README.md`、`NOTICE.md` | 官方文档 | 本地有对应 fork 文档（`CLAUDE.md`、`docs/*`） | 排除（上游文档，不覆盖 fork 版本） | 无 | — | 仅在 `docs/dev/` 新增本轮记录 |

## 5. 验证证据

### 5.1 定向测试（本轮新增/改动相关）

命令均在 `K:\gym\openGym\frontend` 下执行，环境 `TZ=Europe/Zurich`（与仓库既有约定一致；无该变量时 `sheets.workout-detail.test.jsx` 的 .fit 文件名断言会按本机 Asia/Shanghai 时区跨日）。

| 命令 | 结果 |
|---|---|
| `npx vitest run src/lib/set-notes.test.js` | 6/6 通过 |
| `npx vitest run src/lib/set-notes-csv.test.js` | 5/5 通过 |
| `npx vitest run src/lib/set-trend.test.js` | 10/10 通过 |
| `npx vitest run src/lib/typo-check.test.js` | 8/8 通过 |
| `npx vitest run src/lib/week-left.test.js` | 7/7 通过 |
| `npx vitest run src/views/Workout.test.jsx` | 228/228 通过（含新增 11 项） |
| `npx vitest run src/sheets.workout-detail.test.jsx src/views/Home.queue.test.jsx` | 41/41 通过（含新增 4 项） |
| `npx vitest run src/views/settings-pages.test.jsx` | 33/33 通过 |
| `npx vitest run src/lib/export-csv.test.js src/lib/import-csv.test.js src/lib/import-csv.twice.test.js src/lib/import-reimport.test.js src/lib/measurements-csv.test.js` | 51/51 通过 |
| `npx vitest run src/lib/notes-render.test.jsx` | 通过 |
| `node --test test/payload.test.js test/payload-parity.test.js test/payload-bounds.test.js`（`api/`） | 47/47 通过 |
| `node scripts/check-locales.mjs`（`frontend/`） | 18 个语言包各 2449 键，一致 |
| `node scripts/check-source-strings.mjs`（`frontend/`） | 1917 个字面量，5 个缺失且全部为**本轮之前既有**的缺口（`CsvExportSheet.jsx` 的 "3 months"/"4 weeks"/"From"/"To"、`WeightRate.jsx` 的 "From"/"To"、`Passkeys.jsx` 的一整句）；本轮新增字符串 0 缺失 |
| `npx vitest run src/lib/i18n-plural.test.js src/lib/pt-br-locale.test.js src/lib/locale-coverage.test.js` | 16/16 通过 |
| `node scripts/pt-br-inheritance-fingerprint.mjs` | overrides 1476 / inherited 973 / 指纹 `92a87fbd…6795`（已按审查后更新到测试） |
| `git diff --check` | 通过（无空白错误） |

### 5.2 完整前端回归

```
cd K:\gym\openGym\frontend
$env:TZ='Europe/Zurich'; $env:NODE_OPTIONS='--max-old-space-size=6144'
npx vitest run --pool=forks --maxWorkers=2
```

结果：**474 个测试文件、5814 项测试全部通过**（耗时约 280 s）。日志：`C:\Users\Administrator\AppData\Local\Temp\opengym-frontend-v144-full4.log`。

过程如实记录：以默认堆与默认 worker 数首跑时 V8 抛 `JavaScript heap out of memory`（与本轮改动无关，是整库一次性跑的内存上限），改用 6 GB 堆 + forks/2 workers 后通过。

过程中曾出现 2 项失败，均为本轮新增文案引出并已修正：

1. `src/lib/i18n-plural.test.js`：俄语/乌克兰语/波兰语要求所有 `tn()` 键是 `{one, few, many}` 对象，而本轮新增的 4 个次数比较键先写成了字符串 → 已补三种语言的真实复数形式。
2. `src/lib/pt-br-locale.test.js`：`pt.js` 新增 28 键改变了 pt-PT 继承指纹 → 已按该测试的要求核对（新增键全是本轮新文案，未改动既有条目措辞）后更新为 `92a87fbd…6795`，并把 `pt-BR.js` 中误加的显式覆盖块删除，使其继续继承 pt-PT。

### 5.3 未执行的检查

- **MCP 测试套件未执行**：`mcp/` 目录没有 `node_modules`（`vitest` 缺失，`npx vitest run` 报 `Cannot find package 'vitest'`）。本轮对 `mcp/src/tools.js` 的改动仅新增一个可选字段，已通过代码审阅确认，但**没有**跑过 MCP 的 vitest 套件。
- **API 完整套件未执行**：只跑了与改动直接相关的 `payload*.test.js`。v1.4.3 轮记录过 6 项在 Windows 上必然失败的 POSIX 权限用例，本轮未重复全量。
- 未执行任何 build、`cap sync`、Android/BlueOS 编译、模拟器/真机验证、`scripts/catalogue/*` 或本地化批量生成。

## 6. 最终统计（与 §4 一致）

| 状态 | 数量 |
|---|---|
| 适配 | 4（C-08、C-09、C-12、C-43） |
| 本地已有 | 8（C-31、C-33、C-36、C-42、C-54、C-68、C-69、C-70） |
| 排除 | 31 |
| 不适配 | 43 |
| 合计 | 86（C 行 72 + X 行 14） |

统计由脚本按账本的「状态」列逐行核对：`适配 4 / 本地已有 8 / 排除 31 / 不适配 43 = 86`。

## 7. 执行前工作区改动的保护

执行前记录于 `K:\gym\diagnostics\upstream-v144-20261104\baseline\`：

- `head.txt`、`branch.txt`、`status-short.txt`、`status-porcelain.txt`、`diff-name-only.txt`、`diff-cached-name-only.txt`、`untracked.txt`、`diff-binary.txt`、`diff-cached-binary.txt`、`stash-list.txt`
- `preexisting-sha256.json`：12 个 dirty 文件 + 3 个未跟踪文件的 SHA-256 与字节数

**重要事实**：12 个 `catalogue/browse/*.md` 在 `git status` 中显示为 modified，但 `git diff` 为空、`git hash-object` 与 `HEAD:<path>` 的 blob 相同——它们只是 LF/CRLF 字节差异，内容与 HEAD 一致。本轮未编辑其中任何一个文件；结束时会用同一份 SHA-256 清单复核（见 §8）。

本轮未触碰的受保护路径（`git diff --name-only` 中不出现）：`frontend/ios/**`、`frontend/android/**`、`watch-app/**`、`frontend/src/lib/watch-*.js`、`frontend/src/exercise-names/**`、`frontend/src/exercise-desc/**`、`catalogue/**`、`update.json`、lockfiles、`package.json`。

## 8. 遗留问题与风险

- **R-01 Webhooks**：需在不削弱 `api/net-guard.js` 默认私网拒绝的前提下，设计受限 opt-in 出站通道（签名、幂等键、~1h 退避、响应上限、DNS rebinding 二次校验）。建议独立安全任务。
- **R-02 历史侧组对比箭头**：`lib/set-trend.js lastTimeBefore` 已实现且有测试，但历史详情（`WorkoutDetail`）尚未渲染箭头，只渲染了组备注。工作台的箭头已完整接通。属半成品边界，明确记录而非声称完成。
- **R-03 「重点 Tab 回顶 / 滚动回顶按钮」**：未实现，需与 `WorkoutScrollAnchor` 协调。
- **R-04 服务端加固（订阅上限、nudge）**：未做，需真实 web push 回归。
- **R-05 #853 休息时序两处修复**：本地仍保留 `restBeforeWarmup` 抑制与 `SWITCH_SIDES_SEC` 换边逻辑。改动会触及 BlueOS rest deadline/version 推送（受保护），需双端时序回归后再做。
- **R-06 Coach 私网网段清单**：本地已支持明文/私网模型端点，但与官方 172.16–31、100.x、`.local`、私有 IPv6 的完整清单未逐项比对。
- **R-07 非中英语言的新 UI 文案**：简体中文与繁体中文为真实译文；俄语、乌克兰语、波兰语的 4 个 `tn()` 复数键给了真实 one/few/many 形式；其余语言按仓库既有做法（`frontend/scripts/fork-locales-fill.mjs`）先写入英文占位，待翻译。
- **R-09 pt-BR 继承指纹已更新**：`pt.js` 新增 28 个键后，`pt-br-locale.test.js` 的继承指纹从 `7630a61e…` 变为 `92a87fbd…`。已按该测试的说明核对：新增键全部是本轮的 v1.4.4 文案，未改动任何既有 pt-PT 条目的措辞；pt-BR 不覆盖这些键，继承 pt-PT 的英文占位。
- **R-08 既有 5 个未翻译字符串**（`CsvExportSheet.jsx`、`WeightRate.jsx`、`Passkeys.jsx`）在本轮之前就存在，未顺手修（避免无关改动）。
- **风险：无设备验证**。本轮全部结论来自单元/组件测试与静态审阅，未做 Android/BlueOS 编译或真机验收；组备注的输入法行为、组对比箭头的视觉对齐、笔误确认弹层在小屏上的表现都只在测试中验证过行为，未做视觉验收。
