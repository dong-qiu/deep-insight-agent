# Brief 信息完整性：S0 私有诊断

`export.ts` 导出所选窗口内全部 analysis batch（含未发布候选），以及窗口内启动但没有对应窗口内 batch 的分析尝试。
不是发布器、自动归组器或质量评分器；不调用模型、调度、通知或应用 DB bootstrap。

## 输入准备

- 使用现有在线备份 API 产出的**一致性快照**，禁止把正在写入的 live `.db` 单文件拷贝当快照。
- 在私有隔离目录中，通过 SQLite backup API 建立本地实验副本，转换为 DELETE journal，关闭连接。
  exporter 拒绝 WAL 格式及存在 WAL/SHM 的输入；只读打开也可能为 WAL 文件创建旁文件，因此显式要求此准备步骤。
- 文件路径全部为绝对路径；输入目录 0700、实验快照建议 0400；不复制主 worktree 的 `.data/`。
- 如需核对原始归档，只读取得所选输入的 `raw/<id>.<sha256>.txt`，放在独立目录，文件 0600。
  缺归档保持 gap，不访问原站补抓、不将当前网页替代历史版本。
- 当前导出器要求 `asOf` 与 `snapshot-capture-utc` 相等，但两者都只是操作者声明；
  导出器不读取备份清单，也不核验备份区间或原 DB 到本地副本的转换链。
  输出中的 `snapshot_captured_at` 因而**不是已核验的精确捕获时刻**，现有历史导出只作有界诊断，不能据此签认 T02。
  不能用较晚捕获的快照重放更早的 `asOf`：Insight 没有创建时间，报告状态也可能在捕获前改变。
  备份清单 `created_at` 是清单生成时间；新版清单的 `db_snapshot_interval` 仅记录 SQLite 在线备份的起止区间，
  `source_data_version_unchanged` 只表明同一源连接在区间前后未观察到其他连接提交。
  导出前须在私有取样记录中核对备份清单、原始 `insight.db` SHA、
  本地 DELETE-journal 副本 SHA 和转换来源，并把时间证据缺口列明；
  正式 T02 签认还须实现由导出器校验清单、区间与副本来源的契约。
  备份中的 redaction 或 pending request 会阻断本导出器；
  导出后用于人评前，操作者还必须只读确认当前撤回状态，避免旧备份恢复已撤回内容。存在撤回时另做受控取样。
- 私有目录及全部输出均不得加入 Git。输出路径必须尚不存在；若位于 Git worktree 内，必须由 Git 忽略规则覆盖。

```bash
DB_PATH=/absolute/private/offline.db \
BRIEF_DENSITY_DATA_DIR=/absolute/private/archive-copy \
npx tsx evals/brief-density/export.ts \
  /absolute/private/new-export \
  2026-09-23T00:00:00.000Z 2026-09-26T18:00:00.000Z \
  topic-a,topic-b,topic-c \
  2026-09-26T18:00:00.000Z 2026-09-26T18:00:00.000Z <40-character-checkout-sha>
```

三个时间分别为输入队列窗口的排他截止、证据观测 `asOf`、操作者声明的快照时间；第三项尚非已核验时间。
`BRIEF_DENSITY_DATA_DIR` 可省略，此时原文归档检查标 missing，不表示原文已经验证。
CLI 只打印记录数量；正文、候选和来源 URL 均写入私有产物。

## 输出与口径

- `candidate-pool.jsonl`：每行一个 batch 或分析尝试；含全部候选审计、Insight/Citation/check、原文绑定、
  逐报告选择结果、模型/策略上下文。只有原文版本匹配才提供该版本正文；缺失正文为 null。
- `stage-loss.json`：候选互斥终态桶；另列没有 batch 的尝试及其已观测候选下限。
- `snapshot-manifest.json`：最后写入，标识本次导出完成，包含输入/实现/产物 hash、schema 和部署版本。

窗口按 batch 创建或 analyze started 时间取样，不只按已发布报告取样，也不假定所有分析都是日报。
报告决策仅取 `brief` 且 `generated_at <= asOf` 的观察记录。按候选汇总时，截止前曾发布则记 published；
未发布且不同尝试原因冲突则记 multiple_attempt_outcomes，不任选一个排除原因。逐报告结果仍保留。

引用 locator 使用原始 UTF-16 字符偏移严格核对，不做近似子串匹配。归档完整性和内容版本分别检查：
文件 SHA/size、envelope 版本、structured hash/body kind、生产 normalizeBody 和对应长度上限处理后的正文。
这些检查不能代替展示审计或 validator。所有候选的 `experiment_eligibility` 均为 not_evaluated。

被拒候选的完整 coverage audit 可能保留 claim 文本，单独标为 audit_claim_text_available；缺 Insight 不等于缺一切文本。
失败尝试的有损 diagnostics 只有 hashes/reason，不含完整候选文本；即使成功解引用，也只报告已观测候选下限。
未提取事实、事件边界、互补性及阅读价值需要来源标注，不能从候选审计数量推算。
证据 gaps 按每条导出记录内的输入 revision occurrence 计数，另外按有/无 batch 分层，不能当独立文章数。

## 验证

```bash
npx vitest run evals/brief-density/export.test.ts
npm run typecheck
npx eslint evals/brief-density --max-warnings=0
```

定向测试使用真实 SQLite/schema，覆盖只读/独占输出、失败诊断、证据版本错配、时间边界、报告尝试冲突、
撤回及缺失证据。A1 不执行该导出路径，本工具的测试不能证明新 Brief 的质量收益。
