# 篮迹计分 · 基层赛事 SaaS 平台

> 计分员离线也能记，观众扫码就能看。
> 事件溯源（Event Sourcing）+ 离线优先（Offline-First）+ 多端实时（Socket.IO）。

基层赛事最大的痛点不是「没有记分软件」，而是**现场网络极差甚至没网**。
本项目以此为核心约束设计：计分员的每一次点击先写进本机 IndexedDB，再异步同步；
观众扫码进房看实时比分，断线自动重连并补齐缺失事件。

---

## 技术栈

| 层次 | 选型 | 说明 |
|------|------|------|
| 计分端 | React 18 + Vite + PWA | 平板/手机浏览器直接用，无需安装 App；离线可打开 |
| 观众端 | 同一 SPA 的移动端路由 | 扫码即看，另提供大屏比分牌 |
| 小程序端 | Taro 4 + React + TS | 一套代码编译到微信小程序与 H5 |
| 后端 | NestJS 11 | 模块化、依赖注入、Swagger 自动文档 |
| 数据库 | PostgreSQL + Prisma ORM | 事件表为核心；本地开发可用零依赖 JSON 驱动 |
| 实时通信 | Socket.IO 4 | 自动降级长轮询，兼容只放行 80/443 的场馆网络 |
| 共享契约 | `@openhoopscore/contracts` | 事件模型、计分内核、实时协议**唯一真相来源** |
| 部署 | Docker（腾讯云轻量）/ Vercel | 见 `docs/deployment.md` |

---

## 30 秒了解它解决了什么

```
计分员点「+3」
   └─ 1. 本地生成 clientEventId（幂等键）
   └─ 2. 写入 IndexedDB 队列          ← 断网也照样走完这两步
   └─ 3. 用共享计分内核立刻算出比分    ← 画面零延迟更新（乐观 UI）
   └─ 4. 通过 Socket.IO 提交 / 或攒着
        └─ 服务端幂等去重 → 按确定性时钟排序 → 分配权威 seq
             └─ 广播 events:committed
                  └─ 观众手机上的比分立刻跳动
```

断网 10 分钟后恢复：本地积压的事件**一次批量补传**，服务端按
`clientTimestamp → clientId → clientEventId` 重新排序插入时间线，
被顶掉顺序的事件会带上 `reordered` 标记，客户端据此重拉直播流。
重复提交由 `(match_id, client_event_id)` 唯一约束兜底，**绝不重复计分**。

点错了？撤销**不删除历史**，而是追加一条 `void` 事件指向目标 —— 审计链完整，比分自然回退。

---

## 快速开始

```bash
pnpm install
pnpm --filter @openhoopscore/contracts build
pnpm --filter @openhoopscore/api start        # 后端 :3000（默认零依赖文件存储）
pnpm --filter @openhoopscore/web dev          # 前端 :5173
```

打开 <http://localhost:5173>，进入 `/admin` 建一场比赛，然后：

| 角色 | 地址 | 用法 |
|------|------|------|
| 计分员 | `/score/:matchId` | 平板横屏，大按钮；快捷键 `1/2/3` 记分、`Ctrl+Z` 撤销 |
| 观众 | `/live/:matchId` | 手机竖屏，比分 + 图文直播 + 球员数据 |
| 大屏 | `/display/:matchId` | 投影/电视，字号随视口缩放 |
| 扫码 | `/m/:code` | 二维码落地页，自动进直播间 |

计分口令默认 `hoop2024`。完整的运行说明、目录结构与**环境限制**见
[DELIVERY.md](DELIVERY.md)（强烈建议先读它的第三节）。

---

## 项目结构

```
packages/contracts   共享契约：事件模型 / 确定性时钟 / 计分内核 / 实时协议
apps/api             NestJS 后端：存储驱动 · 计分服务 · Socket.IO 网关 · 赛事管理
apps/web             前端 SPA：离线引擎 · 计分台 · 观众端 · 大屏 · 管理后台
apps/miniprogram     Taro 小程序端（微信小程序 + H5）
scripts              依赖补齐工具（Windows 符号链接受限时使用）
```

---

## 测试与验证

```bash
pnpm --filter @openhoopscore/api test            # 42 条单元测试
pnpm --filter @openhoopscore/api test:e2e        # 12 条端到端：真实 HTTP + Socket.IO 闭环
pnpm test:web-offline  # 前端离线链路 36 项断言
```

端到端测试覆盖的都是「真机上最容易炸」的场景：观众是否真的实时收到比分、
断网补传后比分是否正确且不重复、撤销是否同步推给观众、无口令写操作是否被拦、
归档后是否拒绝计分。测试细节见 [docs/testing.md](docs/testing.md)。

---

## 文档

- [DELIVERY.md](DELIVERY.md) — 交付说明、环境限制、已知未完成项
- [docs/architecture.md](docs/architecture.md) — 架构与关键设计决策
- [docs/api.md](docs/api.md) — REST 与 Socket.IO 协议参考
- [docs/deployment.md](docs/deployment.md) — 部署与现场运维手册
- [docs/testing.md](docs/testing.md) — 测试策略
- [docs/roadmap.md](docs/roadmap.md) — 已实现 / 未实现 / 演进路线

---

## 许可证

MIT
