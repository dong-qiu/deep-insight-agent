#!/usr/bin/env bash
# t_code_agents 数据源「被引贡献」运维观测（接入新源后的相关性兜底门）。
# 动机：「会不会重蹈 openai_news 0 被引」是运维指标、静态 eval 测不了——须部署后跑几日看真贡献
# （同 ADR-0009「需部署+跑几日查真命中率」）。判据：某源采到内容但 0 被引 = openai_news 模式 → 手动下线。
# 区分两类失败：采集量=0（feed/适配器问题，非相关性）vs 采到但被引=0（相关性问题，该下线）。
#
# 关联：citation.content_item_id → content_item.source_id（来源）；citation.insight_id →
#       insight.topic_id（主题）。走 SSM 查容器 deep-insight-app-1 的 /data/insight.db（readonly）。
# 前置：本机 AWS 凭据 + 代理已开（Clash 127.0.0.1:7890）。用法：./source-contribution.sh [天数，默认 7]
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad
DAYS="${1:-7}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "✗ 天数须为整数（拼进远程命令，严格校验）"; exit 1; }

read -r -d '' QUERY <<'JS' || true
const db = new (require('better-sqlite3'))('/data/insight.db', { readonly: true });
const T = 't_code_agents';
const DAYS = parseInt(process.argv[2] || '7', 10);
const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const NEW = ['src_simonwillison', 'src_martinfowler', 'src_aider']; // 2026-06-26 接入，重点盯

// 采集量（按源，限本主题烙印 + 窗口内 fetched_at）
const collected = new Map();
for (const r of db.prepare(
  `SELECT source_id, COUNT(*) n, MAX(fetched_at) last FROM content_item
    WHERE topic_ids LIKE '%'||?||'%' AND fetched_at >= ? GROUP BY source_id`).all(T, since))
  collected.set(r.source_id, r);

// 被引（口径对齐 repos.ts:89 sourceContribution / ADR-0008 切片4）：只数**已上报报告(status=done)**里
// 被引的洞察——否则 blocked/未发布洞察的引用会把真·0 贡献源（openai_news 模式）误判成"保留"。
// report(本主题·done·窗口内 generated_at) → instr(insight_ids) → citation → content_item.source_id。
const cited = new Map();
for (const r of db.prepare(
  `SELECT ci.source_id AS sid, COUNT(*) cites, COUNT(DISTINCT i.id) insights
     FROM report r
     JOIN insight i ON instr(r.insight_ids, '"' || i.id || '"') > 0
     JOIN citation c ON c.insight_id = i.id
     JOIN content_item ci ON ci.id = c.content_item_id
    WHERE r.topic_id = ? AND r.status = 'done' AND r.generated_at >= ?
    GROUP BY ci.source_id`).all(T, since))
  cited.set(r.sid, r);

// 全量本主题源（含 0 采集的，便于看全貌）
const srcs = db.prepare("SELECT id,name,enabled FROM source WHERE topic_ids LIKE '%t_code_agents%' ORDER BY id").all();

console.log(`窗口：近 ${DAYS} 天（since ${since.slice(0, 10)}）  主题：${T}`);
console.log('源'.padEnd(22) + '采集'.padStart(6) + '被引'.padStart(6) + '洞察'.padStart(6) + '  最近采集');
console.log('-'.repeat(64));
const fmt = (s) => {
  const c = collected.get(s.id), q = cited.get(s.id);
  const nC = c ? c.n : 0, nQ = q ? q.cites : 0, nI = q ? q.insights : 0;
  const mark = NEW.includes(s.id) ? '▶ ' : '  ';
  return { line: mark + (s.enabled ? '' : '✗') + s.id.replace('src_', ''), nC, nQ, nI,
           last: c ? (c.last || '').slice(0, 10) : '—', isNew: NEW.includes(s.id) };
};
for (const s of srcs) {
  const r = fmt(s);
  console.log(r.line.padEnd(22) + String(r.nC).padStart(6) + String(r.nQ).padStart(6)
    + String(r.nI).padStart(6) + '  ' + r.last);
}

// 新源判据
console.log('\n=== 新源相关性判据（近 ' + DAYS + ' 天）===');
for (const id of NEW) {
  const c = collected.get(id), q = cited.get(id);
  const nC = c ? c.n : 0, nQ = q ? q.cites : 0;
  let verdict;
  if (nC === 0) verdict = '⚠️ 采集=0 → feed/适配器问题（非相关性），先查采集，别下线';
  else if (nQ === 0) verdict = '🔴 采到 ' + nC + ' 条但 0 被引 → openai_news 模式，建议手动 enabled=0 下线';
  else verdict = '✓ 采 ' + nC + ' / 被引 ' + nQ + ' → 相关性成立，保留';
  console.log('  ' + id + ': ' + verdict);
}
console.log('\n注：窗口太短（<3 天）或当日尚无报告时 0 被引可能是未到分析周期，非定论——连看几日。');
JS

B64=$(printf %s "$QUERY" | base64 | tr -d '\n')
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["docker exec -w /app deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/sc.js && NODE_PATH=/app/node_modules node /tmp/sc.js $DAYS'"]}
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
