# A3-S4a 隔离 SSM 响应控制器收据（候选，待最终源码审查/PR/CI）

2026-10-08 实现 [冻结 spec](../plan/specs/a3-ssm-controller.md) 的九文件窄片。
base `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0`，实际 fetch 核同 origin/main；
#453 exact main 37710999247/1 success 原包由协调者保全。本片不借 S3b 未合源码/CI，
不预签本片独立源码通过、Eval、PR、tested merge 或精确 main。

真实离线入口为 `node ops/maintenance/controller-cli.mjs <isolated-root> <action>`，
每事件直接调用原 openLedger/inspect/beginSubmit/bindCommand/observe/cancel/hold。
无 AWS SDK/CLI/network、生产凭据、command、后台poll、任意callback或解除许可。
`production_permitted=false`、`ready=false`、`termination=unknown` 始终保持。
init/acquire/operator新revision由原独立 S0 协议负责，本片不导出刷新或批准能力。

allowStale bind/observe 统一 token=null；终态先且仅一次 strict ingress hold，成功token只用于
同step一次observe，返回token丢弃且无后置mutation。wire解析失败只一次strict ingress hold，
CAS/handle失效保wire首原因及unconfirmed/null；已开始动作失败保原fixed primary而不再hold。
冲突终态可能先持久再throw，已知前置hold保留，close诊断不遮蔽主因。CLI无可信outer/token时
只有fixed error/nonzero，无token/result/hold；可信wire失败有blocked/nonzero及本step已知hold事实。
Cancel空ack只记hold，Success仅terminal_pending+held，未验证/释放或证明停止。

私有根：`/Users/dongqiu/.local/share/insight-agent/evidence/a3-ssm-controller-20261008/`。
最终 head、九文件原字节及源码/日志/fixture size/hash 以非覆盖 `index-v1.json` 绑定。
source/raw/归档0600，目录0700；不入Git敏感原文/数据库/日志、不复制live数据、不清理历史证据。

## 真实负控与过程失败（原时点保留）

- 原 S0 实际双handle：unknown revision2→bind赢家/精确replay3→借返回token的hold4。
  `original-replay-authority-red-v1.mjs/.log` 的安全假设断言真实失败，原fixture与原S0源码保全。
  这是原方法会返currenttoken的已知契约风险，不称原S0新bug或新模块已green；没有把import不存在当行为红。
- 首轮 native-v1 与 native-v2 的失败是fixture切点/归档准备：暂停在inspect事务内占锁，
  两进程同时零等待open也会真实busy；v1另缺显式产物子目录。raw原样保留，不签其journal已保全。
  依据 actual better-sqlite3 cached transaction code 改为 COMMIT返回后切点，先一方完成inspect，
  再启动第二方完成inspect，二者都尚未mutation；v3真实29/29通过，v4扩展31/31通过。
- 首个lint命令显式纳入`.d.mts`时默认JS parser拒类型声明，原log保留；不改全局配置。
  五实际MJS源码/测试精确lint通过，声明由四project编译与TS6/TS7专属消费正反例验收。

## 验证绑定

- 最终新增 parser/controller 两 native 文件：31/31，0 fail/skip。
  实际CLI、双进程未知提交CAS/send/observation replay、初次hold输家、双strict-noop后观察replay、
  SIGKILL持久unknown重启、取消ACK/迟到非终态/终态冲突、旧owner/fence/revision/released/foreignprofile、
  cached/inode/marker/半初始化与真实热journal、流式超限无需EOF、fixed输出/恶意wire全部执行。
- 完整ops最终实际自动发现运行：473 total / 469 pass / 0 fail / 4 local skip。
  skip仅本地无隔离Linux Docker的原447身份/同镜像/不同版本pair/native矩阵；未签镜像验收。
  新31控制器测试0skip；实际CI须核最终对象必需镜像项，不可用本地mock或旧CI补签。
- 4个原真实core/default/S1/strict/validator文件：96/96通过；三个C2a/C2b取消/预算文件58/58通过。
  均已有mock模型；只证明控制/白名单回归，不证明真实模型质量或新评测口径。
- TS7/TS6分别project+tools四编译通过；新`.d.mts`实际consumer两编译通过，包括readonly、
  不完整binding、nullabletoken和未知authorize的负类型断言。五MJS lint零warning；diff whitespace通过。
- 无app/routes/build/Docker接线，本片未运行无关HTTP/browser/build。原ledger/contract与435
  workflow/policy/gate/deploy入口对精确3c逐字hash不变；没有schema/模型/prompt/validator语义改变。

所有原native关键SIGKILL/hotjournal的main/journal/WAL/SHM presence/absence inventories与
备份原字节（副本0600，原模式另记）位于native-v3/native-v4；新run不回填v1/v2历史缺口。
原红fixture继续保留。专属索引同时冻结实现源、声明、tests、spec/receipt、实际日志与消费fixture。

剩余工程为全writer封闭、真实A2 typed消费、部署/备份/恢复适配及未来受控transport工程；
本离线片未解决。缺证为AWS响应来源/host身份、真实终止/continuation/全writer静默、历史覆盖与
新镜像/实际数据验收；人工与生产专项批准另需实名/窗口/失败处置。模型预算仍0，TD20旧head
质量不可补签；TD12/14/15及Brief/P1延期取舍保持。没有部署/回退许可或生产执行。
