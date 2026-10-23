# AI 教练与手机热量记录优化修复技术方案

日期：2026-10-23（Asia/Shanghai）  
执行对象：GPT-6.1-sol  
代码根目录：`C:\Users\Administrator\Documents\ChatGPT\opengym\source`  
审查基线：本地 HEAD `162a916f`；手机前端 1.6.2；手表 0.6.8。

## 0. 本方案的状态与执行边界

这是分析和实施规格，不是已完成的修复。本轮只阅读代码、整理证据、编写文档，没有修改应用代码，没有运行测试、构建、安装或发布。上一轮的 388 项专项测试通过是旧基线记录，不能作为本方案实现后的验收结果。

正文源码路径均相对于上述代码根目录；行号为审查时定位参考，执行前按函数名重新定位。没有真机复现的项目明确标注。所有新增文件名、字段、接口及阈值均为拟议设计，不代表仓库中已经存在。

执行者拿到本文后先确认用户是否已经授权实施：仅“阅读方案”不授权改代码。获得实施授权后，按第 7 节分批实现；不要因本文自动创建新聊天、调用真实付费模型、推送、发布 APK/RPK 或改变签名。修改前保留用户现有改动。

证据等级：

- **静态确认**：代码存在对应逻辑和可说明的触发路径，但本轮没有运行复现测试。
- **待验证风险**：依赖原生回调、存储或固件行为，先建立故障注入/真机证据再确定修复范围。
- **产品优化**：当前功能不一定错误，但缺少明确约束、反馈或体验一致性。

优先级：P1 为数据/状态/凭据正确性；P2 为稳定性、交互或分析质量。热量 UI 是用户直接提出的需求，应作为第一批独立交付。

## 1. 问题索引

| ID | 优先级 | 问题 | 证据 | 本次新增 |
|---|---|---|---|---|
| C01 | 首批 | 热量字体小、位置不当、风格不统一；详情不读取最新热量 | 静态确认 | 是 |
| C02 | P1 | 空热量被转成 0；分段热量与同步状态缺少统一读取规则 | 静态确认/完善契约 | 是 |
| A01 | P1 | 本地 AI 并发、取消、重启、旧结果和新任务混用 | 静态确认 | 延续并补充 |
| A02 | P1 | 接受建议不幂等；处理请求不携带建议 ID，可能清掉另一条建议 | 静态确认 | 延续并补充 |
| A03 | P1 | 上次复盘时间戳被错误截取成日期，复盘窗口不正确 | 静态确认 | 是 |
| A04 | P1 | 密钥写入/删除失败静默降级，且凭据未绑定服务商和端点 | 静态确认 | 是 |
| A05 | P1 | 教练配置/待处理建议写盘失败不反馈，并发写缺少串行保证 | 静态确认/并发风险 | 是 |
| A06 | P1 | 请求总期限、响应体读取和原生取消语义不完整 | 静态确认/原生待验证 | 是 |
| A07 | P1 | “只优化一个计划”只靠文本提示，没有结构化范围校验 | 静态确认 | 是 |
| A08 | P1 | 服务入口授权版本、BYOK 请求体上限等与前端/服务端不一致 | 静态确认 | 是 |
| A09 | P1 | 建议没有生成时单位；计划变更后导入/应用缺少完整保护 | 静态确认 | 是 |
| A10 | P1 | 撤销 AI 更改会整体覆盖之后的手工计划编辑 | 静态确认 | 是 |
| A11 | P2 | 中文输入法回车可能误发送；状态查询失败仍沿用旧状态 | 静态确认 | 是 |
| A12 | P2 | 指定训练不存在时回退到另一场；历史复盘可能混入之后的训练 | 静态确认 | 是 |
| A13 | P2 | 偏好日期、时长、近期重量、轮换计划的约束不足 | 产品优化/部分静态确认 | 是 |
| A14 | 用户明确需求 | 任意单次训练复盘、指定计划最近 N 次训练复盘 | 当前入口限制已静态确认；新增功能规格 | 是，后续补充 |
| W01 | P1 | 离线事件依赖数组下标，计划重排后可能写错动作/组 | 静态确认 | 前轮 |
| W02 | P1 | 手机与手表重量单位、离线体重转换不一致 | 静态确认 | 前轮 |
| W03 | P1 | 队列回调丢失可能卡住，异步持久化缺少故障覆盖 | 待验证风险 | 前轮 |
| W04 | P2 | 关闭会话记录无清理，每次握手重发全部记录 | 静态确认 | 前轮 |
| W05 | P2 | 心率采样跟随页面隐藏停止，旧心率仍可能显示 | 静态确认/真机待验证 | 前轮 |

## 2. 手机热量记录：确定的 UI 与数据方案

### C01：把热量纳入统计区，统一展示组件

**根因与位置**

- `frontend/src/sheets.jsx:2541`：`WorkoutDetail` 用 `<p className="small muted">` 展示热量，位于“继续本次训练”按钮后面。
- `frontend/src/sheets.jsx:3319`：`FinishSummary` 在统计卡片之外使用同样的段落。
- `frontend/src/index.css:155–156`：`.small` 为 13px，`.muted` 为次级文字色，导致主要数值也按辅助信息展示。
- `WorkoutDetail` 虽订阅 store，但热量读取打开弹层时的 `w`；`FinishSummary` 已使用 `saved = st.workouts.find(...) || w`。手表汇总晚到时，两处可能表现不一致。
- `WorkoutRow`（`sheets.jsx:2742`）目前不展示热量。

**确定布局**

1. 新建 `frontend/src/components/WorkoutCalories.jsx`，提供 `variant="card" | "inline"`。组件只展示已归一化数据，不负责 RPC、不写 store、不计算热量公式。
2. 完成页保留原有四张统计卡，把热量作为统计区内横跨两列的一张卡；不挤成五列，不把它做成新的整页视觉中心。
3. 详情页把同一张卡放到标题/日期摘要下方、动作明细上方；移除按钮区原来的小字段落。
4. 历史列表在现有 `.ss` 之外增加可换行的紧凑指标行，仅存在有效数据时展示。不要在右侧追加会挤压 PR、媒体数量和箭头的固定宽度徽章。
5. 只订阅/解析最新训练记录及相关热量字段；不要因热量更新重置用户正在输入的训练笔记。

设计示意（示例数值，非真实训练记录）：

```text
训练完成
┌───────────────┬───────────────┐
│ 时长   48 分钟 │ 容量   3,250 kg│
├───────────────┼───────────────┤
│ 组数   18     │ PR     2      │
└───────────────┴───────────────┘
┌───────────────────────────────┐
│ [现有 flame 图标] 训练热量     │
│  286 千卡          手表估算    │
└───────────────────────────────┘
```

**样式规格**

| 元素 | 规格 |
|---|---|
| 卡片 | 使用 `--surface`、`--r-card`；内边距 14–16px；与 `.tiles` 保持 10px 间距 |
| 主数值 | 1.625rem（默认根字号下 26px）、600 字重、`--label`、等宽数字；继承系统字体 |
| 单位 | 0.9375rem（默认 15px）、500 字重、与数值基线对齐；不得被挤压隐藏 |
| 标题 | 0.9375rem、500 字重；与现有统计标签体系对齐 |
| 来源说明 | 0.875rem（默认 14px）；可换行，不能与主数值同时弱化 |
| 列表紧凑值 | 1rem、600 字重；单位/来源 0.875rem；图标 1rem |
| 图标 | 复用 `Icon` 的 `flame`/`watch`，遵循现有笔画；只图标可用 `--acc`，主数值保持文本色 |
| 响应 | 栅格 `minmax(0,1fr)`；小屏/字体放大时来源换行，禁止固定高度裁切 |

只新增 `.workout-calories-*` 等局部类，不改全局 `.small/.muted/.tile .v`，不引入字体包、图标库、渐变或额外图表。实测主题对比度，不因复用 token 就默认合格；必要时仅调整本组件次级文案色。非交互卡片不伪装成按钮。

文案统一通过 `t()`：建议 `Training calories`→“训练热量”、`Watch estimate`→“手表估算”、`kcal`→“千卡”、`Waiting for watch data`→“等待手表数据”、`Not recorded`→“未记录”、`Partial watch data`→“部分手表数据”。新增键覆盖仓库要求的语言包，至少人工核对简体/繁体/英文，其他语言按现有翻译检查策略处理，不能硬编码中文。

**验收**

- 两个旧小字段落移除，同一有效记录在详情/完成页/历史列表数值和单位一致。
- 详情打开后收到手表汇总，无需关闭重开即可更新；笔记草稿不被覆盖。
- 320/360/390/430 CSS px、深浅主题、200% 文本放大、中文/英文/长数值均不溢出。
- 有数据时主数值计算字号至少 24px；列表至少 16px；单位清晰。
- 来源和“估算”说明保留；不能改称“精准消耗”“活动热量”，除非数据源将来明确提供该语义。

### C02：热量值与状态建立统一读取契约

**证据**：`watch-session.js:13` 的 `Number(ev.calories)` 会把 `null`、空字符串转成 0；UI 的 `w.calories || 0` 也把缺失当作 0。当前有 `watchSegments` 按 sid 汇总的基础，必须复用。

拟新建 `frontend/src/lib/workout-calories.js`：

```ts
type WorkoutCaloriesView = {
  status: 'available' | 'partial' | 'pending' | 'missing' | 'invalid';
  kcal: number | null;
  source: 'watch_estimate' | 'unknown' | null;
  updatedAt: number | null;
};
// workoutCaloriesOf(record, syncContext?) -> WorkoutCaloriesView
```

处理规则：

1. 数值必须是有限、非负 number；兼容旧协议的非空数值字符串时明确 trim 后校验。拒绝 null、undefined、空字符串、布尔值、NaN、Infinity、负值。合法 0 保留为 0。
2. `watchSegments` 是非空且每项有效时，按稳定 sid 合计一次；不把总热量再加一次。新消息同 sid 是替换/更新，不能追加计数。
3. 严格归一化 `at/seq` 后比较新旧。新版本以 seq 为准；旧协议保留 at 规则，已有有效版本不能被缺失/非法时间的消息覆盖。重复消息不改总量；总量允许因更正而下降，不能使用 `Math.max` 隐藏修正。
4. 老记录只有有限 `calories` 和 `calorieSource='watch_estimate'` 时正常显示，不批量改写历史。
5. 如果已经有有效值但还有**明确已知**的训练段等待汇总，显示该值并标注“部分手表数据”。不能仅因存在 watchSid 推断仍在等待。
6. 首批优先使用真实队列/事件证据判断 pending；没有可靠证据则显示 missing，不能编造永久“同步中”。如需持久化同步元数据，再新增 `watchSummarySync`，记录 expected sid、状态和请求时间；旧记录不回填“pending”。
7. 无手表数据时，详情/完成页显示“— / 未记录”；历史列表省略该指标。不能自行套公式补算成事实。
8. 保存后用户编辑时长/组数不自动同比缩放已收到的手表热量；是否重算必须由数据来源明确支持，UI 保持“手表估算”。

涉及 `watch-session.js`、`watch-recovery.js`、`finish-workout.js`、`session-resume.js`，以及新 selector 与组件。现有 `useStore.update` 已用 `stampChange` 标记变更，勿额外叠加另一套无必要的更新时间机制。

测试用例：有效 0、286.4→显示 286、null/空/非法值、合法旧数据、损坏的段、同 sid 重发、乱序消息、恢复训练两段相加、晚到汇总、删除记录后晚到消息不得凭空复活历史。

## 3. AI 教练任务与存储修复

### A01 / P1：任务所有权、取消和重启恢复

**证据**：`coach-local.js:125–177` 在多个 await 后才设置全局 job；run/finally 读写同一全局 job。`localForget:100` 仅清空变量且清空 daily；没有 abort 或 generation 屏障。异常 catch 不写完整 last；nochange 分支没有处理旧 pending。job/last 只在内存，进程退出后失去结束原因。

**实施**

- 在第一次 await 之前获取同步启动锁；每次运行使用独立 job ID（UUID 或现有可靠 ID 工具，不仅用 Date.now）。锁和 cap 更新纳入同一串行事务。
- `run(ctx)` 接收不可变 `{jobId, generation, modeFingerprint, startedAt, deadlineAt, signal, inputSnapshot}`；任何异步回调不得从全局 job 获取自己的 ID。
- 关闭/清除/切换提供方时先使 generation 失效再取消；late result、catch、finally 均检查 ownership，旧任务不能写 pending、last、toast，也不能清掉新任务。
- 将精简运行元数据、最后结果写入教练设备文件。重启遇到 running/starting 时标记 interrupted，不自动重新发起付费请求；用户主动重试才创建新任务。
- 成功、失败、nochange、cancelled、interrupted 均写可关联的 terminal outcome。nochange 与旧 pending 的关系明确：新任务显式 supersede 的旧建议才被清除；失败可保留旧建议但必须标为旧建议，不能当成本次结果。
- 普通关闭/忘记聊天不重置当天用量；区分“配置关闭”“清除历史”“彻底设备重置”。删除训练隐私信息后只保留当天计数和无内容任务元数据，不保留原始请求体。
- 同一用户显式操作只计一次 run；内部修复轮属于同一 job。运行前配置、授权、payload 检查失败不消耗模型调用配额；已发出请求的取消按已消耗处理。

**文件**：`coach-local.js`、`coach-device.js`、`CoachSetup.jsx`、`coach-api.js`、`Settings.jsx`。服务端 `jobs.js` 已有 forgetSeq/AbortController，可参考，不要误称服务端完全没有取消。

**验收**：并发两次 start 最多发一次请求；A→关闭→B→A晚到，B 不受影响；取消后无旧 toast；重启显示中断；异常早于第一次轮询也出现明确失败；关闭重开不能刷新每日额度。

### A02 / P1：建议 ID 绑定与本地幂等决策

**证据**：`CoachChat.jsx:316/326/392/402/563` fire-and-forget resolve 并吞错；`coach.js:398` 每次导入新建 routine；`coach-local.js:99` 和 `api/coach/jobs.js:401` 清理当前 pending，不核对 proposalId。

新决策协议：

```ts
type CoachDecision = {
  proposalId: string;
  requestId: string;
  action: 'apply' | 'dismiss' | 'keep_debrief';
  accepted: string[];
  rejected: string[];
};
// response: { ok:true, proposalId, alreadyResolved?:true }
// ID 不匹配：409 pending_mismatch；保留当前建议，提示刷新。
```

- 本地 draft 内先核查 durable decision，再应用与记录决策，保证同一 proposal 第二次调用无副作用。
- 本地应用与“待发送决策”应在同一 store 更新中提交。网络失败保留结果和决策 outbox，后台可幂等重试；界面显示“已应用，确认待同步”，不得回滚用户计划或重新展示可应用的旧卡片。
- apply/dismiss/keep 三种操作共用单次提交锁。刷新须在本地提交后触发，服务端确认完成后再刷新一次；不要依赖按钮锁作为唯一去重。
- 服务器/localResolve 仅处理匹配 ID；重复同 requestId 返回已处理；陈旧请求不能清掉另一条 pending。
- 去重记录保留至少覆盖建议有效期（当前 14 天）与重试窗口，不能只依赖最多 50 条的展示 log。过期 pending 在应用入口再次检查。
- 明确多设备限制：本地去重不自动实现跨设备 exactly-once。服务器模式应使用决策 claim/lease（绑定 proposalId、deviceId、requestId）或可重放的稳定 routine ID，再由既有同步合并去重；认领后客户端崩溃必须可恢复。先落地同设备可靠性，跨设备场景未验证不得宣称已解决。

兼容：新 API 宣告 decisionVersion；没有 proposalId 的旧决策不能猜测当前 pending 后清除，返回需刷新/升级的明确错误。Web 与 API 协调升级；旧配对客户端保留本地已应用结果，禁止静默删新建议。

验收：连点、断网应用、重启重试、A 的延迟确认遇到 B、两台设备接受同一建议、过期建议、dismiss 与 apply 竞态。

### A04 / P1：凭据作用域与可靠存储状态

**证据**：`coach-secrets.js:10` 只有一个 `coach.apiKey`；`CoachSetup.jsx` 在切换 provider/baseUrl 时可以使用旧 `getApiKey()` 列出模型。`secureSet:48` 失败后落到内存但仍返回成功；`secureGet:41` 原生返回 null/旧值时不会读取新内存值；remove 失败被吞掉。

实施规则：

- 凭据绑定 `provider + normalizedBaseUrl`，生成非敏感 fingerprint。配置和凭据必须匹配才允许发送。换 provider/host/port/path 后默认要求新凭据，不能把之前的 key 自动发给新端点。
- 原生生产环境写入失败返回明确错误，不把“只在内存可用”当作安全存储成功。若保留会话模式，必须显式提示“仅本次启动有效”，并定义内存 override 优先级和 generation；不能悄悄回退到旧 key。
- 迁移旧单 key：只允许绑定升级时已有配置；无法确定原配置则要求重新输入，不猜测。成功写入新 key 并验证可读后再清旧 key。
- 删除失败返回结果并留下非敏感 `credentialDisabled` 标志阻止继续使用，UI 说明无法确认删除；重启仍不使用残留 key，待成功清除后才去掉标志。
- 保存设置以“凭据成功 → 配置提交 → UI启用”为顺序；失败保持旧的完整配置组合。原生超时不能阻止晚到写入，需要每 key 操作串行/版本防护；不要认为 Promise.race 取消了 native 操作。
- 通用 secureGet/Set/Remove 还被其他功能复用，新增 coach 包装层或保留兼容签名，不破坏 Cloudflare Access 等调用者。

验收：原生 set 拒绝/超时、get 返回旧值、remove 失败、重启、切换端点、切换服务商、旧配置迁移；任何日志和快照不得出现真实 key。

### A05 / P1：教练设备文件的可观察、串行持久化

**证据**：`mobile.js:61/68` 读失败返回 null、写失败被吞掉；`coach-device.js:20/27` 先更新 cache 再写入，无单一加载 promise 和写入队列。

实施：提供教练专用严格读写选项/封装，不直接改变所有 mobile helper 调用语义。区分首次缺失、损坏、权限/磁盘失败；损坏文件保留供恢复，不覆盖成默认配置。单例 loadPromise；写入队列在执行时合并 patch，写成功才推进 durable revision；失败保留 dirty/retry 状态并向调用方返回错误。评估原生文件系统同目录临时文件/备份替换能力后采用可恢复写法，不把多次 writeFile 当原子事务。

文件加 schemaVersion/revision；缓存与磁盘恢复规则写明。pending、daily、settings 并发写不互相覆盖。持久化失败不能 toast“设置成功”或“建议已保存”。

验收：延迟乱序写、第二次写失败、损坏 JSON、空文件、冷启动同时加载、断电/进程结束恢复；不丢旧的有效配置。

### A06 / P1：端到端期限与真实取消语义

**证据**：`adapters/http.js:83` fetch 返回后清计时器，`:98` 才读取响应体；浏览器/普通 fetch 的响应体阶段不在该计时器内。重试、路径回退、修复轮各自复用完整 timeout。`capacitor-fetch.js:35` 的 Promise.race 只让 JS 提前返回，没有显式取消原生请求；请求创建早于 signal 检查。

实施：

1. 在 job 创建时固定 deadlineAt；所有尝试、退避、fallback、repair 只使用剩余预算。当前云端 5 分钟/compatible 25 分钟可先保留为整个 job 的预算，提示文案同步。
2. timeout 包住发送、响应体消费和解析分类；body reject 进入统一错误分类。为响应体/repair raw 建立大小上限，超限不能再次原样发送。
3. 发送之前检查已取消 signal；所有 abort listener 在完成后移除；重试等待也消耗总预算，不允许取消后新建请求。
4. 验证当前 Capacitor 原生实现是否支持可取消请求；不支持则实现原生取消桥或明确“本地已停止等待，上游可能仍在处理”。无论哪种都靠 A01 隔离晚到结果，不能承诺取消能撤销供应商计费。
5. timeout、cancelled、provider_unavailable、invalid_response 分开；常规状态错误不把“token 上限”误归为“密钥错误”，优先使用 HTTP status/结构化错误类型。

验收：headers 已返回但 body 卡住、body 中途断开、连续 503、JSON 模式回退再 repair、取消发生在重试间隔、原生晚回、总 deadline 到时无新请求。

## 4. AI 数据正确性与变更保护

### A03 / P1：修复复盘窗口时间转换

**证据**：`coach.js:579/592` 写 `lastReview.at=Date.now()`；`payload.js:551` 用 `String(at).slice(0,10)`；`reviewWindow:295` 与 `YYYY-MM-DD` 比较。当前年份的 epoch 前缀不是日期，通常退回 12 周 cutoff。

实施：新增纯日期归一化函数，支持 epoch 毫秒、旧 ISO 字符串、合法 YYYY-MM-DD；非法值回退默认窗口。给 build/reviewWindow 注入 `now`、用户时区/本地日期，避免 `toISOString().slice` 将本地日期移到前一天。服务端计划任务使用用户配置时区；BYOK 使用设备日期并在请求元数据中固定。

窗口规则：默认最近 12 周，最多 60 场；上次已处理复盘日期晚于 cutoff 时从该日开始，同日训练保留；精确去重若需要使用 reviewedThroughAt/workout IDs，不能仅靠日期截断。同日期按稳定训练时间排序后截取；未来训练不进入截至当前的窗口。

验收：时间戳/ISO/日期三种格式一致，Shanghai 零点前后、洛杉矶夏令时边界、缺失/非法日期、同日两场、61 场及上次复盘之后没有训练。

### A07 / P1：单计划优化的硬范围

**证据**：`CoachChat.jsx:139` 把计划名称写进自然语言；requestReview/payload/validateReview 没有相应 routineId 范围参数。重名计划也难以唯一指认。

新增 `scope={kind:'routine', routineId}`，沿 `CoachChat → coach-api → local/server enqueue → payload → pipeline → validateReview → applyChangeSet` 传递。允许修改目标 routine 内已有类型的动作、组数、顺序、进阶和名称；默认禁止新增/删除其他 routine、全局 week 修改、删除整个目标 routine。每个操作根据实际影响范围验证，不能只验证 target.routineId 字段。

请求时验证目标仍存在；结果应用时再次验证。越界结果进入现有一次 repair，仍越界则拒绝整份建议，不能悄悄删几条后对用户声称完整执行。请求体和 proposal 上保存 scope，应用引擎不能信任纯 UI 限制。重名用 ID 不用 name；用户选择“优化全部”才解除范围。

验收：同名 A/B、模型输出全局 week、新增 routine、改 B、删除 A、A 在等待期间被删除、合法 A 内调整。

### A08 / P1：共享前置校验与同意版本

**证据**：`coach.js:77` 检查 CONSENT_VERSION=2；`coach-local.start`、`jobs.enqueue/execute`、`cadence` 仅检查 agreedAt。`jobs.js:350` 检查 MAX_PAYLOAD_CHARS，local.run 没有相同总上限；localDebrief 缺少服务端同等的训练存在检查。

抽出不依赖 React/Node fs 的 `api/coach/core/consent.js`、`preflight.js`。让 UI、BYOK、服务端入口、执行前与自动复盘共用版本判断。payload 构造和大小约束共用，错误码至少包含 consent、toolarge、noworkout、scope_missing、invalid_config，并补齐本地化错误文本。预检通过后再占用每日模型运行计数。用户输入字段以白名单进入 payload；新增热量数据不自动上传，若以后增加需同时更新披露与同意版本。

验收：旧版本同意不能从 API/自动复盘绕过；大 payload 在本地和服务器都在调用 provider 前失败；无训练请求不发模型调用；拒绝响应在 BYOK 使用“本机”语境。

### A09 / P1：单位、上下文与计划过期保护

**证据**：`validatePlan` 返回 bundle 没有 unit；`plan-share.js:30–65` 缺失单位按目标单位原样使用；`canonicalPlan/hashPlan` 没有 unit；`applyCreatedPlan` 不核对当前计划/排期是否已经改变。

实施：

- proposal 保存可信的 `context={version:2, unit, planHash, scheduleHash, profileRevision, scope}`，由调用方从实际输入创建，不信任模型自报单位；create bundle.unit 强制取 payload.meta.unit。
- create 导入可复用 mergePlan 的单位转换（含 weight 和重量型 inc）；review 若单位变化，第一版明确标过期并重新生成，避免对 before/after 和 cap 做不完整转换。预览按生成单位或明确换算后的值显示，必须与实际导入一致。
- 引入版本化 contextHash，覆盖单位、调度模式及本次建议相关结构；保留旧 hash 兼容路径，不能改变 hash 算法后把老 pending 当 v2。
- create 的“导入动作”和“替换排期”分开判定。排期变更时默认保留当前排期，展示冲突后由用户明确选择替换；不能自动清除等待期间新建的 dayPlan。
- apply 引擎在 store 的最新 draft 内重新检查过期，不能只信任 React render 时的 marked.status。
- 旧 pending 没有生成单位时，不猜重量单位；提供重新生成或明确确认旧单位后再处理，不能静默转换已有历史记录。

验收：kg→lb 后导入重量/增量正确；等待时改 week/dayPlan 不被无提示覆盖；review 等待时改目标值不能应用旧 before；旧建议迁移与过期处理。

### A10 / P1：撤销保护后续手工编辑

**证据**：`coach.js:258/274` snapshot 保存旧 routines/week；revertLast 直接整体替换；确认文案仅说明回到之前，未说明后续计划编辑也会丢失。

第一阶段最小正确方案：snapshot 记录应用前快照、应用后完整相关状态 hash（包含受影响 dayPlan）；撤销时若当前状态与 after 不同则拒绝整体恢复，并展示“之后已有编辑，无法直接撤销”。历史 snapshot 没有 afterHash 同样走冲突路径，不能假定安全。

第二阶段可按字段建立 inverse patch，只撤销仍等于 AI after 值的字段，其余列出冲突交由用户选择；新增 routine 被后来手工使用时不能自动删除。不要一次就实现未经验证的通用三方合并。

验收：AI 应用→手工加计划→撤销不丢新计划；改日期/目标后撤销有冲突提示；没有后续编辑可完整恢复；训练历史不变；撤销失败不 pop 掉可恢复快照。

### A12 / P2：复盘目标精确匹配与历史上下文

**证据**：`payload.js:453` 指定 workoutId 找不到仍返回最后一场；`payload.js:303` aggregates 的部分统计遍历全部 S.workouts；历史 debrief 的“停滞”等信号可能包含目标训练之后的记录。此前同类训练通过 name 匹配，重命名/同名会影响比较。

规则：给定 ID 找不到则 noworkout，不回退；只有未给 ID 才选择时间上最新一场。没有 ID 的旧记录用已有 legacySyncKey 生成内部 ref，不能为了复盘批量改 ID。历史 debrief 传入 asOf（目标场的真实结束时间/顺序），比较只读该场及之前；review 中 lifetime 与 window 指标明确命名，避免假称都来自同一窗口。优先按 routineIds 的稳定组合寻找同类训练，旧记录才回退名称；明确重复动作的匹配顺序。

`coach-insights.js` 同步使用相同排序和筛选规则，保证图表与 AI 所见窗口一致。注意当前 finish-workout 已把暂停/续练后的 end 规范为 start+elapsed；本轮没有确认“end-start 一定包含暂停”的问题，不要借此改坏现有时长逻辑。可统一读取 `durationMs ?? end-start`，但必须保留现有回归。

验收：请求已删除训练不分析另一场；复盘一月训练不使用二月数据；历史乱序导入；同名不同计划；旧无 ID 记录；卡片与 payload 样本数一致。

### A13 / P2：把明确偏好变成可解释约束

**证据**：pipeline 传入 daysPerWeek，但未把 preferredDays/sessionMin 传给确定性校验；cleanEx 不包含 restSec；create history 的 workingWeights.best 来自全部历史最高值；payload 的排期主要为 week，轮换模式信息不足。

这部分属于质量优化，不应承诺“代码能自动判断伤病适宜性”。实施拆分：

1. 日期：若偏好日期数量正好等于 daysPerWeek，要求一致；数量不一致则界面先明确“偏好”或“必须”，不以任意日期补足后假称遵守。
2. 时长：传递每组/动作休息与动作模式，做可解释的时长区间估算（版本化 heuristic）；明显超预算进入 repair/提示。不能拿 2–3 分钟每组当精确生理规律，也不能承诺某套动作精确耗时。
3. 重量：提供 recentWorkingWeight、lastTrainedAt、sampleCount，allTimeBest 仅作历史参考。第一版建议取最近 28 天最近 3 次有效训练的工作重量统计，常量可配置并测试；无近期证据时省略起始重量，交用户确认，保留历史上限校验。
4. 轮换计划：提供 schedulingMode、rotation 次序/位置；在尚未支持生成轮换计划前明确限定为“新增计划，不自动替换当前轮换安排”，禁止展示“周计划已生效”却不影响实际训练入口。
5. 拒绝记忆：previouslyDeclined 目前主要只有 type/why，补充脱敏目标 ID、after 摘要、拒绝时间及证据窗口；重复建议说明新证据，不用简单字符串黑名单永久封死合理建议。

验收：周一三五偏好、30 分钟预算、长休息、恢复训练用户的旧峰值、轮换计划、无历史、用户曾拒绝且无新证据的同一建议。结果说明与实际采用的规则一致。

### A14 / 用户明确需求：任选单次训练与指定计划多次复盘

补充日期：2026-10-23。本项是用户明确要求的新功能，不能仅作为可选增强或以“已有最近一次复盘”视为完成。本轮仅补充方案，不实施。

**用户场景与代码依据**

用户在同一天先完成胸部训练，再单独完成腹部训练。当前 `CoachChat.jsx:134–136/160/218` 用 `.at(-1)` 得到 lastWorkout，并直接发起 requestDebrief；菜单和快捷按钮都只有最近一次入口。因此胸部训练仍在历史中，但无法通过当前复盘入口选择它。

`coach-api.js:69`、`coach-local.localDebrief`、`POST /api/coach/debrief` 已能接收 workoutId，可作为单次选择功能的基础；不是必须重写整个 AI 流程。现有 debrief 只围绕一场训练，不能把全局 requestReview 的提示词改成“分析胸部”就当作实现计划多次复盘。

**目标与默认行为**

| 模式 | 用户操作 | 分析范围 | 输出 |
|---|---|---|---|
| 单次训练 | 选一条已保存记录，可搜索、按日期/计划筛选 | 精确对应这条记录，可附有限的同类历史作比较 | 这次表现、完成情况、值得注意之处、下次建议 |
| 计划近期复盘 | 选计划，再选最近 3/5/10 次，默认 5 次 | 确认列表中的该计划训练数据，最多 10 场 | 重量/次数/有效组趋势、完成情况、停滞信号、变化解释及下一步建议 |

- 统计单位是**训练记录**，不是自然日。同一天胸部、腹部分别是两条可选记录；同一天同一计划训练两次也分别计数。
- 可以选择历史任意一场，不能只展示本周或最近 12 周；列表分页加载，日期筛选用于定位。近期 N 次按所选计划筛选后再取 N 条，不能先取全局 N 条再筛选。
- 保留“最近一次”作为便捷入口，但显示具体训练名、日期/时间；新增“选择训练复盘”和“计划近期复盘”，使它不再是唯一入口。
- 仅分析已保存且有有效完成训练数据的记录；活动中/未保存记录不进入候选。保存但没有有效完成组的记录可显示禁用原因，不消耗模型调用。
- N 不足时显示“最近 5 次 · 实际找到 3 次”，列明实际记录；1 场时转为单次复盘并明确说明不足以分析趋势；0 场时提供返回选择，不发请求。
- 胸/腹只是本例名称，不能硬编码肌群推断规则。计划匹配以稳定 ID 为准。

**界面入口与交互流程**

1. AI 聊天页增加统一的“训练复盘”选择弹层，分“单次训练”“计划近期”两个选项。沿用现有 sheet、Row、分段控件和主题，不新建独立视觉体系。
2. 单次列表按训练时间倒序，按日期分组；每条显示名称、具体时间、时长、有效完成组数，必要时展示所属计划。选择后预览明确的训练标题，再点“开始复盘”。切换筛选或勾选不触发模型调用。
3. 历史训练详情和训练完成页增加“AI 复盘这次训练”入口，直接携带当前记录引用；不能进入聊天后再重新取 lastWorkout。详情页使用最新记录与当前选中身份，晚到数据要按下述快照规则处理。
4. 计划详情/动作菜单增加“复盘最近几次训练”入口，预选该计划。具体 Plan 视图挂载位置由执行者先定位，复用同一个选择组件，不复制筛选逻辑。
5. 计划选择器包含当前计划，以及历史记录中仍可识别但已删除/归档的计划。显示“已删除计划”及可用历史名，不能因为当前 routines 不存在就隐藏历史复盘能力。
6. 最近 3/5/10 次按钮下面展示实际将分析的训练日期、时间、名称及范围；默认选最近 N 次，第一版不必扩展任意多选日期，但所有数据必须可预览。两次同名训练以时间和稳定标识区分。
7. 可以附一条可选问题，例如“为什么最近卧推次数下降”；使用现有长度上限与白名单处理，不能允许附加问题覆盖 scope。
8. AI 尚未配置时先保留 selection，跳转配置/同意流程，成功后返回选择确认。恢复选择不能自动发起付费请求；配置取消返回原页面。已有 job 或未处理 pending 时沿用 A01/A02 的冲突处理，不能静默覆盖前一条报告。

**共享选择器与确定性数据规则**

建议新增无平台依赖的 `api/coach/core/debrief-selection.js`，由本地与服务端使用；前端薄适配层 `frontend/src/lib/coach-debrief-selection.js` 负责把当前 store 和 UI 筛选参数交给同一选择器。若复用 frontend 的 legacySyncKey 会引入平台依赖，将该纯算法提取为共享函数，并建立原有实现的等价测试。

- `workoutRef` 使用有类型的 `{type:'id', value:string}` 或 `{type:'legacy', value:string}`，防止 ID 与 legacy key 命名冲突。旧无 ID 记录不批量回写新 ID；多个记录匹配同一个旧 key 时返回 ambiguous_workout，要求用户消歧，不能任选第一条。
- 排序按训练日期、有效开始时间、真实 finishedAt（如有），最后用稳定 ref 打破并列；不要用数组 `.at(-1)` 代替时间排序，也不要把规范化的 end 当真实结束时间。按日期编辑后的记录使用当前保存的日期；不改变原训练时长。
- 单次选择只认精确 ref。找不到、已删除、内容变化则要求刷新选择，不回退最近一次。这同时落实 A12。
- 计划归属优先读 `routineIds/routineId`，条目归属使用 `entries[].rid`。单计划旧记录可以把所有条目归入该唯一计划；多计划合并记录按 rid 仅截取所选计划的条目，并重新计算该范围的组数/容量/动作指标。
- 合并训练的总时长、总热量和整场 PR 数不能全部归给胸部或按组数比例臆分。没有可靠分段数据时标记“整场时长，仅作背景”，计划范围的时长/热量留空；模型 payload 同样区分 sessionContext 与 scopedMetrics。热量仍遵守 A08 的披露边界，不因本功能自动新增对外发送字段。
- 多计划旧记录缺少条目 rid、或无计划 ID 的自由训练/导入记录：不按同名或肌群自动纳入某计划。选择器明确说明无法可靠归属，并允许按单次训练复盘；人工关联历史计划可另立需求。
- 计划重命名保持 ID，历史仍可匹配；复制计划得到新 ID，不自动混为一条趋势。历史计划版本/目标变化和动作增删在报告中提示；不同动作组合不只按总容量判断退步。
- 去重按训练记录 ref，一条包含目标计划的合并训练计作该计划的一次，不能按动作数放大样本数。续练已合并为同一记录也只计一次。
- 多次报告中的每场指标按当场 target 与完成组计算；缺失努力评分/重量等是 unknown，不能自动当 0；热身组、计时、有氧、双侧等语义复用现有训练读取函数。

**请求接口与快照契约（拟议）**

继续复用 `kind:'debrief'` 以及 `/api/coach/debrief`，新增显式 scope；不把多次复盘发到会产生计划变更的 review 入口。

```ts
type WorkoutRef = { type: 'id' | 'legacy'; value: string };
type DebriefSelection = {
  version: 2;
  scope:
    | { type: 'workout'; workoutRef: WorkoutRef }
    | { type: 'routine_recent'; routineId: string; requestedCount: 3 | 5 | 10 };
  selectedRefs: WorkoutRef[]; // 单次=1，多次=1..10，列表确认后的精确集合
  inputHash: string;         // 共享算法对规范化后的复盘输入与单位计算
  asOf: number;             // 固定确认时点，不由模型决定
};
// POST /api/coach/debrief
// { selection: DebriefSelection, note?: string, lang: string }
```

1. 前端确认时冻结所选 refs、顺序、范围、单位和内容 hash；服务端从已认证用户自己的 state 查数据，不信任客户端提交的训练数值，也不接受他人 userId。
2. server/BYOK 共用 resolveSelection：校验 ID 长度/类型、N 上限、refs 唯一、归属、有效数据、范围一致、inputHash。ID 不能沿用现有 route 的固定 40 字符截断而静默改变身份；按系统真实 ID 约束验证，超长拒绝。
3. 对配对手机，发现本地训练尚未同步、服务器缺少某 ref 或内容不一致时返回 `selection_stale`/`state_not_synced`，前端提示同步后刷新选择；不能省略某场后静默继续，也不能临时改用其他提供方。
4. 入队时绑定已确认选择。排队到执行之间若数据变更，第一版 fail closed：标记 selection_stale 并请求重新确认，不能重新计算“最近 N 次”替换用户选择；预检前避免扣费，已扣的内部计数按 A01 的前置失败规则处理。
5. provider 调用开始后使用白名单规范化输入快照，后续新增腹部训练不能改变已提交胸部复盘。保存 inputHash、单位、实际样本数、选中 refs、时间范围和紧凑指标快照；不在日志保存原始 prompt、密钥或无界训练全文。
6. 新 payload 字段建议 `debriefScope`、`sessions`、`aggregates`、`comparisonContext`。单次维持现有 `session/previous` 的兼容读取；计划多次的趋势以已确认 sessions 为主，不再从全部训练暗中加入样本。单次的 prior context 最多 3 场并且早于所选记录，标为比较背景。
7. 多次复盘最多 10 场只是数量上限，仍执行 A08 的总 payload 上限；大训练先用相同可解释的确定性摘要压缩，明确数据详情覆盖范围，不能默默丢某几次训练。压缩后仍超限则请用户减少次数。
8. 新服务器宣告 `debriefSelectionVersion:2`。旧请求 `{workoutId}` 继续按单次处理；新客户端遇到旧服务器，普通有 ID 的单次可走旧接口，legacy/计划多次需提示服务器升级，不把多次请求降成最近一次。demo 与 BYOK 必须支持同一 selection 形状。

**报告结构与后续动作**

- 单次标题示例：“胸部训练 · 2026-10-23 10:00”；多次标题示例：“胸部计划 · 最近 5 次 · 2026-09-25—2026-10-23”，展示实际训练次数，不只显示报告生成时间。
- 为 pipeline 增加明确的单次/计划多次 prompt 分支和 schema/validator 分支，可继续由 debrief kind 内的 scope 决定。多次报告包含 summary、trends、highlights、watch、nextTime、dataLimitations；不强行把多次训练塞进单次 0–10 评分。旧单次 score 保持兼容。
- 数字由程序算好，模型负责解释。趋势条目引用已选 sessionRef/动作 ID，validator 拒绝引用未提供记录；不能让模型返回统计值后直接当真实数据绘图。
- `pending`、`recordDebrief`、聊天 Recap、HistorySheet、ProposalDetail 全部保存/展示 scope 和紧凑 evidence。图表使用生成时的指标快照；后来编辑训练则标“训练记录已更新，可重新复盘”，不能让旧文字配上新计算的图表而不说明。
- 用户可以打开来源记录；来源删除则显示“原记录已删除”，报告不跳转到别的训练。隐私清除仍按现有 coach 清除策略处理，快照有界并计入 namespace 预算。
- 复盘只提供分析，不自动改计划。多次报告可提供“根据这份复盘优化该计划”，用户明确点击后用 A07 的 routine scope 发起独立 review，经 A02 确认后才应用。计划已删除时禁用该变更入口但保留历史复盘。
- 单次 debrief 和计划近期 debrief 都不更新全局 `lastReview`、不冒充全局计划审核，避免影响 A03 的复盘窗口及自动审核节奏。

**具体文件任务**

| 文件/拟新增模块 | 实施内容 |
|---|---|
| `frontend/src/views/CoachChat.jsx` | 替换唯一最近一次入口；接收选择结果；任务状态和报告分支；来源列表 |
| 新增 `frontend/src/components/CoachDebriefPicker.jsx` | 两种模式、搜索/筛选/分页、次数选择、预览与确认；纯选择不调用 AI |
| `frontend/src/sheets.jsx`、实际计划详情视图 | 单次详情/完成页/计划详情快捷入口，共用选择器，保留导航上下文 |
| 新增共享 `debrief-selection.js` 及前端适配 | refs、归属、排序、截取、hash、混合训练投影、样本不足处理 |
| `coach-api.js`、`coach-local.js`、`coach-demo.js` | selection 透传、能力协商、pending/任务元数据、模式一致性 |
| `api/coach/routes.js`、`jobs.js` | scope 校验、用户数据隔离、入队绑定与执行时一致性检查、错误码 |
| `payload.js`、`pipeline.js`、`schemas.js`、`validate.js` | 单次/多次输入、确定性统计、输出结构及来源引用验证 |
| prompt 源文件及生成后的 `prompts.js` | 单次与计划近期指令区分；先定位仓库 prompt 生成来源，不仅修改生成副本 |
| `coach.js`、`coach-insights.js`、`coach.css`、locales | 有界报告快照、历史展示、趋势图和文案；旧记录兼容 |

**必须验收的场景**

1. **用户原例**：同日 10:00 胸部、11:30 腹部；从选择器及胸部详情都能复盘胸部，payload 主目标是胸部 ref，标题不是“最近腹部”。腹部仍能独立复盘。
2. 最近全局 10 条有胸/腹/腿混合，胸部最近 5 次跨更久时间；先按胸部 routineId 筛选再取 5，摘要和图表只以所选胸部数据为主。
3. 同日同计划两场计 2 次；同一记录多次 watch 重传计 1 次；续练合并记录计 1 次。
4. 合并胸+腹训练有条目 rid：胸部趋势不计腹部组数/容量，不把整场热量与时长算作胸部专属。旧混合记录无 rid 时显示无法可靠归属，可选单次复盘。
5. 计划重命名/删除、同名计划、复制计划、自由训练、旧无 ID、历史乱序、日期编辑均符合上述身份和排序规则。
6. 找到 3/1/0 场分别显示真实数量、单次降级提示、无数据；不会虚构 5 场。
7. 选择后删除/修改记录，排队期间数据变化，配对服务器未同步：不分析其他记录；返回可理解错误，选择可刷新。
8. 请求开始后又新增腹部训练：已提交胸部选择不变；结果历史中能看到原始范围与生成时指标。
9. BYOK/server/demo 选择结果相同；旧服务器单次兼容、多次能力提示；权限隔离、非法 refs/N/payload 大小被拒绝。
10. 选择、筛选、预览不发请求；确认只发一个 job；连点/重复保存报告遵循 A01/A02；复盘不改 routine/week/lastReview。
11. 有/无配置的入口均能保留选择；中文日期时间可读，小屏/大字体选择列表和报告不溢出。

## 5. AI 交互反馈

### A11 / P2：中文输入与状态不可用反馈

**证据**：`CoachChat.jsx:225` Enter 直接 send，不判断 composing；`coach-api.useCoachStatus` catch 吞掉错误并保留旧 state。

- 组合输入期间 `nativeEvent.isComposing` 或 composition ref 为 true 时不发送；处理 Android WebView 的 compositionend/Enter 顺序，用实际输入事件序列测试。Shift+Enter 换行保留。移动端优先显式发送按钮，桌面 Enter 行为维持。
- status 增加 `lastSuccessfulAt/statusError/isStale`；查询失败保留旧结果但明确标为未更新，不显示“仍在思考”作为确定事实。请求恢复后自动消除错误；保留输入文本与重试入口。
- useCoachStatus cleanup 使在途请求失效，避免卸载/切换配置后的旧响应写入另一模式；modeFingerprint 变化清除 awaitedJob/旧 pending 展示，但不删除其持久化数据。
- 若已知任务进行中，短暂错误仍按忙碌节奏退避；不要第一次失败就改成最长空闲轮询。错误提示合并，避免每 3 秒弹 toast。

验收：拼音选词回车不发请求，下一次明确发送才发一次；Shift+Enter；断网后输入保留；切换 BYOK/server 后旧状态不串页；重新联网后恢复。

## 6. 前轮手表问题的实施补充

以下纳入总方案，避免上轮指出问题却没有可执行任务。它们不能阻塞纯手机热量 UI 交付。

### W01：稳定身份同步（P1）

文件：`watch-workout.js`、`watch-events.js`、`watch-session.js`、`watch-recovery.js`、`watch-app/src/lib/protocol.js/session.js/rpc.js` 及所有事件产生页面。

- 活动训练条目新增 entryInstanceId，组新增 setId；exerciseId 不能代替实例 ID，因为同动作可能出现两次。复制组/新增组分配新 ID，重排保持 ID，完成/撤销不变 ID。
- plan/snapshot/event/close.completedSets 全链路携带 ID、structureRevision、protocolVersion。pendingEdits 按 ID 重放，不能只改手机接收函数。
- 接收端查 ID；被删对象不回退同下标，返回明确 rejected/conflict 并刷新快照。快照里保留稳定映射。
- 旧协议只有在可证明结构一致时使用原下标；否则隔离并请求确认。必须协商能力并保留旧设备基础功能，不能宣称旧下标协议也能无损处理任意离线重排。
- 验收：离线重排/删除、相同动作两次、复制组、旧协议、恢复训练和待确认保存。

### W02：重量和体重单位契约（P1，与 C02 关联）

文件：`watch-workout.js:10/22/53`、Keypad/Workout/ExerciseList、protocol 和 phone apply。

- 训练负重采用显式 weightUnit；事件带单位和上下文版本。体重固定 `bodyWeightKg`（新字段）并保留旧 profile.weight 兼容。
- 在线开始和离线目录调用同一 profile builder，lb 体重都转换为 kg。手表单位标签、键盘步进、容量和回传保持一致。
- 单位变化时本地待发编辑按记录时单位转换，不能按接收时手机单位直接解释。
- 验收：手机 kg/lb、无体重默认值来源、在线/离线一致、训练中切换单位、旧 RPK 兼容。

### W03：可靠发送与持久化（P1，先验证）

文件：watch `rpc.js:22/84/264`、`session.js:78`；测试 `watch-receiver.test.js`、`watch-next.test.js`。

- 用可延迟/失败的存储 fake 和丢失回调的 transport fake 建立问题证据；原生 storage.set 是否即时更新可读缓存需真机核实。
- 单一内存 outbox 为运行态真值，持久化串行；新增业务事件落盘成功后才允许视作可靠入队，失败保留内存并明确待保存状态。ACK 删除也持久化，崩溃后重发靠 eventId 幂等。
- sending 绑定 connectionGeneration 和 eventId，超时释放；重连使旧发送回调失效；不要旧回调清新发送锁。持久化 event ID 时钟也按序处理，防重复。
- 退避上限/抖动与队列年龄计数可配置；不合并完成/撤销/结构事件。除非证明保序与最后写入语义，不先做“优化合并”。
- 验收：延迟写、写失败、杀进程恢复、ACK 丢失、回调消失、重连旧回调、快速表冠/键盘事件，证据证明不丢训练操作。

### W04：关闭记录与增量同步（P2）

phone `rememberClose`、`createWatchLifecycle hello/session_close_ack`、`watch-recovery` 与 watch closed_sessions 协调。

分开轻量 tombstone 与较大的恢复 entries；为 peer 保存确认水位/待确认 sid，只重发未确认项；记录恢复期限与容量上限。清理 payload 不能清掉尚未裁决的离线保存。超出保留期的旧 plan/start 必须仍有 age/epoch 检查或进入确认，不能删 tombstone 后让旧训练自动复活。500 条以上历史、重复握手、跨期限离线事件需测试。

### W05：采样生命周期与质量（P2）

watch `Workout.onHide/startHrCapture/stopHrCapture`、`sensors.js`、`session.calories`。

- 先确认固件允许的会话/后台能力，再把心率订阅从页面可见性提升到活动训练生命周期；切输入页/动作列表不应该自然成为训练暂停。
- 管理 sampleAt、sampleCount、sampledDuration 和采样错误；无新样本超过可配置窗口时显示“—”，不把 hrLast 永久当实时值。
- 暂停/结束必须停采样；失败不能一直保持 hrActive=true，恢复时可重试；离开应用后的后台能力以真机结果为准。
- 热量算法变更单独版本化，历史汇总不回算；低覆盖率保留“估算/样本不足”含义。不要宣称采样恢复即保证热量准确。
- 验收：切页面、息屏/亮屏、后台、暂停/恢复、权限失败、断样和不同采样间隔；检查电量与订阅数量，避免重复订阅。

## 7. GPT-6.1-sol 的执行顺序和提交边界

| 批次 | 内容 | 前置 | 最小交付 |
|---|---|---|---|
| B0 | 读取当前变更与指令，核对本文证据 | 实施授权 | 最新基线、复现清单；不覆盖用户改动 |
| B1 | C01+C02 手机热量组件、归一化、晚到刷新 | 无手表升级依赖 | 三个展示入口、旧数据兼容、截图与数据测试 |
| B2 | A03+A11+A12 日期窗口、IME、精确复盘目标 | 无协议迁移 | 独立确定性测试；不使用真实模型 |
| B2a | A14 单次任选复盘 | B2、复用现有 ID 接口；采用 B3/B4 的最终预检/任务契约 | 胸部/腹部同日可分别选择，详情快捷入口，历史任意记录可定位 |
| B3 | A04+A05+A08 凭据、持久化、预检 | 保留通用 helper 兼容性 | 故障注入与迁移测试 |
| B4 | A01+A06 任务状态机、期限、取消 | B3 | 竞态/重启/超时覆盖，原生取消边界说明 |
| B5 | A02+A07+A09+A10 决策、范围、单位、撤销 | B3/B4，API能力协商 | 不重复、不越界、不误覆盖；离线与多设备证据 |
| B5a | A14 计划近期 3/5/10 次复盘及完整报告保存 | B2a/B3/B4/B5；selection v2 能力协商 | 计划筛选、混合训练范围、冻结选择、多次报告和快照，三个运行模式一致 |
| B6 | A13 分析质量 | B2/B5 | 明确 heuristic 与限制，固定 fixture 评估 |
| B7 | W02→W01→W03→W04→W05 | 协议设计与设备能力验证 | 分开手机/手表提交，双端兼容与真机矩阵 |

每批先写能验证实际风险的最小回归，再修改对应边界；纯字号/间距调整以视觉验收为主，不写只逐字镜像 CSS 的脆弱测试。用户只有方案授权时到 B0 的阅读阶段为止，不能执行后续批次。

每个提交说明：解决的问题 ID、前后行为、兼容路径、实际运行的检查和剩余边界。不把几十个问题放进一个无法审查的大提交。不会因为剩余 P2 尚未实现就阻塞已验证的热量 UI 代码交付。

## 8. 测试规格与命令清单（仅供未来执行）

本节命令本轮均未运行。执行时从相应目录运行，先确认路径和脚本仍存在。

### 手机与共享核心

复用/扩展：

- `frontend/src/lib/coach-local.test.js`：job 并发、清除/取消、last/nochange、cap、重启。
- `frontend/src/lib/coach-secrets.test.js`：保留 Capacitor Proxy thenable 回归，再补 set/get/remove 失败与作用域。
- 新增 `coach-device.test.js`：写盘时序、失败恢复、迁移。
- `frontend/src/lib/coach.test.js`、`coach-parity.test.js`：幂等、context 单位、scope、冲突撤销。
- 新增共享 `debrief-selection` 测试及 `CoachDebriefPicker.test.jsx`：同日胸/腹、计划最近 N 次、混合训练投影、旧 ref、样本不足、冻结选择、身份与时间范围。
- 扩展 debrief payload/pipeline/jobs/API/UI 历史测试：单次/多次 scope、能力协商、服务器未同步、选后修改/删除、报告快照、引用验证，确认不改计划及 lastReview。
- `frontend/src/views/CoachChat*.test.jsx`：IME、陈旧轮询、决策失败、跨模式、错误快回。
- `frontend/src/views/CoachSetup*.test.jsx`：只在完整保存成功后启用、凭据更换与删除失败。
- 新增 `workout-calories.test.js`、`WorkoutCalories.test.jsx`、`sheets.calories.test.jsx`：数据契约、晚到刷新、笔记保持、三个入口。
- `watch-session.test.js`、`watch-next.test.js`、`watch-workout.test.js`：段去重、恢复、单位。
- `api/test/payload*.test.js`、`coach-limits.test.js`、`adapters-http.test.js` 及仓库现有 jobs/validator 测试：日期、scope、consent、总期限、ID决策。

从 `source/frontend` 执行的参考命令：

```powershell
npx --no-install vitest run src/lib/coach-local.test.js src/lib/coach-secrets.test.js src/lib/coach.test.js src/lib/coach-parity.test.js src/lib/coach-insights.test.js src/lib/watch-session.test.js src/lib/watch-next.test.js src/lib/watch-workout.test.js
npx --no-install vitest run src/views/CoachChat.test.jsx src/views/CoachChat.fast-failure.test.jsx src/views/CoachSetup.flow.test.jsx src/sheets.workout-detail.test.jsx
# 新增测试文件按实现后的实际路径补入；随后运行完整 frontend test。
npm test
node scripts/check-source-strings.mjs
node scripts/check-locales.mjs
```

API 从 `source/api` 运行 `npm test`。若精简检出缺少测试/适配器模块，先确认 Git 清单与 sparse 状态，不把检出缺失误报为新功能缺陷。所有既有失败区分基线与新增，但不能用“历史失败”掩盖相关回归。

**构建仅在用户授权实现后作为验证步骤**：手机脚本含 POSIX 环境变量写法，PowerShell 不直接照搬 `VITE_MOBILE=1 ...`。使用 `$env:VITE_MOBILE='1'` 配合现有 Vite、media stage、Capacitor sync、bundle checker 分步骤执行，finally 恢复环境变量；或者使用项目支持的 POSIX 构建环境。本方案不要求修改版本号或制作发行包。

### 视觉和真机验收

- 热量页：320/360/390/430 CSS px，深浅主题及至少两种 accent，字体 100%/200%，数据 0/286/1,234/99,999/无效，中文/英文/长文案，完成/详情/历史三处。
- 连接流程：手机先结束→手表后上传；手表离线保存→重连；同 sid 重发；分段续练；历史已删除。
- AI：所有确定性用例用 fake provider，不默认调用真实 key。真实模型冒烟需单独明确授权和费用边界，验证结构/约束，不把“回复看起来合理”当回归测试。
- 手表：方屏/圆屏的编译布局检查与真实交互分开记录；传感器、存储、取消、息屏、RPC 要有设备型号/固件和日志证据才称通过。

### 完成标准

1. 每个问题有结果：已实现+证据 / 经复现否定+依据 / 待真机+可执行步骤；不以全部静态结论冒充真机 bug。
2. 热量可读、风格一致、晚到数据及时更新，缺失不伪装 0，重连不翻倍。
3. AI 只在当前有效任务和授权上下文内运行；接受/拒绝精确绑定建议；不能越界改计划、误转换单位或覆盖用户后续编辑。
4. 凭据/写盘失败可见；重启恢复和旧数据迁移明确；不记录敏感原始请求和 key。
5. 所有执行后的测试、截图、编译日志独立保存；不得引用本轮或上一轮基线作为修复后通过证据。
6. 用户能选择任意已保存单次训练复盘，或按计划复盘最近 3/5/10 次；同日胸部和腹部可分别选中，报告明确真实范围，训练选择与计划修改严格分开。

## 9. 可复制给 GPT-6.1-sol 的任务提示

> 请先阅读 `C:\Users\Administrator\Documents\ChatGPT\opengym\audit-2026-10-23\AI_COACH_CALORIES_SOL_IMPLEMENTATION_PLAN.md`。工作代码在 `C:\Users\Administrator\Documents\ChatGPT\opengym\source`。这份文件是未执行的技术方案，静态发现需要先建立回归证据。若我已在本聊天明确授权实施，请按 B1 开始，先完成手机端训练热量显示、数据归一化与晚到刷新，再按 B2–B7 逐批完成 AI 教练及手表问题；保留用户已有修改。每批报告改动文件、问题 ID、实际验证和剩余限制。使用现有 React/Capacitor/Zustand 与设计 token，保留旧数据及协议兼容。不要默认使用真实付费模型，不自动创建新聊天，不推送、发布、安装 APK/RPK 或更换签名。若我只要求审阅方案，则只审阅，不实施。

> 已补充用户明确要求的 A14：支持任选任意单次训练复盘，以及指定计划最近 3/5/10 次训练复盘（默认 5 次）。请把 B2a 和 B5a 纳入实施范围，不能只保留“最近一次”。同日先练胸再练腹的例子必须作为验收用例；单次/多次复盘都要明确训练来源和范围，且不自动修改计划。详细的选择器、API、共享筛选、报告快照、旧协议和混合训练处理以 A14 为准。

