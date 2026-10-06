# ============================================================================
# 基层赛事 SaaS 平台 —— 交付说明（先看这个）
# ============================================================================
#
# 本仓库是「方向二：基层赛事 SaaS 平台」的完整实现：
#   计分记录（可离线） → 实时展示（扫码即看） 的最小闭环，加上管理后台。
#
# 本文件面向接手的人，回答三个问题：
#   1. 怎么最快把它跑起来？
#   2. 每个目录是干什么的？
#   3. 有哪些**环境限制**必须先知道，否则会误判成「代码坏了」？
#
# ============================================================================

## 一、最快跑起来（零基础设施）

前置：Node.js ≥ 20.11、pnpm ≥ 9（仓库用 pnpm 11 开发）。

```bash
# 1) 安装依赖
pnpm install

# 2) 构建共享契约包（前后端都依赖它，必须先构建一次）
pnpm --filter @openhoopscore/contracts build

# 3) 启动后端（默认 json 文件存储，不需要 PostgreSQL）
pnpm --filter @openhoopscore/api start

# 4) 另开一个终端，启动前端开发服务器
pnpm --filter @openhoopscore/web dev
```

打开：

| 地址 | 用途 |
|------|------|
| http://localhost:5173 | 首页（三种角色共用入口） |
| http://localhost:5173/admin | 赛事管理后台：建比赛、录名单、拿二维码 |
| http://localhost:5173/score/:matchId | **计分端 PWA**（平板横屏用） |
| http://localhost:5173/live/:matchId | 观众端 H5（手机竖屏用） |
| http://localhost:5173/display/:matchId | 大屏比分牌（投影/电视用） |
| http://localhost:5173/m/:code | 观众扫码落地页（二维码里就是这个地址） |
| http://localhost:3000/docs | 后端接口文档（Swagger，仅非生产环境） |

计分口令默认 `hoop2024`（改 `SCORER_PASSCODE` 环境变量可覆盖）。

**最快验证一遍闭环**：后台建一场比赛 → 记分台点 +3 → 手机打开 `/live/:matchId` 看比分同步变化。

## 二、目录结构

```
.
├── packages/contracts/          跨端共享契约（唯一真相来源）
│   └── src/
│       ├── events.ts            GameEvents 事件模型（事件溯源核心表结构）
│       ├── clock.ts             确定性时钟：离线多设备合并规则
│       ├── score.ts             纯函数计分内核（前后端跑同一份）
│       ├── state.ts             实体与投影结果类型
│       ├── realtime.ts          Socket.IO 协议（事件名与载荷）
│       └── api.ts               REST 请求/响应类型
│
├── apps/api/                    NestJS 后端
│   ├── src/store/               存储层：memory / json / prisma 三个驱动 + 写入规划器
│   ├── src/scoring/             计分服务、比赛引擎（投影、直播文案、撤销栈）
│   ├── src/realtime/            Socket.IO 网关与广播收口
│   ├── src/matches/             赛事管理（赛季/比赛/球员）
│   ├── prisma/schema.prisma     PostgreSQL 数据模型（GameEvents 表）
│   └── test/                    42 条单元测试 + 12 条端到端测试
│
├── apps/web/                    前端（一个 SPA 承载三种角色）
│   └── src/
│       ├── offline/             ★ 离线优先：事件队列、本地投影、同步引擎
│       ├── services/api.ts      REST 客户端
│       ├── hooks/               实时订阅、本地存储
│       ├── pages/               首页/计分台/观众端/大屏/后台/扫码落地
│       └── components/          比分牌、分享二维码
│
├── apps/miniprogram/            小程序端（Taro 4 + React，微信小程序 + H5）
│
├── scripts/fix-node-modules.mjs 依赖补齐工具（见第三节限制 1）
├── Dockerfile                   一体化镜像（后端 + 前端静态产物）
└── docker-compose.yml           本机一键起服务（可选 PostgreSQL）
```

## 三、必须先知道的环境限制

### 限制 1：Windows 未开启「开发者模式」时，pnpm 的符号链接会失败

**症状**：`pnpm install` 一路绿色 Done，但运行时报
`Cannot find module 'uid'` / `'tslib'` / `'make-error'`，
或者构建时报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

**原因**：pnpm 默认用目录符号链接组织 node_modules。Windows 上创建符号链接
需要开启「开发者模式」或持有 `SeCreateSymbolicLinkPrivilege`，普通账户会 EPERM 失败。

**本仓库的处理**：`pnpm install` 的 `postinstall` 会自动运行
`scripts/fix-node-modules.mjs`。它读取每个包的依赖清单，从 pnpm 自己的
`.pnpm` 目录里按**语义化版本**解析出正确的那一份，用**目录联接（junction）**
补进各包 node_modules —— junction 在 Windows 上不需要任何特权。

判断是否需要手工修：

```bash
node scripts/fix-node-modules.mjs           # 正常应输出「依赖链接完整，无需修补」
node scripts/fix-node-modules.mjs --rebuild # 怀疑挂错版本时强制重建
```

如果某次安装后仍然报模块找不到，执行 `--rebuild` 即可。
（在 Linux/macOS 或已开启开发者模式的 Windows 上，pnpm 的符号链接本来就正常，这个脚本会空转。）

### 限制 2：受限环境里打包器起不来（spawn EPERM）

**症状**：`vite build` / `taro build` 报 `Error: spawn EPERM`，
堆栈里是 `esbuild/lib/main.js` 或 `@swc/core/binding.js`。

**原因**：esbuild、SWC 这类原生二进制由 JS 封装层通过**子进程 + 管道 stdio** 调用。
在禁止创建管道句柄的环境里（部分沙箱、企业安全策略、某些容器）这个 spawn 必然失败。

**这不是代码问题**，在同一台机器的普通终端里执行同样的命令即可成功。
为此仓库做了两件事：

1. `apps/web/scripts/vite-run.mjs`：绕过 Vite「用 esbuild 打包配置文件」这一步
   （改为进程内 `transformSync`），排除掉配置加载阶段的失败；
2. `apps/web/scripts/verify-offline-engine.mjs`：**不依赖任何打包器**，
   用 TypeScript 的进程内转译把前端真实的离线代码跑起来，并对着真实 API
   验证完整闭环（36 项断言）。打包器不可用时，用它来确认前端逻辑是对的：

```bash
pnpm --filter @openhoopscore/api build      # 先构建后端
pnpm test:web-offline
```

### 限制 3：PostgreSQL 不是必需的

默认 `STORAGE_DRIVER=json`，数据落在 `data/hoop-store.json`（原子写 + 写串行化）。
适合单场几百到几千条事件、几十场比赛的规模。
规模更大或需要多实例部署时切到 `STORAGE_DRIVER=prisma`：

```bash
docker compose --profile full up -d                    # 拉起 PostgreSQL
pnpm --filter @openhoopscore/api db:deploy             # 执行迁移
STORAGE_DRIVER=prisma pnpm --filter @openhoopscore/api start
```

## 四、常用命令

```bash
pnpm install                              # 安装依赖（含 junction 修补）
pnpm build                                # 构建 contracts + api + web
pnpm test                                 # 全部测试

pnpm --filter @openhoopscore/api test       # 42 条单元测试
pnpm --filter @openhoopscore/api test:e2e   # 12 条端到端测试（真实 HTTP + Socket.IO）
pnpm test:web-offline                       # 前端离线链路 36 项断言
pnpm typecheck                              # 四个包全部类型检查

pnpm --filter @openhoopscore/miniprogram dev:weapp   # 小程序端（需微信开发者工具）
```

> `pnpm build` 由 `scripts/build-all.mjs` 编排：它**不依赖 PATH 里的 pnpm**，
> 直接在 Node 进程内顺序调用各包的构建入口。前端构建失败时若判定为环境限制
> （见限制 2），会打印明确说明并以**退出码 2** 结束 —— 便于区分
> 「代码坏了」（退出码 1）与「环境不允许」（退出码 2）。
> 子进程输出统一走临时文件而不是管道，原因同样是受限环境禁止创建管道。

## 五、文档索引

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 架构与关键设计决策（事件溯源、确定性时钟、离线优先） |
| [docs/api.md](docs/api.md) | REST 接口与 Socket.IO 协议完整参考 |
| [docs/deployment.md](docs/deployment.md) | 部署（Docker / Vercel / 腾讯云轻量）与现场运维手册 |
| [docs/roadmap.md](docs/roadmap.md) | 已实现 / 未实现清单与后续演进路线 |
| [docs/testing.md](docs/testing.md) | 测试策略与每个测试覆盖的场景 |
| [apps/miniprogram/README.md](apps/miniprogram/README.md) | 小程序端构建说明 |

## 六、已知未完成项（诚实清单）

1. **小程序端 `build:weapp` / `build:h5` 在本机未能产出 dist**：卡在限制 2（SWC 原生二进制
   spawn 被禁）。源码 `typecheck` 通过，转译与逻辑断言全部通过，在正常开发机上应可构建。
   详见 [docs/roadmap.md](docs/roadmap.md)。
2. **Prisma 驱动未针对真实 PostgreSQL 跑过端到端测试**：本机没有 Docker/PostgreSQL。
   Schema、迁移与驱动实现均已就绪，但「跑通」这件事需要你在有数据库的环境验证。
   `json` 驱动与 `memory` 驱动有完整测试覆盖。
3. **计分端没有做完整的比赛时钟倒计时**：节次切换是权威事件，但「秒表走动」目前只在
   前端体现，没有做成本事件（避免秒表把事件流刷爆）。这是有意取舍，见架构文档。
