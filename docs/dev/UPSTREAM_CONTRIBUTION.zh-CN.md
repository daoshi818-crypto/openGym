# 把本分支功能贡献给官方：建议流程

核对日期：2026-11-06。官方仓库：[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)。提交前再阅读其当前 [CONTRIBUTING.md](https://github.com/DuarteSantos8/openGym/blob/main/CONTRIBUTING.md) 和 [CLA.md](https://github.com/DuarteSantos8/openGym/blob/main/CLA.md)。本文件不是法律意见，也不替你同意协议。

## 先澄清“合并”

不是把整个定制 main 推到官方 main，而是向官方发 Pull Request，请维护者审阅选择接受。当前 `daoshi818-crypto/openGym` 在核对时 GitHub 返回 `fork:false`、无 parent，不属于官方 fork 网络。不要删除现有发行仓库或强制改写历史；它继续承担手机更新源和安装包发布。

最稳妥的方法是在官方仓库点 Fork，新建正式 fork。因为你账号已有同名仓库，可在 fork 界面取另一个可用名字，例如 `openGym-upstream`；这是示例，只有你实际创建后才使用该名字。原定制仓库仍保持原名。

## 推荐拆成几个小 PR

1. **AI 聊天格式兼容**：lossless notes 字符串包装、提示词/schema和单测，先确认上游当前代码是否还存在同类问题；不要连同本分支 APK 版本号与发行 workflow 一起提交。
2. **主题训练日历**：日期 → 当天训练 → 动作/组详情，明确与现有统计的关系，提供窄屏和空状态截图、键盘/无障碍行为以及所有 locale 文案。
3. **已完成训练接续**：保留原历史 ID、原组记录、此前用时，保存更新而非重复新建；同时测试丢弃接续不删除原历史、已有 active 的限制和同步冲突。
4. **BlueOS / vivo / iQOO 手表**：跨端协议、配对、安装和多机型适配范围较大，建议先在官方 Discussions 提议/RFC，取得维护者方向反馈，再拆协议、手机桥接、手表客户端 PR。

官方已存在的功能不要标为新创，例如丢弃训练、基础 AI、统计、中文、Apple Watch / Wear OS。

## 在新目录开始，避免污染当前发布分支

以下 `<...>` 都是占位符，必须替换；切勿原样复制执行。使用新目录，不在现有发行 checkout 上重置或覆盖。

```bash
# 先在网页上创建正式 fork；以你实际创建的 fork 地址为准。
git clone https://github.com/<你的账号>/<正式fork仓库名>.git <新的本地目录>
cd <新的本地目录>
git remote add upstream https://github.com/DuarteSantos8/openGym.git
git fetch upstream
git switch -c fix/coach-notes-compat upstream/main
```

按当前上游代码结构移植一个功能及其测试。不能直接 cherry-pick 包含发行定制的整份提交；若参考本分支提交，应只移植必要修改，并审阅全部 diff。不要复制本分支更新地址、签名密钥、API key、APK/RPK、用户记录、宣传图片或默认中文 README 替换。

按上游 CONTRIBUTING 当前要求执行相应测试。其准则包括：UI 修改需浏览器实测；文案更改同步所有 locales；目录数据修改保留翻译一致性；不要手改生成的 exercises-data；不要带入 media/data；不要为普通贡献改 CHANGELOG。AI 辅助允许，但贡献者需理解并负责审阅。

```bash
# 测试、审阅和提交后：
git push -u origin fix/coach-notes-compat
```

在 GitHub 打开 PR：base repository 选 `DuarteSantos8/openGym`，base `main`，head 选正式 fork 的这个功能分支。先用 Draft 更便于讨论，未被接受前不要宣称已合并。

## PR 描述建议

- Problem：具体如何复现，原请求、错误文本、环境（不带密钥）。
- Root cause：在哪个数据边界不兼容，为什么复盘可能正常而聊天失败。
- Change：最小改动、哪些规则未放宽、是否需要迁移。
- Verification：命令、实际通过/失败结果；明确真实 API / mock / 浏览器 / 真机的区别。
- Screenshots：只在 UI 修改时给前后对照，声明演示数据。
- Scope：明确不包含本分支发行定制和未完成手表功能。

## CLA 必须你本人决定

上游当前要求贡献者确认 CLA。原文说明你保留贡献版权，同时向维护者授予长期、广泛、可转授的使用权，包含商业和专有许可，并定义贡献涵盖过去与未来的提交。请完整阅读原文；如果不接受，不要签署或继续假定能按该流程合并。

**不能由代理替你签名、冒用你的知情同意或自动发送签名评论。** 本次仅整理流程，未创建 PR、未向上游发送消息、未签 CLA。若决定继续，先确定愿意提交的首个小功能并确认对协议的理解。
