# syntax=docker/dockerfile:1
# 自托管单实例镜像（architecture「部署」）：Next standalone + 内置 SQLite/FS（挂持久卷 /data）。
# 构建阶段用完整版 node 镜像（自带 gcc/g++/make/python3）：better-sqlite3 预编译下载超时也能就地编译，
#   且全程不依赖 apt 镜像源。运行阶段用 slim 并去除 curl 依赖（healthcheck / cron 均用 Node fetch）。
# 镜像 tag 锁定到具体 patch（不用 latest）；cron 服务复用同镜像跑 supercronic。

ARG NODE_BUILD_IMAGE=node:20.18.1-bookworm
ARG NODE_RUNTIME_IMAGE=node:20.18.1-bookworm-slim

# ---- 依赖层 ----
FROM ${NODE_BUILD_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 构建层 ----
FROM ${NODE_BUILD_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- supercronic（容器内系统 cron）：完整版镜像有 curl，下好 + 校验后给 runner ----
FROM ${NODE_BUILD_IMAGE} AS supercronic
ARG TARGETARCH=amd64
ARG SUPERCRONIC_VERSION=v0.2.45
RUN case "${TARGETARCH}" in \
      amd64) SC_SHA1=e894b193bea75a5ee644e700c59e30eedc804cf7 ;; \
      arm64) SC_SHA1=20ce6dace414a64f0632f4092d6d3745db6085ad ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
      -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
 && echo "${SC_SHA1}  /usr/local/bin/supercronic" | sha1sum -c - \
 && chmod +x /usr/local/bin/supercronic

# ---- 运行层（slim，无 apt / 无 curl）----
FROM ${NODE_RUNTIME_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    DB_PATH=/data/insight.db \
    INSIGHT_CONFIG_PATH=/app/config/defaults.yaml

# 非 root 运行
RUN useradd --create-home --uid 1001 app

COPY --from=supercronic /usr/local/bin/supercronic /usr/local/bin/supercronic
# Next standalone 产物（server.js + 裁剪 node_modules）
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
# 显式带上原生模块，规避 standalone trace 偶发漏拷 better-sqlite3 的 .node
COPY --from=builder --chown=app:app /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# 运行时读取的静态配置（standalone 不会自动带非 JS 资源，靠 INSIGHT_CONFIG_PATH 定位）
COPY --from=builder --chown=app:app /app/src/lib/config/defaults.yaml ./config/defaults.yaml
# 容器内 cron 调度表 + 触发脚本（用 Node fetch，免 curl）
COPY --chown=app:app ops/crontab ./ops/crontab
COPY --chown=app:app ops/trigger.mjs ./ops/trigger.mjs

# 持久卷挂载点（SQLite 库 + 报告正文 + 原文归档）
RUN mkdir -p /data && chown app:app /data
VOLUME ["/data"]

USER app
EXPOSE 3000
# healthcheck 用 Node fetch（slim 无 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node --no-warnings -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 默认进程 = Web 服务；cron 服务在 compose 里 override 为 supercronic
CMD ["node", "server.js"]
