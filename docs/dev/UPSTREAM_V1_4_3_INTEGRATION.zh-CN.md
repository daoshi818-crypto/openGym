# 官方 v1.4.3 选择性合入说明

日期：2026-10-27

## 1. 当前状态与范围

已将用户选定的官方 v1.4.2 → v1.4.3 功能适配到本地 main 工作区。此次是按功能提取、合入并解决 fork 差异，不是全量覆盖官方文件，也没有把本地版本号改成官方版本号。

- 官方 v1.4.2：e9a303877d02e4237b183f96a9a6603990e8fafb。
- 官方 v1.4.3：7c8290ca20cb619bf6baa6830ea864d283df305a。
- 本地 HEAD 保持 020ed3f776bbe75a141709c3323c45d7c11eb0a3，改动尚未提交或推送。
- 不构建、不打包、不安装、不发布；没有生成新的手机或手表安装包。
- 先前 UPSTREAM_V1_4_3_REVIEW.zh-CN.md 是合入前的评估快照，本文件记录后续实际实施结果。

## 2. 已合入内容

### 身体数据与统计

| 项目 | 实施内容 |
| --- | --- |
| 相对体重力量进度 | 估算 1RM 或最重组相对训练时体重的趋势；负重引体/双杠加入自身体重，辅助器械扣除辅助重量。 |
| 每周体重趋势 | 过去 21 天趋势，以重量与体重百分比呈现；目标体重及参考进度区间。 |
| 疲劳详情 | 肌肉疲劳百分比、恢复阶段和预计进入恢复/准备状态的时间。 |
| 自定义测量单位 | 支持重量、长度和无单位数据；CSV 明确各字段单位，回导同时处理体重与测量。 |
| 累计训练容量 | 加入终身累计统计，包含历史导入；沿用本分支正式组统计口径，不顺带引入热身组容量设置。 |
| 称重撤销 | 记录表和体重记录列表删除后可撤销。 |
| 肌肉平衡与图表 | 未充分训练肌肉可跳到相应动作；清理周计划多余线条；短周期日期、跨年标签、负零显示修复。 |
| CSV 导出入口 | 训练与身体数据分别导出，支持日期范围；只提取共享日期范围函数，不引入整套 PDF 报告模块。 |

主要入口：frontend/src/views/Stats.jsx、Home.jsx、Measurements.jsx，frontend/src/components/WeightRate.jsx、CsvExportSheet.jsx；计算与回导分别在 frontend/src/lib/relative-strength.js、bodyweight.js、measurements.js、export-csv.js、import-csv.js。

### AI 教练

- 普通训练问题走 ask 文本回答，不再一律生成改计划提案；包含正在进行的训练上下文，并做安全裁剪。
- 多设备同步按消息、日志和撤销记录合并，避免后同步设备整段覆盖另一端记录；已在另一设备处理的建议不重复提示。
- 教练创建的计划可进入轮换，Undo 恢复旧轮换和队列。
- 手机 BYOK 模式在应用打开期间按训练次数/每周安排自动回顾；服务器模式接收服务器端回顾提示。
- 设置内提供管理员教练入口。
- Gemini 采用官方本版默认配置及模型列表回退；严格 JSON schema 的 additionalProperties/兼容重试适配；BYOK 的运行次数、输出 token 和消息长度选项。
- 修复计时训练的时间保留、空位计划二次尝试，以及问卷训练天数和星期选择一致性。

保留本分支已有的 consent v2、debriefSelection、多 scope/context、双槽/checksum 写盘、并发取消/超时、decision IDs 和 Undo 封印，不整套覆盖成官方实现。所有 resolvePending 仍带 proposalId 与 requestId。

额外修复：Undo 判定忽略 routines 顶层纯同步元数据 _ts/_f/_u，避免计划同步后被误判为人工修改；实际人工修改仍阻止撤销。已补真实 applyChangeSet/stampChange 回归用例。

主要入口：frontend/src/views/CoachChat.jsx、CoachSetup.jsx、CoachIntake.jsx；共享逻辑在 api/coach/core 和 frontend/src/lib/coach*.js、sync-merge.js。

### 动作别名

加入自定义别名、按别名搜索、跨端同步和随共享计划携带别名。原来的动作 ID 和本分支已优化的简体中文动作名不变，不用别名覆盖内置名称。

主要文件：frontend/src/components/ExerciseAliases.jsx、frontend/src/lib/exercise-aliases.js、plan-share.js、api/sync-stamps.js。

### 万圣节主题

加入季节主题入口，支持自动/常开/关闭、南瓜橙强调色和训练中装饰开关。动画与样式按需懒加载，不启用时不加载整套主题代码。未复制官方 iOS 换图标基础设施。

入口：设置 → 外观 → 季节主题。实现位于 frontend/src/components/Seasonal.jsx、frontend/src/lib/seasonal.js、frontend/src/seasonal/。

### 此前确认的修复及手表借鉴

- Android 安装入口：严格限制更新文件名，要求完整 SHA-256；注意这是完整性检查，不等于独立的发布者签名认证。
- 备份目录：持久写授权检查和本应用备份文件清理范围限制。
- 手机配对：创建配对前重新证明账户所有权，前后端与提示一起适配。
- Android 更新前后台生命周期、主/测试变体识别、返回键导航、休息状态持久化与通知、导入体重来源和肌肉映射修复。
- 借鉴官方 Apple Watch：同一训练自动切换到另一动作后的 1 秒内忽略完成/跳过操作，防止慢双击误落到下一动作。普通刷新不延长窗口，手动切换或明确返回训练页立即放行，新训练不误锁。
- 不移植 SwiftUI/HealthKit/WCSession；不替换现有 BlueOS eventId、业务 ACK、持久 outbox、restId/seq 和组目标锁定机制。没有重新引入跨组 RPE 草稿复用。

## 3. 已保护的本地定制

本轮开始前保存了原有 dirty/untracked 文件和 SHA-256 基线。最终检查确认：

- catalogue/i18n/zh.json 和 frontend/src/exercise-names/zh.js 与本轮开始时逐字节一致，已完成的简体中文动作名优化未被官方覆盖。
- watch-link.js、watch protocol/rpc、SYNC_PROTOCOL 及已有同步/RPE 回归测试与原始基线一致；Workout 页面仅作有意的防误触适配。
- 前后端 package/lock、Android build.gradle/Manifest、Capacitor 和手表 package 配置保持原字节，未改包名、签名配置、版本和依赖锁。
- Android 更新仍指向 daoshi818-crypto/openGym，而非官方签名不同的安装包。
- DeepSeek 动作要领翻译本轮未执行；现存翻译相关文件未被当作本轮新成果。

20 个保护文件的具体哈希验证见 K:/gym/diagnostics/upstream-v143-20261027/final-audit.json。

## 4. 验证结果

环境：Windows / Node 24.18；测试时区 Europe/Zurich。测试不是生产构建。

| 验证 | 结果 |
| --- | --- |
| 最新前端完整回归 | 467 个文件、5759 项测试全部通过。 |
| 最新手表定向回归 | 7 个文件、152 项全部通过，已包含在最新前端完整回归内，不重复累计。 |
| API 完整回归 | 628 项：622 通过、6 失败；同样 6 项在合入前 HEAD 隔离基线复现。 |
| API 相关定向回归 | 66 项全部通过。 |
| locale 键对齐 | 18 种语言，每种 2421 keys，一致。此项不代表所有语言文案人工审校。 |
| diff 格式检查 | git diff --check 通过。 |
| 静态依赖/冲突检查 | 本次修改与新增运行代码无缺失相对 import，无遗留合并冲突标记。 |
| 保护与 Git 状态 | 20 个指定文件哈希一致，HEAD 未变、暂存区为空、更新源保持 fork。 |

### API 六个已知失败

1. credential 文件 0600 权限检查。
2. durable atomicWrite 目录 fsync 顺序/行为检查。
3. 数据文件不可读后的恢复：依赖 chmod 0600 语义。
4. 健康检查对不可写目录返回 503：Windows chmod 不能按 POSIX 方式模拟。
5. 媒体目录/文件 0700、0600 权限检查。
6. 推送清理保存失败测试依赖 chmod 0500 使目录不可写；Windows 上不能按 POSIX 方式模拟。私网端点会被 SSRF 防护拒绝并标记 dirty，随后仍会尝试保存；不能将此失败归因于没有进入保存分支。

不能将这轮 API 全量描述为全绿；上述同名失败已在合入前基线复现，建议后续在官方 CI 对齐的 Linux / Node 22 环境复核，尤其验证真实权限与目录 fsync。

### 生成文件检查

- Coach prompts 与 nudge-copy 同步。
- build-coach-assets.mjs --check 会把现有 api/coach/core/library-data.js 判为 stale，原因仅是该文件原有四处 CRLF，生成器按字节比较 LF。
- 已独立按同一生成逻辑重算：5632 个动作的字段、顺序与生成结果完全一致，归一换行后字节一致，且与 HEAD 中原内容一致。因此未重新生成/重排整套动作库，也没有为通过检查而修改动作内容。

### 尚未验证

没有运行 Android/BlueOS 原生编译，没有生成或安装新包，没有真机验证双端时延、后台通知、安装器或主题的最终设备表现；单元测试不能代替这些验收。之前用户报告的同步体验不能因本次代码测试通过就直接宣称完全解决。

## 5. 日志与复核位置

- 最新前端全量：C:/Users/Administrator/.codex/frontend-v143-verified-20261027.log。
- 手表定向：C:/Users/Administrator/.codex/watch-final-20261027.log。
- API 全量：K:/gym/diagnostics/upstream-v143-20261027/api-full-final.log。
- 合入前 API 对照：K:/gym/diagnostics/upstream-v143-20261027/api-baseline.log。
- API 定向：K:/gym/diagnostics/upstream-v143-20261027/api-focused2.log。
- 逐补丁记录：K:/gym/diagnostics/upstream-v143-20261027/merge-log.jsonl。
- 保护/静态/动作库核对：K:/gym/diagnostics/upstream-v143-20261027/final-audit.json。

K 盘剩余空间约 32 MB，本轮后期日志已改存 C 盘。以后若确认构建，需要先准备足够磁盘空间；本轮没有为释放空间删除用户文件。
