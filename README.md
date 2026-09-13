# apple-pickup-watch

Apple 中国到店库存监控，部署在 Cloudflare Workers + Durable Objects 上；间隔、店铺、型号、容量和颜色均在网页选择。

- **云端定时抓取** — 不依赖电脑开机，失败会记录在网页日志
- **SSE 实时推送** — 浏览器一打开就接到推送，无轮询
- **浏览器原生通知 + 提示音 + title 闪烁** — 有货立刻响3 声"哔-哔-哔"
- **完全免费** — 默认每 120 秒检测，可直接在网页调整

## 一键部署（5 分钟）

### 前置

- 一个 Cloudflare 账号（没账号：https://dash.cloudflare.com/sign-up 免费）
- Node.js 18+ （用来跑 `wrangler`）

### 步骤

> 想跳过本地环境直接部署？点下面按钮，从 GitHub 一键导入到 Cloudflare Workers：
>
> [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fworkers-and-pages%2Fcreate)
>
> 点击后会进入截图所示的 Cloudflare **Create an app → 选择一种方法** 页面。接着：
>
> 1. 点击 **Continue with GitHub**
> 2. 选择仓库 `soapmancn/apple-pickup-watch`
> 3. 项目名称填写 `apple-pickup-watch`
> 4. 构建命令留空
> 5. 部署命令填写 `npx wrangler deploy`
> 6. 点击 **部署**

#### 或者本地手动部署

```bash
# 1. 克隆仓库
git clone https://github.com/soapmancn/apple-pickup-watch.git
cd apple-pickup-watch

# 2. 安装 wrangler
npm install -g wrangler

# 3. 登录 Cloudflare（会打开浏览器授权）
wrangler login

# 4.（可选）设置 ADMIN_KEY，让你能伪造有货事件来测试通知
#    不设也没事，只是没有 /api/test-stock 调试入口
wrangler secret put ADMIN_KEY
# 然后在终端输入一个随机字符串，回车

# 5. 部署
wrangler deploy
```

部署成功后会输出一个 URL，类似：

```
Published apple-pickup-watch (X.XX sec)
  https://apple-pickup-watch.YOUR-SUBDOMAIN.workers.dev
```

直接打开它 → 点右上角蓝色按钮「启用浏览器通知 + 提示音」一次 → 完成。

## 用法

| URL | 说明 |
|---|---|
| `/` | 仪表盘（每个用户看到的都相同） |
| `/api/state` | JSON 当前状态 |
| `/api/log` | JSON 最近 100 条 tick 日志（newest-first） |
| `/api/settings` | `GET` 读取网页配置；`POST` 保存并立即重排 Alarm |
| `/api/stream` | SSE 实时事件流（推送`new-available`、`state`） |
| `/healthz` | 健康检查端点（永远返回 200） |

### 测试通知（不真的等苹果补货）

```bash
curl -X POST https://apple-pickup-watch.YOUR-SUBDOMAIN.workers.dev/api/test-stock \
  -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"part_number":"MJYD4CH/A","store_number":"R793"}'
```

打开 dashboard 的浏览器标签页会立刻收到通知 + 3 声哔 + title 闪烁。

## 网页配置

部署后直接打开 Worker 地址，展开 **⚙️ 监控设置**，即可在网页上完成全部配置：

- 输入监控间隔，单位为秒（10–86400 秒，默认 120 秒）
- 输入查询位置或邮编（默认 `518000`）
- 勾选要监控的 Apple Store
- 勾选手机型号、容量与颜色
- 点击 **保存并立即检测**

设置会保存在 Durable Object 中，并立即安排下一次库存检测，不需要修改代码、环境变量或重新部署。当前内置选项是深圳三家 Apple Store 和 6 个 iPhone 18 Pro Max SKU。

如果部署时设置了 `ADMIN_KEY`，在网页的“设置密码”输入框中填写该值后再保存；没有设置 `ADMIN_KEY` 时留空即可。

## 架构

```
                 ┌────────────────────────────────┐
                 │ Cloudflare Worker (watchdog)  │
                 │   src/index.js                 │
                 └───────┬───────────────────────┘
                         │ fetch + ingest
                         ▼
┌────────────────────────────────┐
│ Durable Object "Room"          │
│   src/room.js                  │
│   - 网页监控设置              │
│   - 秒级 Alarm 调度           │
│   - latest observation         │
│   - previous_available set     │
│   - log ring buffer            │
│   - SSE subscribers            │
└───────┬────────────────────────┘
        │ SSE fanout
        ▼
   Browser EventSource('/api/stream')
        │ 收到 new-available
        ▼
   Notification + beep(3) + title 闪烁
```

**为什么用 DO？** Cloudflare Workers 默认无状态；网页设置、库存状态、秒级 Alarm 和浏览器 SSE 连接都由同一个 `Room` Durable Object 持有。

**为什么 Cron 仍是每分钟？** Cron 仅作为看门狗，在 Alarm 丢失时重新创建；真正的 Apple 库存查询由 Durable Object Alarm 按网页设置的秒数执行。

**为什么最低 10 秒？** Alarm 支持按毫秒时间戳调度，但过高频率容易触发 Apple 限流。项目限制为 10–86400 秒。

## 隐私 / 费用

- **代码**：开源（仓库公开），但你账户下的部署是私有的
- **日志**：Workers 自带的 `observability` 已开启（`wrangler.toml` 里有 `[observability]`），可以看请求数；不存任何用户数据
- **费用**：默认 120 秒约 720 次查询/天；即使设为 10 秒也约 8640 次/天，仍低于 Workers 免费层 100k 请求/天和 Durable Objects 免费额度

## License

MIT — 自用自改，保留作者注释即可。