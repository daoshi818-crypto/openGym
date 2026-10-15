# 训练助手（BlueOS 手表应用）

vivo 手表上的极简训练伴侣：**抬腕点一下记一组，组间倒计时结束震动提醒，全程记录心率并估算热量**。
不做计划编辑、不做好看的东西——手表只干这三件事，训练记录通过云端 Worker 转成 openGym 能导入的 CSV。

```
手表（本项目）                      Cloudflare Worker（../worker）
  完成一组 → 立即落盘                        POST /session  → KV
  组间倒计时（绝对时间戳）+ 震动                GET  /config   → 训练安排
  心率订阅 → 均值/最大/热量                   GET  /export.csv → openGym CSV
  结束 → 上传（失败留本地，下次重试）
```

## 为什么闪退不怕

手表应用闪退是常态，所以这里**不做内存里的状态**：

| 事件 | 落盘时机 |
|---|---|
| 完成一组 | `completeSet()` 里立即写 `session_state`（含训练位置）|
| 休息开始 | 写的是**绝对时间戳** `restUntil`，不是"还剩几秒" |
| 心率 | 累计值随每 10 秒的 flush 写入 |

重新打开应用时（`pages/Workout` 的 `onInit`）读回状态：

- 训练位置、已完成组数、心率累计 → 原样恢复
- 休息**还在进行** → 倒计时接着走（因为存的是时间戳，不是剩余秒数）
- 休息**在应用没运行时已经结束** → 补一次震动提醒，然后清掉
- 结束时上传失败的会话 → 存在 `pending_sessions`，每次启动 `flushPending()` 重试

## 目录

```
manifest.json          应用声明：路由、features、心率权限
src/app.ux             入口
src/pages/Index/       开始页（今天的安排 / 继续训练）
src/pages/Workout/     训练页（完成一组、倒计时、心率热量）
src/lib/session.js     会话状态机 + 落盘（防闪退核心）
src/lib/cloud.js       网络：拉配置、推会话、失败重试
src/lib/sensors.js     心率订阅 + 震动
```

## 部署前改一行

`src/lib/cloud.js` 顶部：

```js
export const WORKER_URL = 'https://你的worker.workers.dev'
export const TOKEN = '你设置的口令'
```

## 用 BlueOS Studio 构建、装到手表

1. 装 [BlueOS Studio](https://studio.blueos.com.cn/install)（官方 IDE，Windows 可用），同时装 Node.js
2. Studio → 打开工程 → 选这个 `watch-app` 目录 → 安装依赖
3. 右侧模拟器直接能跑（先看界面和倒计时逻辑）
4. 真机：菜单里构建 `rpk` 包，用调试包装到自己手表上（个人使用走调试安装；正式分发需要在 vivo 开放平台签名）
5. 手表型号要求：跑**蓝河系统**的手表（WATCH 3 / WATCH GT 这类），手环不支持第三方应用

## 已知限制（都实测过原因）

- **没有屏幕常亮 API**：训练中屏幕会按系统超时熄灭，倒计时看不见；靠"结束震动"和抬腕点亮解决
- **息屏时心率可能停采**：心率传感器不在蓝河的后台接口清单里，所以均值/最大是"亮屏期间采样"的结果；热量按这个均值估算，够"大概数据"用
- 手表连不上网时不影响训练：数据先落本地，下次启动自动补传
