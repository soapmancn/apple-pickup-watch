# apple-pickup-watch

iPhone 18 Pro Max 深圳三家 Apple Store 到店库存监控，部署在 Cloudflare Workers + Durable Objects 上。

- **全球边缘 IP 轮换抓取** — Apple 不会因为同一 IP 高频请求而 541
- **SSE 实时推送** — 浏览器一打开就接到推送，无轮询
- **浏览器原生通知 + 提示音 + title 闪烁** — 有货立刻响3 声"哔-哔-哔"
- **完全免费** — Workers 免费层 100k 请求/天；默认每 2 分钟检测，也可用环境变量修改

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

## 配置项（Cloudflare 环境变量）

部署后打开 Cloudflare Dashboard：

**Workers & Pages → `apple-pickup-watch` → Settings → Variables and Secrets → Add variable**

所有变量都是可选的；不设置时继续使用当前的深圳三店、6 个 iPhone 18 Pro Max SKU 和 2 分钟间隔。

| 变量 | 作用 | 默认值/格式 |
|---|---|---|
| `CHECK_INTERVAL_MINUTES` | 实际库存检测间隔 | 整数 `1`–`1440`，默认 `2`；Cloudflare 最快 1 分钟 |
| `MONITOR_LOCATION` | Apple 查询位置或邮编 | 默认 `518000` |
| `MONITOR_STORES_JSON` | 要监控的门店 | 非空 JSON 数组 |
| `MONITOR_PRODUCTS_JSON` | SKU、型号、容量、颜色和购买页 | 非空 JSON 数组 |

### 门店变量示例

变量名：`MONITOR_STORES_JSON`

```json
[{"store_number":"R761","store_name":"深圳万象城","city":"深圳"},{"store_number":"R484","store_name":"深圳益田假日广场","city":"深圳"},{"store_number":"R793","store_name":"前海壹方城","city":"深圳"}]
```

每项必须有 `store_number`；`store_name`、`city`、`state`、`address` 可选。

### 手机型号与容量变量示例

变量名：`MONITOR_PRODUCTS_JSON`

```json
[{"part_number":"MJY84CH/A","model":"iPhone 18 Pro Max","capacity":"256GB","color":"勃艮第酒红色","purchase_url":"https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy84ch/a"},{"part_number":"MJYD4CH/A","model":"iPhone 18 Pro Max","capacity":"512GB","color":"勃艮第酒红色","purchase_url":"https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyd4ch/a"}]
```

每项必须有 `part_number`、`model`、`capacity`；`color` 和 `purchase_url` 可选。

保存变量后，在 **Deployments** 中重新部署最新版本使配置立即生效。页面上的“监控间隔”、门店、型号、容量和颜色会自动使用这些变量。

> `wrangler.toml` 设置了 `keep_vars = true`，所以通过 Cloudflare Dashboard 修改的变量不会在下一次 Git 自动部署时被删除。Cron 每分钟唤醒一次 Worker，但只有达到 `CHECK_INTERVAL_MINUTES` 时才请求 Apple。

## 架构

```
                 ┌────────────────────────────────┐
                 │ Cloudflare Worker (cron 1min)  │
                 │   src/index.js                 │
                 └───────┬───────────────────────┘
                         │ fetch + ingest
                         ▼
┌────────────────────────────────┐
│ Durable Object "Room"          │
│   src/room.js                  │
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

**为什么用 DO？** Cloudflare Workers 默认无状态，但 cron 抓到结果要广播给"所有当前打开的浏览器"——必须有一个长寿命的 actor 持有这些 SSE 连接。DO 是官方推荐的 fanout 出口。

**为什么默认 2 分钟？** Workers 免费层 Cron 最小粒度是 1 分钟。Cron 每分钟唤醒，但默认 `CHECK_INTERVAL_MINUTES=2`，因此 Apple 请求仍是每 2 分钟一次；需要时可以把变量改为 1 或更大的整数。

**为什么 cron 唤醒 DO？** 定时查询会把最新状态写入 DO，浏览器打开后可直接读取，并通过 SSE 接收后续变化。

## 隐私 / 费用

- **代码**：开源（仓库公开），但你账户下的部署是私有的
- **日志**：Workers 自带的 `observability` 已开启（`wrangler.toml` 里有 `[observability]`），可以看请求数；不存任何用户数据
- **费用**：完全在 Workers 免费层（100k 请求/天）+ Durable Objects 免费层（1M 请求/天）。算下来 1 个月大概几十次 cron + 几十次浏览器拉取，0 美元

## License

MIT — 自用自改，保留作者注释即可。