# A3 隔离 AWS CLI transport 实施收据（候选）

六个新文件实现 [冻结 spec](../plan/specs/a3-isolated-ssm-transport.md)，
base=`a51c0579310e9a3c380fc1caf2862ef14870ed75`，独立 branch=`refactor/continuation-a-20261008`。
本收据只记录各次实际执行；最终源 bytes、受审 head、正常提交与后续 PR/tested merge/main CI
分别由非覆盖私有索引和协调者交付身份绑定，不预签独审、CI、合入或生产通过。

实际新函数和 CLI 使用原真实 S0 SQLite/controller，每次最多一个实际 AWS CLI API 子进程，
HTTP 只到固定字面 127.0.0.1 合成接收者，fake credentials，不加载本地环境。
本地 Node24.19.0 / AWS CLI2.35.3 的行为不能冒称 AWS 服务或不同 CI executable 已验收。
zero model budget 保持；本片无模型/source/validator/report 语义或历史数据变化，
没有以不执行本片的 A1 预签质量。四个权限 false/null/unknown 与 #435/hold/deployment blocked 保留。

私有根：`/Users/dongqiu/.local/share/insight-agent/evidence/refactor-continuation-20261008-224349/executor-a/`，
目录0700，原始日志、合成 SQLite/main/hot-journal 副本、inventory 与索引0600；不覆盖旧封存。
C1 三备份源归属未释放，未改；旧 controller/ledger/contract/writers/drain/runtime/schema 与
package/lock/policy/workflow 不变。无 app/HTTP route/build/image 接线，无生产访问/SSM/dispatch。

## 实际过程与边界

方案 v1→v2 接受两位非作者直接源码/实际反例审查。B 已证明旧 openLedger 可在合法600热journal时
先恢复 main/删除 journal，再拒错误身份；原失败原 bytes 保留在 B 的独立材料。
本片 NEW 纯 FS 门拒一切 observed sidecar；合法600 hot-journal 在 wrongIdentity 和合法身份下
均保全 before 再实际调用，native SQL/API0，前后完整 hash/mode/absence 相同。
该反例不改变旧 S0 恢复合同；FS→旧内部 SQL 的非原子窗口/ABA 仍是限制。

首轮 `transport-tests-v1.log` 为 27 total / 26 pass / 1 fail。末例发现 no-EOF 拒绝后
仅 pause stdin 留住管道，CLI 没有在 deadline 后退出。保全原日志与 `stdin-no-eof-hang-v1.json`，
只 SIGTERM 精确自有挂起 child 得到原失败断言；没有将人工终止当功能通过。
查因后 NEW adapter 改为 destroy 自有 stdin，v2 实际27/27、0 fail/skip；该结果只绑 v2 源。

随后按冻结方案补独有0700临时 cwd，与 ledger 根分开。版本 probe、临时目录是实际 spawn/FS 效应；
纯输入/物理拒绝的零副作用只签 ledger/business/API。只删除 inode/uid/mode 符合且已观察为空的
本次新目录；未知 CLI 产物/清理失败保留，不能递归清理未知文件。
stage blocked=unknown 是原 controller 信息不足下的保守事实，可含 pre-CAS 拒绝，非 confirmed COMMIT。

最终实际 module 反例增加 version child 首因取消、hold COMMIT ACK 丢失和 blocked-but-committed
terminal conflict，公开 capability 行记录 Node/binary/version；v4 为31/31、0 fail/skip，
`transport-tests-v4.log` 绑定首轮候选 runtime/test 字节。原 v1/v2 不回填为新源 green。
503/429 和301/302/307/308都必须 actual HTTP1、redirect sentinel0，不以 logical invocation 代替发送计数。
双 CLI stage 唯一赢家、SIGKILL/restart未知、socketdrop、no EOF、输出超限、首取消与迟到 response、
Comment/requestHash binding、wrong wire、虚假 stopped 签名负控均直接执行真实受影响函数。
虚假声明负控的 continuationsStopped=true 与活跃 continuation 矛盾，不是可信停止或生产 release；
迟到发送依然可能，foreign operation audit/revision/failures 不变，始终无新 authority。

首次最终 FULL 独审中，B 对 `f33778a0` 的真实 inherited-root 反例发现 Blocking：
缺 own root 时 Object.prototype.root getter 读1次，HTTP1/stage committed/main bytes 改变。
31/31 原 native 通过不抵消此缺口，原 `final-ready-index-v1` 和 R1 原通过时点保留，
R1 将首轮结论撤为待修。NEW-only 修正先拒 Proxy、必需/optional own data descriptors、
primitive immutable snapshot；raw JSON schema/token/全部 token-target 必需 key 不许 prototype 补齐。
永久实际反例验证五缺字段、继承/own getter、Proxy traps、coercible endpoint、raw schema/token
以及嵌套 token/target 缺字段均 reads/SQL/child/API0、原 DB bytes 不变；原 caller 在真实 version
子进程期间修改其 options 也不能改变已冻结目的地/身份/预算。修后 v5 实际33/33、0 fail/skip，
whole lint 与四 TS 再次 exit0；声明/旧维护路径未变复用其原有效结果，新结果单独以 v2 索引绑定。

stage/hold COMMIT ACK throw 前实际执行 native COMMIT，原 bytes 先保全；返回 unknown，
随后测试的独立只读 inspect 记录真实持久事实，不从其结果刷新 continuation 或签已知返回 COMMIT。
Success/cancel ACK、子进程 exit0/kill、HTTP200均不证明 remote 停止；cleanup grace 可超过原 deadline。

## 验证和仍待工作

每次测试命令用 `env -i`，Node24 PATH，真实业务/云/模型/通知凭据缺席；AWS child另建固定 fake env。
定向 module 和原 controller/parser/S0 recovery/protocol/writer/drain/staged/组合原路径，
四项目 TS、whole lint 与新声明 TS6/TS7 consumer 正负类型断言的原日志、命令、退出码、源hash
由最终私有索引逐次绑定。原维护定向187/187、0 fail/skip；最终四 TS、whole lint 和两版 consumer
均 exit0。CI 缺实际 aws binary 必须 fail，不能 skip 或借本地结果补签。
无真实模型质量验收，无新镜像/生产/历史覆盖验收。

仍待工程包括备份源明确交接后的实际 backup consumer、业务启动/HTTP/其他运维维护接线、
全 writer fencing 与受控远端 transport/可信未知终态协议。真实 AWS transport、来源认证、
可信终止/continuation/全 writer停止、历史 checkpoint 连续覆盖、新镜像/数据验收及生产专项授权
均未完成。本片不是“只剩外部阻塞”，TD20旧head真实质量还需要单独方案与新模型预算。
