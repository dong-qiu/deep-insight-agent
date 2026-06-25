#!/usr/bin/env bash
# 把 t_code_agents 三个补充源（Simon Willison / Martin Fowler / Aider，2026-06-26 接入）幂等
# seed 进生产库 /data/insight.db。动机：seedDefaults 仅在库空时自动跑（getEffectiveSources 的
# sources.length===0 守卫），生产库非空 → 改 defaults.yaml + 部署也不会自动插入；故手动写 DB
# （记忆「新主题/源须手动写生产 DB」「DB 覆盖 config 源配置」）。列映射 == src/lib/db/repos.ts
# insertSource；按 id 跳过已存在（幂等，可重复跑）。
#
# 走 SSM send-command 在容器 deep-insight-app-1 内跑 node（better-sqlite3 在 /app/node_modules）。
# 前置：本机 AWS 凭据 + 代理已开（Clash 127.0.0.1:7890）。用法：./seed-new-sources.sh
set -euo pipefail
RGN=ap-southeast-1
IID=i-061dc19d7f7ff81ad

read -r -d '' SEED <<'JS' || true
"use strict";
const db = new (require('better-sqlite3'))('/data/insight.db'); // 读写
// 列/默认严格对齐 repos.ts insertSource：topic_ids JSON、enabled 1、fetch_mode 默认 feed、container null
const SOURCES = [
  { id:"src_simonwillison", name:"Simon Willison's Weblog", type:"rss",
    endpoint:"https://simonwillison.net/atom/everything/", topic_ids:["t_code_agents"],
    fetch_interval:"6h", enabled:1, fetch_mode:"full_text", content_container:null },
  { id:"src_martinfowler", name:"Martin Fowler", type:"rss",
    endpoint:"https://martinfowler.com/feed.atom", topic_ids:["t_code_agents"],
    fetch_interval:"24h", enabled:1, fetch_mode:"feed", content_container:null },
  { id:"src_aider", name:"Aider", type:"rss",
    endpoint:"https://aider.chat/feed.xml", topic_ids:["t_code_agents"],
    fetch_interval:"24h", enabled:1, fetch_mode:"feed", content_container:null },
];
const ins = db.prepare(
  `INSERT INTO source (id,name,type,endpoint,topic_ids,fetch_interval,backfill,enabled,fetch_mode,content_container)
   VALUES (@id,@name,@type,@endpoint,@topic_ids,@fetch_interval,@backfill,@enabled,@fetch_mode,@content_container)`);
const has = db.prepare("SELECT 1 FROM source WHERE id=?");
let added = 0, skipped = 0;
const tx = db.transaction(() => {
  for (const s of SOURCES) {
    if (has.get(s.id)) { console.log("skip (已存在): " + s.id); skipped++; continue; }
    ins.run({ id:s.id, name:s.name, type:s.type, endpoint:s.endpoint,
      topic_ids:JSON.stringify(s.topic_ids), fetch_interval:s.fetch_interval,
      backfill:null, enabled:s.enabled, fetch_mode:s.fetch_mode, content_container:s.content_container });
    console.log("inserted: " + s.id); added++;
  }
});
tx();
console.log(`\n新增 ${added}，跳过 ${skipped}`);
console.log("\n=== 当前 t_code_agents 生效源 ===");
for (const r of db.prepare(
  "SELECT id,name,fetch_mode,enabled FROM source WHERE topic_ids LIKE '%t_code_agents%' ORDER BY id").all())
  console.log(`  ${r.enabled? '✓':'✗'} ${r.id}  [${r.fetch_mode}]  ${r.name}`);
JS

B64=$(printf %s "$SEED" | base64 | tr -d '\n')
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cat > "$PARAMS" <<EOF
{"commands":["docker exec -w /app deep-insight-app-1 sh -c 'printf %s $B64 | base64 -d > /tmp/seed.js && NODE_PATH=/app/node_modules node /tmp/seed.js'"]}
EOF

echo "下发 SSM seed（生产库写入，幂等；需本机 AWS 凭据 + 代理已开）..."
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
