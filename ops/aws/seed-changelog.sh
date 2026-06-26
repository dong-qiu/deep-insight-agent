#!/usr/bin/env bash
# 把 src_changelog（The Changelog 播客转写源，PR #123，t_code_agents）幂等 seed 进生产库
# /data/insight.db。列映射 == src/lib/db/repos.ts insertSource；按 id 跳过已存在（可重复跑）。
#
# ⚠️ 时序硬约束：src_changelog 依赖本次部署的 extractCiteTranscript（normalize.ts）。**先部署再 seed**——
# 否则旧 fetchTranscript 对 Changelog HTML 走 stripTranscript 得垃圾正文。故本脚本带**部署守卫**：
# seed 前在生产 bundle 里 grep 符号 extractCiteTranscript——命中=确已部署、自动放行；未命中（可能被
# minify 改名）则拒绝，须确信已部署后加 `--deployed` 人工断言放行。
#
# 走 SSM 在容器 deep-insight-app-1 跑 node（better-sqlite3 在 /app/node_modules）。
# 前置：本机 AWS 凭据 + 代理已开（Clash 127.0.0.1:7890）。用法：./seed-changelog.sh [--deployed]
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad
ASSERT=0
[ "${1:-}" = "--deployed" ] && ASSERT=1

read -r -d '' SEED <<'JS' || true
"use strict";
// 部署守卫：在 Next bundle 里找 extractCiteTranscript 的 **regex 字面量** `(cite|p)`——regex/字符串字面量
// 不被 minify 改写（symbol 会，故不可用），命中=新代码确已部署。用 node fs（免 shell 引号坑）。
// 未命中且非 --deployed（argv[2]='1' 人工断言）→ exit 3 拒绝，防在旧代码上 seed 致 Changelog 转写抓垃圾。
(function deployGuard() {
  const fs = require('fs'), path = require('path');
  const NEEDLE = "(cite|p)", ASSERT = process.argv[2] === '1';
  let hit = false;
  (function walk(p) {
    if (hit) return;
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
    if (!/\.(js|cjs|mjs)$/.test(p)) return;
    let s; try { s = fs.readFileSync(p, 'utf8'); } catch { return; }
    if (s.includes(NEEDLE)) hit = true;
  })('/app/.next');
  if (hit) { console.log("guard:bundle-has-cite-regex（确已部署）"); return; }
  if (ASSERT) { console.log("guard:operator-asserted-deployed（--deployed 跳过）"); return; }
  console.log("guard:FAIL——bundle 无 (cite|p) regex，本次代码疑未部署，拒绝 seed（防 Changelog 抓垃圾转写）。先部署，或确信已部署用 --deployed。");
  process.exit(3);
})();
const db = new (require('better-sqlite3'))('/data/insight.db'); // 读写
// 列/默认严格对齐 repos.ts insertSource；与 defaults.yaml 的 src_changelog 一致。
const S = { id:"src_changelog", name:"The Changelog（播客 · 转写）", type:"rss",
  endpoint:"https://changelog.com/podcast/feed", topic_ids:["t_code_agents"],
  fetch_interval:"24h", enabled:1, fetch_mode:"feed", content_container:null };
const has = db.prepare("SELECT 1 FROM source WHERE id=?");
if (has.get(S.id)) {
  console.log("skip (已存在): " + S.id);
} else {
  db.prepare(
    `INSERT INTO source (id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container)
     VALUES (@id,@name,@type,@endpoint,@topic_ids,@fetch_interval,@backfill,@enabled,@fetch_mode,@content_container)`
  ).run({ id:S.id, name:S.name, type:S.type, endpoint:S.endpoint,
    topic_ids:JSON.stringify(S.topic_ids), fetch_interval:S.fetch_interval,
    backfill:null, enabled:S.enabled, fetch_mode:S.fetch_mode, content_container:S.content_container });
  console.log("inserted: " + S.id);
}
console.log("\n=== t_code_agents 播客类源 ===");
for (const r of db.prepare(
  "SELECT id,name,fetch_mode,enabled FROM source WHERE topic_ids LIKE '%t_code_agents%' AND (name LIKE '%播客%' OR id IN ('src_changelog','src_practical_ai','src_lex_fridman','src_latent_space')) ORDER BY id").all())
  console.log(`  ${r.enabled? '✓':'✗'} ${r.id}  [${r.fetch_mode}]  ${r.name}`);
JS

B64=$(printf %s "$SEED" | base64 | tr -d '\n')
# 守卫已并入 SEED 的 node 脚本（regex 字面量检测，见上）；ASSERT 经 argv 传入。守卫 exit 3 → 整条 node
# 进程退出、不 INSERT。命令保持纯 ASCII + 免引号（base64 无特殊字符、ASSERT 是 0/1）。
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["docker exec -w /app deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/seed.js && NODE_PATH=/app/node_modules node /tmp/seed.js $ASSERT'"]}
EOF

echo "下发 SSM seed（带部署守卫；ASSERT=${ASSERT}；生产库写入，幂等）..."
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
[ "$ST" = "Success" ] || { echo "（守卫拒绝时 SSM 整条命令为 Failed/exit 3——先部署再重跑，或确信已部署用 --deployed）"; }
