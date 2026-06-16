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

# —— 运行时配置（成本熔断 + 报告推送）：覆盖前先从现有 .env.local 继承 ——
# 这些通常在生产手动配。本脚本会覆盖写 .env.local，故先抽出旧的有效赋值行原样保留，
# 避免重跑 gen-env.sh / 随后 deploy.sh 把生产的熔断/推送配置静默抹掉（见 operations.md §8/§14）。
extract_prev() {  # 抽取旧 .env.local 中某 key 的有效（非注释）赋值行；无则空。
                  # 单文件 grep 不带文件名前缀；多行取最后一个有效赋值；
                  # sed 剥离行内注释（` #...`）+ 首尾空白——防运维手写的行内注释被原样继承，
                  # 否则 COST_LIMIT_DAILY=5 后带注释会让 Number() 解析成 NaN、熔断静默失效。
                  # 末尾 `|| true` 兜底：grep 无匹配时（pipefail 返回非0）不触发 set -e。
  [ -f "$ROOT/.env.local" ] && grep -E "^[[:space:]]*$1=" "$ROOT/.env.local" 2>/dev/null \
    | grep -vE '^[[:space:]]*#' | tail -n1 \
    | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' || true
}
PREV_COST_D="$(extract_prev COST_LIMIT_DAILY)"
PREV_COST_M="$(extract_prev COST_LIMIT_MONTHLY)"
PREV_COST_PCT="$(extract_prev COST_ALERT_PCT)"
PREV_PUSH="$(extract_prev REPORT_PUSH)"
PREV_BASE="$(extract_prev PUBLIC_BASE_URL)"

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

# —— 运行时配置块：继承旧值则原样保留，否则写注释占位（运维按需填）——
{
  echo ""
  echo "# —— 运行时配置（成本熔断 + 报告推送）：生产常手动配；重跑本脚本会继承上次的值 ——"
  echo "# 见 docs/launch/operations.md §14（成本）/ §12（推送）。空=不限/不推。"
  echo "# 日成本上限 USD：触顶熔断定时管线（跳过剩余 topic）+ 告警"
  echo "${PREV_COST_D:-# COST_LIMIT_DAILY=5}"
  echo "# 月成本上限 USD（自然月 UTC）：同上熔断 + 告警"
  echo "${PREV_COST_M:-# COST_LIMIT_MONTHLY=80}"
  echo "# 触顶前告警阈值百分比（默认 80）"
  echo "${PREV_COST_PCT:-# COST_ALERT_PCT=80}"
  echo "# 报告推送 opt-in：置 1 开启（复用 ALERT_WEBHOOK 渠道）"
  echo "${PREV_PUSH:-# REPORT_PUSH=1}"
  echo "# 站点根地址，拼报告 deep-link（如 http://<EC2-IP>:3000）；缺则推送不带链接"
  echo "${PREV_BASE:-# PUBLIC_BASE_URL=}"
} >> "$ROOT/.env.local"

chmod 600 "$ROOT/.env.local"
echo "==> 已写 $ROOT/.env 和 $ROOT/.env.local（权限 600）"
{ [ -n "$PREV_COST_D" ] || [ -n "$PREV_COST_M" ] || [ -n "$PREV_PUSH" ] || [ -n "$PREV_BASE" ]; } \
  && echo "    ↻ 已从旧 .env.local 继承运行时配置（成本熔断/报告推送），未抹掉" \
  || echo "    ℹ️ 运行时配置（COST_LIMIT_*/REPORT_PUSH/PUBLIC_BASE_URL）当前为注释占位，按需在 .env.local 取消注释填值"
echo "    ANALYZER=$ANALYZER_MODEL  VALIDATOR=$VALIDATOR_MODEL  （二者已确保不同）"
[ "$API_KEY" = "TODO_PASTE_YOUR_KEY" ] && echo "    ⚠️ ANTHROPIC_API_KEY 仍是占位，部署前请编辑 $ROOT/.env.local 填入真实 key"
[ "$ANALYZER_MODEL" = "$VALIDATOR_MODEL" ] && { echo "    ✗ ANALYZER_MODEL == VALIDATOR_MODEL，应用会启动失败！改 config.sh"; exit 1; }
