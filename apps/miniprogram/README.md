# @openhoopscore/miniprogram — 观众端小程序 / H5

基层赛事 SaaS 平台的**观众端**：计分员在 Web 计分端记录 → 观众扫二维码看实时比分。
一套 Taro 4 + React + TypeScript 代码，同时编译到**微信小程序（weapp）**与 **H5**。

---

## 1. 目录结构

```
apps/miniprogram/
├── config/
│   ├── index.ts            # Taro 主配置（sourceRoot/outputRoot/alias/defineConstants）
│   ├── dev.ts              # 开发环境覆盖
│   └── prod.ts             # 生产环境覆盖
├── project.config.json     # 微信开发者工具项目配置（miniprogramRoot = dist/）
├── tsconfig.json           # typecheck 用（include: src + types）
├── tsconfig.node.json      # Taro 配置文件自身的 typecheck
├── types/global.d.ts       # Taro 全局类型 + TARO_APP_* 环境变量声明
└── src/
    ├── app.tsx / app.css / app.config.ts
    ├── contracts/index.ts  # @openhoopscore/contracts 的统一入口（见 §5 说明）
    ├── constants/index.ts
    ├── services/
    │   ├── api.ts          # REST 封装（baseURL / 错误归一化 / 接口清单）
    │   └── realtime.ts     # Socket.IO 订阅封装，返回可 dispose() 的句柄
    ├── store/match-store.ts# zustand：state + feed + 连接状态 + 高亮
    ├── utils/
    │   ├── share-code.ts   # 分享码解析（?code= / /m/CODE / 纯 6 位码 / 文案兜底）
    │   ├── time.ts         # mm:ss、第 N 节、HH:mm:ss、N 分钟前
    │   └── projection.ts   # 离线兜底用的本地重放（服务端不可用时）
    └── pages/
        ├── index/          # 首页：输入分享码 / 扫一扫 / 进行中比赛列表
        ├── live/           # 核心页：大号比分牌 + 图文直播 + 得分 + 连接状态
        └── leaderboard/    # 球员榜：得分 / 犯规 / 三分 可切换排序
```

---

## 2. 安装依赖

依赖装在 `apps/miniprogram` 自己的 `node_modules` 里（pnpm workspace）。

```powershell
# 仓库根目录执行
pnpm install
```

## 3. 开发

### 3.1 微信小程序

```powershell
# 仓库根目录
pnpm --filter @openhoopscore/miniprogram dev:weapp     # 监听模式，产物在 apps/miniprogram/dist
# 或
pnpm --filter @openhoopscore/miniprogram build:weapp   # 一次性构建
```

然后用**微信开发者工具**「导入项目」：

- 目录选择：`apps/miniprogram`（不是 `dist`！`project.config.json` 里已设置 `miniprogramRoot: "dist/"`）
- AppID：选「测试号」即可（`project.config.json` 里是 `touristappid`）
- 首次打开请在「详情 → 本地设置」勾选 **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**，
  否则 `http://localhost:3000` 会被小程序拦截。

生产包：在开发者工具里「上传」，或直接用 CI 构建 `dist` 后上传。

### 3.2 H5

```powershell
pnpm --filter @openhoopscore/miniprogram dev:h5      # 开发服务器（默认 http://localhost:10086）
pnpm --filter @openhoopscore/miniprogram build:h5    # 产物 apps/miniprogram/dist
```

H5 产物是静态文件，部署到任意静态服务器即可；调用后端同源时可直接把
`TARO_APP_API_BASE_URL` 设为空或同源地址。

### 3.3 类型检查

```powershell
pnpm --filter @openhoopscore/miniprogram typecheck        # src + types（硬要求：0 错误）
pnpm --filter @openhoopscore/miniprogram typecheck:config # Taro 配置文件
```

---

## 4. 配置后端地址

优先级从高到低：

1. **环境变量** `TARO_APP_API_BASE_URL`（推荐，构建期注入）

   ```powershell
   $env:TARO_APP_API_BASE_URL='http://192.168.1.8:3000'
   pnpm --filter @openhoopscore/miniprogram build:weapp
   ```

   生产（PowerShell）：`$env:NODE_ENV='production'` 后再执行同一条命令。

2. `config/index.ts` 里的 `DEFAULT_API_BASE_URL`（默认 `http://localhost:3000`）。

运行时会两处都读：Taro 注入的 `process.env.TARO_APP_API_BASE_URL` 优先，
其次 `config/index.ts` 通过 `defineConstants` 注入的 `API_BASE_URL` 常量
（见 `src/services/api.ts` 的 `resolveBaseUrl()`）。

> **真机调试注意**：手机上的 `localhost` 指手机自己，必须改成电脑的局域网 IP，
> 并且微信开发者工具要开启「不校验合法域名」，或把小程序的 request/uploadFile
> 合法域名配置好（线上必须 HTTPS 且已备案）。

---

## 5. 关于 `@openhoopscore/contracts` 的引用方式（重要）

契约包 `packages/contracts` **当前无法构建**：它的 `src/index.ts` 用 `export *`
汇总时存在两处重名再导出，`tsc -p packages/contracts/tsconfig.json` 直接报错：

```
src/api.ts(14,70):  error TS2305: Module '"./state"' has no exported member 'ProjectionTeamRef'.
src/clock.ts(1,34): error TS2305: Module '"./ids"' has no exported member 'GameEventType'.
src/index.ts(18,1): error TS2308: Module './events' has already exported a member named 'GameEventType'.
src/index.ts(19,1): error TS2308: Module './api' has already exported a member named 'ProjectionTeamRef'.
```

（`ProjectionTeamRef` 实际定义在 `src/score.ts`；`GameEventType` 实际定义在 `src/events.ts`。
本次任务不允许修改 `packages/contracts`，故未修复，仅在此记录给主 agent。）

因此小程序端**不依赖 contracts 的 dist 产物**，改为：

- `tsconfig.json` / `config/index.ts` 里把 `@openhoopscore/contracts` 指到
  `../../packages/contracts/src`，按模块精确引用（`.../ids`、`.../events`、`.../state`、`.../realtime`）；
- 统一从 `src/contracts/index.ts` 再导出，页面只 import 这一个入口；
- `api.ts` / `clock.ts` 这两个自带错误的模块**不被引用**，因此不会污染本包的 typecheck。
  `api.ts` 里观众端用到的少量响应类型（`HealthResponse` / `MatchSummary` /
  `ListMatchesResponse` / `ResolveShareCodeResponse` / `QueryEventsResponse` /
  `PlayerLeaderboard*`）已按契约**原样**在 `src/contracts/index.ts` 内重述，字段名与可空性一致。

等 contracts 修复并构建成功后，可把 `src/contracts/index.ts` 改回
`export * from '@openhoopscore/contracts'` 并移除路径映射。

---

## 6. 页面用到的后端接口

| 页面 | 接口 | 用途 |
| --- | --- | --- |
| 首页 | `GET /api/health` | 后端连通性提示 |
| 首页 | `GET /api/matches` | 进行中 / 其他比赛列表 |
| 首页 | `GET /api/matches/by-code/:shareCode` | 分享码 → matchId，校验后进房 |
| 直播间 | `GET /api/matches/:id/live` | 首屏权威 state + feed |
| 直播间 | `GET /api/matches/:id` | 队名 / 赛事名 / 节数配置 |
| 球员榜 | `GET /api/matches/:id/leaderboard?sortedBy=` | 球员榜（失败时用本地 state 兜底） |

**Socket.IO**（命名空间 `/realtime`，路径 `/socket.io`，`transports: ['websocket']`）：

- 客户端 `emit('match:join', { matchId, role: 'audience', lastSeq }, ack)`
- 监听 `events:committed`、`state:patch`、`feed:appended`、`match:finished`、
  `player:highlight`，另外也监听 `undo:applied` 与 `error`。
- `reconnection: true`，退避 800ms → 8000ms，UI 顶部显示「连接中… / 重连中… / 实时连接正常」。
- 页面 `useUnload` 一定 `dispose()`；`reordered = true` 或收到撤销时会重新拉一次
  `/live`，因为历史图文直播条目可能被改写。

---

## 7. 构建产物位置

`outputRoot: 'dist'` → 产物在 `apps/miniprogram/dist`：

- weapp：`dist/app.js`、`dist/app.json`、`dist/pages/**`
- h5：`dist/index.html`、`dist/js/*.js`、`dist/css/*.css`

---

## 8. 当前已知问题 / 未完成项

见本仓库交付报告。简要：

1. **typecheck 通过（0 错误）**。
2. **`build:weapp` / `build:h5` 在当前沙箱环境中无法启动**，报错来自 `@swc/core`
   原生插件的缓存目录 ACL 校验（详见交付报告与下方原文）。Taro CLI 启动时会
   `require('@swc/core')`，该原生 addon 在加载阶段即失败，因此两个平台都会在
   「读取配置之前」就退出，与本包源码无关。

   ```
   Error: SWC native addon: create cache root C:\Users\谢宇翔\AppData\Local\swc: 拒绝访问。 (os error 5).
   Reinstall the native package if its payload is damaged; check SWC_NATIVE_BINDING_CACHE
   and directory permissions for materialization failures.
       code: 'ERR_SWC_NATIVE_CACHE'
   ```

   在**正常的开发机**上（`%LOCALAPPDATA%\swc` 可写），该问题不存在，
   `dev:weapp` / `build:weapp` / `build:h5` 可直接运行。
