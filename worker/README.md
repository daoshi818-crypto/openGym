# 训练助手 · 云端中转站（Cloudflare Worker）

手表上传训练会话 → 存 KV → 导出 openGym 能直接导入的 CSV。免费层足够个人使用。

```
GET  /config       手表启动时拉训练安排（profile + 今天的动作清单）
POST /session      手表结束时上传（幂等：同一个 id 重复上传只覆盖）
GET  /export.csv   导出全部会话为 openGym CSV（手机浏览器打开即可下载）
```

所有请求都要带 `?token=XXX`（与 secret `GYM_TOKEN` 一致）。

## 部署（约 5 分钟，全程免费）

```bash
cd worker
npm install -g wrangler      # 只需一次
npx wrangler login           # 浏览器授权自己的 Cloudflare 账号

# 建 KV 存储，把输出的 id 填进 wrangler.toml 的 kv_namespaces
npx wrangler kv namespace create GYM_KV

npx wrangler secret put GYM_TOKEN    # 设一个自己的口令，随便一串字符
npx wrangler deploy
```

部署完把地址和口令填进手表应用的 `src/lib/cloud.js`。

## 本地测试

```bash
npm test        # 跑通 鉴权 → 配置 → 上传 → 导出 CSV 全链路（不需要 Cloudflare）
npm run dev     # 本地起服务，用 curl 试
```

## 改训练安排

`default-config.json` 是手表看到的计划，结构：

```json
{
  "profile": { "age": 30, "weight": 73.25, "sex": "male" },   // 热量估算用
  "workout": {
    "name": "背",
    "exercises": [
      { "name": "反手高位下拉", "gym": "cable underhand pulldown",
        "sets": 4, "reps": "12", "restSec": 60, "weight": "35" }
    ]
  },
  "allWorkouts": [ ... ]   // 其他训练日，手表后续可切换
}
```

- `name` 是手表上显示的中文名，`gym` 是 openGym 动作库里的英文名（**导出 CSV 时用它匹配动作，别删**）
- 现在这份是从练练健身的历史记录生成的（15 个训练日）
- 改完重新部署：`npx wrangler deploy`；或者放进 KV 覆盖默认值：

```bash
npx wrangler kv key put config --binding GYM_KV --path default-config.json --remote
```

## 数据流到 openGym

1. 手表练完 → 会话进 KV
2. 手机浏览器打开 `https://你的worker.workers.dev/export.csv?token=口令` → 下载 CSV
3. openGym → 设置 → 数据与备份 → 从其他 App 导入 → 选这个文件
   （导入按天去重，重复导入不会重复记；心率/时长/热量写在备注里）
