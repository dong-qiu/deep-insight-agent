# F 前瞻分段时钟工程（2026-10-07）

状态：接口 v1 封存；实现、回归、真实 P/C 探索收据映射和非作者工程评审完成；质量/人工裁决仍 pending。仅探索观测，不打开正式留出、不写生产 DB、不改变抓取或发布策略，不声称时效改善、首发或人评通过。

## 冻结接口 v1

`forward-clocks.ts` 提供 `createForwardJournal(directory, config)`、`appendForwardEvent(directory, event, recordedAt?)`、`readForwardJournal(directory)`、`assembleForwardClocks(journal, asOf, window)`。目录必须绝对、全新、gitignored、0700；配置与每个事件以 `wx` 独占创建为 0600 文件。没有更新或删除 API；每个事件绑定序号、前项 hash 与配置 hash，重放验证所有历史资源。并发碰撞拒绝，不自动覆盖或重排。

配置固定 `format_version=forward-clock-journal-v1`、`journal_id`、`run_id`、`scope=exploration` 和完整登记的 `sources`。每项来源固定 `source_id`、`revision`、`body_sha256`、`topic_id`、`issue_id`、`source_form`、可空 `source_family`。来源身份以 `[source_id, revision]` 表示；正文 hash 不允许漂移。同 URL 并不等同同版本。v1 不把来源家族、首报/续报或人工重要性自行判为已知。

每事件含唯一 `event_id`、配置中的 `run_id`、`attempt_id`、`attempt_kind`（`source_acquisition` 或 `analysis`）、精确 `source`（id/revision/body hash）、真实 `observed_at` 和非空 `resources`（绝对路径、SHA-256、角色）。角色为 `receipt`、`source_body`、`publication_commit` 或 `metadata`。文件及父路径不得经 symlink，路径必须为真实规范路径。所有资源 hash 均核对；已登记资源路径/hash 不得漂移。`recorded_at` 是日志追加时间，不拿它代替事件观察时间。

事件判别 `kind`：

- `availability_observed`：`result=available|unavailable|unknown`、`reason`。available 必须有 `forward-positive-observation-v1` 成功收据，绑定 run/attempt/source/observed_at、HTTP 200 与 source_body 路径/SHA，且同事件包含相同正文资源。negative 须有相同身份/时间/原因的 `forward-negative-observation-v1` receipt，HTTP 404/410 或明确 publisher `not_yet_published`。403、网络失败、解析失败不证明尚未发布，应写 unknown。成功证明细则由非作者发现任意 receipt 可填 known 的漏洞后补强，外层 API 保持冻结。
- `collected`：采集完成，必须带正文资源，其 SHA 与来源 body hash 一致。它只证明本次采集，不证明 lifetime first。
- `selected`、`extracted`、`evidence_pass`：本 attempt 的处理阶段。入选须已有本版本采集证据；随后阶段必须本 attempt 依次完成。
- `publication_committed`：必须有 `publication_id` 与 `publication_commit` 资源；收据使用 `forward-publication-commit-v1`，绑定相同 run/attempt/source/publication 和 `committed_at=observed_at`。收据必须含 `artifact_resource={path,sha256}`，该实际产物也须作为同事件的 receipt 资源登记并回查。此证明细则在冻结外层 API 后补强；不接收 report `generated_at` 或文件 mtime 代理。
- `source_clock`：显式来源元数据时钟 `event_at|recorded_at|source_published|source_version_updated` 与 `value`，必须有 metadata 资源；同来源同钟只能登记一次，value 不得晚于 observed_at。
- `stage_failed`：`stage=collection|selection|extraction|evidence|publication` 与 `reason`；失败不变成成功钟，后续重试用新 attempt。
- `attempt_started`：可选的真实分析/采集开始记录；缺少它则 execution duration unknown。
- `attempt_finished`：`status=completed|failed|unknown` 和 `ledger={model,input_tokens,output_tokens,usd,failure_code}`，无法取得的成本字段为 null，不以零代 unknown。失败/空输入 attempt 也须记录。

拒绝重复 event/阶段/终点、未登记或不同正文版本、run/attempt 类型漂移、逆序观察或阶段、未来观察、结束后追加、成功/失败矛盾、资源漂移、publication 收据错绑、配置与 hash 链改写。相同 UTC 可有不同序号，不因此虚构时长；规范 UTC 精度不可补午夜。

组装器输出现有 `FreshnessInput` 与 `summarizeFreshness`，另列完整采集 attempt 分母、observed availability 区间、current collection 钟和已观测阶段延迟。分析与采集分母不混。所有失败、unknown、成本未知和空刊保留；P50/P90 只用已证实时间对并显示 known/unknown 分母。

`first_observed_available` 是最早记录的成功观察。若此前有来源确认的 negative，边界为 `(last_negative, first_observed_available]`；它仍不是精确的首次可获取时刻。一条成功请求不能证明此前不可获取，因此现有 `first_available` 始终 unknown。`collected` 是本次真实采集；由于 v1 没有完整 lifetime 历史认证，现有 `first_collected` 始终 unknown。后续认证接口与证据不足均 pending，不用 `fetched_at`、窗口内最早或单个布尔声明补出首钟。

v1 无读者遥测入口，`reader_open` 始终 unknown，`reader_scenario_at=null`。探索 P/C 收据可经明确字段映射转入，但不称正式前瞻留出、改善或首发；缺阶段不生成假事件。

## 实施及验证记录

接口在实现前复制到私有不可改写封存件，SHA-256 `8b644e00f3938e5f57fac45143bbd6600ae5d685ef2396221fd5b2a9e9b99512`。全部 23 版独立盲读此前已封存，未读取另一读者结果来改标签。

Node `24.19.0` 独立运行 `npm ci --ignore-scripts`（502 packages、0 vulnerabilities）；本 worktree `.env.local` 0600 并钉本树隔离 `.data/forward-clock-runtime`，没有打开 DB。node_modules 为本树独立目录。

真实回归命令 `npx vitest run evals/rich-brief-stage0/forward-clocks.test.ts evals/rich-brief-stage0/freshness.test.ts`：2 文件、24 测试通过。覆盖完整阶段、采集与分析分母、失败/空输入/unknown 成本、单次成功及 403 不补首钟、同精度 negative、序号先后、重复和逆序、错绑正文与提交、实际产物漂移、资源/hash 链/权限/symlink、窗口及来源版本时钟。新增任意成功 receipt、403 冒充成功、遗漏正文、attempt 错绑及 publication 失败计数回归；非作者复现 expanded-year 绕过字符串未来检查后，UTC 限制四位年份/三位毫秒/Z，并覆盖 event、recorded_at、source_clock、asOf 和窗口入口。`npm run typecheck`（TS7/TS6、app/tools）及完整 `npm run lint` 均通过。

逻辑 append-only 适用于可信本地文件所有者，使用独占写入及 hash 链检测历史漂移。没有外部 head 锚，所有者能删除尾项或重算整链；它不是对抗所有者篡改的完整性公证。observed_at 与 metadata 依赖观测者的真实收据，hash 能证实固定字节而不能独立证明观测者陈述。现有 freshness terminal 枚举没有 publication_failed，因此该项在其 stage_loss 中仍为 pending_or_unobserved；本工具独立 `observed_stage_failures` 按 collection/selection/extraction/evidence/publication 保留显式失败分母和计数，明细也保留 failed_stage。

## 真实探索映射

只使用 provenance 提供的纯技术桥包 `pc-forward-technical-bridge-v1/bridge.json`，SHA-256 `9206c1522f5ff3a83daa21ea57189c3c289a7da4ed22571877b7f98985ffd4c5`；不读来源核对结论或另一读者结果。2 runs、12 acquisition attempts、48 events，保留 7 页面、3 PDF、2 licence 文档全部操作；20 HTTP requests 包含 robots。raw HTML 是解码后的 UTF-8 保存字节，PDF 是 binary；normalized 正文单列 metadata。新版本为 `pc-page-v1`/`pc-pdf-v1` 加 raw hash，不替换旧 content-v4 正文或盲读标签。

将实际资源按 hash 复制到本树 0700/0600 私有目录，保持 observed_at 为实际 operation.started_at 加实测 elapsed_ms 的完成观察；recorded_at 则为本次导入时间。成功 wrapper 绑定原技术收据、原采集回执 hash 和实际正文。导入封存回执 `.data/rich-brief-wave1/F-exploration/import-receipt.json`，SHA-256 `d3a4418ed755ed3d719dfada4aaa420cf34d82a2852a5fbf8cfdd3a04df667cf`。

phase01/02 分别 7/5 attempts，全部 completed，failed/unknown 为 0；12 项费用全 unknown，USD lower bound 为 0，不能解释为免费。分析/出版分母为 0，没有伪造选择、提取、通过或 publication commit。12 版只有 first_observed_available，negative 区间下界、精确 first_available、lifetime first_collected、来源发布/版本时钟及 reader telemetry 均 unknown；阶段 P50/P90 为 null。比较不 ready、improvement_claim=false、formal_holdout_opened=false。

非作者 provenance v2 审查封存 SHA-256 `db316530863f0d852253c7be3c546bc6608b9b9b0d6fb056963189ee8fb4e6db`，无阻塞工程 finding。独立 24/24 回归通过，expanded-year 实际 probe 从 accepted 变 rejected；两 journal 的 48 事件重放后，两个 assembly 字节 hash 与本次导入相同。审查绑定实现 SHA `12ce910df4e5b6542d26e6abec0ceeea3489b55da69c6c1c5b4768ddd19ef268`、测试 SHA `7a660d96bdad42677b72239c4f46d3a7331773aa65b99343892a1e10c187b5e6` 及上述 import receipt；本段仅追加工程评审收据，不升级质量或人类结果。

按 eval-gate 分类：离线确定性探索时钟工具不改 prompt、模型、来源适配器、校验语义或数据集，不执行业务模型，AI 质量评测不适用；不盖 AI 质量 pass 或纯重构 skip。作者阶段经非作者 Agent 独立审查后仅本地提交；后续 PR/CI/集成记录见 [离线切片验证](daily-brief-wave1-offline-preparation-2026-10-07.md)。
