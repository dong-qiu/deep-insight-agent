# R3–R6 接口与归属准备收据

## 范围与当前结论

基线为重新 fetch 的 `origin/main@ff7820af9d6517a7543355fd58524fccac6bbc19`。
10-12收尾再次fetch因GitHub网络连接超时失败；随后GitHub connector比较该SHA与远端main，
返回identical、ahead/behind均0，确认当前远端仍为此基线；原失败与替代核对结果均保留。
只新增 [接口/归属spec](../plan/specs/r3-r6-interface-preparation-2026-10-11.md)及
[分片/验收/提示词](../plan/specs/r3-r6-implementation-slices-2026-10-11.md)和本收据。
真实源码未修改。已有 S1/strict/staged terminal 与 C3 usage 不重复实现；现 terminal permit
不覆盖 usage/raw/report/startup。HTTP当前只传telemetry，getDb仍可能隐式恢复/seed。
anchored recovery 的planned分支实际可put，按源码而非旧注释列入验收。

本轮形成条件可派发的 S/U/A/P/W 切片，但源码移交、D1–D3协议决定及后续实现授权仍是前置。
所有拟owner不是实际授权；clean/合入/聊天结束不作释放。未来真实路径验收尚未执行。
普通report与anchored同owner串行；共享接口由S统一冻结；startup→HTTP/jobs→消费者由W串行。

## 本地核查

已读用户指定九份规则/协调/spec，以及 pre-pr-ai-review skill。重新核35份当前规则和
源码，沿SDK/provider、repository、collector外层txn、report final txn、startup/seed实际入口
盘点副作用。历史三份交接原件路径与SHA256实核，仅证明历史保留身份，不证明最新释放。
只读核主控、Dev-Agent-重构、Worktree清理的相关聊天，确认本聊天独立bcba及并行边界。
没有读取.env、生产数据、依赖目录/构建内容或重跑历史矩阵。

文档检查结果、独立审查与冻结hash以私有目录实际原件为准；未发生的命令、CI、PR和合入
不预写通过。普通文档不运行应用测试/typecheck/build；本提案按高风险完成双独审，
不拿文档检查替代未来实现验收。Eval不适用：本轮不改AI/应用执行代码，无模型调用。

## 独立审查

按 pre-pr-ai-review 与 L3 高风险规则，两位fresh非作者分别核新完整候选/源事实，
仅写各自私有review目录。最多两轮；修正仅复查原发现与相关delta，仍未解不换人重开。
此审查只评价新R3–R6方案，不签旧R2候选、native资格矩阵或全writer安全。
首轮完整审查：reviewer-contract B0/W1（事务未开始的not_committed分类漏项），
reviewer-wiring B0/W2（两处函数名不精确、完整cron integrity附带副作用未精确分类）。
原candidate-v1与两份原报告保留。本次最小delta补零SQL拒绝分支、校正真实函数名，
盘点cron周期orphan/维护lease/checks/daily-root，并将W4限定per-report recovery；
collection/health/shadow/notification附带writer保持未覆盖。第二轮仅核这些delta及相关影响，
第二轮、最后一轮两位reviewer均B0/W0，原三条Warning已处理；不把首轮Warnings倒签为无。
两份 `review-round2.md` 绑定 `candidate-v2c.json` 的三文档hash；spec/切片此后未变。
本收据收尾仅补实际结果、源快照计数、remote核对和交付身份，不新增方案；最终hash另入
`final-index.json`。review结论只代表新文档准备，不代表后续实现、全cron或生产通过。

## 证据与限制

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-r6-interface-prep-20261011/`；
`inventory-v1.json` 与 `source-v1/` 绑定当前35份Git blob/bytes/hash，目录0700、文件0600。
`source-supplement-v1.json`补5份源事实；首/末轮候选、原报告与源快照均保留。
`candidate-v2b`因同名spec/收据快照冲突不可用，不作审查证据；完整路径的v2c实核hash吻合。
`remote-main-final.json`绑定10-12远端核对，`docs-check-final.json`绑定最终三文档检查。
新分支 `codex/r3-r6-interface-prep-20261011`，工作区
`/Users/dongqiu/.codex/worktrees/bcba/insight-agent`。证据/工作区不清理、不移交旧路径。
后续候选head、reviewed docs hash、tested merge、精确CI attempt及合入SHA分开记录，未发生就保持无。

本轮无业务模型、资格矩阵、生产访问/部署/备份/迁移/恢复/解hold/环境清理。
safe_rollback=null、#435、原hold保持。没有全writerready、生产许可或未知子工作终止证据。
历史Warning/unknown/失败不清除；新方案与实现证据、文档CI与应用/镜像验收严格分开。

## 回退与交接

源码未改，无运行状态回退。本轮只可停止使用新文档提案；保留分支/工作区/所有原证据。
最小下一步为主控指定S/W并办shared+usage移交、冻结D1，随后授权S1→U；其余owner/D2/D3
缺口按spec矩阵协调。未识别到本轮文档PR/合入的明确授权时停在可评审文档交付。
三份新文档保留于专属分支工作区；未提交、未推送、未建PR、未合入，未释放任何源码owner。
