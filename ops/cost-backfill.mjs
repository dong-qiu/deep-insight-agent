// Cost backfill —— 修「amount=0 但 tokens>0」的历史 Run。
// 触发场景：VALIDATOR_MODEL/ANALYZER_MODEL 配为不在 src/lib/runtime/cost.ts PRICING
// 表内的型号 → costUSD 返 null → usageToCost 兜 ?? 0 → amount 静默 $0、admin 看板
// 成本偏低。已于 commit 19880e7 加 fallback 估算 + Opus 4.8 入表防呆；本脚本清账。
//
// 用法（在 app 容器内或本地）：
//   node ops/cost-backfill.mjs                # dry-run（默认；不改库，仅打印影响）
//   node ops/cost-backfill.mjs --apply        # 实际写入 + audit_log 记录
//   node ops/cost-backfill.mjs --apply --rate=5.46    # 自定义 $/M token 估算率
//
// 容器：docker compose exec app node /app/ops/cost-backfill.mjs [--apply]
// 默认估算率 $5.46/M（早期 validate Opus 4.7 实测均值，含 input/output/cache 混合）。
// 操作落 audit_log 一条 cost.backfill 记录（含原因/策略/applied_at），可追溯。
//
// 限制：DB 只存 cost.tokens 总和（无 input/output/cache 拆分）→ 无法精确还原，仅估算。

import Database from "better-sqlite3";

const DB_PATH =
  process.env.DB_PATH ??
  (process.env.DATA_DIR ? process.env.DATA_DIR + "/insight.db" : ".data/insight.db");

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
function readArg(name, fallback) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}
const rate = parseFloat(readArg("rate", "5.46"));
if (!Number.isFinite(rate) || rate <= 0) {
  console.error(`无效 --rate=${rate}（须为正数）`);
  process.exit(2);
}

console.log(`数据库     : ${DB_PATH}`);
console.log(`模式       : ${apply ? "APPLY（写入 + audit_log）" : "dry-run（不改库；加 --apply 才写）"}`);
console.log(`估算率     : $${rate}/M token`);

const db = new Database(DB_PATH);

const buggy = db
  .prepare(
    `SELECT id, kind, started_at, cost FROM run
     WHERE cost IS NOT NULL
       AND json_extract(cost, '$.tokens') > 0
       AND json_extract(cost, '$.amount') = 0
     ORDER BY started_at`,
  )
  .all();

if (!buggy.length) {
  console.log("\n✅ 无 amount=0 + tokens>0 的 Run，无需 backfill。");
  process.exit(0);
}

const byKind = {};
let totalTok = 0;
for (const r of buggy) {
  const t = JSON.parse(r.cost).tokens;
  byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  totalTok += t;
}
console.log(`\n找到 ${buggy.length} 行待 backfill：`);
console.log(`  按 kind  : ${JSON.stringify(byKind)}`);
console.log(`  总 tokens: ${totalTok.toLocaleString()}`);
console.log(`  估算总额 : $${((totalTok * rate) / 1_000_000).toFixed(2)}`);

if (!apply) {
  console.log("\n（dry-run；加 --apply 实际写入）");
  process.exit(0);
}

const upd = db.prepare("UPDATE run SET cost = @cost WHERE id = @id");
let applied = 0;
const tx = db.transaction(() => {
  for (const r of buggy) {
    const c = JSON.parse(r.cost);
    c.amount = Number(((c.tokens * rate) / 1_000_000).toFixed(6));
    applied += c.amount;
    upd.run({ id: r.id, cost: JSON.stringify(c) });
  }
  db.prepare(
    "INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)",
  ).run(
    "ops/cost-backfill",
    "cost.backfill",
    JSON.stringify({ rows: buggy.length, total_usd: Number(applied.toFixed(2)) }),
    JSON.stringify({
      reason: "amount=0 + tokens>0 (model not in PRICING)",
      strategy: `empirical rate $${rate}/M tokens`,
      applied_at: new Date().toISOString(),
    }),
  );
});
tx();

console.log(`\n✅ 完成。${buggy.length} 行已更新，总额 $${applied.toFixed(2)} 入账。`);
console.log("   audit_log 已写 cost.backfill 记录（SELECT * FROM audit_log ORDER BY id DESC LIMIT 5 可查）。");
