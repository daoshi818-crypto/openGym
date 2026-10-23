# 手机与手表 RPC 排查（2026-10-19）

## Phase11: watch redesign and training lifecycle (delivered; device validation pending)
- Scope: 390x450 watch UI with explicit controls, documented crown support, online/offline finish reconciliation, calorie summaries saved on phone, resume completed workout with accumulated time and replacement of original history record.
- Acceptance: reproduce ended/offline state defects; tests for both finish directions and reconnect, historical record id/upsert and timer continuation, calorie correlation; validate actual watch scripts and frontend build; bump both versions, push main without dispatching build.
- Plan: read current lifecycle and BlueOS docs; implement lifecycle/data model before views; rebuild watch screens and history continuation; focused tests, layout inspection, documentation and delivery.
- Verified: global ended/hello reconciliation, persistent closed sids and reliable energy summary, resumed history upsert/time/segment identity; 390x450 source-render previews of 5 pages plus rest/actions. 15 files / 368 tests pass; VITE_MOBILE=1 build pass; versions 1.5.15/code43/bridge.7 and 0.5.0/code12 consistent. Native package/device checks unavailable; manual GitHub APK build and separate BlueOS RPK build required.
- Final: 15 files/370 tests and final mobile Vite build pass. b8ac3a63aa23fa523d69acb06b14bad0631a1f69 pushed to origin/main; independent ls-remote matches local HEAD and working tree clean. No Actions dispatch/build marker; preview server stopped. User must install both new native packages and verify gestures/crown/end/reconnect/energy/resume on device.

目标：核对用户提供的 SDK 文档、实际 AAR、手机及手表实现，定位 init(false, null) 与 REGISTER code=8，并修复可确定的本地问题。

验收：
- 用实际 SDK 字节码或官方 API 确认错误码和初始化参数。
- 区分已证实的软件缺陷与需要真机/平台后台验证的条件。
- 修复已证实的代码问题，并执行对应回归与可用的构建检查。
- 给出具体复测步骤，不将静态检查称为真机连接成功。

阶段：
7. 已完成代码修复与交付：真机已确认 .2 初始化、授权、设备连接成功。新增设置页拉起手表应用接口，参考 ZIP 的 action_pull_up_watch/package/router；修复训练计划随路由卸载丢失、发送中更新滞留及 hello 空 sid 被拒绝的问题。增加训练收发诊断，升级 1.5.11/39/.3。专项4文件19项通过，手机模式Vite构建、版本/拉起目标/手机构建标识校验、git diff --check通过。4a12bb59004707d3e6f77806dc4dca781d37340b 已推送main且ls-remote核实一致；只余原有watch-app/dist/未跟踪。Gradle因无Java未能启动，原生与真机验证交由用户手动构建复测，未触发构建。
6. 已完成代码修复与交付：新日志计数为 1，AAR 确认初始化前 isConnected 会缓存 null Context；init 不重置 client，已修复提前访问并升级 1.5.10 / 38 / bridge .2。增加组件覆盖状态和 resolveService 诊断，专项测试4/4、手机模式Vite构建、版本一致性、暂存差异检查通过。提交 aad1f505d15d58a3bae049f86c05cdd12fd6e04d 已推送并核实 origin/main。原生编译/仪器测试/真实互联仍待用户手动构建和设备复测。
1. 已完成：读取历史排查记录；没有可用 memory 数据库工具，历史记录仅包含旧 BLE 问题。
2. 已完成：文档、AAR、调用链比对。SDK 可能在绑定前因设备计数为零返回 8，需真机确认。
3. 已完成：确定的本地问题修复及专项测试，手机模式前端构建通过。
4. 已完成：排查报告、诊断字段和真机复测步骤；Android 编译及真实互联待 GitHub/真机。
5. 已完成：升级到 1.5.9 / versionCode 37，同步更新元数据；提交 05699f4 已推送 GitHub main，远端提交号已核实。构建由用户手动触发。

限制/错误：
- web.run 打开/搜索返回空结果；已通过内置浏览器读取用户文档。
- shell 网络请求被套接字权限拒绝。
- PATH 中无 java/javap/adb/python，需确认其他本地工具或采用静态字节码解析。
- Gradle 实测无法启动：JAVA_HOME 未设置，PATH 无 Java；已使用 Node 自定义 class 字节码解析。
- 全量前端测试：393 文件通过、14 失败，4941 项通过、4 失败（11 套件加载失败），涉及 sparse-checkout 缺文件、Windows 脚本、日期/示例数据断言。
- ui-skills CLI 无输出已中断，保留最小状态和诊断界面修正。
- 版本检查首次 node -e 因 PowerShell 引号失败，改为 here-string 管道执行后通过。

8. 已完成代码修复与交付：用户更新0.4.1后仍无动作，新日志已有hello补发，尚缺业务接收证据。修复id-only名称映射及页面接收回调恢复，增加planId匹配回执、版本/解析/清理原因诊断；专项6文件55项、手机模式Vite构建、版本与暂存差异校验通过。1.5.12/code40/bridge.4和手表0.4.2/code9已提交4ea9983cea49fb87e367dfd211abddb290ef1801并推送main，ls-remote确认一致，工作区干净。未触发构建、未更新手表构建目录。APK/RPK与真机业务回执仍待用户构建安装验证。

## Phase 9: watch 0.4.2 receive parsing (in progress)
- Device logs confirm every plan/rest/sync reaches onMessage but is rejected before page handlers: watch_rx invalid_message, outer object keys=[data].
- Exact inner shape is not captured yet. Existing tests cover only one data envelope + one JSON parse.
- Investigate documented/reference formats, reproduce decoding gaps, implement bounded decoding with structural diagnostics, verify actual page processing, bump dual versions and push main without dispatching CI.

- Phase9代码修复与交付已完成：手机1.5.13/code41/bridge.5、手表0.4.3/code10。有界data/msg/JSON解包及内层结构诊断；专项6文件65项、手机模式前端构建、版本元数据、git暂存差异检查通过。提交ec497718a6d31ff805274f14cf4a0c4e060f8f4f已推送main并独立ls-remote验证，工作区干净。未触发构建、未生成APK/RPK，真机格式及训练显示恢复仍待用户安装双端后验证。

## Phase10: editing and set synchronization
- User confirms transport works but watch weight/reps cannot be edited and sets synchronize incorrectly.
- Device ACK now proves event.data.data envelope and plan/sync applied at Index and Workout.
- Trace Keypad lifecycle/saving/transport and cursor/structural events; reproduce before fixing; bump versions and push main after checks.

Phase10 已完成代码修复与交付：手机1.5.14/code42/bridge.6、手表0.4.4/code11。专项8文件297项、手机模式Vite构建、版本和暂存差异检查通过。提交ae9ab5190b3952b91e3c0fc38af8e97d84359133已推送main，ls-remote与本地HEAD一致，工作区干净。未手动触发Actions；APK/RPK及真机编辑/组数/左右滑动待用户双端安装后验证。
