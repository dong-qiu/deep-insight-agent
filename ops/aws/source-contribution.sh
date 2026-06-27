#!/usr/bin/env bash
# 数据源「被引贡献」运维观测（接入新源后的相关性兜底门）。通用于任意主题。
# 动机：「会不会重蹈 openai_news/Darknet 0 被引」是运维指标、静态 eval 测不了——须部署后跑几日看真贡献
# （同 ADR-0009「需部署+跑几日查真命中率」）。判据：某源采到内容但 0 被引 = 相关性坏 → 手动下线。
# 区分三类：采集量=0（feed/适配器问题或低频源窗口外，非相关性）vs 采到但被引=0 且满曝光（相关性问题，
# 该下线）vs 采到但被引=0 但新接入（曝光不足，0 被引非定论，继续观察）。
#
# 关联：citation.content_item_id → content_item.source_id（来源）；citation.insight_id →
#       insight.topic_id（主题）。走 SSM 查容器 deep-insight-app-1 的 /data/insight.db（readonly）。
# 前置：本机 AWS 凭据 + 代理已开（Clash 127.0.0.1:7890）。
# 用法：[TOPIC=t_prompt_injection] [NEW_DAYS=14] ./source-contribution.sh [天数，默认 7]
#   TOPIC 默认 t_code_agents（向后兼容无参旧调用）；NEW_DAYS=判定「新接入、曝光不足」的阈值。
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad
DAYS="${1:-7}"
TOPIC="${TOPIC:-t_code_agents}"
NEW_DAYS="${NEW_DAYS:-14}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "✗ 天数须为整数（拼进远程命令，严格校验）"; exit 1; }
[[ "$NEW_DAYS" =~ ^[0-9]+$ ]] || { echo "✗ NEW_DAYS 须为整数"; exit 1; }
[[ "$TOPIC" =~ ^[a-z0-9_]+$ ]] || { echo "✗ TOPIC 须为 [a-z0-9_]（拼进远程命令，严格校验）"; exit 1; }

read -r -d '' QUERY <<'JS' || true
const db = new (require('better-sqlite3'))('/data/insight.db', { readonly: true });
const DAYS = parseInt(process.argv[2] || '7', 10);
const T = process.argv[3] || 't_code_agents';
const NEW_DAYS = parseInt(process.argv[4] || '14', 10);
const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const newSince = new Date(Date.now() - NEW_DAYS * 864e5).toISOString();

// 采集量（按源，限本主题烙印 + 窗口内 fetched_at）
const collected = new Map();
for (const r of db.prepare(
  `SELECT source_id, COUNT(*) n, MAX(fetched_at) last FROM content_item
    WHERE topic_ids LIKE '%'||?||'%' AND fetched_at >= ? GROUP BY source_id`).all(T, since))
  collected.set(r.source_id, r);

// 被引（口径对齐 repos.ts sourceContribution / ADR-0008 切片4）：只数**已上报报告(status=done)**里
// 被引的洞察——否则 blocked/未发布洞察的引用会把真·0 贡献源误判成"保留"。
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

// 全量本主题源（含 0 采集的，便于看全貌）+ created_at（自动识别新接入源，替代写死清单）
const srcs = db.prepare(
  "SELECT id,name,enabled,created_at FROM source WHERE topic_ids LIKE '%'||?||'%' ORDER BY enabled DESC, id").all(T);
// 按日期粒度比（created_at 是 "YYYY-MM-DD HH:MM:SS" 空格分隔，newSince 是 ISO 'T' 分隔，
// 直接字符串比在阈值当天会因第 10 位 空格<T 误判；切到日期前缀规避，也对未来改 ISO 写入鲁棒）。
const isNew = (s) => (s.created_at || '').slice(0, 10) >= newSince.slice(0, 10);
const nrep = db.prepare(
  "SELECT COUNT(*) n FROM report WHERE topic_id=? AND status='done' AND generated_at>=?").get(T, since).n;

console.log(`窗口：近 ${DAYS} 天（since ${since.slice(0, 10)}）  主题：${T}  已上报报告：${nrep}  ▶=近 ${NEW_DAYS} 天新接入`);
console.log('源'.padEnd(26) + '采集'.padStart(6) + '被引'.padStart(6) + '洞察'.padStart(6) + '  最近采集');
console.log('-'.repeat(70));
for (const s of srcs) {
  const c = collected.get(s.id), q = cited.get(s.id);
  const nC = c ? c.n : 0, nQ = q ? q.cites : 0, nI = q ? q.insights : 0;
  const line = (isNew(s) ? '▶ ' : '  ') + (s.enabled ? '' : '✗') + s.id.replace('src_', '');
  console.log(line.padEnd(26) + String(nC).padStart(6) + String(nQ).padStart(6)
    + String(nI).padStart(6) + '  ' + (c ? (c.last || '').slice(0, 10) : '—'));
}

// 启用源相关性判据
console.log(`\n=== 启用源相关性判据（近 ${DAYS} 天）===`);
for (const s of srcs.filter((s) => s.enabled)) {
  const c = collected.get(s.id), q = cited.get(s.id);
  const nC = c ? c.n : 0, nQ = q ? q.cites : 0, nI = q ? q.insights : 0;
  let verdict;
  if (nC === 0) verdict = '⚠️ 采集=0 → feed/适配器问题或低频源窗口外，先查采集，别下线';
  else if (nQ > 0) verdict = `✓ 采 ${nC} / 被引 ${nQ} / ${nI} 洞察 → 相关性成立，保留`;
  else if (isNew(s)) verdict = `⏳ 采 ${nC} / 0 被引，但近 ${NEW_DAYS} 天新接入 → 曝光不足，非定论，继续观察`;
  else verdict = `🔴 采 ${nC} / 0 被引（满曝光）→ openai_news/Darknet 模式，建议手动 enabled=0 下线`;
  console.log('  ' + s.id.replace('src_', '').padEnd(22) + verdict);
}
console.log('\n注：窗口太短（<3 天）或当日尚无报告时 0 被引可能是未到分析周期，非定论——连看几日。');
JS

B64=$(printf %s "$QUERY" | base64 | tr -d '\n')
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["docker exec -w /app deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/sc.js && NODE_PATH=/app/node_modules node /tmp/sc.js $DAYS $TOPIC $NEW_DAYS'"]}
EOF

echo "下发 SSM 查询（TOPIC=${TOPIC} DAYS=${DAYS} NEW_DAYS=${NEW_DAYS}；需本机 AWS 凭据 + 代理已开）..."
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
