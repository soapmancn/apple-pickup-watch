# apple-pickup-watch

Apple 中国到店库存监控，部署在 Cloudflare Workers + Durable Objects 上；间隔、店铺、型号、容量和颜色均在网页选择。

- **云端定时抓取** — 不依赖电脑开机，失败会记录在网页日志
- **任意城市 · 任意 iPhone 型号/容量/颜色** — 网页搜索 + 手动输入 part_number，Apple 在售 5 个 family 全部支持
- **秒级间隔（10–86400）** — Durable Object Alarm 按网页配置自调度，失败指数退避
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
| `/api/settings` | `GET` 读取网页配置 + catalogue；`POST` 保存并立即重排 Alarm |
| `/api/catalog` | `GET` 读取缓存的 catalogue；`POST` 强制刷新（`{"products":true,"stores":true,"location":"510000"}`） |
| `/api/search/products?q=iPhone+17` | 搜索在售 SKU 列表（family 详情） |
| `/api/search/stores?q=510000` | 查询邮编/城市附近 Apple Store |
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

- **监控间隔**：秒级（10–86400 秒，默认 120 秒）
- **查询位置 / 邮编**：任意城市、邮编或地址（例如 `518000`、`100000`、`510000`、`200000`）
- **📱 手机型号 / 容量 / 颜色**：
  - **方式 A**：在搜索框输入关键字（`iPhone 17`、`512GB`、`勃艮第酒红`、`MG6W4`），点 **重新拉取** 让 Worker 从 Apple 官网拉取该 family 全部 SKU 并勾选
  - **方式 B（推荐 fallback）**：在 **"也可直接输入 Apple part_number"** 框直接粘贴（空格或逗号分隔），如 `MJY84CH/A MJYD4CH/A MG6W4CH/A`
- **📍 监控 Apple Store**：
  - **方式 A**：在搜索框输入城市或邮编（如 `上海`、`510000`），点 **重新搜索** 让 Worker 调 Apple `pickup-message` 获取附近所有门店并勾选
  - **方式 B（推荐 fallback）**：在 **"也可直接输入 Apple store_number"** 框直接粘贴（空格或逗号分隔），如 `R761 R484 R793 R448`
- **设置密码**（仅在 Cloudflare 配了 `ADMIN_KEY` 时填写）
- **保存并立即检测**：写入 Durable Object 并立即触发一次 Alarm

任意在售 iPhone family（`iphone-18-pro`、`iphone-air`、`iphone-17`、`iphone-17e`、`iphone-16`）和任意城市的 Apple Store 都可以选择；如果 catalogue 拉取被 Apple 反爬挡住，手动输入 part_number / store_number 仍能正常监控。

如果部署时设置了 `ADMIN_KEY`，在网页的"设置密码"输入框中填写该值后再保存；没有设置 `ADMIN_KEY` 时留空即可。

### 怎么知道 part_number 和 store_number？

- **part_number**（每个 SKU 唯一）：打开 `https://www.apple.com.cn/shop/buy-iphone/iphone-17`，URL 里 `iphone-17/mg6w4ch/a` 的 `mg6w4ch/a` 就是 part（统一大写为 `MG6W4CH/A`）；或直接调用 `GET /api/search/products?q=iPhone%2017` 让 Worker 返回该 family 全部 SKU。
- **store_number**（每家店唯一）：打开 `https://www.apple.com.cn/retail/...`，URL 里通常包含 `R761` / `R448` 等；或直接调用 `GET /api/search/stores?q=510000` 让 Worker 返回该邮编附近全部门店。

## 架构

```
                        Browser Dashboard (本仓库 public/index.html)
                                  │
                                  │ fetch /api/*
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker                                                │
│   src/index.js                                                   │
│   - 路由 /api/state /api/log /api/settings /api/stream           │
│            /api/catalog /api/search/products /api/search/stores   │
└───────┬──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│ Durable Object "Room"  (src/room.js, SQLite-backed)              │
│   - 网页配置：interval_seconds / location / store_numbers /      │
│              part_numbers                                         │
│   - 在售 catalogue：products[] stores[]（从 Apple 官网抓取）     │
│   - second-level Alarm 调度（含失败 backoff）                    │
│   - 历史 in-stock 集合 + 日志 ring buffer                         │
│   - SSE subscribers                                               │
└───────┬──────────────────────────────────────────────────────────┘
        │
        │ fetch https://www.apple.com.cn/shop/buy-iphone/<family>
        │       https://www.apple.com.cn/shop/retail/pickup-message
        ▼
                Apple CN（无需认证）
```

**为什么用 DO？** Cloudflare Workers 默认无状态；网页设置、库存状态、秒级 Alarm、catalogue 缓存和浏览器 SSE 连接都由同一个 `Room` Durable Object 持有。

**为什么用 SQLite DO？** Workers 免费计划从 2024 年起只接受 `new_sqlite_classes` 迁移，KV-backed DO 会触发 `code: 10097`。

**为什么 Cron 仍是每分钟？** Cron 仅作为看门狗，在 Alarm 丢失时重新创建；真正的 Apple 库存查询由 Durable Object Alarm 按网页设置的秒数执行。

**为什么最低 10 秒？** Alarm 支持按毫秒时间戳调度，但过高频率容易触发 Apple 限流（HTTP 541）。项目限制为 10–86400 秒；连续失败会自动 30→60→120→240→480→900 秒指数退避。

## 隐私 / 费用

- **代码**：开源（仓库公开），但你账户下的部署是私有的
- **日志**：Workers 自带的 `observability` 已开启（`wrangler.toml` 里有 `[observability]`），可以看请求数；不存任何用户数据
- **费用**：默认 120 秒约 720 次查询/天；即使设为 10 秒也约 8640 次/天，仍低于 Workers 免费层 100k 请求/天和 Durable Objects 免费额度

## License

MIT — 自用自改，保留作者注释即可。