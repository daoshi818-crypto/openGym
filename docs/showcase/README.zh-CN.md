# openGym 手机阅读与社交展示素材

## 导出图片：七张独立短图

**全部 1080×1440（3:4），不做拼接长图。** 推荐按 01→07 顺序发布；02–04 是官方主要功能，05–07 是我们的定制拓展。每张只围绕一个主题，正文使用大字号，适合手机左右翻图阅读。

| 顺序 | 图片 | 主题 |
| --- | --- | --- |
| 01 | [封面](../../assets/showcase/opengym-cover.png) | 认真练，也认真记录 |
| 02 | [官方：计划与记录](../../assets/showcase/opengym-02-official-training.png) | 训练计划、逐组记录、历史 |
| 03 | [官方：统计与复盘](../../assets/showcase/opengym-03-official-progress.png) | 日历、趋势、报告 |
| 04 | [官方：辅助工具](../../assets/showcase/opengym-04-official-tools.png) | 动作库、AI、数据自主 |
| 05 | [定制：AI 对话改计划](../../assets/showcase/opengym-05-custom-coach.png) | 自然语言需求、校验、确认应用 |
| 06 | [定制：vivo 手表训练](../../assets/showcase/opengym-06-custom-watch.png) | BlueOS / GT1、切动作、选组、录入 |
| 07 | [定制：中文与更新](../../assets/showcase/opengym-07-custom-ecosystem.png) | 中文内容增补、独立发布更新 |

此前的 5280px 长图和两张 2640px 分图已从当前展示中移除，避免误用旧排版。可以直接保存上述 PNG 使用，无须再截图 HTML 页面。

附加原始素材：[训练日历](../../assets/showcase/app-calendar.png)、[趋势统计](../../assets/showcase/app-trends.png)、[训练报告](../../assets/showcase/app-report.png)、[手表总结代码预览](../../assets/showcase/watch-summary-preview.png)。这些也分别属于浏览器演示截图或代码预览，不是真机截图。

## 内容与真实边界

- 手机：当前代码 `238f4d3c7` 的中文浏览器演示数据截图，390×844、DPR2。不是用户真实训练记录，也不是 Android 实机拍摄。
- 手表：0.6.18 / code33 的真实 UX 模板、样式及场景数据生成的390×450浏览器预览；不是 BlueOS 模拟器或 GT1 真机截图。图中与 README 均明确标注。
- AI 区块是操作流程说明，引用用户需求作为例子，不伪造聊天截图或宣称已对某一模型在线复现。实际方案须通过校验并明确确认。
- 官方已有计划、记录、统计、中文、AI、报告、Apple Watch 和 Wear OS，不宣传成我们首创。vivo/BlueOS、普通聊天确认应用、中文内容增补与本分支更新流程为拓展重点。
- 固定官方对照基线为已审阅 v1.4.4，不自动使用「官方最新版」措辞。定制功能快照为手机1.6.13、手表0.6.18；后续功能变化需重新制作。
- 当前无手表动作演示；不承诺后台强制拉起手机。AI 和在线同步需要对应配置与服务。
- 源码 AGPL-3.0；上游与素材声明见仓库 LICENSE、NOTICE.md。

证据：[既有功能对照](../dev/FORK_VS_OFFICIAL_1_6_9.zh-CN.md)、[GT1交互边界](../dev/WATCH_GT1_UI_REBUILD.zh-CN.md)、[1.6.12发布](../dev/RELEASE_1_6_12.zh-CN.md)、[1.6.13发布](../dev/RELEASE_1_6_13.zh-CN.md)。

## 编辑与重新导出

源稿是 [index.html](index.html)，只用本地图片、系统字体和 CSS，无外部字体、CDN脚本或生成式图片依赖。

1. 从仓库根目录启动本地静态服务器，例如 `python -m http.server 8768 --bind 127.0.0.1`。
2. 打开 `http://127.0.0.1:8768/docs/showcase/index.html`。手机宽度按1080px画布等比显示；各张保留独立的3:4比例。
3. 按 [render.cjs](render.cjs) 的说明配置 Playwright，然后运行导出；导出脚本仅逐张截图，不截整页；同时检查字体、图片比例、正文与页脚边界、文字溢出、七张产物尺寸，以及360/390/430/768px宽度适配。

```bash
# 标准 Node 环境，先在仓库外部的工具目录安装 playwright，并安装对应浏览器。
# 本地工具已具备时无须修改项目 package.json 或 lockfile。
set PLAYWRIGHT_MODULE=C:\tools\node_modules\playwright
node docs/showcase/render.cjs
```

默认连接 `http://127.0.0.1:8768`。可用 `SHOWCASE_BASE_URL` 指定静态服务器，用 `SHOWCASE_BROWSER_CHANNEL` 指定浏览器通道（Windows可设为 `msedge`）。未设置时使用 Playwright 的 Chromium。导出报告写到 `SHOWCASE_REPORT` 指定的位置；未指定则写入系统临时目录。

不要把预览标记、非官方标记或功能归属裁掉后对外宣称为官方或真机效果。
