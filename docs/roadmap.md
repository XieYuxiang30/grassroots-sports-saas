# 已实现 / 未实现 / 演进路线

本文对照原始方案（`基层赛事 SaaS 平台.md`）逐条说明落地情况，并诚实列出缺口。

---

## 一、对照方案的完成情况

### 第一步：技术选型与架构设计

| 方案建议 | 落地情况 |
|----------|---------|
| 计分端 React + Vite + PWA | ✅ React 18 + Vite 6 + `vite-plugin-pwa`（含 manifest 与 Service Worker） |
| 观众端 Taro / Uni-app | ✅ Taro 4 + React + TS（`apps/miniprogram`，编译到微信小程序与 H5） |
| 后端 NestJS | ✅ NestJS 11（模块化 + DI + Swagger） |
| PostgreSQL + Prisma | ✅ `prisma/schema.prisma` 完整建模；另提供零依赖 JSON 驱动用于开发与演示 |
| Socket.IO | ✅ Socket.IO 4，自动降级长轮询、房间、ack、断线重连与增量补齐 |
| 部署 Docker + Vercel | ✅ 一体化 `Dockerfile` + `docker-compose.yml` + `vercel.json` + 部署文档 |

### 第二阶段：核心功能

| 功能 | 落地情况 |
|------|---------|
| 赛事管理后台：创建比赛 | ✅ 含赛季、分享码自动生成 |
| 赛事管理后台：录入两队球员名单 | ✅ 支持批量粘贴（`4 张三` / `张三 4` / `4、张三`），支持赛前补录与删除 |
| 计分端：大按钮布局（+1/+2/+3、犯规、暂停） | ✅ 另含失误、前场/后场篮板、团队犯规、结束本节、结束比赛 |
| 计分端：点击触发 WebSocket 事件 | ✅ 优先 Socket.IO，失败退回 REST（两条链路共用同一套广播） |
| 计分端：撤销上一步 | ✅ 撤销栈显示「要撤什么」，支持连撤、离线撤销；不删历史只追加 `void` |
| 实时展示端：生成比赛专属二维码 | ✅ `qrcode` 生成，可下载 PNG 投大屏；同时显示 6 位手输分享码 |
| 实时展示端：扫码进房间 | ✅ `/m/:code` 落地页零点击自动进直播间 |
| 实时展示端：实时更新比分、节次、球员得分榜 | ✅ 比分牌 + 节次 + 球员榜（同分并列名次） |
| 实时展示端：图文直播流 | ✅ 中文文案（「第2节 05:30 张三（4 号） 命中三分，+3」），每条带比分快照 |

### 第三步：核心痛点（离线优先）

| 方案要求 | 落地情况 |
|----------|---------|
| 计分端用 IndexedDB 先存本地 | ✅ `src/offline/queue.ts`，IndexedDB → localStorage → 内存三级降级 |
| 网络通畅时通过 WebSocket 实时同步 | ✅ Socket.IO 提交 + ack；ack 失败退 REST |
| 断网时 UI 提示「离线记录中」 | ✅ 顶部状态条如实显示连接与待同步条数，不假装在线 |
| 网络恢复后自动 Push 本地队列并合并状态 | ✅ 自动 `flush()` + 5 秒退避重试；服务端按确定性时钟重排 |
| 每个本地事件带时间戳与唯一 `client_event_id` | ✅ `clientTimestamp` + `clientEventId` |
| 后端做幂等处理，防止重复计分 | ✅ `(match_id, client_event_id)` 唯一约束 + 规划器幂等表；端到端测试专门覆盖重推场景 |

**方案之外多做的**：

- 大屏比分牌 `/display/:matchId`（场馆投影/电视用，字号随视口缩放）；
- 球员里程碑弹幕（20 分、五次犯规离场）；
- 在线计分设备提示（多设备同时计分时警告人工核对）；
- 本地队列对账接口（断网恢复后先问「哪些其实已收到」，避免无谓重推）；
- 无副作用试算接口（校验两端投影是否一致）；
- 同步批次审计表（记录每次离线补传的批次与离线时长）；
- 数据自检与损坏隔离（JSON 文件损坏时改名留证据，不静默丢数据）。

---

## 二、测试与验证情况

| 类型 | 数量 | 状态 |
|------|------|------|
| 后端单元测试 | 42 | ✅ 全部通过 |
| 后端端到端测试（真实 HTTP + Socket.IO） | 12 | ✅ 全部通过 |
| 前端离线链路断言 | 36 | ✅ 全部通过 |
| 前端类型检查 | — | ✅ 0 错误 |
| 后端类型检查 | — | ✅ 0 错误 |
| 小程序端类型检查 | — | ✅ 0 错误 |

细节见 [testing.md](testing.md)。

---

## 三、未完成 / 有妥协的部分

### 3.1 小程序端未能在本机构建出产物

- **状态**：源码完成，`typecheck` 通过（0 错误），用 tsc 真实转译全部 22 个源文件
  并跑通 18 条逻辑断言；但 `build:weapp` / `build:h5` 未产出 `dist`。
- **原因**：Taro CLI 在启动阶段就 eager `require('@swc/core')`，
  而 SWC 原生二进制在 require 时会校验缓存目录 DACL 并拒绝在受限环境工作，
  报 `ERR_SWC_NATIVE_CACHE` / `spawn EPERM`。**与业务代码无关**，
  正常开发机（`%LOCALAPPDATA%\swc` 可写）上应可构建。
- **下一步**：在正常开发机执行 `pnpm --filter @openhoopscore/miniprogram build:weapp`，
  用微信开发者工具打开 `apps/miniprogram/dist` 验证。

### 3.2 Prisma 驱动未经真实 PostgreSQL 验证

- **状态**：Schema、迁移目录约定、驱动实现（含事务、COUNT 求排名、幂等插入）均已完成；
  `json` 与 `memory` 驱动有完整测试覆盖。
- **原因**：本机没有 Docker 与 PostgreSQL，装不了。
- **下一步**：
  ```bash
  docker compose --profile full up -d
  pnpm --filter @openhoopscore/api db:deploy
  STORAGE_DRIVER=prisma pnpm --filter @openhoopscore/api test:e2e
  ```
  （端到端测试只依赖 HTTP/Socket.IO，换驱动即可复用，无需改测试。）

### 3.3 其他妥协

| 项 | 现状 | 影响 |
|----|------|------|
| 计分口令是共享密钥 | 单一 `SCORER_PASSCODE` | 单场赛事够用；无法区分「哪个计分员」 |
| 比赛时钟没有倒计时 | 前端显示 + `state:patch` 广播，节次是事件 | 有意取舍：秒表做成事件会把事件流刷爆 |
| 无横向扩展 | 单实例；JSON 驱动文件锁仅进程内有效 | 观众并发到数百级没问题，再往上要 Redis adapter |
| 前端无 UI 自动化测试 | 需要 Playwright 浏览器二进制 | 交互靠人工验证 + 逻辑靠离线脚本 |
| 小程序端未接 `GET /events` 增量接口 | 现靠 socket `state:request` 补拉 | 功能等价，少一条兜底路径 |

---

## 四、演进路线

### P0 — 上线前必须做

1. **改掉默认口令**：`SCORER_PASSCODE`，并让 `/api/config/public` 的
   `scorerPasscodeIsDefault` 变成 `false`。
2. **在真实 PostgreSQL 上跑一遍端到端**（3.2 的命令）。
3. **在正常开发机构建前端与小程序**，用真机（平板 + 手机）各走一遍闭环。
4. **配置备份**：JSON 驱动就定时拷 `hoop-store.json`；PostgreSQL 就定时 `pg_dump`。

### P1 — 现场体验（投入产出比最高的几项）

1. **比赛时钟倒计时**：把「开始/暂停/复位」做成事件，
   「秒表走动」仍只在客户端本地跑，每 10 秒对齐一次服务端 —— 兼顾体验与事件量。
2. **犯规满 5 次自动提示换人**：数据已经有了（`fouled_out` 里程碑），
   差一个计分台的醒目横幅。
3. **观众端比分推送的公众号/服务通知**（可选）：让没在场的人也能关注。
4. **离线模式下的图片/音频提示**：现场嘈杂，计分成功给一点声音反馈（可关）。

### P2 — 多用户与权限体系

1. 引入 `User` / `Role`（管理员 / 计分员 / 只读），口令换成账号 + JWT；
2. 事件里记录 `operatorId`，撤销审计能追到人；
3. 赛季级权限（不同赛事的计分员互相隔离）。

### P3 — 赛事运营能力

1. **赛季积分榜**：把多场比赛的事件流按队伍聚合，天然可算积分、净胜分；
2. **赛程编排**：小组赛 / 淘汰赛自动生成对阵与分享码；
3. **球员赛季数据**：投篮热区（`madeByShotType` 已经在采集）、场均得分、效率值；
4. **直播回放**：事件流本身就是时间轴，可以做成「拖动进度条重看比分变化」；
5. **数据导出**：Excel / PDF 战报，供主办方存档与对外发布。

### P4 — 工程健壮性

1. **横向扩展**：Redis adapter + sticky session，`STORAGE_DRIVER=prisma`；
2. **观测性**：结构化日志 + 关键指标（事件写入速率、补传批次、Socket 连接数、
   广播延迟分位）；接入腾讯云监控或自建 Grafana；
3. **端到端回归**：把 `verify-offline-engine.mjs` 的断言并入 CI，
   并在 CI 里补 Playwright 的 UI 用例；
4. **压测**：k6 打 `/events`（含批量补传）与 Socket.IO 广播，
   确定单实例的真实容量上限；
5. **归档与冷数据**：`purgeArchived` 已有实现，补一个定时任务与「归档前自动导出」。

---

## 五、这套设计的可复用点

即使不做赛事，以下三块也可以直接搬到其他「现场 + 弱网 + 需要留痕」的场景
（社区比赛、趣味运动会、体测记录、义卖收款……）：

1. **`AssignmentPlanner`**（`apps/api/src/store/assignment-planner.ts`）——
   离线多端事件合并 + 幂等 + 确定性排序，约 200 行，逻辑自洽、可独立单测；
2. **`src/offline/queue.ts` + `src/offline/engine.ts`** ——
   三级降级队列 + 「先落盘再联网」的同步引擎，模板化程度很高；
3. **`realtime.ports.ts` 的端口注册表** ——
   绕过 NestJS 模块循环依赖的一个干净做法，任何「广播服务需要业务服务」的项目都能用。
