# D7 / TD-20：标识容量审计与新对象 ID 熵提升

日期：2026-10-06（Asia/Shanghai）。实施基线：`origin/main` @ `4855d0c3eec26a7bc5ac6a74dee684b5f2c051f7`。
状态：S1 范围及六处生成表达式交接已由用户确认（2026-10-06）；按以下最小范围实施。
承接 [TD-20](technical-debt-remediation.md)、[架构](../architecture.md)、
[审计与处置表](../../verify/d7-id-capacity-audit-2026-10-06.md)。

## 建议范围及理由

建议分阶段交付，先实施 S1：五种随机对象、六个生成表达式。S1 通过后仍仅为 TD-20 部分完成。
S2 中的低熵风险继续登记，不能因本轮 PR/CI 成功而关闭整体 TD-20。

| 切片 | 实体 / 生成位置 | 处置 |
| --- | --- | --- |
| S1 | Run：`runtime/jobs.ts` 的 `runBudgetedJob` | 缺省新 Run 从 32 位提升；existingRunId 原样复用 |
| S1 | Report：`agents/report-gen.ts` 的 `buildReport`；`db/reports.ts` 的 `saveFailedReport` | 成功与失败默认入口一起提升，显式 input.id 保留 |
| S1 | FollowupQA：`app/api/reports/[id]/followup/route.ts` 的 POST | 回答成功后的新 QA 提升；thread_id 继续等于 QA ID |
| S1 | TechLead：`db/tech-leads.ts` 的 `upsertTechLeads` | 新记录提升；canonical_key 命中旧对象时复用原 ID |
| S1 | TechnologyOpportunity：`db/planning.ts` 的 `upsertTechnologyOpportunities` | 新记录提升；update 仍复用 row.id，保留原随机调用位置与次数 |
| S2，待另确认 | Topic / Source 自动 ID：`db/validate.ts` | 16 位随机后缀存在同 slug 容量风险；Source ID 直接进入模型输入；Topic ID 进入缓存/输入身份 |
| S2，待另确认 | Analyzer candidate / AnalysisBatch：`agents/analyzer.ts` | candidate 44 位、batch 32 位；batch 派生 Insight/event ID，后者进入未来历史模型输入，不能预签 AI 不变 |
| 保留 | 确定性 ContentItem、citation_ref、fingerprint、canonical_key、UUIDv5、缓存、幂等键、Controller 身份 | 稳定性契约优先；不按字符串长度统一 |
| 保留 | 已有完整 UUID 对象、provider / 外部身份、静态配置 ID、fixture、eval run/temp 文件 | 无本切片容量收益，避免引入无关协议变化 |

S1 是零付费优先的小切片：所改 ID 用于应用对象关联，不直接进入 Analyzer/Validator/coverage/PPT polish 请求。
报告正文生成不使用 Report ID/prevReportId，必须保持同输入同字节；页面邻接URL、通知链接、PPT页脚及缓存行归属随新对象身份变化，需要真实报告接线证明。
不得仅凭静态调查最终签 eval；最终 diff、请求对照及生产路径回归共同支持质量结论。
S2 的新 event_id 长度会影响未来历史 payload/token，模型验证范围与预算须另外确认。

## 格式选择

| 候选 | 随机来源 / 有效随机位数 | 编码 / 长度 | 取舍 |
| --- | --- | --- | --- |
| 建议：16 bytes hex | `node:crypto.randomBytes(16)`，128 位 | 保留 `run/rep/fup/lead/opp` 前缀 + `_` + 32 小写 hex；36 或 37 字符 | 路径、CLI、anchor 与 JSON 消费方现有字符集兼容，无新依赖 |
| 完整 UUID 去连字符 | `node:crypto.randomUUID()`，122 位 | 同前缀 + 32 hex | 与已有 provenance 模式一致；版本/variant 占 6 位，不能写成 128 位随机 |
| 16 bytes base64url | 128 位 | 同前缀 + 22 字符 | 更短；大写、`-`、`_` 不兼容现有报告预览 CLI 的小写字母数字后缀门，需要额外协议修改 |
| 保留 UUID 前缀 20 hex 等 | 取决于去连字符顺序、version/variant 所在位置 | 需逐位计算 | 无必要以手工截断换微小长度收益 |

建议 helper 放入 `src/lib/utils/object-id.ts`，只接受上述五种前缀的类型联合。
不提供解析、迁移、重试、命名空间注册或 caller 自选长度，不建设通用 ID 平台。
生产接线必须仍直接使用 Node CSPRNG；不以测试注入随机源替代生产生成器验证。

## 历史及输入安全契约

- 不改历史 ID、URL、正文、文件名、FK、引用、索引或通知归属；新旧对象允许共存。
- SQLite 相关主键/外键为 TEXT，现有 schema 无这些随机对象的固定长度门；不新增 migration、DDL 或 checksum 变化。
- 不将 reader 限制为新格式。保留已有精确查询、参数绑定、认证、路径安全及长度门；新生成值满足现有边界。
- 新随机 ID 只含固定小写前缀、下划线、32 小写 hex，总长度最大 37；不得为兼容放宽输入上限。
- 报告前缀文件名 `<rep-id>.md/.html`、anchor 的 `<rep-id>-md/html` 与 `report_file:<rep-id>` 仍按相同公式派生。
- `report_file:<id>` 等幂等键的算法保持原样；新对象自然产生新实例值，不把实例值变化误写成算法变化。
- 已有 PK/unique 冲突继续拒绝；不添加碰撞重试、不吞 SQL 错误、不因 ID 碰撞重执行业务/模型请求。
- 保留生成时间及分支位置：Run 在原位置生成；failed report 显式 ID 不抽样；Followup 仍在 answer 成功后生成；Lead 仅 insert 抽样；Opportunity 有 lead 的每轮仍抽一次，包括 update。
- 不改变既有排序、canonical_key公式、cache inputs、event 复用或 citation 复合绑定；Opportunity 的 canonical_key 引用 lead.id，因此新 Lead 自然产生新 key 实例值；旧对象及其 key 不重新计算，不重造旧 fixture。

## 文件交接与受保护契约

已建立 `feat/d7-id-capacity` / `insight-agent-d7`；仅复制 `.env.local`，0600，DB_PATH/DATA_DIR 为该 worktree 的绝对隔离路径。
没有复制 `.data`、SQLite/WAL、原文、报告或 `.env.development.local`，未打开业务数据库。
主工作区 Brief 的 ADR/roadmap 与未提交专属文档保持原样。

现场 D3 位于 `insight-agent-d3`，新增其专属 spec/benchmark/fixture/protection test；现有 src 未见修改不是交接证明。
其窄窗口为 graph.ts/analysis.ts；D7 不改这两处。实施前 D3 #418 已合入4855d0c，仅新增测试/证据/benchmark；S1六处生产文件未改变，reader继续接受opaque ID。
Brief 保留 analyzer、report-gen、pipeline、reports/report-review；C1 保留 schema、恢复、删除、启动和 ops。
没有可调用的跨 Session 消息通道；独立 reviewer 不冒充这些窗口负责人。

用户已确认 S1 六个生成表达式与专属新测试的窄窗口：
`runtime/jobs.ts`、`agents/report-gen.ts`、`db/reports.ts`、`db/tech-leads.ts`、`db/planning.ts`、
`app/api/reports/[id]/followup/route.ts`；保留其他函数及 reader 接口，不修改 pipeline、schema、共享测试或 D3 优化。
此前未交接时仅做专属文档、只读审计与不重叠新测试；本次根据用户明确确认进入实施。不能用分支干净或旧 PR 合入推定文件释放。

继续保留 [D1](d1-database-lifecycle.md)、[C2a](c2a-task-cancellation.md)、
[C3](c3-model-usage-persistence.md)、[C2b](c2b-task-budget.md)、[D2 处置](d2-scope-disposition.md) 和
[发布协议](generation-provenance.md)：每写 fencing、首个取消原因、预算门顺序、usage attempt 身份、
发布白名单、planned→committed/failed effect 与删除拒绝门不变。

## 先反例、后实现的验收

1. 专属保护测试先在旧源码上冻结短 ID：真实 DB 同时保留旧格式和预期长格式对象，精确读取、列表、关联与重复提交不重新编号。
2. 在旧源码上证明新格式接线断言为红；再逐阶段实现 Run/QA/Lead/Opportunity 与成功/失败报告入口。
3. 生产 helper 实际接线断言前缀、32 小写 hex、36/37 长度；受控 Node 随机源验证 16 bytes、一处一次的调用契约，两类证据互补。
4. 唯一冲突拒绝、FK 错误不被吞、事务回滚及已有幂等/canonical update 行为不变；复用 Run/failed report ID 不抽样。
5. `runReportGen → DB validation/history → buildReport → saveReport → artifacts/index/FTS → reader` 实际接线：新旧邻接报告、引用白名单、index、失败不可读、重试新对象、取消/失租约拒写。
6. Followup 的真实 POST（mock 模型 transport/answer 边界）→ saveFollowup → GET：旧 report/new QA 与新 report/旧 QA 均精确关联、thread 与引用锚一致；失败不落错误关联。
7. Lead/Opportunity 真实 insert/update → DB → reader/API：旧 canonical 对象保持 ID；新 ID 对应正确 citation/lead；列表同时读旧/新格式。
8. 相关 URL、参数与路径安全反例仍拒绝 traversal/NUL/非法字符；不放宽现有门。新 report 的 anchor/manifest 纯契约与 C1 文件清单路径关联仅做合成测试，不执行恢复/生产操作。
9. 固定输入的 `contentItemId`、UUIDv5、canonical_key、引用与 cache hash 保持相同；旧 fixture/source 文件不变。
10. 实施前在基线源码冻结长ID合成fixture的只读消费行为，实施后验证相同消费契约；不用版本回滚/恢复实验代替，不运行旧 startup/reconciliation，不删改数据解决兼容性。

所有受影响测试、`npm run typecheck`（TS7/TS6 app/tools）、lint、build、HTTP E2E、D4 browser smoke；
沿用 C5 一个 build 收据及 built 校验。按 eval-gate 使用报告真实路径 scoped 回归，若发现 AI 输入/判断变化，
停止扩大并申请 scoped 模型验证的范围与预算，不预盖 skip，不用无关 A1。
方案与最终完整 diff 独立审查；修正重要发现后复查。按 pre-pr-ai-review 创建 PR，核验最终候选精确 SHA 的 CI。

## 回退与退出

S1 无 schema 变化，但回退前必须验证旧 reader 能消费已经生成的 36/37 字符新 ID，包括路径、FK、retry_of、
report prev/index/FTS、QA/thread、lead/opportunity 关联。源码 inspection 目前支持，不等于实验已通过。
回退生成器会重新产生短 ID 的旧容量风险，不能称为完整治理回退。
不允许为回退删除/改写新数据、URL 或报告，也不回退 migration/ledger；生产回退与恢复实验均不执行。

本任务到 PR + 最终候选 CI 成功为止；不合并、部署、生产迁移、恢复、历史修复或 branch/worktree 清理。
S2 和审计表保留风险另行处理。独立审查/CI 不替代范围确认，也不证明生产已上线。
