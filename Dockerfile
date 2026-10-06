# ============================================================================
# 基层赛事 SaaS 平台 —— 部署用镜像（内含前端静态产物）
# ============================================================================
# 为什么把前端一起打进来：
#   现场只有一个域名、一个端口最省事 —— 手机连场馆局域网就能打开，
#   也顺手绕过了跨域（同源）。后端启动时会自动托管 apps/web/dist，
#   目录不存在时自动跳过，所以单独跑 API 镜像也是安全的。
#
# 构建：
#   docker build -t openhoopscore:latest .
# 运行（用文件存储，零额外依赖）：
#   docker run -p 3000:3000 -e SCORER_PASSCODE=你的口令 -v hoop-data:/app/data openhoopscore:latest
# 运行（用 PostgreSQL）：
#   docker run -p 3000:3000 -e STORAGE_DRIVER=prisma -e DATABASE_URL=... openhoopscore:latest
# ============================================================================

# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder

WORKDIR /build

# 只拷依赖清单，先装依赖：源码改动不会让依赖层缓存失效
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# scripts/fix-node-modules.mjs 在 postinstall 里被调用，必须先于 install 拷进来
COPY scripts ./scripts

RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate \
  && pnpm install --ignore-scripts

# 拷源码后构建：contracts → api → web（顺序即依赖顺序）
COPY packages ./packages
COPY apps ./apps
COPY tsconfig*.json ./

RUN pnpm --filter @openhoopscore/contracts build \
  && pnpm --filter @openhoopscore/api build \
  && pnpm --filter @openhoopscore/web build

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime

# 时区与中文：比赛时间按本地时区显示，日志里中文不乱码
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_DRIVER=json \
    DATA_DIR=/app/data \
    SERVE_WEB_ASSETS=true \
    WEB_DIST_DIR=/app/apps/web/dist

# tini 负责转发信号：docker stop 时 Nest 才能收到 SIGTERM 优雅退出（写完最后一批数据）
RUN apk add --no-cache tini

WORKDIR /app

# 只带走运行必需的东西：编译产物 + 前端产物 + 依赖清单
COPY --from=builder /build/package.json /build/pnpm-workspace.yaml ./
COPY --from=builder /build/scripts ./scripts
COPY --from=builder /build/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /build/packages/contracts/package.json ./packages/contracts/
COPY --from=builder /build/apps/api/dist ./apps/api/dist
COPY --from=builder /build/apps/api/package.json ./apps/api/
COPY --from=builder /build/apps/api/prisma ./apps/api/prisma
COPY --from=builder /build/apps/web/dist ./apps/web/dist
COPY --from=builder /build/node_modules ./node_modules

# JSON 驱动会把数据写到 /app/data，声明为卷方便备份与升级
VOLUME ["/app/data"]

# 现场排查用：容器内自带健康检查，编排工具能据此判断「是真活着还是假活着」
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/src/main.js"]
