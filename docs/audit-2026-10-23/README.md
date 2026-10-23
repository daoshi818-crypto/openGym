# 2026-10-23 审计与实施记录

本目录保存 2026-10-23 这一轮 AI 教练、训练热量与手表端加固工作的计划、审计结论、
实施报告和验证证据。代码变更对应提交 `447449a9`（基线 `162a916f`）。

## 目录结构

| 路径 | 内容 |
|---|---|
| `plans/` | 实施计划：`AI_COACH_CALORIES_SOL_IMPLEMENTATION_PLAN.md`（C/A/W 条目逐项规格）、`WATCH_STYLE_EFFORT_OVERLAY_PLAN.md`（手表样式与努力值浮层） |
| `notes/` | 本轮审计的发现、进度、任务计划，以及实施前基线测试结果 `baseline-tests.json` |
| `implementation/IMPLEMENTATION_REPORT.md` | 实施报告：用户可见变化、AI 教练逻辑图、C01–W05 逐项落实表、验证结果、真机与部署边界 |
| `implementation/evidence/` | 实施后的测试输出（`.tap`、`.json`、构建与服务日志） |
| `implementation/screenshots/` | 热量卡片在不同屏宽/主题下的视觉检查截图、复盘选择器预览 |
| `implementation/source-final-status.txt` | 提交前的源码状态记录 |
| `handoff/prior-iteration/` | 上一轮迭代的交接说明（`WATCH_NEXT_ITERATION_HANDOFF.md`）及其发现/进度/计划 |
| `handoff/integration-notes/` | 同步集成阶段的笔记、核心 diff 与补丁 |
| `handoff/rpc-investigation/` | 手表 RPC/SDK 调查笔记与发布、校验脚本 |
| `handoff/store-screenshots/` | 应用商店用截图 |

## 未纳入仓库的文件

- `mobile-web-bundle/`（约 24 MB 的前端构建产物）：属于构建输出，需要时由 `npm run build:mobile` 重新生成。
- `deliverables/*.rpk` 与 `.sha256`（手表安装包，约 2 MB）：二进制发布物，不入库；应通过 GitHub Release
  附加资源发布，并由 CI 的 `[build]` 流程产出签名包。
- 根目录的 `full-test-results.json`、`final-test-results.json`（1.8–2.4 MB 全量原始日志）：内容与
  `implementation/evidence/` 中的精炼结果重复，未重复入库。

## 测试状态说明

实施报告记录了验证结果：本轮相关的前端专项 615/615、API 核心专项 173/173 通过。
全量测试在 Windows 上仍有环境类失败（POSIX 权限/不可写目录假设、缺失的 kubernetes/helm 脚本、
入口脚本依赖 POSIX shell 等），这些与本次产品改动无关，未通过修改产品逻辑去掩盖。

代码验证不等于真机与上线验收：原生安全存储、手表熄屏/后台心率、跨设备并发等仍需真机矩阵复测。
