# A3-S3a strict isolated terminal 提交 fencing 候选收据

状态：实施候选待两位独立最终diff review、正常PR与精确CI；未合入、未上线，生产仍阻断。
本片只覆盖真实core dispatch done/failed同步终态事务，不覆盖全部生成writer。
对应[冻结方案与实现增量](../plan/specs/a3-commit-fencing.md)。原4998方案31794bytes，
SHA256 `5f8d6798c7c424700f661c4c8cbbaf98aa2b19bcba81cfc729ffaa03a3dfe7e9`，两独立方案
B0/W0；b4d B0/W1及初调查pending时点保留，不改签历史。

## 前置、范围和消费接口

启动重新fetch origin/main `56c7ddbcf0bc9d6a7d84f231e6804896d76d0841`，直接GitHub核
`37696229494 / attempt1 / completed / success / headSha=56c7ddb`。
包含S0 #448 `cb2f924`、S1 #445 `0ca3ec9`；其精确main success由协调者核验保全。
新独立WT `insight-agent-a3-terminal-20261008` / `feat/a3-terminal-fencing-20261008` / PORT3123。
正常顺序cherry-pick6176→b4→4998，仅引入专属完整spec，起点8ab1391，未复制其他Session源码。
S2源/test/spec/receipt保持独立冻结，此片不依赖未合S2源，不把S2 PR/main待办写通过。
工作中共享origin/main ref已推进cfca8bc；本候选base仍56c，最终PR前必须正常同步及重新绑定
最新main/tested对象/CI，不能移植原56c成功或旧镜像矩阵。

public port为 `a3-terminal-commit-v1` / `close-fences-terminal`，只在显式
`runtime.terminalWriterAdmission` 时激活。S1 cooperative close/localfinish/default照旧；
strict的close本身撤销该terminal消费者，不新增“合作drain后第二阶段revoke”或持久profile字段。
registry的一个私有连接BEGIN IMMEDIATE→完整validate/task/marker→固定同步driver业务事务
→真实业务COMMIT返回→registry COMMIT，锁序registry→business，不跨await，不公开work callback。
factory `openTerminalDispatchDriver(root)` 只打开同root `fixture-business.sqlite`，fileMustExist/
timeout0，不初始化/迁移/reconcile，不接受custom factory、filename、callback或agent输入。

两个内部Symbol只读数据桥记录factory物理descriptor与admission业务连接引用，driver/
descriptor/marker嵌套freeze，DB不deep freeze。core在admit/claim前核确切DB对象及literal
scope/version/profile，错/缺桥或同时配置S1 port拒绝。Symbol/shape/freeze不认证OS或同uid
身份，不证明任意外部callback安全；真实受审composition仅由固定factory产出driver。
每次registry/business BEGIN前无SQL核root700/DB600/owner/nlink/canonical/dev/ino/marker/
sidecars，事务内完整复核。driver只向下依赖db/provenance，core无ops runtime依赖，
Docker allowlist没有扩大。

freshcap仅当前admit当场mint，private WeakMap对象身份；真实claim返回后、execute前一次
绑定不可变六字段dispatchId/traceId/ownerToken/claimEpoch/fencingEpoch/rootRunId。
同connection所有admission共用claim tuple索引，finish/deny/unknown不删除；任一terminal
attempt消费权限，未绑定/JSON clone/跨closure/重启旧cap/同claim换cap不能重试。
固定driver同外层业务事务执行完整lease+dispatch guard及真实trace.root_run_id/Run.trace_id
关联，再调原finishGenerationDispatch嵌套savepoint；wrong root不会修改另一个Run。

## 三态与实际core收尾

- committed：业务COMMIT与registry COMMIT都返回。
- not_committed：业务未进入写事务，或未尝试COMMIT且显式ROLLBACK成功。
- unknown：COMMIT尝试后抛错/rollback失败/未分类driver切点，业务事实未知；业务COMMIT
  已返回但registry失败则unknown/businessCommit=committed，不称rollback或重新finish。

strict实际terminal尝试后返回可选terminalCommit，固定脱敏诊断不写新历史schema，不覆盖
原lease>C2a>C3>budget优先与首取消reason。done deny/false/throw和post-COMMIT读/状态错误
不会再catch→failed terminal；execute真正失败只有一次guarded failed。strict最外localfinish
若失败而已有terminal结果，返回status failed保留原三态，task仍unfinished/remoteunknown；
未形成terminaldiagnostic的preclaim/no_claim异常继续reject。Default/S1返回形状和行为不变。
不从core status failed推断business回滚，不补写本地completion、不重试、不删除记录。

## 实际反例与验证

全部运行使用Node24.19.0、env-i、隔离真实provenance fixture，0700目录/0600数据库。
测试实际openDb/provenance migration/createRequest/claim/core/finish、SQLite锁和独立process，
controlled executor/故障注入仅证明控制协议，不调用模型、抓取、通知、cron或生产服务。
构建用自有最小synthetic配置；最初必要copy保留owner0600 `.env.local.retained-before-isolated-build`，
不输出密钥、不将复制的凭据注入构建。没有新模型/prompt/validator/来源/评测口径或预算。

| 原始材料 | 实际执行与绑定 |
| --- | --- |
| `ops-v2.log` | finalized writer/driver及14专属terminal tests，全部ops422：418pass、4本地Linux镜像skip、0fail，umask077；不是Linux镜像通过 |
| `terminal-final-v2.log` | 14/14真实专属node tests，0skip；同源fixed事务、并发、物理身份、finish false、rollback/COMMIT/registry和SIGKILL切点；补充已通过原S1 finish完成task的cap拒绝及同claim再mint拒绝 |
| `final-core-v3.log` | strict17 + driver4 + S1 core8 + default core12 = 41/41，0skip，final runtime/core/source；后续仅专属partial-coverage test改为真实C3写入另验 |
| `real-uncovered-usage-v1.log` | 全strict17，真实C3 begin/observe在strict terminal closed后仍可写，原lease guard保留、partial费用null、零provider调用；证明部分覆盖仍blocked |
| `regressions-v1.log` | 12文件298通过，含C2a/C2b/C3、报告发布/白名单与planned/committed/anchor recovery；运行于strict收尾增量前，publication模块字节未变，最终core另由41项验收，不将旧strict结果补签新分支 |
| `typecheck-v3.log` | 最终TS7/TS6 app/tools四编译通过 |
| `declarations-v1.log` | shared terminal port/writers.d.mts独立TS6声明检查通过 |
| `lint-v3.log`、`lint-v4.log` | 项目lint与最终全部改动source/test定向lint通过 |
| `build-v2.log` | final runtime/core生产build成功，Next无ops runtime依赖、动态路由构建正常；不是Docker或生产验收 |
| `docker-local-unavailable-v1.log` | 明确本机Docker Desktop socket不存在，probe exit1，未启动daemon、未构建/运行镜像 |

真双进程：持registry锁时另一process的open/close均SQLITE_BUSY，业务提交后close可成功；
unlocked负控在check释放后让另一process close，再真实repo finish，确实穿门。
strict close先持久成功→迟到done/failed，终态business原行不变、本地退出事实允许记录，
但真实未覆盖C3 repository在原lease仍合法时仍写，不能签全静默。
实际业务表保留queued/claimed/lease/Run/event事实；六字段交换/改rootRun/真实关联故障、
旧owner/epoch/expiry、reverse transaction、busy、completed/foreign/clone/unbound cap都拒绝。

真实SIGKILL child cache_size1 生成 DELETE-mode业务hot journal：0644 new factory和existing
admission均在可能恢复SQL前拒绝，原DB/journal size/hash保持；合法0600允许native恢复后
重核lease，错误owner仍拒绝。另真实子process分别在业务COMMIT前后SIGKILL：claimed或
failed事实与registry unfinished任务均保留，终止/远端子工作仍unknown，不从cap消失推断未提交。
真实业务COMMIT已返回后关闭actual registry连接，返回unknown/committed；实际core的localfinish
也失败时保存该诊断，fresh独立连接确认business已提交与task未完成，不再failed提交。

原红非覆盖保留：`protection-red-v1.log`是factory模块不存在，不冒称旧控制已执行断言；
`registry-counterexamples-v1.log`7pass/2fail由child open未在fixture catch、topic插入未列columns
引起，修fixture后9通过，没有改生产guard。`local-finish-diagnostic-red-v1.log`16pass/1fail是真实
收尾诊断被S1 localfinish异常遮蔽，协调者冻结strict-only保真后最终41通过。所有旧raw仍归档。

## 限制、剩余门与归属

本片不是全writer commit封闭：claim、heartbeat、Job、usage、分析/cache、report、startup、
HTTP/worker composition未覆盖。两DB非crash原子，不阻止同uid恶意注入/篡改，未提供OS
身份认证。没有子工作终止收据；registry closed/task done/expired lease/health均不证明全静默。
strict混合S2 cooperative consumer必须明确选择，全部维护ready/许可仍false；生产hold、
safe_rollback=null、#435硬阻断、旧安全镜像冻结不变，本片不生成生产候选批准。

本地4skip分别为冻结同镜像矩阵、不同版本pair、A2隔离兼容、批准镜像真实GHCR前置；
最终Linux CI必须实际执行所需门，Docker/build与新候选镜像须绑定本片最终head，不能补签。
PR前root需pre-pr review/eval门判断、正常latestmain同步、两独立最终review、testedmerge/
requiredCI、合入后精确main CI；当前未推送、未创建PR、不预签Eval-Gate skip、未上线。

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a3-terminal-fencing-20261008/` 0700，
raw/source/非覆盖index0600；index-v1绑定最终commit/source字节、原始日志及限界，不入Git。
十专属文件由执行Agent A独占冻结，root管理台账/Git/PR流程；原S2和其他Session文件未接手。
WT/branch/原材料不清理，待两独立最终完整diff审查。真实模型预算和生产权限均保持0/未授权。
