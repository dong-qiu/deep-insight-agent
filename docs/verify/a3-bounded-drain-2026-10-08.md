# A3-S2 隔离有限 drain / lease 全清单候选收据

状态：实现候选待两独立最终review、PR与精确CI；未合入、未上线、生产仍阻断。
对应 [冻结spec](../plan/specs/a3-bounded-drain.md)，原proposal `74081029ee9f9ba32b9ef5dc406331c33e9497bc`
与私有plan index-v2 `a9c69799fea43f0b6777620b67f9aadbd73972795d40f831b5f8a289f784ef77` 保留。

## 前置和实际消费

协调者核验S0 #448合`cb2f924`，精确main `37686929840 / attempt 2 / success`；
S1 #445合`0ca3ec9bfa9d1e7ad7134f027bf1dc7b53b5f813`，精确main
`37691558952 / attempt 1 / success`。本独立worktree正常fetch及merge main后源起点为
`18f625007d20cc345c77ad002312133cc1a8e7d4`，PORT/APP_PORT3116、配置600、独立DB/DATA。
此前“未合入”的proposal时点不覆盖当前；source、最终head/tested merge/main CI分别绑定。

唯一源改动为新`ops/maintenance/drain.mjs`、声明和专属node-test。observeDrain直接打开
真实S0/S1，先严格request/物理源身份和全清单校验，再close→acquire→有限observe→hold。
源自己打开同root唯一fixture-business.sqlite的native readonly/fileMustExist/timeout0连接，
每次BEGIN前无SQL重核marker/root/file/inode/owner600/nlink/sidecars，事务内重核完整S0身份。
同一SQLite快照分别读取全部dispatch、全部lease，不用JOIN遗漏其他入口/无dispatch active lease。
不写业务库，不初始化/迁移，不改lease、S1源、历史schema、模型、validator、workflow或policy。

所有输出包括本地空/完成、queued/claimed/expired与cancel/timeout，都固定ready/quiescence/
production许可false、process_termination与controller_uniqueness unknown。S0当前token CAS
才可写持久hold，事前已有op只读replay。held与closed在重启/迟到finish后不解除。
S1尚未绑定task↔trace/claim，本片不凭本地done推断lease owner或未知子工作已停止。
S3仍只为已冻结方案，未在此片接提交fencing，也不改S1 cooperative closed语义。

## 原始验证

Node v24.19.0，独立npm ci。运行使用env-i，仅Node路径；测试不载入.env.local、不注入生产
凭据、不调用真实provider、抓取、通知或cron。node-test以tsx loader导入真实openDb/
provenance migrations/createRequest/claim与真实core，受控executor仅证明控制协议。

| 证据 | 实际结果与覆盖 |
| --- | --- |
| `core-and-concurrent-controllers.log` | 18/18 pass，0skip；真实core在途/迟到失败、queued/current/expired、独立epoch、source_collect孤立lease与JOIN负控、非法owner/time/state/epoch/歧义、身份/权限/损坏、cancel首因、monotonic窗口/listener清理、replay/revision及双进程竞争 |
| `ops-v1.log` | 406 tests，403pass，3本地Linux Docker专属skip，0fail；S0/S1与新drain原始ops路径，CI必须实际执行所需Linux镜像测试，不能把本地skip补签为镜像通过 |
| `typecheck-v1.log` | TS7+TS6 app/tools四编译pass |
| `declaration-typecheck-v2.log` | 新drain.d.mts额外独立TS6检查pass |
| `lint-v1.log` | 项目lint pass |

真实SIGKILL child cache_size=1在自有DELETE-mode业务fixture生成hot journal；新open及existing
readonly sample对0644均拒绝，前后DB/journal size/hash原样，日志保存原hash。
合法600但需要恢复写时readonly拒绝且原字节保留；没有自动修权限或恢复。
业务lease/dispatch/Run在drain观察前后逐行比较未变；随后真实core的合法迟到失败仍能按
原lease guard收尾，但不会改变S0 hold，这是部分覆盖/不能全静默的重要反例。

原失败日志非覆盖保留：`protection-red.log`首红为新API模块不存在，不冒称旧实现已执行
采样断言；`first-implementation.log`指出实际reserved expiry=null及测试未提交故障/缺Source/
边界时间误差，修正真实fixture与采样后通过。`extended-counterexamples.log`实际hot-journal
fixture试图在已打开WAL reader下切DELETE遇SQLITE_BUSY；改为先seed/关连接/切DELETE再开
只读observer，真实SIGKILL反例通过。`declaration-typecheck.log`为TS6 TS5112（明确文件参数
需--ignoreConfig）命令用法，修正后独立声明检查通过。不以重跑覆盖原失败材料。

没有src/runtime、route或Docker构建输入改动，本地不无目的重复S1有效build；本PR仍需正常
CI实际Docker/构建门。真实模型预算0；未触AI语义/模型/prompt/来源或评测，控制实路径反例
不替代模型质量，不跑不消费改动代码的A1，也不预签真实模型质量通过。

## 限制与交接

S0幂等acquire无法认证两个同identity同时首次controller的唯一性；双handle获得同token
反例明确存在，+1 fence/revision只算观测，不是created-only原子门。双进程结果blocked/
unknown，仅CAS当前owner/revision可持久hold，失败不续租/重试副作用。无全writer覆盖、
未知子工作终止与提交fencing，始终保持维护阻断。两个DB的close/acquire不是crash原子。
60秒限制等待窗口，不给任意规模完整同步SQL/文件读取总耗时硬上界；不追加性能优化实验。

主台账由协调者更新。私有证据根
`/Users/dongqiu/.local/share/insight-agent/evidence/a3-drain-20261008/` 0700，raw与非覆盖索引0600；
最终源码hash/head与原始logs由index-v1登记。两独立Reviewer最终结果、PR、tested merge、
精确CI/main归档由协调者后续增量绑定，当前不预签。所有worktree/分支/原证据保留。
