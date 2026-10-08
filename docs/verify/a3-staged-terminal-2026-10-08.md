# A3-S3b staged terminal — 2026-10-08 local candidate

本片交付首个真实 core terminal 的显式隔离合作 close→有限观察/held 绑定→独立持久 revoke 接线。
它不登记所有 HTTP、startup、cron、dispatch 后代或用量 writer，不签 drain-ready、静默、生产或回退许可。
`safe_rollback=null`、#435 production hard block 和既有 hold 不变。没有模型或生产访问。

## Source and interfaces

基线 `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0`，其精确 main
`37710999247 / attempt 1 / success` 由协调者保全；并不把基线 CI 当本片候选 CI。
完整方案 `6235976` + `ffddd2d0d0584af8fc2948192ac527b43717ed56` 正常 cherry-pick，
最终方案原字节 36615 / SHA256 `e18ce1c578cd342606462b33ba428a2b5851d16eda736d1b322fc967412a0304`。
原 B0/W4 与后续双独立最终方案 B0/W0 保留各自时点；方案通过不替代本轮源码评审。

真实调用是 `runGenerationDispatchOnce` opt-in `stagedTerminalWriterAdmission`，literal
`a3-staged-terminal-v1 / cooperative-close-then-revoke-terminal`。exact business bridge 在 admit/claim/execute
前核对；admit 物理预检识别创建后 ATTACH。新 register 只登记 fresh owner generation，cap 在私有 WeakMap，
实际六字段 claim 在 execute 前持久绑定和 UNIQUE；重启不从已有 worker/task 恢复、重绑或 remint。
首次合法 claim 意图只由受审同步 core 调用链限定，不宣称能认证任意外部 caller 的首次未绑定合法 claim 交换。

新 gate 表只在新 `staged-terminal-v1` 侧车，旧 S0/S1/业务 schema、provenance、固定 terminal driver、
validator 白名单、AI/prompt/模型/评测口径不改。phase1 reservation 独立 COMMIT 与两锁释放后，phase2
registry→同 stage→business 同步锁持至真实 business COMMIT。无跨 await、公共 callback 或 fault CLI。
只读 held S0 绑定不持外层 S0 lock、不授新安全权限；跨 DB 提交与崩溃均不声称 atomic。

closed 合作已有 cap；revoked 单独拒绝 late terminal。strict CAS 仅返回自己确认 mutation revision，no-op
保 immutable ingress；永久 drainRecord 保完整旧 token，而 fresh 当前 revision 的相同 stable binding 可以
独立 revoke。leaseSampleHash 仅原完整聚合 sample 的 canonical SHA256，不能认证底层行/epoch。

## Executed paths and counterexamples

- 真实原 strict close 之后拒 terminal，作为新合作阶段缺口的行为 red；不是 import/export 缺失的假行为 red，
  也不称旧 strict 合同本身有缺陷。原 script、失败日志和基线共享源码均保全。
- Native 路径涵盖真实 done/failed terminal、close 合作/revoke 拒绝、strict stage CAS、S0 旧 revision 拒绝与
  合法 fresh same-binding、once-set 两记录、tuple 唯一、重复/foreign/交换 cap、wrong root、独立 epoch、
  重启 remint 拒绝、lease owner/epoch/expiry loss、ATTACH、marker/schema/audit/权限/inode、busy 与 COMMIT 三态。
- 两个真实 OS 进程：gap revoker 赢后 attempt 保留且 business 零写；business COMMIT 时仍持 registry/stage
  锁，第二进程 busy，原 terminal 返回后才可 fresh revoke。
- 四个真实 SIGKILL：reservation COMMIT 前/后、business COMMIT 前/后。恢复前 native DB/journal 原 bytes
  先以非覆盖副本保全；phase1 确认后 attempt 跨第二阶段 rollback 保留，claims 防同 tuple 重发。
- 真实 hot journal 新/已有 handle 0644 拒绝，原 DB/journal hash/size 不变；0600 合法引擎恢复保持
  closed/unfinished/unknown。新 own fixture 的 `.hot-before` 保恢复前字节，不引用已被引擎删除的 journal。
- 真实 core 先登记/实际 claim/绑定再 execute；合作 late done/failed、revoke、首取消/lease 优先、预算与
  C3 归因、done deny/throw 单 attempt、post-read 与 localfinish 异常保存 COMMIT 事实，不 ordinary failed fallback。
  真实 C3 partial 用量 writer 可在 revoke 后继续写，是仍缺全 writer 覆盖的负控，全部 ready 恒 false。

原 `native-crash-v2.log` 17/18 保留：锁内 child 的 openWriters 失败发生在 test child catch 外，触发断言并令
私有 native COMMIT hook 抛错；最小 test 修正把 child 开连接纳入 catch。runtime 未借此放松锁/门。
后续两进程反例实际通过。阶段二零 driver 调用的已知 deny 另有专属保护，不冒称 reservation unknown。

## Local validation

Node 24.19.0 / npm 11.17.0，env-i、umask077、自有隔离 DB/DATA/port3128。
四 TS（TS7/TS6 × app/tools）及新增路径 lint 均 success。受影响 core、旧 strict/S1/default、固定 driver、
C2a/任务预算/report-gen 白名单 11 文件 223 测试通过；本片实际 native/最新 core 的最终计数在私有索引。
全 ops 最终 `464 total / 460 pass / 0 fail / 4 local skip`。四个 skip 仅真实 frozen447 Docker matrix、
A2 cross-version immutable Linux pair、released-manifest migration/record Docker、approved GHCR deployment hold
Linux 门，本地没有这些真实镜像执行证据，CI 必须实际执行。

Next production build success，仅使用 synthetic build config；复制的本地配置另行 0600 保留且不注入 build。
既有 middleware deprecation warning 保持原事实，没有放宽构建门或镜像 allowlist。编译的 app/type 文件与随后
phase2 deny 分类修正完全同字节（修正仅 ops mjs/native test）；不伪称本地 Docker success。

## Evidence and remaining states

专属私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a3-staged-terminal-20261008/`，
`index-v1.json` 绑定最终 head、十文件原字节非覆盖 archive、日志、明确 own fixture 与恢复前 bytes 的 size/hash。
目录0700、文件0600；不归档 `.env.local`、模型/报告原文、其他 Session 未提交内容或 live DB。
原红/失败与 v1–v6 日志按原时点保存，不覆写或把新结果倒签旧 head。

本地验收完成；独立双 final diff review、PR/required CI/tested merge/最新主干关系与精确 main CI 尚待协调者。
合入不等于上线，新的代码不在旧冻结447镜像内，不能移植旧矩阵证据。

工程待办：全部 writer 覆盖、真实部署/备份/恢复维护消费者、SSM 离线协议方案的独立实现与验收。
缺证：本片候选 Linux/Docker 与精确 main 尚未执行。预算：真实模型为0，没有质量补签授权。
生产授权：AWS/SSM/部署或真实 stop/drain/restart 均未获授权。技术工程缺口不能列作纯外部授权阻塞。
所有私有 evidence、WT 和 branch 保留，源/test/spec/receipt 唯一作者继续保有写入归属。
