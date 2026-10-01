#!/usr/bin/env bash
# 历史数据迁移工具：写入目标卷，未内建空卷保护。不得用于已有生产卷；
# 当前 CD 也不支持空主机首发，须另行设计/批准迁移与 bootstrap 流程。
#
# 关键：真生产库在本机【容器】deep-insight-app-1 的 /data/insight.db（不是本地 .data，见项目记忆）。
# 故用容器内 better-sqlite3 跑 VACUUM INTO 导出干净单文件，再搬到云端卷（chown 到 uid 1001）。
set -euo pipefail
cd "$(dirname "$0")"
source config.sh

[ -f .vm-ip ] || { echo "缺 .vm-ip：先跑 ./provision.sh"; exit 1; }
IP="$(cat .vm-ip)"
VOL="${COMPOSE_PROJECT}_insight-data"

# 1) 在源容器内导出干净快照（VACUUM INTO 自动 checkpoint WAL，产出独立单文件）
echo "==> 从源容器 $SOURCE_CONTAINER 导出快照..."
docker exec "$SOURCE_CONTAINER" sh -c \
  "rm -f /tmp/golden.db && node -e \"require('better-sqlite3')('/data/insight.db').exec(\\\"VACUUM INTO '/tmp/golden.db'\\\")\""
docker cp "$SOURCE_CONTAINER:/tmp/golden.db" /tmp/golden.db
docker exec "$SOURCE_CONTAINER" rm -f /tmp/golden.db
echo "==> 本机快照：/tmp/golden.db（$(du -h /tmp/golden.db | cut -f1)）"

# 传输目标：经 SSM 隧道时 SSH_HOST=localhost / SSH_PORT=2222；否则回落公网 IP:22
SSH_HOST="${SSH_HOST:-$IP}"; SSH_PORT="${SSH_PORT:-22}"

# 2) 传到 VM
echo "==> scp 到 VM（${SSH_HOST}:${SSH_PORT}）..."
scp -i "$SSH_KEY" -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new /tmp/golden.db "$ADMIN_USER@$SSH_HOST:~/golden.db"

# 3) 在 VM 上：建卷 + 写入 + 改属主（容器内 app 用户 uid 1001）
echo "==> 写入云端卷 $VOL ..."
ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$ADMIN_USER@$SSH_HOST" bash -s <<EOF
set -e
docker volume create $VOL >/dev/null
docker run --rm -v $VOL:/data -v \$HOME/golden.db:/src/golden.db:ro alpine \
  sh -c "cp /src/golden.db /data/insight.db && chown -R 1001:1001 /data"
# 注意：chown 整个 /data 目录（非仅文件）——预填的卷其目录默认 root 所有，
#       SQLite 需在目录内写 -wal/-shm，否则 app(uid 1001) 报 'readonly database'。
rm -f \$HOME/golden.db
echo "云端卷 $VOL 已写入 insight.db："
docker run --rm -v $VOL:/data alpine ls -la /data/insight.db
EOF

rm -f /tmp/golden.db
echo "==> 数据迁移完成。当前 CD 不能对空主机首发；请停止并按单独批准的 bootstrap 流程处理。"
