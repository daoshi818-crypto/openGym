# openGym 手机阅读与社交展示素材

## 导出图片：九张独立短图

**全部 1080×1440（3:4），不做拼接长图。** 按 01→09 发布；手表适配放第 2 张，官方核心在 03–05，本分支日历、AI、接续和中文更新在 06–09。

| 顺序 | 图片 | 归属 |
| --- | --- | --- |
| 01 | [封面：认真练，也认真记录](../../assets/showcase/opengym-cover.png) | 总览与适配机型 |
| 02 | [vivo / iQOO 手表适配与安装](../../assets/showcase/opengym-02-custom-watch.png) | 我们的定制拓展 |
| 03 | [计划与逐组记录](../../assets/showcase/opengym-03-official-training.png) | 官方核心功能 |
| 04 | [统计与复盘](../../assets/showcase/opengym-04-official-progress.png) | 官方核心功能 |
| 05 | [动作库、AI 与数据自主](../../assets/showcase/opengym-05-official-tools.png) | 官方核心功能 |
| 06 | [按日期回看训练、动作与组](../../assets/showcase/opengym-06-custom-calendar.png) | 我们的定制日历 |
| 07 | [AI 对话到确认改计划](../../assets/showcase/opengym-07-custom-coach.png) | 我们的定制拓展 |
| 08 | [丢弃与接续已完成训练](../../assets/showcase/opengym-08-custom-lifecycle.png) | 保留基础能力，拓展接续闭环 |
| 09 | [中文资料与发布更新](../../assets/showcase/opengym-09-custom-ecosystem.png) | 我们的定制拓展 |

手表适配目标按发布方说明：vivo / iQOO WATCH GT1 / GT2、vivo WATCH 3–6，未逐台真机验收；需 orbibitv 安装，未上架官方手表应用商店。图上不提供未经核实的安装器下载地址。

新增素材：[选日期](../../assets/showcase/app-calendar-selected.png)、[当天训练动作与组](../../assets/showcase/app-calendar-workout-detail.png)。均为真实界面的浏览器演示数据截图。

## 内容与真实边界

- 手机：当前代码 `238f4d3c7` 的中文浏览器演示数据截图，390×844、DPR2。不是用户真实训练记录，也不是 Android 实机拍摄。
- 手表：0.6.18 / code33 的真实 UX 模板、样式及场景数据生成的390×450浏览器预览；不是 BlueOS 模拟器或 GT1 真机截图。图中与 README 均明确标注。
- AI 区块是操作流程说明，引用用户需求作为例子，不伪造聊天截图；真实 API 验证另见 1.6.14 发布说明。实际方案须通过校验并明确确认。
- 官方已有计划、记录、统计、中文、AI、报告、Apple Watch 和 Wear OS，不宣传成我们首创。vivo/BlueOS、普通聊天确认应用、中文内容增补与本分支更新流程为拓展重点。
- 固定官方对照基线为已审阅 v1.4.4，不自动使用「官方最新版」措辞。定制功能快照为手机1.6.14、手表0.6.18；后续功能变化需重新制作。
- 官方 v1.4.4 已有丢弃能力，不能宣传为原创；本分支重点是退出与接续已完成训练的闭环。
- 当前无手表动作演示；不承诺后台强制拉起手机。AI 和在线同步需要对应配置与服务。
- 源码 AGPL-3.0；上游与素材声明见仓库 LICENSE、NOTICE.md。

证据：[既有功能对照](../dev/FORK_VS_OFFICIAL_1_6_9.zh-CN.md)、[GT1交互边界](../dev/WATCH_GT1_UI_REBUILD.zh-CN.md)、[1.6.12发布](../dev/RELEASE_1_6_12.zh-CN.md)、[1.6.14发布](../dev/RELEASE_1_6_14.zh-CN.md)。

## 编辑与重新导出

源稿是 [index.html](index.html)，只用本地图片、系统字体和 CSS，无外部字体、CDN脚本或生成式图片依赖。

1. 从仓库根目录启动本地静态服务器，例如 `python -m http.server 8768 --bind 127.0.0.1`。
2. 打开 `http://127.0.0.1:8768/docs/showcase/index.html`。手机宽度按1080px画布等比显示；各张保留独立的3:4比例。
3. 按 [render.cjs](render.cjs) 的说明配置 Playwright，然后运行导出；导出脚本仅逐张截图，不截整页；同时检查字体、图片比例、正文与页脚边界、文字溢出、九张产物尺寸，以及360/390/430/768px宽度适配。

```bash
# 标准 Node 环境，先在仓库外部的工具目录安装 playwright，并安装对应浏览器。
# 本地工具已具备时无须修改项目 package.json 或 lockfile。
set PLAYWRIGHT_MODULE=C:\tools\node_modules\playwright
node docs/showcase/render.cjs
```

默认连接 `http://127.0.0.1:8768`。可用 `SHOWCASE_BASE_URL` 指定静态服务器，用 `SHOWCASE_BROWSER_CHANNEL` 指定浏览器通道（Windows可设为 `msedge`）。未设置时使用 Playwright 的 Chromium。导出报告写到 `SHOWCASE_REPORT` 指定的位置；未指定则写入系统临时目录。

不要把预览标记、非官方标记或功能归属裁掉后对外宣称为官方或真机效果。
