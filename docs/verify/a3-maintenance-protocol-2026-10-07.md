# A3-S0：隔离维护账本与执行状态交付收据

## 范围与基线

fetch 后 base：`a5253da8a4e9c40f8098235d6976e5a7b7f6eb71`；branch
`feat/a3-maintenance-protocol-20261007`；专属 linked worktree `insight-agent-a3`。
[spec](../plan/specs/a3-maintenance-protocol.md) 登记实际入口与阻塞、A2/A3 接口提案、状态机、AC 和授权。
只新增四个 [maintenance 文件](../../ops/maintenance/ledger.mjs) 和两份专属文档。
不复制任何 `.env`/业务数据，不访问其他 Session 工作区，不访问生产/AWS/SSM，不 dispatch、drain/stop/restart、
生产备份/迁移/恢复/配置覆盖/历史修复，不调用付费模型，不合并、不清理分支/worktree。
测试创建并清理自身合成 temp fixtures；原始验证日志另存，非生产数据。

S0 是用户允许的大任务小切片。没有取得 A2 Session 的接口确认，不能宣称双方已冻结；
用户要求专业建议后，本轮继续独立 S0，把 A2 的资格与 A3 的互斥/静默/执行状态边界写成待确认提案。
共享 workflow、备份/恢复 CLI、runtime、schema、运维手册、ADR 均零修改。
本片不签 A2 ready、drain ready 或任何生产执行许可，不能由模块或 PR 完成推出全部 A3 完成。

## 持久化、状态与接口

实际隔离实现：canonical 绝对目录 0700/current uid；SPKI Ed25519 公钥身份固定；
marker O_EXCL、文件和目录 fsync 后才创建0600独立 SQLite，schema/genesis 同事务。
marker/genesis initId、target、approver/key 精确一致；DELETE journal / FULL synchronous / timeout=0 / BEGIN IMMEDIATE。
append-only snapshot audit hash-chain、固定 schema/version；缺失、损坏、半初始化、错权限/链接、错 genesis 都 fail closed。
没有 TTL、exit 解锁或删除 hold。不同维护 kind 共享 active 操作；非等待竞争；operation ID 永久保留，精确重复返回历史结果；
owner/target/execution/fence/revision 精确核验，旧 owner 不能变更新操作。

未来 host 候选路径 `/var/lib/insight-maintenance/` 只是设计，当前从未 provision/访问；
实际只允许 `region=isolated`、fixture instance/volume/executor、dataPath 绑定测试根。
同 uid/root 能完全替换/删除目录或回滚整账本，hash-chain 不是防恶意管理员/全账本回滚的锚；
open 不自动重建，init 仅接受空隔离目录。生产身份 provision、外部防回滚/丢失接管、writer 只读接口均未实现。
不得删原记录后再 init；本片不是提供该行为的授权，未来生产初始化不能复用隔离 CLI。

状态：pre_submit → submission_unknown → submitted → running → terminal_pending → terminal_verified；
cancel_requested 表示取消请求事实；manual_takeover 与 sticky held 表示接管/阻断。
持久 unknown 后唯一一次 fixture transport，提交超时、轮询失败、取消返回、重启不释放、不自动重发。
完整响应绑定 submit token/requestHash/commandId/target/owner/fence/executor。
精确重复或迟到非终态不倒退、不放行；旧 revision 非精确 mutation 拒绝且 audit 不变；当前终态冲突持久 held。

人工授权单 domain/version/canonical JSON/字段严格固定，绑定当前 revision 与完整操作/命令身份。
release/terminal_verify 必须 Ed25519 批准人签名、实际有界普通0600证据文件、原始字节 SHA256、精确 binding，
并声明 fixture remote/local controller/continuations 均停止。takeover 允许未知，保留 hold。
授权及原证据同事务持久保存；失败核终态保持 hold，成功且无 sticky hold 才能 complete。
release 只允许下一隔离维护，不启动 writer、不重新执行原任务，所有 CLI 输出 production_permitted=false。
签名和文件核验不证明真实 OS 或 SSM 派生/脱离子进程已终止；假签名者陈述无法由本模块验真。
本地暂停提交者可能恢复发送，CAS 仅 fence 写回；没有全执行者停止证据只能接管，不得解除。

A2 接口提案：共用精确 target/operation/owner/fence/revision/execution identity；A2 收据引用/hash 绑定
候选与回退镜像及 before_stop/after_backup/after_migration 数据阶段。A3 不授予漏洞修复/兼容资格。
本片未消费 A2 收据；没有安全回退时未来停止后的失败继续保持 writer 停止并交值守，不自动恢复旧镜像/DB/逆迁移。

## 实际接线与证明边界

[隔离 CLI](../../ops/maintenance/cli.mjs) 的 init/acquire/begin-submit/bind-command/observe/cancel/hold/complete/authorize
全部调用真实 ledger，不提供 shell/AWS/执行备份/迁移/切换 adapter。deploy/backup/restore 是隔离 operation kind，
不是接入既有生产命令。fixture submit 由真实 module 编排、mock transport；CLI begin-submit 仅记录发送前未知状态。
已有 backup-db、db-restore、SSM/host 脚本、app/API/cron/dispatch、启动 reconciliation、进程内/独立任务均**未接入**。
旧报告维护脚本保持只读 snapshot preview，旧 deploy exit2、P1 dormant、恢复启动阻断均保留。

本片没有实现全 writer 准入、task registry、有限 drain、queued/claimed/expired lease 处置或迟到业务写入 guard。
既有取消/fencing/预算/发布回归只证明保留原契约，不能作为 A3 全 writer 准入/静默证据。
SSM 的取消/终态只在本地状态机和 mock fixture 上验证；未对真实 AWS 提交/轮询/取消，也未验证远端进程。
失败后没有执行 backup/migrate/switch 的代码能力；不能把这点写成既有运维入口已调用协议并停止后续步骤。
#435 workflow/policy 与基线逐字不变；生产硬阻断未解除，不增加任何部署 unlock 参数。

## 本地验证与原产物

Node `24.19.0`，干净 `npm ci`，无依赖变更、无凭据/数据复制。
首次互斥测试在 ledger 尚不存在时 ERR_MODULE_NOT_FOUND（红）；实现后反例通过。

| 验证 | 结果与边界 |
| --- | --- |
| `node --test ops/maintenance/protocol.node-test.mjs` | 52/52；真实 CLI/子进程竞争、重放、错身份、损坏/半初始化、unknown/取消/重启、签名/文件/原bytes、迟到状态反例 |
| `npm run test:ops` | 289：288 pass、1 既有 Linux Actions Docker 集成本地 skip；C1/历史封闭/worker drain/身份硬阻断保持 |
| 7 个 runtime/agent/DB 定向 Vitest 文件 | 145/145（jobs cancellation、task-budget integration、c2a integration、generation-dispatch、D1、reports cancellation、raw archive） |
| `npm run typecheck` | TS7+TS6 app/tools 通过；独立 reviewer 另运行通过 |
| `npm run lint` | 全仓目标零 warning；独立 reviewer maintenance 文件另通过 |
| `actionlint .github/workflows/deploy.yml` | 通过，workflow 无 diff |
| 文档链接/锚点/格式与 `git diff --check` | 冻结提交前检查，结果记录 PR 摘要 |
| 本地 build/HTTP/browser/Docker | 未执行：本片零 app/runtime/build/router/dependency/镜像接线变更；最终 PR full CI 另核，不能借旧构建收据 |

原始定向/ops/lint日志：`/tmp/insight-a3-evidence-20261007.Rq6vkN/`；
该目录只存本轮验证日志，不是恢复库、生产备份或长期部署证据。CI 原产物由精确 PR run 提供。
本地日志与本收据不冒充尚未创建的精确 PR head/merge CI；最终 base/head、PR、CI 在 PR 交付摘要绑定。

## 独立审查与 eval

完整读取 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。
新上下文 a3_plan_review 首轮五项 Warning，修正 init/SSM/CAS/停止证据/签名规则后方案复核通过，Blocking0/Warning0。
新上下文 a3_implementation_review 完整实现审查发现四项 Warning：旧 revision 冲突绕 CAS、UTF8 解码后 hash 非原bytes、
createPublicKey 接受 private PEM、已有连接的版本/schema 未在事务内重核；全部修正并新增反例，独立复核 52/52、lint/typecheck通过，未解决 Blocking0/Warning0。
reviewer 另构造隔离 child 未提交大 insert、真实 hot journal 后异常退出：SQLite 恢复后 canonical state 与原状态一致，
held 保留。该独立实验未成为常规测试，不是实际主机重启、业务任务 drain 或远端 SSM 终止证明。
最终文档和远端完整候选/精确 CI 仍由独立 reviewer 复核并记录 PR。

最终 diff 仅 ops/maintenance 与专属文档，不命中 AI agent/prompt/model/validator/source/dataset，
AI eval 不适用，未预签或添加 Eval-Gate skip trailer。A1 不执行本维护协议；不调用付费模型、不把不相关 eval 当证明。

## 阻塞、后续交接与授权

下一片先由用户协调 A2/A3 接口及共享文件串行交接，再实现真实 all-writer admission/task registry/drain/lease/commit guards；
必须逐入口反例证明新写拒绝、在途停止/完成、迟到拒写和未知进程不放行，不能用 SIGTERM/readiness/SQL count 替代。
随后串行接 backup/restore/host SSM/deploy；真实 target/执行身份、账本 provision/防回滚/host 丢失及可信停止证据另审。
安全回退/数据兼容、当前生产版本与配置/备份/容量、实名 operator/on-call/reviewer/批准人仍缺；历史观察不证明当前状态。
共享入口未交接、A2 未确认、不合格回退或未知 writer/执行终态均继续阻塞。

生产核验/操作必须另申请精确实例/区域/卷/目录/服务、命令、窗口、副作用、证据/失败处置和人员授权；
避 16:50–17:30 UTC，与其他维护串行。工程切片/PR 不等于全部部署条件满足、修复上线或 TD-19 关闭。

## 首次 PR CI 失败记录

[PR #440](https://github.com/dong-qiu/deep-insight-agent/pull/440) 首次 head `2a7fc298f3c445826c95f59a20a0eca3c69299e0`，
[CI 37614378766 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37614378766) 测试 merge
`d11b53ff6cddad8d8abdcf2141bd92161b568aec`，mode=full。Docker 验证/收据通过；应用 Vitest
2935 pass、1 fail：未改动的 `d3-reader-batch-boundary.test.ts:14` 的 801 IDs 用例超过默认5000ms。
该次 Vitest 失败后 ops/build/HTTP/browser 未执行，没有应用 CI 收据，不能宣称 CI 全绿。
精确基线 [CI 37603495951](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37603495951) 同文件7项通过、
全 Vitest 2936项通过；本地原测试另诊断7/7通过。这些观察不能单独证明超时为 flaky，也不替代最终 CI。
本补记保留失败事实；业务测试/阈值/CI/代码字节均不改，后续精确候选 full CI 与独立复核记录在 PR 摘要。
