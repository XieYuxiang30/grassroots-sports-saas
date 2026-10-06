# 部署与现场运维手册

---

## 一、三种部署方式怎么选

| 方式 | 适用 | 优点 | 代价 |
|------|------|------|------|
| **一体化镜像**（推荐） | 腾讯云轻量 / 任意一台能跑 Docker 的机器 | 一个容器、一个端口、同源无跨域；现场手机连局域网就能用 | 需要 Docker |
| 分离部署 | 前端 Vercel + 后端云服务器 | 前端全球 CDN、免费额度 | 要配 CORS、两个域名；现场网络差时跨域更易出问题 |
| 直接跑 Node | 临时演示 / 开发 | 零 Docker | 要自己管进程与开机自启 |

> **现场建议**：基层赛事往往就在街道体育馆，网络条件差。一体化镜像 + 场馆本地一台
> 小主机（甚至一台笔记本）跑起来，比任何云端方案都稳 —— 观众走局域网，根本不经过公网。

---

## 二、一体化镜像部署（推荐）

### 2.1 构建与运行

```bash
# 构建
docker build -t openhoopscore:1.0.0 .

# 运行（json 文件存储，零额外依赖）
docker run -d --name hoop \
  -p 3000:3000 \
  -e SCORER_PASSCODE='换成你自己的口令' \
  -e CORS_ORIGINS='*' \
  -v hoop-data:/app/data \
  --restart unless-stopped \
  openhoopscore:1.0.0
```

打开 `http://<服务器IP>:3000` 就是完整站点（前端静态产物由后端托管）。

### 2.2 用 PostgreSQL（生产推荐）

```bash
docker compose --profile full up -d postgres

# 等 postgres 健康后执行迁移
docker run --rm --network host \
  -e DATABASE_URL='postgresql://hoop:hoop_dev_pw@127.0.0.1:5432/openhoopscore?schema=public' \
  openhoopscore:1.0.0 \
  node -e "require('child_process').execSync('node apps/api/dist/src/main.js', {stdio:'inherit'})"
```

更省事的做法是用 compose 起 api，并把 `STORAGE_DRIVER` 设为 `prisma`
（`docker-compose.yml` 已经写好，改环境变量即可）：

```bash
STORAGE_DRIVER=prisma docker compose --profile full up -d
```

首次部署别忘了建表与灌种子数据：

```bash
# 在宿主机（有 pnpm 与源码）执行
pnpm install
pnpm --filter @openhoopscore/api db:deploy   # 建表
pnpm --filter @openhoopscore/api db:seed     # 可选：一场可直接计分的种子比赛
```

### 2.3 反向代理与 HTTPS（可选）

现场用局域网 IP 时不需要 HTTPS。要挂域名并上 HTTPS，Caddy 两行就行：

```caddyfile
hoop.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Socket.IO 走的是同域 `/socket.io`，Caddy/Nginx 默认会做 WebSocket 升级透传。
若用 Nginx，关键是这两行：

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket 升级必须
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;                     # 现场网络慢，别过早断
}
```

---

## 三、分离部署（Vercel + 云服务器）

仓库自带的 `vercel.json` 已配好：构建 `apps/web`、输出 `apps/web/dist`、
SPA rewrites（`/m/ABC123` 刷新不会 404）、静态资源长缓存、`sw.js` 不缓存。

```bash
# Vercel 侧环境变量
VITE_API_BASE_URL=https://api.your-domain.com
```

后端侧要放开跨域：

```bash
CORS_ORIGINS=https://your-app.vercel.app,https://hoop.example.com
```

**注意**：分离部署时 Socket.IO 的地址来自 `VITE_API_BASE_URL`，
所以必须填**完整可访问地址**（带 `https://`），否则 WebSocket 会连到 Vercel 域名上。

---

## 四、环境变量速查

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3000 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `NODE_ENV` | development | `production` 时关闭 Swagger、启用静态托管默认值 |
| `SCORER_PASSCODE` | hoop2024 | **生产必须改**；`/api/config/public` 会暴露「是否仍是默认值」 |
| `CORS_ORIGINS` | * | 逗号分隔；同源部署不需要配 |
| `STORAGE_DRIVER` | json | `json` / `prisma` / `memory` |
| `DATA_DIR` | ./data | json 驱动的数据目录 |
| `DATABASE_URL` | — | `STORAGE_DRIVER=prisma` 时必填 |
| `SOCKET_PING_INTERVAL` | 20000 | 心跳间隔（ms），弱网可放宽 |
| `SOCKET_PING_TIMEOUT` | 25000 | 心跳超时（ms） |
| `MAX_EVENTS_PER_MATCH` | 20000 | 单场事件上限（防刷） |
| `MAX_SYNC_BATCH` | 500 | 单次离线补传上限 |
| `SERVE_WEB_ASSETS` | 非生产为 false | 是否托管前端静态产物 |
| `WEB_DIST_DIR` | ../web/dist | 前端产物目录 |

---

## 五、现场运维手册

### 5.1 赛前 10 分钟检查清单

```bash
# 1) 后端活着，且存储驱动符合预期
curl -s http://localhost:3000/api/health

# 2) 口令不是默认值（生产环境）
curl -s http://localhost:3000/api/config/public
#    → "scorerPasscodeIsDefault": false

# 3) 比赛列表能读出来
curl -s http://localhost:3000/api/matches | head -c 400

# 4) 手机连场馆 Wi-Fi，扫码确认能打开 /live/:matchId
```

再加两件不靠命令的事：

- **计分平板**：提前打开 `/score/:matchId`，确认顶部状态是「已连接 · 实时同步中」；
- **大屏**：提前打开 `/display/:matchId`，确认二维码与分享码显示正确。

### 5.2 现场断网了怎么判断

计分台顶部状态条是唯一权威指示：

| 显示 | 含义 | 该做什么 |
|------|------|---------|
| 已连接 · 实时同步中 | 一切正常 | 正常计分 |
| 离线记录中 · N 条待同步（正在补传） | 网络抖动，本地在攒 | **继续计分**，别退出页面 |
| 未连接服务器 · 记录会先存在本机 | 彻底断了 | 继续计分；不要清浏览器数据、不要关标签页 |
| 存储：localStorage / 内存 | IndexedDB 不可用（隐私模式等） | 容量有限，尽快恢复网络；换一个正常窗口更稳 |

**关键原则**：断网时计分员**什么都不用做**。事件已落本地，
恢复网络后自动幂等补传。反复刷新页面才是唯一会丢数据的操作
（如果队列已经成功落盘，刷新也不会丢；但没落盘完成就刷新会有风险）。

### 5.3 多台设备同时在计分

计分台会显示「N 台设备在计分」的提示。这是**风险信号**：

- 两台平板同时计分会各自产生事件，服务端按客户端时间戳合并，
  可能出现「同一球员两次得分」重复录入；
- 正确做法：**只让一台设备计分**，另一台作为备用（备用机不要打开计分台）。

真要并行操作时，靠撤销兜底：各自都能撤掉自己记错的那一步。

### 5.4 点错了怎么撤

1. 计分台顶部「↩ 撤销上一步」按钮，旁边会显示**具体要撤什么**
   （如「撤销 张三（主队） 的 3 分（第2节）」），确认再点；
2. 连点错误时先撤一步看比分对不对，再继续撤；
3. 断网时也能撤 —— 本地会追加一条 `void` 事件，联网后随队列一起补传。

撤销**不删除历史**。赛后可以完整复盘「谁在什么时候撤销了什么」。

### 5.5 备份与迁移

**json 驱动**：

```bash
# 备份（数据就是一个文件）
docker cp hoop:/app/data/hoop-store.json ./backup-$(date +%F).json

# 恢复
docker cp ./backup-2024-06-01.json hoop:/app/data/hoop-store.json
docker restart hoop
```

**prisma 驱动**：

```bash
docker exec hoop-postgres pg_dump -U hoop openhoopscore > backup-$(date +%F).sql
```

**json → PostgreSQL 迁移**：`hoop-store.json` 的结构与 Prisma 模型一一对应
（`seasons` / `matches` / `teams` / `players` / `events` / `syncBatches`），
按表逐个导入即可。注意 `events` 是嵌套的 `{ matchId: GameEvent[] }`。

### 5.6 常见故障

| 现象 | 原因 | 处理 |
|------|------|------|
| 页面能开但比分不动 | WebSocket 被中间设备掐断 | 正常，Socket.IO 会自动降级长轮询；若一直不动，检查反向代理是否透传 `Upgrade` |
| 观众端一直「连接中…」 | 后端挂了 / 跨域被拦 | `curl /api/health`；分离部署时检查 `CORS_ORIGINS` |
| 计分台提示「计分口令不正确」 | 口令被改或输错 | 向管理员索取；口令存在浏览器 localStorage，清掉可重新输入 |
| 补传后比分跳变 | `reordered` 触发了重排 | 这是**正确行为**：离线事件插回了正确的时间位置。页面会自动重新对齐 |
| 数据文件损坏 | 磁盘故障 / 手改文件 | 服务会把损坏文件改名为 `hoop-store.json.corrupt-<时间戳>` 并空库启动；用备份恢复 |
| `scorerPasscodeIsDefault: true` | 还在用默认口令 | **立即修改 `SCORER_PASSCODE`** |

### 5.7 日志排查

后端日志里这三类关键词最有价值：

- `存储驱动：json（数据文件 /app/data/hoop-store.json）` — 启动时确认在写哪里；
- `比赛 <id> 有 N 条事件被拒绝` — 现场有脏事件进入，会带明细原因；
- `已连接 PostgreSQL` / `Socket.IO 实时通道已就绪` — 依赖就绪确认。

---

## 六、容量与性能参考

| 指标 | 参考值 | 说明 |
|------|--------|------|
| 单场事件数 | 200–600 条 | 4 节制、双方都记球员 |
| 单场事件上限 | 20000 条 | `MAX_EVENTS_PER_MATCH` |
| 单次补传上限 | 500 条 | `MAX_SYNC_BATCH` |
| 观众并发 | 数百级 | Socket.IO 单实例；再往上需要 Redis adapter |
| json 驱动适用规模 | 几十场比赛 / 几万条事件 | 再大请切 PostgreSQL |
| 广播延迟 | 局域网内 < 50ms | 现场体感是「点完就跳」 |

**需要横向扩展时**（多实例）：Socket.IO 需要 sticky session +
`@socket.io/redis-adapter`，并且必须切到 `STORAGE_DRIVER=prisma`
（json 驱动的文件锁只在单进程内有效）。这是 roadmap 里的一项。

---

## 七、前端白屏排障（实战记录）

### 症状

浏览器打开前端后是**空白页**，DevTools 控制台只有一行红色错误：

```
Uncaught SyntaxError: The requested module
'/node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js?v=xxxx'
does not provide an export named 'default'
```

### 根因

两件事叠加：

1. **`optimizeDeps.exclude` 把 `debug`（以及 `socket.io-client` 等）排除在依赖预构建之外。**
   `debug` 是 CommonJS 模块（`module.exports = debug`，**没有** `default` 导出）。
   Vite 的依赖预构建负责把 CJS 转成浏览器能用的 ESM；一旦被 `exclude` 掉，
   Vite 就把**源码原样**丢给浏览器，于是 ESM 加载器报「没有 default 导出」。
   验证方法：看 `apps/web/node_modules/.vite/deps/_metadata.json`，
   如果是 `"optimized": {}`，就说明什么都没预构建 —— 这正是故障状态。

2. **`debug` 在 monorepo 里存在多份**（2.6.9 / 4.3.6 / 4.3.7 / 4.4.3）。
   `express` 要 4.3.6、`socket.io-client` 要 ~4.3.2、`vite` 自己要 ^4.4.0。
   不去重时，Vite 可能把「A 副本的 browser.js」和「B 副本的导出形状」拼在一起，
   即使预构建能跑也会出现同类报错。

### 修复（已在仓库里生效）

| 位置 | 改动 |
|------|------|
| `apps/web/vite.config.ts` | 删除 `optimizeDeps.exclude`，改为 `include`（让依赖一定被预构建成 ESM） |
| `apps/web/vite.config.ts` | 增加 `resolve.dedupe: ['debug', 'react', 'react-dom', 'socket.io-client']` |
| `apps/web/vite.config.ts` | 增加 `esbuildOptions.define`，把 `process.env.NODE_ENV` / `process.env.DEBUG` 替换掉（debug 的浏览器实现会读它们，浏览器里没有 `process` 对象） |
| `apps/web/package.json` | 把 `debug` 固定为 `4.4.3`（与 vite 自身依赖范围一致） |

**改完必须重启 dev server**（`vite.config.ts` 的变化只在启动时读取；
即使开着 HMR 也不会自动应用）。

### 一句话规则

> 浏览器要用的依赖，只能 `optimizeDeps.include`，**永远不要 `exclude`**。
> `exclude` 只适用于「自己已经是 ESM 且不需要预构建」的包，
> 对 CommonJS 包使用它必然白屏。

### 验证是否修好

```bash
# 1) 依赖确实被预构建了（optimized 不为空）
cat apps/web/node_modules/.vite/deps/_metadata.json

# 2) 页面能打开，且控制台无红字
#    浏览器访问 http://localhost:5176/
```

### 改完配置后必须做的三步（否则会看到 504）

改完 `vite.config.ts` / `package.json` 后，如果只是刷新浏览器，会看到：

```
Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)
  react.js / react-dom_client.js / react_jsx-dev-runtime.js / socket__io-client.js / qrcode.js
```

**原因**：Vite 把「预构建结果」按 `browserHash` 编号。配置或依赖变化后，
服务端会重新预构建并换一个新的 hash，但**页面上仍然是旧 hash 的 URL**，
服务端找不到对应文件就返回 504（这是 Vite 的自我保护，不是崩溃）。
更麻烦的一种情况是：预构建中途失败，留下一个空的
`_metadata.json`（`"optimized": {}`），此时每个依赖都 504。

**正确顺序：**

```powershell
# ① 停掉正在运行的 dev server（Ctrl+C）
# ② 强制重新预构建并启动（--force 让优化器忽略缓存）
pnpm --filter @openhoopscore/web dev -- --force

# ③ 浏览器硬刷新清掉旧 hash 的模块缓存
#    Windows: Ctrl+Shift+R
```

`pnpm dev -- --force` 里的 `--` 是把参数透传给启动器；启动器会打印
`透传参数=--force` 以确认生效。不带 `--` 时 Windows PowerShell 会把
`--force` 当成 pnpm 自己的参数而报错，所以 `--` 不能省。

想看预构建到底做了什么，加 `--debug`：

```powershell
pnpm --filter @openhoopscore/web dev -- --force --debug
```

### 补充：预构建报 147 个 `Transforming destructuring ... is not supported yet`

如果 `--force` 之后控制台刷出大量这样的错误：

```
✘ [ERROR] Transforming destructuring to the configured target environment
  ("chrome87","edge88","es2020","firefox78","safari14") is not supported yet
    node_modules/debug/src/browser.js:260:6
      const { formatters } = module.exports;
            ^
Error: Build failed with 147 errors
```

**原因**：Vite 默认把依赖预构建的 target 设成那串较老的浏览器列表，
而 **esbuild 本身不支持**为了兼容它们而把解构语法降级 —— 这是 esbuild 的能力边界，
不是配置写错。预构建一旦失败，`optimized` 就是空的，随后每个依赖都 504、页面白屏。

**修法**（已在仓库里生效）：在 `optimizeDeps.esbuildOptions` 里显式设

```ts
optimizeDeps: { esbuildOptions: { target: 'esnext' } }
build: { target: 'esnext' }
```

代价是预构建产物不做语法降级，要求浏览器支持现代语法。
本项目面向近几年的平板/手机（微信内置浏览器、iOS Safari 15+、Android Chrome 100+），
完全满足。若将来要支持很老的设备，请引入 `@vitejs/plugin-legacy` 单独处理，
**不要**把这里的 target 压回去。

> 排查提示：看到「一大堆 esbuild ERROR」时不要立刻断定「esbuild 跑不起来」。
> 真正起不来的表现是只有一行 `Error: spawn EPERM`（创建子进程被拒）；
> 能打印出成百条具体语法错误，说明 esbuild 工作正常，问题在**配置**。

### 补充：`spawn EPERM` 与前端构建

如果你在**受限终端**（沙箱、部分企业策略环境）里启动前端，可能遇到：

```
Error: spawn EPERM
    at ensureServiceIsRunning (node_modules/esbuild/lib/main.js:...)
```

这是该终端**禁止创建「子进程 + 管道 stdio」**导致的 —— Vite 依赖预构建、
TS 转译、生产打包都靠 esbuild 驱动原生二进制，全部走这条管道路径。
**与项目代码无关**：换一个普通终端执行同样的命令即可。

排查建议：

1. 先在普通终端（不是沙箱/受限终端）里执行 `pnpm --filter @openhoopscore/web dev`；
2. 如果确实需要在该环境工作，用 `pnpm --filter @openhoopscore/web typecheck`
   与 `pnpm test:web-offline`（36 项断言）验证前端逻辑 —— 它们不依赖打包器；
3. 或者用 Docker 构建：`docker build -t openhoopscore .`
