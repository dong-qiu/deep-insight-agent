#!/usr/bin/env bash
# 主题聚合第一/二步（ADR-0005 演化 #42 / ADR-0006 里程碑 #45，2026-06-16 上线）回看：
# 只读核对生产 t_code_agents 的演化 + 里程碑数据。
# 走 SSM send-command 查容器 deep-insight-app-1 的 /data/insight.db——无需 SSH（GFW 下直连/隧道易超时）。
# 前置：本机已配 AWS 凭据 + 代理已开（Clash 127.0.0.1:7890；aws cli 读 http_proxy/https_proxy）。
# 用法：./review-evolution.sh [新报告分界日 yyyy-mm-dd，默认 2026-06-16（即上线日）]
#
# 核对项：
#   1. 有焦点演化点（tags/entities 非空的报告）是否 ≥3 → 演化轨迹是否已在主题页显现；
#   2. 上线后新报告是否带 tags（验证 analyzer 标签抽取在生产正常——上线时老报告仅有 entities）；
#   3. 焦点是否随时间漂移（演化是否真有信息量）；
#   4. 里程碑（ADR-0006）：milestone_count>0 的报告/里程碑数——严格门槛下够不够，太严则调低 MILESTONE_MIN_IMPORTANCE；
#   5. 生产健康 + cron 是否在产出 brief。
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad
SINCE="${1:-2026-06-16}"
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "✗ 分界日格式应为 yyyy-mm-dd（拼进远程命令，须严格校验）"; exit 1; }

# 容器内 node 查询（better-sqlite3 readonly；脚本在 /tmp 跑须钉 NODE_PATH=/app/node_modules）
read -r -d '' QUERY <<'JS' || true
const db = new (require('better-sqlite3'))('/data/insight.db', { readonly: true });
const T = 't_code_agents';
const SINCE = process.argv[2] || '2026-06-16';
const pj = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const rows = db.prepare("SELECT date,tags,entity_names,importance FROM report_index WHERE topic_id=? ORDER BY date").all(T);
const pts = rows.map((r) => { const t = pj(r.tags), e = pj(r.entity_names); return { date: r.date, tags: t, ents: e, has: t.length > 0 || e.length > 0 }; });
const focus = pts.filter((p) => p.has);
const fresh = rows.filter((r) => r.date >= SINCE);
const freshTagged = fresh.filter((r) => pj(r.tags).length > 0);
console.log('报告总数: ' + rows.length);
console.log('有焦点演化点: ' + focus.length + (focus.length >= 3 ? ' → 轨迹显示 ✓' : ' → 降级隐藏（需 ≥3）'));
console.log(SINCE + ' 后新报告: ' + fresh.length + ' 篇，带 tags 的: ' + freshTagged.length + ' 篇'
  + (fresh.length && !freshTagged.length ? ' ⚠️ 新报告全无 tags，analyzer 标签抽取可能有问题' : ''));
console.log('焦点时间线（演化）:');
for (const p of focus) console.log('  ' + p.date + '  tags=' + JSON.stringify(p.tags) + ' ents=' + JSON.stringify(p.ents.slice(0, 3)));
// 里程碑核对（ADR-0006，第二步）：report_index.milestone_count（importance≥5 + 非追加 + aggregation）
const hasMs = db.prepare('PRAGMA table_info(report_index)').all().some((c) => c.name === 'milestone_count');
if (!hasMs) {
  console.log('里程碑: report_index 无 milestone_count 列（第二步未部署到此库？）');
} else {
  const ms = db.prepare("SELECT date,title,milestone_count FROM report_index WHERE topic_id=? AND milestone_count>0 ORDER BY date").all(T);
  const total = ms.reduce((s, m) => s + m.milestone_count, 0);
  console.log('里程碑: ' + ms.length + ' 篇含里程碑 / ' + total + ' 个里程碑洞察'
    + (rows.length && !ms.length ? '（暂无——门槛严格或新报告未攒够；6/23 看够不够，太严可调低 MILESTONE_MIN_IMPORTANCE）' : ''));
  for (const m of ms) console.log('  ' + m.date + '  ×' + m.milestone_count + '  ' + m.title);
}
JS

# base64 单行传输（mac base64 长输入会换行，tr 去掉；容器内 base64 -d 解码成文件再跑）
B64=$(printf %s "$QUERY" | base64 | tr -d '\n')
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["echo '=== /api/health ==='; curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null; echo; echo '=== 演化 + 里程碑核对 ==='; docker exec -w /app deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/q.js && NODE_PATH=/app/node_modules node /tmp/q.js $SINCE'"]}
EOF

echo "下发 SSM 查询（需本机 AWS 凭据 + 代理已开）..."
CMD=$(aws ssm send-command --region "$RGN" --instance-ids "$IID" --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS" --query Command.CommandId --output text)
echo "CommandId=$CMD"
ST=Pending
for _ in $(seq 1 20); do
  ST=$(aws ssm get-command-invocation --region "$RGN" --command-id "$CMD" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  if [ "$ST" = "Success" ] || [ "$ST" = "Failed" ]; then break; fi
  sleep 2
done
echo "Status=$ST"
echo "======================================================"
aws ssm get-command-invocation --region "$RGN" --command-id "$CMD" --instance-id "$IID" --query StandardOutputContent --output text
ERR=$(aws ssm get-command-invocation --region "$RGN" --command-id "$CMD" --instance-id "$IID" --query StandardErrorContent --output text)
[ -n "$ERR" ] && { echo "--- stderr ---"; echo "$ERR" | head -8; } || true
