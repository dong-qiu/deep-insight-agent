#!/usr/bin/env bash
# 生成项目根的 .env（compose CLI 用）和 .env.local（容器运行时用）。
# 密钥用 openssl 现场生成，写入 gitignored 的 .env.local——绝不进仓库。
#
# API key / 管理员密码两种提供方式（择一）：
#   ① 环境变量：ANTHROPIC_API_KEY=sk-xxx ADMIN_PASSWORD=xxx ./gen-env.sh
#   ② 不传则交互输入（密码不回显）。
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
ROOT="$(cd ../.. && pwd)"   # 仓库根

command -v openssl >/dev/null || { echo "缺 openssl"; exit 1; }

# —— 密钥：缺则生成 ——
AUTH_SECRET="$(openssl rand -base64 32)"
CRON_SECRET="$(openssl rand -hex 16)"

# —— API key ——
API_KEY="${ANTHROPIC_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  read -rp "ANTHROPIC_API_KEY（直接回车则先留 TODO 占位，稍后手动填）: " API_KEY
fi
[ -z "$API_KEY" ] && API_KEY="TODO_PASTE_YOUR_KEY"

# —— 管理员密码 ——
ADMIN_PW="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PW" ]; then
  read -rsp "ADMIN_PASSWORD（不回显）: " ADMIN_PW; echo
fi
[ -z "$ADMIN_PW" ] && { echo "ADMIN_PASSWORD 不能为空"; exit 1; }

# —— .env（compose CLI）——
cat > "$ROOT/.env" <<EOF
# 由 ops/aws/gen-env.sh 生成；compose CLI 读取（工程名/端口）。
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT
APP_PORT=3000
EOF

# —— .env.local（容器运行时）——
# 注意：云上不钉 DB_PATH/DATA_DIR，用容器默认 /data（挂持久卷）。
cat > "$ROOT/.env.local" <<EOF
# 由 ops/aws/gen-env.sh 生成；容器运行时读取。切勿提交（.gitignore 已忽略 .env.*）。
ANTHROPIC_API_KEY=$API_KEY
$( [ -n "$ANTHROPIC_BASE_URL" ] && echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" )
ANALYZER_MODEL=$ANALYZER_MODEL
VALIDATOR_MODEL=$VALIDATOR_MODEL

AUTH_SECRET=$AUTH_SECRET
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PW

CRON_SECRET=$CRON_SECRET
EOF

chmod 600 "$ROOT/.env.local"
echo "==> 已写 $ROOT/.env 和 $ROOT/.env.local（权限 600）"
echo "    ANALYZER=$ANALYZER_MODEL  VALIDATOR=$VALIDATOR_MODEL  （二者已确保不同）"
[ "$API_KEY" = "TODO_PASTE_YOUR_KEY" ] && echo "    ⚠️ ANTHROPIC_API_KEY 仍是占位，部署前请编辑 $ROOT/.env.local 填入真实 key"
[ "$ANALYZER_MODEL" = "$VALIDATOR_MODEL" ] && { echo "    ✗ ANALYZER_MODEL == VALIDATOR_MODEL，应用会启动失败！改 config.sh"; exit 1; }
