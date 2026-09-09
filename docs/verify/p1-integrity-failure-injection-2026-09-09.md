# P1 完整性故障注入与对账验收（INSI-17）

> 范围：隔离的内存 SQLite、临时文件和内存 anchor store。此记录是 P1a §7 验收项 3–6 的本地可复现证据；不是生产准入、部署或 P1 启用批准。

## 结论

通过本地故障注入验收。所有 44 个相关测试和确定性
`provenance-dashboard-integrity-v1` gate 均通过；P1 runtime gate 未改变，生产
`INTEGRITY_ANCHOR_ENABLED` 仍不在本次验收范围内。

## 可复现命令与结果

在提交 `dfac075` 的干净 checkout 中执行：

```sh
npm ci
npm exec vitest run src/lib/db/integrity-anchors.test.ts src/lib/db/integrity-publication.test.ts src/lib/db/integrity-checks.test.ts src/lib/db/integrity-lifecycle.test.ts src/lib/db/report-reader-p0c-baseline.v2.test.ts src/lib/runtime/integrity-anchor-runtime.test.ts
npm run eval:provenance-integrity
npm run typecheck
```

2026-09-09T04:07Z 的结果：6 test files、44 tests 通过；deterministic gate 的
24 个 vectors 通过，dataset SHA-256 为
`b591e6c51dc7d3b8c211859966ac31b3cf01ebdf9966fd1f553b8062c3297acd`；TS 6/7
均无类型错误。运行环境为 darwin/arm64、Node v25.9.0（高于仓库声明的
`>=24.19 <25`，因此不将此结果替代 CI 的受支持 Node 运行）。

## P1a 验收映射

| P1a 条款 | 注入 / 断言 | 证据位置 |
| --- | --- | --- |
| §7.3 发布与校验故障 | 条件写重放只在字节完全相同时复用；篡改 binding、非 canonical/duplicate-key anchor 均拒绝。SQLite final commit 故障后，报告仍为 `generating`、manifest 不可见；同一 anchor 对账后 effect 才 `committed`，并追加 `anchor_written_sqlite_uncommitted` 与 `anchor_reconciled`。网络结果未知可精确重试；冲突 orphan 变为 `unknown`。artifact、manifest、anchor 篡改分别落到确定性终态，失败通知 30 分钟去重。 | `src/lib/db/integrity-anchors.test.ts`；`src/lib/db/integrity-publication.test.ts`；`src/lib/db/integrity-checks.test.ts` |
| §7.3 daily root | 02:15 缺 root 记录 `daily_anchor_missing` / high；canonical root 可幂等恢复，非 canonical bytes 被拒绝，既有 reader state 保持 `done`。 | `src/lib/db/integrity-publication.test.ts` |
| §7.4 保留与 hold | active hold 拒绝删除并生成不含 locator 的审计；先扩展外部保留再记录 hold，扩展失败则不写 hold。正常删除只变更 reader 为 `delete_pending`，验证材料仍在；retain-until 前及保留前置不满足时不能销毁。 | `src/lib/db/integrity-lifecycle.test.ts` |
| §7.4 销毁与不可用材料 | 符合前置时先生成可验签 retention tombstone，随后销毁；viewer/read resolver 返回不可见，admin 仅见脱敏结论。缺失 anchor 则写 `verification_material_unavailable`，而 reader 基线不解析当前 lifecycle 模块。 | `src/lib/db/integrity-lifecycle.test.ts`；`src/lib/db/integrity-checks.test.ts`；`src/lib/db/report-reader-p0c-baseline.v2.test.ts` |
| §7.5 固定向量 | JCS UTF-8 manifest、anchor payload、SHA-256 和 Ed25519 向量精确匹配；gate 输出的 content/manifest hashes 与预期一致。 | `src/lib/db/integrity-anchors.test.ts`；`evals/provenance-dashboard-integrity-v1.ts` |
| §7.6 读取隔离 | 报告读取使用冻结的 P0c visibility snapshot，未解析 lifecycle 实现；完整性 runtime 默认关闭，缺失 admission 时拒绝开启。 | `src/lib/db/report-reader-p0c-baseline.v2.test.ts`；`src/lib/runtime/integrity-anchor-runtime.test.ts` |

## 告警边界

本地验证覆盖 checker 调用通知回调、failure dedup 以及 high/critical 审计状态；不发送
外部消息、不配置 webhook/SSO/KMS/S3，也不验证 5 分钟送达或 15 分钟升级。这些必须由
INSI-25 按 `docs/launch/p1-production-admission-runbook.md` 在获授权环境中完成，不能用本
地 mock 代替。

## 回退

本次仅新增本地证据文档；回退为还原此文件。没有数据库迁移、配置、runtime gate、云资源或
生产数据变更。
