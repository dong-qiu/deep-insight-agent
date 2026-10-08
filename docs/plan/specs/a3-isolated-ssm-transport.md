# A3：真实 AWS CLI 的隔离 loopback transport

本片 base 为 `a51c0579310e9a3c380fc1caf2862ef14870ed75`。协调者已核本轮方案 v2，
两位非作者 R1、执行 Agent B 分别独立核对原 controller/ledger、实际 CLI 能力及反例后，
冻结六个新文件实施。旧 [SSM 响应控制器](a3-ssm-controller.md)、S0 ledger/schema/签名、
writer、维护门、业务入口、运维共享源、policy/workflow 和生产 #435 均不修改。

它增加真实 `aws` 子进程与 `SendCommand` / `GetCommandInvocation` / `CancelCommand`
HTTP 字段消费，目的地只能是显式的合成 loopback 接收者。不是生产 adapter，不运行 AWS
服务或生产命令；不证明服务器身份、全 writer 静默、子工作终止或历史 checkpoint 覆盖。
`production_permitted=false`、`maintenance_permitted=false`、`ready=false`、
`termination=unknown`、`safe_rollback=null`、`token=null` 始终保持。现有 hold、
deployment blocked 和 #435 硬阻断保留。真实模型预算为 0，历史 attempts/费用不改写。

## 唯一文件归属和接口

执行 Agent A 唯一写入六个新文件：`ssm-isolated-transport.mjs`、对应 `.d.mts`、
`ssm-isolated-transport-cli.mjs`、`ssm-isolated-transport.node-test.mjs`（均在
`ops/maintenance/`），本 spec 和 `docs/verify/a3-isolated-ssm-transport-2026-10-08.md`。
主台账 root-only。C1 三个备份源仍等待明确交接，不能凭 clean/merged 接手。
worktree `insight-agent-continuation-a-20261008` / branch `refactor/continuation-a-20261008`
独立；不需要本地配置，未复制 `.env`、`.data`、live SQLite/WAL、真实报告或原文。
每例新建独有 0700 SQLite 根、端口与产物目录；运行 Node 24.19.0 的 `env -i` 进程。

公共函数 `runIsolatedSsmTransport({root, action, inputJson, endpoint, deadlineAt, signal?})`
先拒 Proxy，再要求 root/action/inputJson/endpoint/deadlineAt 五项为 own enumerable 数据属性，
optional signal 同规则且不得由 prototype 补齐；从 descriptors 生成冻结的 primitive 输入快照。
缺字段、继承/accessor、coercible object、Proxy trap 都在读取属性或 FS/SQL/child 前拒绝。
动作白名单 `send|invocation|cancel`；无 callback、任意 shell、
注入 child/ledger、可选 AWS 地址或批准接口。`inputJson` 是最多 65536 bytes 的普通 JSON：
`{schema:"a3-isolated-ssm-transport-v1",token:<原 S0 完整 token>}`，两 key 必须自身存在，
token/target 全必需 key 同样自身存在，拒绝未知字段或 Object.prototype 补齐。
目标固定原 fixture profile，executionIdentity=`fixture-controller-v1`；深冻结 ingress token。
不得拿 inspect/current state 刷新丢失的 owner/fence/revision。函数异常与 CLI 只输出固定脱敏码。

真实入口：`node ops/maintenance/ssm-isolated-transport-cli.mjs <root> <action> <endpoint> <deadlineAt>`。
stdin 按 chunk 累积字节，超限或原 deadline 到达无需 EOF 即拒绝并关闭自有 stdin；
输出只含阶段事实/command UUID/status/固定原因，不含 token、Comment、stdout/stderr、
远端 message/URL、native stack 或凭据。CLI 信号转为首个取消原因。
公共无参数 CLI adapter 只读取本进程固定 argv/stdin；不能重置或延长 ingress 的绝对/单调时间窗口。

## 副作用前准入及物理拒绝

任何旧 SQLite open/pragma/inspect/controller 前，先用纯 FS 观察核绝对 canonical 根，
0700/current uid/无 symlink；marker 和 main 必须为 0600/current uid/nlink=1 的普通文件。
marker 最多 16384 bytes、O_NOFOLLOW/fstat/UTF-8/完整 target 绑定；main 最多 16 MiB。
任何已有 `ledger.sqlite-journal`、`-wal`、`-shm`，包括合法 0600 hot journal，一律拒绝，
不打开 SQLite、不恢复/repair/chmod、不删除 sidecar。每次自有 ledger open/hold、旧 controller
调用之前重核 initial marker hash 与 root/marker/main dev/ino。非法输入可纯输入先拒。

首次已经观察的非法输入/sidecar 前检拒绝，SQLite 操作和 API 发送为 0，marker/main/audit
原字节不变。必须先保全合法 hot-journal/main 的原 bytes，再运行 wrongIdentity 和合法身份反例，
核 native SQL 方法调用 0、HTTP0 与前后 inventory/hash 完全相同。旧 openLedger 会在身份拒绝前
恢复 hot journal 的实际反例保留，不能补签旧实现零副作用。

前检通过后，为本次 CLI 创建独有 0700 临时 cwd，绝不使用 ledger 根作 CLI cwd；
`aws --version` 是实际 spawn，临时目录是实际 FS 效应，二者与 ledger/business/API 效应分别记录。
结束时只有 dev/ino/uid/mode 仍相符且已观察为空的本次目录可 `rmdir`；未知 CLI 产物或清理失败
原位保留，不递归删除。不能把所有后续拒绝概括成全文件/进程零副作用。

纯 FS 门到旧模块内部 SQL 之间不原子，不能在每条旧 SQL 前插入检查；并发新 journal、
inode/marker ABA 或虚假签名者声明不在本片可认证范围，仍可能触发旧 reader 恢复或迟到发送。
本片不改变原 S0 恢复合同，不据此证明全局无恢复/写入或执行资格。

## 固定 CLI、网络和提交边界

Darwin 唯一 binary `/opt/homebrew/bin/aws`，Linux 唯一 `/usr/local/bin/aws`；
要求真实 AWS CLI v2，缺 binary、无法执行或版本不符直接失败，CI 不 skip、不自动安装/升级。
子进程 `shell=false`，env 从空对象构造：公开 fake credentials、us-east-1、
metadata disabled、`AWS_MAX_ATTEMPTS=1`、standard retry、pager/auto prompt off、
config/shared credentials `/dev/null`、固定 locale/PATH。HOME、profile、proxy、webidentity、
container credentials、credential process、PYTHONPATH、NODE_OPTIONS 均不继承。
版本探针同样不载真实凭据；业务测试不使用 SDK 或任何默认 provider fallback。

endpoint 仅字面 `http://127.0.0.1:<1..65535>/`，无 DNS、别名、HTTPS、编码、用户信息、
路径、query/hash 或 redirect 许可。CLI 实际 503/429 必须只产生 1 次 HTTP；301/302/307/308
必须初始 HTTP1、redirect sentinel0，若实际 executable 会 follow 或 retry 即失败停止。
官方 [retry 配置](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html)
说明 MAX_ATTEMPTS 包括首次尝试，实际 server 计数仍为必须验收证据。
文档版本不替代本地/CI tested executable 身份。

send 使用原 controller `stage-submit`，原 `beginSubmit` 将 submitToken/requestHash 与
`submission_unknown` 先提交，确认返回后才最多一次 spawn `send-command`。
若 stage blocked，原 controller 不能区分 pre-CAS 拒绝、COMMIT 失败或 ACK 丢失；
返回 `stage=unknown` 是保守事实，可能包含已知拒绝，不能签 confirmed COMMIT 或发布资格。
不会凭诊断 inspect、exit0、health、重启 fixture 或 ready/new operation 补造资格。
unknown/held 的 send 重启不重发；两个实际 CLI 进程只允许 stage winner 发送。

wire descriptor 固定原 `FIXTURE_WIRE`：`i-00000000000000000`、
`InsightA3FixtureRecordOnly`、version1、plugin=`fixtureRecordOnly`。
send 只给 singleton InstanceIds、上述 document、TimeoutSeconds30 和
`Comment=a3:<submitToken>:<requestHash前56hex>`；不接受 arbitrary commands/Parameters/Targets。
Comment 是原本地 binding 的关联提示，非远端认证、幂等性键或不可伪造凭据。
invocation 只查询原 commandId+固定 node/plugin；cancel 先原 `stage-cancel`，再一次 cancel-command。
无自动 poll/重试/acquire/authorize/release/refresh；不锁住 SQLite 跨 await。

真实 wire 结果交原 `receive-send|receive-invocation|receive-cancel`。原 blocked、已提交 hold、
冲突终态 COMMIT 和 fixed primary reason 逐字段保留；不取 allowStale 返回 token 做后续 mutation。
Success 仅 terminal_pending+held；cancel ACK 仅 cancel_requested+held，均不证明停止。
receive-* CAS/终态冲突后不再次 hold/刷新；wire 失败只用私有 strict staged/ingress token 一次 hold。
hold COMMIT ACK 丢失返回 unknown，保留真实 bytes，再由独立只读诊断记录实际持久状态；
诊断不升级返回事实，不给旧 continuation authority。

## 取消、超时及永久反例

deadline 为当前未来最多 60000ms 的绝对时间与首次 ingress 单调剩余量的较小值。
每段都共享原窗口，保留第一个 cancelled/task_deadline_exceeded/generation_fence_lost，
不得在重启、version、发送或 cleanup 重新充值。SIGTERM 后最多 950ms 发 SIGKILL，
cleanup grace 最多 1000ms；清理可以超过原 deadline，不能称整个函数硬上限 60 秒。
同步旧 SQL/FS 和 OS signal 实际终止也不能由 JS deadline 认证。
spawn started 与 HTTP 已发送分开；客户端不猜 wire count，测试使用实际 loopback server 计数。
local close/kill、HTTP200、SSM Success/Cancel ACK 均保持 remote termination=unknown。

stdout 每 chunk 累计最多 65536 bytes、stderr4096；超限立即终止本地 child 并保守 unknown/hold。
UTF-8 fatal、invalid JSON、错误 Comment/ID/plugin/status、socket drop、合法 body no EOF、
取消中的迟到 response 都不能获权限或自动重试。CLI stdin 超限/no EOF 同样实际执行。

永久负控包括合法热 journal/wrong token 的 SQL0/HTTP0/bytes 不变、双进程 stage CAS、
真实 SIGKILL 后持久 unknown/restart send0、stage/hold COMMIT 已执行后 ACK throw、
blocked 但 hold/conflict 实已提交、首取消原因、超限/no EOF、retry/redirect 实际计数及 fake env。
last-check→spawn 负控用错误/恶意 fixture 签名者声称 continuationsStopped=true 后 release/newop；
活跃 continuation 事实与该声明矛盾，明确不是可信 stopped 或合法生产 release。
它展示虚假声明后仍可迟到 HTTP1，原 token 对 foreign operation mutation0；不能作为解除 hold 证据。

定向原 controller/parser/S0 recovery/protocol/writer/drain/staged/组合路径、四 TS、whole lint、
TS6/TS7 新声明 consumer 与两位非作者最终 full review 是本片质量门。
没有 app/路由/镜像接线，不能复用旧镜像/旧 main 的 HTTP/browser/Docker 验收签本片。
PR/tested merge/latest target/main CI 由协调者按各自精确身份核验，合入不等于部署。
