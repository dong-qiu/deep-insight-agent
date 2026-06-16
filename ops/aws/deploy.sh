#!/usr/bin/env bash
# 投递代码 + 密钥到 VM，docker compose up，配 Caddy(若有域名)，最后验证。
# 前置：provision.sh（VM 已起）、gen-env.sh（.env/.env.local 已生成）；可选 migrate-db.sh。
# 代码走 rsync（不 clone 私库、不用 PAT）；.env/.env.local 一并加密传输。
set -euo pipefail
cd "$(dirname "$0")"
source config.sh
ROOT="$(cd ../.. && pwd)"

[ -f .vm-ip ] || { echo "缺 .vm-ip：先跑 ./provision.sh"; exit 1; }
IP="$(cat .vm-ip)"
[ -f "$ROOT/.env.local" ] || { echo "缺 .env.local：先跑 ./gen-env.sh 或确保仓库根已有 .env.local"; exit 1; }
grep -q "TODO_PASTE_YOUR_KEY" "$ROOT/.env.local" && { echo "✗ .env.local 里 ANTHROPIC_API_KEY 还是占位，先填真实 key"; exit 1; }

# 传输目标：经 SSM 隧道时 SSH_HOST=localhost / SSH_PORT=2222；否则回落公网 IP:22
SSH_HOST="${SSH_HOST:-$IP}"; SSH_PORT="${SSH_PORT:-22}"
SSHO="-i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new"
SSH="ssh $SSHO $ADMIN_USER@$SSH_HOST"

# 准备投递用的环境文件（不改动你的本地 dev .env.local）：
#  - 容器版 .env.local：剔除 DB_PATH/DATA_DIR（云上用容器默认 /data 持久卷），其余密钥原样复用
#  - compose .env：钉 COMPOSE_PROJECT_NAME（卷名恒为 <name>_insight-data）+ APP_PORT
TMP_ENVLOCAL="$(mktemp)"; TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENVLOCAL" "$TMP_ENV"' EXIT
grep -vE '^\s*(DB_PATH|DATA_DIR)=' "$ROOT/.env.local" > "$TMP_ENVLOCAL"
if [ -f "$ROOT/.env" ]; then cp "$ROOT/.env" "$TMP_ENV"; else
  printf 'COMPOSE_PROJECT_NAME=%s\nAPP_PORT=3000\n' "$COMPOSE_PROJECT" > "$TMP_ENV"
fi
echo "==> 已准备容器版环境文件（剔除本地 DB_PATH/DATA_DIR；钉 COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT}）"

# 投递前体检：本脚本 scp 会全量覆盖远程 .env.local。若运行时配置（成本熔断/报告推送）
# 缺失，生产会静默降级——熔断失效=可能意外高成本、推送失效=用户收不到报告。仅告警不阻断
# （未设=不限/不推 是合法选择）；本意如此可忽略，否则补进 $ROOT/.env.local 后重跑。见 operations.md §8/§14。
MISS_RUNTIME=""
for k in COST_LIMIT_DAILY COST_LIMIT_MONTHLY REPORT_PUSH PUBLIC_BASE_URL; do
  grep -qE "^[[:space:]]*$k=" "$TMP_ENVLOCAL" || MISS_RUNTIME="$MISS_RUNTIME $k"
done
[ -n "$MISS_RUNTIME" ] && {
  echo "⚠️  .env.local 缺运行时配置（非注释赋值）：$MISS_RUNTIME"
  echo "    deploy 将全量覆盖远程 .env.local——缺这些会令生产「成本熔断 / 报告推送」静默失效。"
  echo "    有意为之可忽略；否则 Ctrl-C，编辑 $ROOT/.env.local 取消注释填值后重跑。"
}

# 0) 等 cloud-init 装完 docker（最多 ~4 分钟）
echo "==> 等待 cloud-init 完成（docker/swap/caddy）..."
for i in $(seq 1 24); do
  if $SSH "test -f /opt/app/.cloud-init-done && command -v docker" >/dev/null 2>&1; then
    echo "==> cloud-init 就绪"; break
  fi
  [ "$i" = 24 ] && { echo "✗ 等待超时，登录 VM 看 /var/log/cloud-init-output.log"; exit 1; }
  sleep 10
done

# 1) rsync 代码（排除 git/依赖/数据/构建产物 + 本地 env；env 改用消毒版单独投递）
echo "==> rsync 代码到 $IP:$APP_DIR_REMOTE ..."
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude '.data' --exclude '.env' --exclude '.env.local' \
  --exclude 'ops/aws/.vm-ip' --exclude 'ops/aws/.vm-id' --exclude 'ops/aws/config.sh' \
  -e "ssh $SSHO" \
  "$ROOT/" "$ADMIN_USER@$SSH_HOST:$APP_DIR_REMOTE/"

# 1b) 单独投递消毒版 env（加密 scp），并设 600 权限
echo "==> 投递容器版 .env / .env.local ..."
scp -i "$SSH_KEY" -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$TMP_ENV"      "$ADMIN_USER@$SSH_HOST:$APP_DIR_REMOTE/.env"
scp -i "$SSH_KEY" -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$TMP_ENVLOCAL" "$ADMIN_USER@$SSH_HOST:$APP_DIR_REMOTE/.env.local"
$SSH "chmod 600 $APP_DIR_REMOTE/.env.local"

# 2) 构建 + 启动（B1s 上 build 较慢，有 swap 兜底）
echo "==> docker compose up -d --build（首次较慢，5–15 分钟）..."
$SSH "cd $APP_DIR_REMOTE && docker compose up -d --build"
$SSH "cd $APP_DIR_REMOTE && docker compose ps"

# 3) Caddy 自动 HTTPS（仅当配了域名）
if [ -n "${APP_DOMAIN:-}" ]; then
  echo "==> 配置 Caddy 反代 $APP_DOMAIN -> 127.0.0.1:3000 ..."
  $SSH "sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$APP_DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl restart caddy"
  echo "==> 确认 A 记录 $APP_DOMAIN -> $IP 已生效，Caddy 会自动签 Let's Encrypt 证书。"
fi

# 4) 验证健康端点
echo "==> 验证 /api/health ..."
sleep 5
$SSH "curl -fsS http://127.0.0.1:3000/api/health && echo '  <- health OK'" \
  || echo "（health 暂未通过，可能还在构建/启动；稍后 ssh 进去看 docker compose logs -f app）"

echo ""
echo "==================================================================="
echo " 部署完成。"
if [ -n "${APP_DOMAIN:-}" ]; then echo " 访问：https://$APP_DOMAIN"; else echo " 临时访问：http://$IP:3000（需在安全组临时放行 3000，或配域名走 Caddy）"; fi
echo " 登录：ADMIN_EMAIL=$ADMIN_EMAIL / 你设的 ADMIN_PASSWORD"
echo ""
echo " 手动验证 cron 链路（模拟 supercronic）："
echo "   ssh -i $SSH_KEY $ADMIN_USER@$IP \\"
echo "     'cd $APP_DIR_REMOTE && docker compose exec -T app sh -c \"curl -fsS -X POST http://127.0.0.1:3000/api/cron -H \\\"authorization: Bearer \\\$CRON_SECRET\\\"\"'"
echo "==================================================================="
