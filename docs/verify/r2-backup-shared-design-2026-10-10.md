# R2 backup-only 共享接口设计与双独立评审收据

## 结论与授权

用户授权本轮仅进行共享接口设计、独立评审及实施窗口准备。
本轮已形成条件合同、完成两轮双非作者审查、修订发现并保存精确输入；
**条件设计未签通过，完整 R2 未冻结为可实现方案，未进入源码实施。**

首轮六项设计 Warning 经第二轮确认为设计层闭合。第二轮两位 Reviewer
都发现新增物理绑定段的同一个字段错配，故各保留 B0/W1/S0，不签通过。
随后协调者按真实 S0 源码修正该文案，但未开展第三轮，**不将最终修正版
冒充已经独立复核通过**。这不同于声称当前实际源仍存在该文案错误。

使用 pre-pr-ai-review 的高风险双独立流程及最多两轮规则，保留原审查关注点。
本轮没有 PR、提交、tested merge、main CI、共享实现或合法正例接受身份。
`design_condition_accepted=false`、`implementation_ready=false`、
`positive_admission_ready=false`。

## 身份与归属

- worktree：`/Users/dongqiu/Dev/code/insight-agent-r2-backup-20261010`。
- 分支：`refactor/r2-backup-contract-20261010`。
- 已 fetch 的 origin/main 与本轮 HEAD：`22fc151ec5d452efc06527987b2a48af93d21524`。
- 仅四份专属未跟踪 Markdown；已有源码、其他工作区和三主台账未修改。
- C1 三文件的原恢复移交仍有效；不因这次设计接管共享维护源或 native/build 文件。
- 主工作区、旧 C1 工作区、本 worktree、私有证据均保留，未清理。

## 合同与反例要求

主合同：[r2-backup-shared-interface-v1.md](../plan/specs/r2-backup-shared-interface-v1.md)。
其中 A01–A14 全部仍是**待实施、待执行的验收要求**，不是已通过用例。

| 设计项 | 本轮修订 | 证据边界 |
| --- | --- | --- |
| 首次 reservation 未知 | 首 SQL 前建立文件及父目录已同步的永久 intent；无 attempt 行也阻断；明确 pre-intent crash 限制 | 两位 Reviewer 接受设计，不是崩溃测试 |
| 实际撤销来源 | registry close 仅止 writer 准入；backup 失权为 S0 hold/CAS 或 attempt 停止事实 | 未交付共享固定锁域源码 |
| 原始取消/窗口 | prepare 异步但不重置预算；绑定原 signal；无消费时替换接口；锁外让出且 syscall 前直核 | 未证明原生停止或硬实时 deadline |
| 发布与轮转 | publication、durability、controlReceipt 独立分列；三者确认才删旧恢复点 | 未执行 Linux 正例或 fsync 失败试验 |
| 精确删除树 | 不可扩展 postorder；仅按确认动作推进；部分删除与未知逐项记录 | 未交付文件删除 consumer |
| 物理字段修正 | target.dataPath=DATA_DIR=isolationRoot；DB_PATH 为 root 下固定数据库文件 | 第二轮之后的协调者修正，未补签独立通过 |

不使用 inspect/空 task/签名 stopped/complete manifest 伪造许可。
当前 A3/R6 实际全入口覆盖生产者尚未交付，正向准入保持明确拒绝。
同进程 no-replace 固定原语为条件设计选型；native/build 最小窗口仍待冻结，
没有新增依赖或改变 Docker/npm/CI/cron 运行时闭包。

## 精确评审绑定

评审原件位于本 worktree 的 `.cache/r2-design-review/`，已复制私有持久归档。

| 对象 | SHA-256 | 结论 |
| --- | --- | --- |
| 首轮草案 | `811ec5e39b6a437120ccee844f71ea109d8539408269c71d144f992e296e0b64` | A B0/W2/S1；B B0/W4/S1 |
| 第二轮草案 | `09f3431437449d653f3b2cee6df60e904d8de8ca65451b8130ebf75bc9bff980` | A/B 各 B0/W1/S0，不通过 |
| 后置修正版 | `73c551e0964a3885c4587dcb5e40b3db030f1502d20859306d75e35bf1dd44d1` | 字段及状态说明修正；未独立补签 |
| A 首轮原件 | `04fedfa1a47b2ee91735982c783bf66dde6f08a9f1ede504f7a0cc82ac50ad04` | 保留 |
| A 第二轮原件 | `8b1f32f475b04c7300edacf32bf57c0918a867dbeecd0917bba04467425c7235` | 保留 W3 |
| B 首轮原件 | `218aaea7c7ae0d5197addb0f398d9105d762cb4e3e3ac56dbbd36ade9f7e5bd0` | 保留 |
| B 第二轮原件 | `3bdc9815eddcb0ff726beebddb4d4fd2f08e500ba34e88b4eb1f62413e6565e6` | 保留 W5，同一字段问题 |

## 已执行验证与未证明范围

- Node 24.19.0、无凭据白名单进程执行 `npm run typecheck`，四项 TS7/TS6 检查 exit 0。
  日志 SHA-256：`4576ccb2819cc20836f7a61bb82deb02ab9b14fa92983ef552b0098d4e9425a1`。
- 实际调用仓库 `checkDocuments` 检查本轮专属文档的格式、相对链接和 anchor；
  这是未提交工作区的本地检查，输入 scope 在内存构造，不是 Git/远端 CI 门证据。
- 只读核对真实 S0 的 initialize/openLedger 均要求 target.dataPath 为 root 目录；
  后置文案修正不更改旧 marker/schema 或源码。
- 已确认 ops/src/工作流/package/Docker 跟踪源码 diff 为空；三 C1 和三共享文件
  identity/hash 未变，精确清单在本轮私有 identity.json。
- 没有执行 R2 新功能测试、Linux syscall/probe、业务 DB 操作、构建/镜像或应用 CI。
  上轮旧 C1 26 pass、held 红例仍绑定旧证据，不补签本轮 A01–A14。
- 没有 AI 语义变更；Eval 不适用，不调用真实模型，不以 A1 证明备份协议。

## 后续最小窗口与停止条件

以下是实施准备建议，不是本轮源码授权或完整工程已就绪证明：

1. 先明确移交 `ops/maintenance/ledger.mjs`、`writers.mjs`、`writers.d.mts`
   给唯一共享 owner，并对后置字段修正及必要 ADR/架构入口完成责任签收。
2. 冻结两个不重叠窄片：新的 backup attempt/拒绝状态内核；同进程 no-replace
   原语的限定资格试验。后者须列出精确 native/build 文件，不能沿用泛称授权。
3. 唯一 owner 串行处理真实 registry→S0→attempt 固定接口；另由 A3/R6
   完成实际覆盖生产者、入口清单及迟到写入/continuation 证据。缺这些时拒绝
   路径可以验收，完整合法备份不能验收，不能把所有前置归为只差授权。
4. 前置齐备后才做真实隔离组合正例；C1 CLI/cron 及镜像闭包切换另批确认，
   避免未具备准入时令现在线上备份静默失效。

不通过第三轮重复 review 改签当前方案；不擅自接管、实现或解除 hold。
方案关注点、源码归属及工程依赖均有明确接收方后，才能确定后续实施窗口。

## 保全与生产边界

本轮持久归档：
`/Users/dongqiu/.local/share/insight-agent/evidence/r2-shared-design-20261010-NClji3/`。
仅保存本轮文档、评审输入/原件、检查日志和身份 metadata；索引及 checksum
独立封存，目录 0700、文件 0600。本地归档不等于异地备份。
旧归档 `r2-backup-contract-20261010-SQ1mrN` 原封不动；未复制凭据、原文或业务 DB。

`safe_rollback=null`、deployment blocked、既有 hold 和 #435 保持。
未访问或操作生产、未部署、未恢复、未迁移、未调用模型、未清理。
R2/TD-09/TD-19 不因本轮设计及静态检查关闭。
