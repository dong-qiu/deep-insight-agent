# A2：安全回退与数据兼容（隔离契约切片）

状态：方案独立评审及定向复核通过（Blocking 0 / Warning 0）；不提供生产执行能力。工程基线 origin/main
`a5253da8a4e9c40f8098235d6976e5a7b7f6eb71` 的身份以交付收据中的实际 Git SHA 为准。

## 对象、范围与证据层级

复用 #435 的 `ops/aws/security-release-policy.json` 和 `security-release-gate.mjs`，
不修改它们或 deploy workflow，不创建第二套 OCI digest 规则。发布对象冻结
`4477412a3e2b1cb2764fb4357f2284e73952af67`，精确 index/manifest/config/compose 从 policy 读取。
研究回退对象为同一冻结对象；它不是批准回退，也不能解决该版本自身启动失败。
其他已发布对象只进入调查清单，须各自核源码/compose、OCI链、实际拉取、安全闭包、业务契约和CI发布绑定。
历史 b199 镜像含 source-map-js 1.2.1/sharp 0.35.4，不具备安全回退资格。
当前 approved rollback 仍为 null，没有占位 digest、虚构备份或实名负责人。

所需证据层级逐层独立：①身份；②安全修复（builder与runtime分列）；③隔离兼容；
④当前生产数据兼容；⑤回退操作批准。当前①沿#435核验，②③仅限本收据所列路径；
④未核、⑤未批准。①–③不会授予④或⑤。
模块输入只是本地证据声明，无法证明签发者真实性；输出永远 `deployment_permitted=false`、
`rollback_permitted=false`。即使所有fixture声称通过也必须保持阻断。将来生产验签/授权由独立集成PR提供。

A2负责专属模块、测试、spec和收据；本切片交付诊断契约及隔离验证，未接入真实执行入口，
不得称生产回退能力完成。无配置复制需求时不复制.env。只创建合成临时目录，不读取live DB或生产快照。

## 静态审计与隔离矩阵

先按指定Git版本核schema/迁移checksum、启动协调、ID、deployment record、usage、认证、reader、
报告白名单、取消/fencing；不以当前main测试代替指定版本。指定发布与研究回退相同，
版本差异矩阵只能证明同版本重复消费，不能外推跨版本downgrade。

| 数据阶段 | 验证边界 |
| --- | --- |
| 发布前合成v46/v47 | 历史checksum不变；指定v48 migration升级；旧ID/FK/失败报告状态保留（历史done报告由指定源码业务测试另核） |
| 指定目标初始化v48 | 真实镜像migration CLI、ledger、幂等、FK、usage append-only |
| 目标版本产生的新数据 | 旧/长ID、关联、发布记录、历史报告及认证/reader边界；源码业务函数与实际镜像证据分别报告 |
| 必要迁移后的数据 | 同镜像重复migration及record；拒绝checksum错配，不能删数据/逆迁移来兼容 |
| 回退读取/更新 | 同镜像实验保留新数据；未知版本、读者约束弱化、新数据丢失风险拒绝 |

普通PR CI的自动发现ops测试必须在Linux有Docker时对policy精确manifest实际pull，复用#435
preflight核实际save/config/compose，然后禁网执行该镜像的migration/record/native probe。record必须显式设置
`PROVENANCE_DEPLOYMENT_REQUIRED=1`、精确GIT_SHA/manifest digest；核实际ledger行、重复record追加而非幂等、
非法identity失败不追加。migration重复执行须ledger checksum/行数不变并保留新数据。
原生验证复用冻结4477412的六项脚本：实际binding/bundled libvips/rsvg、SVG像素/PNG、损坏XML、
像素上限、WebP、AVIF。builder source-map-js/magicast由指定447源码的实际API测试与历史CI绑定证明，
发布镜像runtime中source-map-js实际版本另核；不声称运行了发布builder层或全面扫描所有bundle。
本地没有daemon时显式skip实际镜像项；CI中不可skip。实际运行测试仅声明所执行的路径，
不把SQLfixture写入当成业务writer生成、不把mock readiness当成A3实现。
完整同镜像HTTP/auth/reader及当前生产库/配置/备份hash/完整性/容量缺口另列。

## A2/A3版本化接口与文件归属

协议 `a2-a3-handoff-v1` 是待A3确认的提案，当前无A3实现收据。
交接必须绑定operation_id、maintenance_holder、operator身份、执行阶段、
release/rollback完整身份、schema/迁移checksum集合hash、配置hash、数据采样身份和证据有效期，
以及准入证据hash、SSM command/终态、人工接管与解除证据。敏感身份/位置保存在私有批准单，公共收据只留摘要。
具体输入见 `ops/aws/a2-rollback-contract.mjs`：顶层 `schema_version/phase/context/rollback/evidence`；
context七项binding字段及release全身份必须存在；每项evidence带scope、result、receipt_sha256、
issued_at/expires_at、相同context及release/rollback的binding和该层必需checks。hash均是声明摘要，
不是本模块已读取或认证的证据字节。证据scope分别为isolated-runner/synthetic/current-production/scoped-authorization。
保留A3字段提案：`a3.maintenance_receipt_sha256/execution_receipt_sha256/command_id/terminal_state/
writer_quiescence/takeover_receipt_sha256/release_authorization_sha256`；本模块不校验其真伪，也不认可其ready。
A3接收该版本后须提供实际协议收据与全部调用方测试，未知字段不能作为准入凭据。
A2校验候选/兼容证据声明绑定和缺口；A3负责维护互斥、全writer准入/drain/lease/fencing、执行状态真实性与持久未知终态。
输入 `ready:true`、模拟holder、过期/错operation证据均不能产生许可。

A2独占 `ops/aws/a2-*`、本spec、A2收据；A3独占自己的维护/执行模块。
共享deploy workflow、policy、identity gate、operations入口本轮不改；集成须串行、新PR独立评审，
先核A3实际入口/调用方覆盖，再验证A2真实调用。不得新增解锁参数或删除always hold。
未知终态必须保持维护隔离，只有独立核实命令终止、writer状态、数据/安全状态并有实名解除批准后才可解除。
不由A2释放锁或签发A3 ready。

## 失败处置（未来执行契约，本轮不执行）

| 失败阶段 | 要求 |
| --- | --- |
| 停writer前 | 禁止继续任何生产变更，现有服务保持原状；不调用rollback |
| 停writer后/备份前 | 仅可审查已批准且兼容的安全回退；当前null，保持停止，人工接管 |
| 迁移期间/之后 | 可能已有逐migration提交；不得假定整轮事务回滚，不恢复DB或逆迁移；兼容不足保持停止 |
| deployment record | 不绕过严格启动身份门；先核账本真实提交结果，未知终态不得重试切换 |
| app/cron/worker启动或readiness | 部分writer可能启动；A3维持隔离并核静默，不以health放行；同版本不能解决自身故障 |
| 回退启动失败 | 保持停止/维护隔离，交预先实名指定值守，不再尝试旧漏洞镜像 |
| 身份/兼容缺失或未知SSM终态 | fail closed；阶段不明按可能已停writer处置，禁止后续切换 |

授权单必须先接受持续停止、指定operator/oncall/reviewer/approver、联络响应时限、
目标实例/区域/命令/窗口/副作用、兼容及回退范围。当前这些信息未指定，不能用PR作者代填。
外部限制仅在事先获授权范围内保留；跨B1b边界需专门密钥轮换/容器重建/旧cookie拒绝验收，
不在普通code-only流程盲目轮换；health恢复不等于安全验收。

## 验收

1. 方案先经新上下文独立review，重要问题修正后实施。
2. 反例覆盖缺失/未批准/旧漏洞对象、digest/revision错配、证据缺失/过期/错绑定、迁移后不兼容、
   新数据丢失、虚构ready及回退启动失败；真实模块调用及不变硬阻断同时验证。
3. 运维测试、typecheck、lint、文档/workflow检查、风险相称构建/业务回归；源码/mock/实际镜像明确分层。
4. 最终完整diff独立pre-pr-ai-review、正常hooks、Draft PR、远端复核与精确head/tested SHA/CI证据。
5. 本轮无生产访问、dispatch、drain/stop/restart、备份/迁移/恢复/配置覆盖、付费模型、合并或清理。
   生产核验另申请目标/命令/窗口/副作用授权，避16:50–17:30UTC，与所有维护串行。
   不批准安全回退，不关闭TD-09/TD-19或宣称已上线。

依据：[身份门spec](security-deploy-preconditions.md)、[恢复契约](recovery-time-coverage.md)、
[认证边界](auth-hardening.md)、[reader契约](evidence-reader-visibility.md)、[运维](../../launch/operations.md)。

同镜像研究仅可能在外部瞬态或经独立确认已修复的编排/配置故障后重新验收；
不承诺处理该镜像自身启动故障、坏迁移、新数据无法读取、认证/reader降级或未知执行终态。
本切片没有已批准的回退操作，所有停writer后失败均交人工处置。
