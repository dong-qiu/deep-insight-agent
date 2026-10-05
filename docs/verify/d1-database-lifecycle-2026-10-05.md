# D1 / TD-11 数据库职责拆分验证收据

日期：2026-10-05（Asia/Shanghai）。验收见 [D1 spec](../plan/specs/d1-database-lifecycle.md)。基线 `origin/main` @ `c7648986d96e040dcad8c7e6dd01e75759c2bbee`；分支 `refactor/d1-db-lifecycle`，隔离 worktree `insight-agent-d1`。本收据记录提交前本地结果；候选 PR/main CI 待实际运行后绑定到 PR 摘要，不提前声称通过或生产上线。

> 前面各节保留提交前时点记录；后续已完成的 PR、主干和镜像结果见 [主干交付与收尾补记](#主干交付与收尾补记)。历史红灯、当时待验证项及范围决定不覆盖或删除。

## 范围与归属

先只读盘点，再专属 spec/反例，最后分阶段实现。#404 D4、#409 认证、#410 C3 已合入，基线 main CI 37213415190 success；不重复实现，不把镜像发布当生产上线。主 worktree 的 ADR/roadmap 两处改动及四份未跟踪文档保留；其他会话工作区只读。只复制 `.env.local`，权限 0600，DATA_DIR/DB_PATH 改为 D1 隔离路径；没有复制 SQLite/WAL、原文或报告。

C2b 的专属范围声明不占用 D1 入口，其 repos/runtime/agents 活跃改动仍由 C2b 保有。C1 三个分支相对各自 merge-base 未占用四入口，干净状态不代表交接。用户随后“按照你的建议继续”，作为协调者确认 D1 临时独占 index.ts、provenance-migrations.ts、auth-reader.ts、local-bootstrap.ts 及新模块。没有直接 C1 Session 回复，不虚构通信。C1 保留 schema/recovery/delete/ops；未来生产 CLI/startup 改动串行交接。

| 模块 | 最终职责 |
| --- | --- |
| connection.ts | 创建、连接配置、失败关闭；readonly/fileMustExist/query_only，不导入 schema/runner/startup |
| migration-definitions.ts | 原冻结 SQL、48 版本与顺序；schema.ts 仍事实源 |
| migration-runner.ts | 显式 runner、历史 checksum 校验、每版本 DDL+ledger 事务 |
| migration-ledger.ts | 原 latest-only startup gate，只 SELECT，不导入 runner |
| legacy-bootstrap.ts | 原兼容 schema replay/补列，永不推进 provenance ledger |
| startup.ts | openDb 兼容初始化、orphan recovery、getDb readiness/reconciliation/seed、成功后发布缓存、close |
| index.ts / provenance-migrations.ts | 原对外入口与 DB 类型兼容 re-export |
| auth-reader.ts / local-bootstrap.ts | 分别接入 readonly factory、自有连接失败关闭 |

未拆分入口：ops migration/deployment/redaction CLI 保持 facade；controller/store.ts 自有数据库保持独立生命周期；全部 repository、业务调用方与 C2b runtime 不重写。schema、迁移版本、package/lock、CI、Docker、共享 ADR/roadmap 零修改。

## 反例、行为与修复边界

[前置收据](d1-database-lifecycle-preflight-2026-10-04.md) 和 [边界设计收据](d1-handoff-boundary-design-2026-10-05.md) 保留实施前红灯：原 63 项 59/63；另 4 项设计反例 2/4，合跑 61/67。没有用 skip/xfail 覆盖失败。

两项明确失败生命周期修复：FK/BEGIN 进入 finally 保护，抢锁失败恢复 FK；仅回滚本次成功 BEGIN 的事务，不回滚调用方已有事务。local bootstrap 的 runner/meta 任一步失败关闭自有连接且保留原错；不会回滚此前已提交版本。正常成功路径、迁移特殊分支与业务语义保持。新连接工厂亦在 pragma 失败时关闭真实连接并保留原错误。

只读范围由用户明确确认：应用零 DDL/建表/迁移/修复/业务写、不创建 missing DB 或目录；实时 WAL 允许 SQLite 自身 sidecar 协调。主文件、schema/ledger/user_version 不改；停写 DELETE 离线快照文件 hash/mtime/目录不变。测试保留实时认证对未 checkpoint 密码/角色变化的可见性，不使用 immutable/exclusive。此前严格 WAL 物理零写失败记录仍保留，当前两测试按确认的引擎例外核对主文件和数据库状态。

Startup 严格模式只校验最新 ledger，再 deployment、raw/report reconciliation、默认方向，成功后发布缓存；不偷偷调用 runner。历史 checksum 校验仍属于 explicit runner，不擅自将启动 gate 强化为完整 ledger gate。失败不缓存、正确关闭，异常后重试、路径缓存和 close 契约不变；openDb 独立连接不进入单例。

## 本地验证

全部 Node 24.19.0 / npm 11.17.0，合成数据与隔离临时数据库，零生产访问和付费模型调用。

| 验证 | 实际结果 |
| --- | --- |
| B：先修资源边界，5 个受影响测试文件 | 96/96 |
| C：迁移/连接/协调拆分，8 个受影响测试文件 | 131/131 |
| 最终 npm run test:coverage | 245 文件、2,523 用例通过；ops 150/150，零 skip |
| coverage statements / branches / functions / lines | 79.01% / 71.53% / 79.02% / 82.94%，原门限保留 |
| npm run typecheck | TS7+TS6，app/tools 四项通过 |
| npm run lint | 通过，max-warnings=0 |
| npm run build:e2e | 成功，真实构建一次 15,921ms（单次观察） |
| npm run test:e2e:built | HTTP 6 文件、7/7；同一 C5 收据 additional_builds=0 |
| npm run test:browser:built | D4 Chromium 5/5，零重试，同一构建收据 |
| 真实 CLI → 严格启动 | 白名单环境中迁移 CLI 连跑两次，48 ledger/C3 表存在，getDb 缓存和双 close 成功 |
| P1 provenance integrity | 24 vectors，与固定 expected_output 完全一致 |
| P1 metrics capacity v4 --enforce | 通过 |
| report reader P0c benchmark --enforce | passed=true，相对/绝对 P95 门通过；不是浏览器性能证明 |
| 历史字节与 fixture | 原 migration 定义（只改 export）、legacy ensureColumn/migrate 主体、latest-only gate 均与基线一致；fixture SHA256 不变 |
| 文档链接/结构、diff | 5 份专属文档和 git diff --check 通过 |
| npm audit --audit-level=high | 0 漏洞 |
| 本地 Docker | 未运行；候选 CI 独立容器门必须补足 |

冻结 fixture 在改共享实现前生成，SHA256 `8db5364ae12c3f451edb68946bb1168a2dc26ea4a7d6294e9d77372975aa8290`，48 ledger / 277 schema objects。D1 63 项覆盖空库及 v1–v47 每个已提交真实 runner 前缀，经 VACUUM INTO 文件重新打开升级，与冻结新库等价；重复最新 runner 包括 applied_at 不变。另覆盖 v48 ledger INSERT 真实失败 DDL/ledger 回滚、错误/缺失 ledger 拒绝、strict 旧库不迁移、只读 v0/v47/v48/empty/missing、单例/独立连接隔离与重试。4 项设计测试覆盖 v40 锁失败、调用方事务、meta 失败和 live WAL 认证；3 项连接测试覆盖无 schema 创建与 writer/reader pragma 清理。原 C3 SDK/writer missing-schema、Job/cancel/fencing、C1 redaction/raw/report/recovery 与真实 Auth.js 路径在全量测试中继续执行。

前缀是当前冻结 runner 的真实已提交前缀，不能替代各历史发行二进制备份或任意生产脏数据验证；专项 legacy rebuild/v42–v47 测试继续执行。生命周期故障注入仅补真实连接不可直接触发的错误，不代替文件迁移/锁竞争/HTTP/browser。实时外部 writer 会改变目录，测试不承诺 live 数据库所有文件物理不变。

## 独立审查与 Eval

独立设计评审及 C1 范围核对已完成，详见两个时点收据。最终全 diff 新上下文 pre-pr-ai-review 通过：基线 c764898，数据库改动风险高，Blocking 0 / Warning 0 / Suggestion 0。reviewer 机器逐字核对冻结 SQL/MIGRATIONS、legacy 主体和 latest-only gate；独立 Node24 跑 15 文件/195 测试（4.27s）、TS7/TS6 app/tools、diff/链接/fixture hash 均通过。全 coverage/ops/lint/build/HTTP/browser/P1 命令来自主 agent，reviewer 未独立重跑，不将其写成第二份运行证据。最终收据与完整 spec 也经定向核对。之后还需独立核对 PR 远端 diff 与冻结候选一致，不拿方案评审替代最终评审。

使用 eval-gate：无模型/prompt/provider/引用判断/预算阈值/业务数据或评测语义变更，相关代码未改且全量生产路径回归通过。未运行 A1，它不执行数据库职责拆分/迁移路径，也不能证明迁移正确性。采用 `Eval-Gate: skip (D1 database lifecycle extraction and failure cleanup; AI output and eval semantics unchanged; real DB, Job, HTTP and browser regressions pass)`。

## PR、主干、生产与回退

用户已有正常合入授权。按 [交付流程](../plan/specs/pr-delivery-evidence-workflow.md) 冻结候选、独立评审、首次提交、正常 hooks 推送、Draft PR、远端复核、full CI（应用+Docker+原必需门）。CI 后仅补 PR 摘要，记录 head/base/tested SHA、run/attempt、scope/checks、artifact 原始 hash/到期时间，不为链接修改 head。最新 main 包含于候选后，匹配已审查 head 正常 squash，再核验精确 merge SHA 的 main push CI；不使用 admin 或弱化保护。

本收据未声称 PR/main CI 已通过、已合并或生产已部署。未授权也不执行生产部署/迁移/恢复/历史修复及分支/worktree 清理。远程分支若由仓库自动删除，是仓库设置，不执行本地清理。

回退仅正常 revert 代码，保留 schema/ledger/业务数据，不降级迁移或恢复数据库。D2 实施条件：D1 已合入且精确 main CI 成功，connection/startup 接口及后续 C1 文件交接稳定；调查/spec 可提前，D1 PR 成功不替代主干验收或生产证据。

## 主干交付与收尾补记

D1 / TD-11 技术验收与主干交付已完成。[#411 交付摘要](https://github.com/dong-qiu/deep-insight-agent/pull/411)保存最终完整证明，以下补记不改变原冻结候选或提交前本地结果。

| 阶段 | 实际身份与结果 |
| --- | --- |
| 最终候选 | head `c9f395c8079bc064e476993a96d9048e6ad1784c`，base `c7648986d96e040dcad8c7e6dd01e75759c2bbee`；[PR CI 37217402707 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37217402707) full/success，实际 tested merge SHA `38861432873c02f1b5b82ce20bb701c06841ff95` |
| 独立远端复核 | GitHub 19/19 blob、完整 diff、原始三份候选证明与冻结候选一致；Blocking 0 / Warning 0，正文链接建议已处理 |
| 正常合入 | #411 于 2026-10-04T17:15:48Z squash 合入 `4e09ec93923a0d7bece2b282045a18c98eb3a1c8`，无 admin 或保护绕过 |
| 精确主干 | [main push CI 37219844193 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37219844193) completed/success、full；commit 与 tested_commit 均为实际合并 SHA；应用、独立 Docker、三个必需门成功 |
| 主干实际执行 | 245 文件/2,523 测试、ops 150/150、TS7/TS6 app/tools、lint、P1 门、HTTP 7/7、Chromium 5/5、audit 0；真实构建一次 53,425ms，两个 built 入口 additional_builds=0 |
| 自动镜像发布 | [37220231546](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37220231546) completed/success，head 为同一合并 SHA；未手动触发发布或部署 |
| 生产 | 未部署，未核验生产实际版本，未做生产迁移/恢复/历史修复；镜像成功不能证明上线 |

原 artifact ID、原 JSON SHA256、run/attempt、创建/到期时间及两阶段的完整最小 CI/Docker JSON 均保存在 #411 摘要。PR 产物实际到期 `2027-01-02T16:36:42Z`，main 产物实际到期 `2027-01-02T17:15:50Z`；原产物会过期，scope 仅摘要/hash，不能冒充完整长期原文件归档。

用户“请完成三项收尾事务”随后授权专属文档状态同步、PR 镜像结果更新及限定 D1 本地分支/worktree 清理。该授权覆盖 D1 工作区的可丢弃配置、依赖、构建/测试产物，经核实再删除；不扩展至 C1/C2b 或主工作区已有文件。清理本地资源不构成 production restore 或历史修复。

删除前只读核对发现 `.data` 是测试遗留：本地库 35 张表无业务行，仅 report FTS 内部行；三份归档逐一等于 `source-collect-entries.integration.test.ts` 的 ondemand/retry/probe 合成 envelope，hash 与文件名一致。时间与 D1 全量测试吻合。使用只读连接审计后 main DB/WAL hash 不变，无 schema replay、迁移、修复或 checkpoint；此前及审计后均须再确认无进程占用，清理不依赖 Git 忽略状态推断数据价值。没有读取或输出环境密钥。

本次文档修订只改 D1 专属 spec/收据，主工作区 ADR/roadmap 和其他会话文件保持原样。文档 PR 按轻量链接/结构/证据核对与 docs CI 交付，保留三个必需门；不为状态文字重跑模型或应用全套验证。清理实际结果由文档 PR 与 #411 摘要在执行后记录，不在执行前声称已删除。

D2 数据库前置已满足，后续具体 C1/C2b 共享文件仍串行交接。ops CLI/controller 保留入口是明确兼容边界，不是尚未完成的 D1 实现。
