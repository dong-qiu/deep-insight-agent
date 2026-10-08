# A2/A3 owned-existing drain 隔离接线收据（2026-10-08）

本片交付六个 NEW 路径，实际消费已 acquired 的同 root S0 operation：真实 A2 consumer → strict initial hold → S1 close → 有限真实业务 lease inventory → strict final hold。入口始终 blocked，所有执行许可 false、safe rollback null、终止与控制器唯一性 unknown。没有生产访问、模型、AWS/SSM、真实业务 stop、部署/备份/恢复或解除 hold。

## 冻结、范围与真实接口

实施基线 `1f278ec815cd75a2f0da26d3e94e9de822daab91`。协调者已核其精确 main `37738854606 / attempt1 / full success` 与原包。冻结文件 `coord/owned-drain-interface-freeze-v1.json` 4683 bytes / SHA256 `d30d81dc3f8a38c76deaf580ffaae4aac7663d1595a6b767a1a650d1339c806a`，完整亲读；两独立方案 v2 B0/W0 只签 PLAN，原 v1 B0/W2、B0/W1 与未提交 initial hold 回滚实证保留原时点。

Agent A 独占 `owned-drain.mjs/.d.mts/.node-test.mjs`、`owned-drain-cli.mjs`、专属 spec 和本收据。旧 consumer/ledger/contract/writers/drain、业务 schema/provenance/runtime、staged、SSM、policy、workflow、allowlist与台账没有修改。独立 worktree `insight-agent-a2-owned-drain-20261008`、分支 `feat/a2-owned-operation-drain-20261008`、PORT3150；仅复制 env.local 600 并改 DB/DATA 为自己的隔离目录，运行使用 Node24/env-i，不注入本地配置。node_modules 是同 exact lockfile 的依赖链接，未复制其他 Session 源、live SQLite/WAL、报告或配置。

公共库保留冻结签名 `consumeOwnedDrainIsolated({root,artifactRoot,inputJson,deadlineAt,pollEveryMs,signal?})`。固定无参数 process 适配 `runOwnedDrainCli():Promise<void>` 经协调者准许，CLI 文件仅调用它；私有 consume 接同一个已接受 abs/mono window，不开放 caller clock/window/callback/driver。CLI 四 args 为两个 roots 与两个数字；stdin 流式最多65536原 bytes，未 EOF 有期限，fatal UTF8、固定错误与非零退出，不输出原异常/stack/input。实际 stdout EPIPE 通过 write callback/error 捕获，不二次 hold。

完整 JSON token/binding/target/executor/context由原真实 consumer 与 S0 strict CAS 核对，不 drop nullable字段，不从 inspect/acquire/replay刷新 authority。初次 hold确认返回才记 committed；COMMIT 返回丢失记录unknown/token null、不能继续close或重试。最后 current owner/fence/revision 守卫在观察catch之外。首取消在采样失败、cleanup和initial/final COMMIT unknown均保留；phase三态保留次因事实，未知采样为null，不伪装last sample当前。异常reasonCode getter只安全映射writer_drain_cancelled。

首次 CAS 前完成所有 setup 后紧邻同步读signal/首因/原墙钟及单调remaining；expiry/abort无 entry/final attempt、hold/close/audit/token。CLI原单调起点穿过EOF/解码和同步SQLite直到这一 checkpoint，不能靠queued timer或墙钟回拨续窗。fresh非法库deadline仍invalid零I/O；已接受CLI窗口在handoff耗尽则不调用库、stdout空/固定controlcause。

physical gate检查canonical root、owner0700/600、nlink1、固定main/marker dev+ino、内容绑定和全部journal/WAL/SHM，在constructor/pragma/BEGIN前执行，cached调用也重核。low-projection metadata snapshot容量门早于旧完整reader，并为两hold events/snapshots预留。旧reader不同连接、并发增长/ABA与SQLite同步调用耗时限制仍保留；不声称全内存原子界或整个函数硬60s。

## 实际保护结果

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a2-a3-owned-drain-20261008/`，全部目录0700/文件0600。最终 source、精确head/tree与原材料索引采用非覆盖保存，避免本文件自引用hash；未预签独立review、Eval、PR、候选CI或main。

- `owned-final-v2.log`：完整当时29/29 pass，零skip。随后仅新增cached组合handle实际热journal保护，`owned-cached-v1.log` 1/1 pass，零skip；先前29测试体和runtime不变，两个结果分别绑定最终源码闭包，不谎称已有单run30结果。
- 五个真实旧文件 `a2-consumer.node-test.mjs`、`protocol.node-test.mjs`、`ledger-recovery.node-test.mjs`、`writers.node-test.mjs`、`drain.node-test.mjs`，实际 `node --test`：`ops-targeted-v2.log` 184/184 pass，零skip。存在的 S0 原套件确实执行；不把不存在filter或其他计数凑入。
- whole `npm run lint`、TS7/TS6 app/tools四项，以及专属 `.mts` TS6/7 readonly/null token/禁止注入window和CLI args正负控实际通过，raw最终绑定见索引。没有 src/build/image变更，不重复build或旧同镜像矩阵；正常 required Linux/Docker CI由协调者另核，不能拿本地skip补签。

30项实际保护包括：同root真实 consumer与两确认hold、queued/claimed/expired和真实 source-collect orphan、unknown subwork/空和已完成任务依然coverage unknown；完整preabort/非法wire/deadline；setup末端取消/expiry零副作用；首取消+真正source采样失败null；最终旧revision；实际fixedCLI positive、nonEOF/超容量/非法UTF8、EOFqueuedtimer及CAS同步setup+墙钟回拨原mono；早SIGINT首因、stdout断管；actual cached inspect COMMIT后另一进程推进导致旧CAS拒，两个独立进程同token最多一个strict入口赢家；原signed synthetic release/new foreign owner窗口仅保守close且foreign失败记录不变；marker同字节换inode；真实SIGKILL热journal不安全拒绝原hash不变/BEGIN0，已打开handle同样拒前SQL；两次COMMIT return-loss unknown/无retry、取消与cleanup首因优先、owner主错优先、events/selected TEXT/预测两hold容量拒前写。

六个真实 SIGKILL 切点：initial hold INSERT后COMMIT前/COMMIT返回后，close COMMIT前/后，final hold INSERT后COMMIT前/返回后。`owned-cuts-v2.log` 初次6/6通过，完整29 run再次真实执行；每轮各自 BEFORE ANY recovery保存main/journal/WAL/SHM+marker/实际角色presence与原bytes，并保存实际子进程code、signal、状态/audit读回。前 initial COMMIT回滚 active/OPEN且旧token仍current，只证明旧协议没有entry nonce；不声称识别任意重启。后 entry/held与known unknown绝不自动续接。raw planned/committed/unknown不以SIGKILL或exit猜测。

## 保留的失败与验收会计

所有失败log和该轮已捕获原 bytes不覆盖、不清理fixture：

1. `owned-v1.log` 8/10：测试的 setup native count9实际在close后，不是首次CAS前；orphan伪trace触真实FK。修为实际末setup count7及真正createSourceCollectTrace，未改运行门。`owned-v2.log`前10项通过后出现testCode.index typo的测试bootstrap失败。
2. `owned-cuts-v1.log` 0/6：eval child相对policy URL错，未执行SIGKILL，不能称行为red。修固定Git公开policy路径；真实cut v2独立6/6。
3. `owned-extra-v1.log` 2/5：private TextDecoder hook误作用于loader导致watchdog、race hook命中readonly metadata COMMIT、两process setup读写竞争均保守失败。private负控仅限定实际JSON/native readwrite COMMIT，并在各child最后setup readonly COMMIT释放锁后用IPC/SIGSTOP私有barrier再竞争；不引入runtime fault seam、不改CAS/数据库锁门。早期第二轮一child停在barrier，确认其为本次测试进程后只SIGCONT释放，原run失败保留；永久barrier有4秒watchdog。
4. `owned-boundaries-v1.log` 4/5：generic无任务同步完成、测试在consume之后装cleanup hook太迟。改为实际initial INSERT后才arm的私有close反例；`owned-cleanup-v2.log`真实取消/generic/owner三态通过，运行cleanup规则保持首取消。
5. `owned-final-v1.log` 28/29 与 `ops-regressions-v1.log`实际624＝618pass/2fail/4skip：意图五模块的 `ops/run-node-tests.mjs` 实际忽略args并discover全部OPS，原命令事实保留。仅本片新测试1秒默认fixture在全OPS+四TS并行负载中setup已耗尽，正确not_attempted/timeout；旧模块无fail。新测试非expiry默认余量改5秒，专门setup expiry/CLI budget和生产最大60秒不变。没有重复跑全部OPS；正确定向五文件184与新完整29另记。四skip分别是冻结447业务镜像矩阵、不同版本Docker pair、Linux镜像compat、真实GHCR批准门，必须CI真实执行，不自动清零。

## 退出、保留与未完成工程

本片只提供fixed isolated hold-first positive接线。初hold/close跨库不原子；合法fixture release/takeover可在old check与close间发生，允许保守partial-stop，随后必须拒续且无foreignhold/reopen/refresh/newop/token grant。signed负控测试key/停止声明不等于人类裁决、生产stop或许可。初hold未COMMIT的旧attempt无nonce，controller_uniqueness一直unknown；phase/lease/cancel/late finish不能解除hold。

其他writer/core entry全覆盖、staged真实阶段统一、C3/usage/raw/report/coverage及真实部署/备份/恢复adapter/受控transport仍属工程前置。可信生产证据、实名窗口/授权、回退批准、真实模型预算和人工裁决另列；#435硬阻断、deployment blocked、safe_rollback=null和已有hold不变。原私有fixture/worktree/branch/证据与旧源ownership全部保留。等待最终两非作者 FULL review及协调者正常Git/PR/required CI/main归档，合入不代表上线。
