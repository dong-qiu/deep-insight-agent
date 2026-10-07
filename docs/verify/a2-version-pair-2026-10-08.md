# A2 唯一不同版本隔离资格对工程收据

## 当前状态与对象

工程已准备，**实际两个镜像尚未运行，本地无Docker daemon；不得签隔离资格通过**。
本收据承接[初次调查](a2-different-version-candidates-2026-10-08.md)的时间点，
后续协调者已确认合理预筛对象可用预算0做隔离工程，镜像运行缺证为工程待办，S2a旧head质量为独立预算待办。
初次“没有完成资格对象”不表示不同版本永久不合格，也不阻止用运行实验补齐该资格。

[冻结方案](../plan/specs/a2-version-pair.md)限制唯一pair：release
`81dac77cd27f82d7b554694bf0a12cd82cd0920b` / amd64
`sha256:ea30cf753ba58ecabcd8462b2c6390f60aa2c124c6bf8a6aeef594b91927c255`
→ candidate `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71` / amd64
`sha256:73f49e69b6247a57d362554ab34d839817ce2c38158ee9414881c904274b9d48`。
index/config/compose完整链见spec及调查原字节；本工具普通CI会再次核registry/pull/save/config/compose。
两个不同image build的原bundle各自绑定，不能移植447的#443矩阵，不能声称解决共同应用payload自身启动故障。
本轮A3新接线不在两个旧对象中，未来工程镜像必须重新冻结验收。

工程base `81dac77cd27f82d7b554694bf0a12cd82cd0920b`；继承调查文档commit `9ae14b9`，
branch `feat/a2-version-pair-20261008` / 独立worktree `insight-agent-a2-version-pair-20261008`。
执行Agent B只新增 `ops/a2-version-pair/*`、专属spec/收据；主台账及既有A2/A3/#443/policy/gate/workflows只读。
本地0600配置隔离DB/DATA/端口3114，未运行应用、复制live库/WAL/raw/report或打印密钥。

## 实际工程路径及证据层级

普通 `ops/run-node-tests.mjs` 自动发现 `ops/a2-version-pair/image.node-test.mjs`；
`GITHUB_ACTIONS=true`时必须Linux/真实Docker，每项身份/原生/业务/失败断言失败均使CI失败，不能skip。
本地实际image测试明确skip，源码、mock控制协议或工程full CI不代替两digest资格运行。
`run.mjs`只接受两个冻结对象，没有通用revision/digest CLI或解锁参数；reuse preflight的研究描述始终blocked/null，
输出scope为research identity-only，不是实际部署policy，也不进入AWS/deploy入口。

1. 两个指定Git源码独立导出，package/lock精确相同才共享安装依赖；原source-map/magicast真实API各7项。
   这是指定源码安装API，不是重执行已发布builder层；其源码tar原字节/hash保全。
2. 两个immutable manifest各自实际preflight pull/save/config/compose；禁网/non-root/read-only rootfs，
   每个原runtime source-map-js=1.2.2、原sharp六项binding/libvips/rsvg/decoder反例。
3. release fresh卷真migration/strict record/server。只读复用#443完整HTTP auth/revocation/reader17类、
   旧/长ID和报告快照、topic/user/manual-review真实writer、失败保全及幂等；模型相关report/Insight/Check为SQL fixture。
4. release重启持久state保全，原容器精确Stopped才切下一阶段；unknown/仍运行/错owner拒绝。
   candidate migration无ledger/state改变；非法record拒绝且state不变；新record只追加1条候选、旧row所有字段精确保留。
5. candidate专属probe核自身bundle，保留release bundle/artifact/snapshot；对release写出的新数据实际登录/401/403/reader精确集合、
   17类拒读/报告/长ID；candidate真实manual-review新trace/2events/3refs/released lease、同key重放无新增；再重启保全。
6. 原成功卷在两个Web停止核验后复制纯合成DB到两个独占故障卷，checksum错配与追加坏identity分别让真实业务初始化拒绝，
   实际HTTP listener/health/auth拒绝单列；故障前后完整选定业务state及全字段deployment rows hash保持。
   此复制不声称C1完整文件备份/恢复；故障在startup的schema/identity前置拒绝，不运行报告/原文恢复。

所有子进程env最小化，业务env仅合成auth/admin/viewer及严格身份/陈旧门，无模型/AWS/通知密钥。
容器无host port、Docker socket、替换/app或其他Session数据；TCP数字外网和metadata ENETUNREACH反例。
生成harness仅适配固定import/cwd，原字节SHA256及替换次数受保护；公共合成harness只读0644/0755以适配容器UID，
env和私有证据始终0600/0700。所有实际app bundle/migration/record原字节保持，reader/权限/status保护函数只读复用。
运行结束或失败只按本轮owner/精确id清理本轮临时容器、卷、harness/source；原证据及其他branch/worktree保留。

## 本地验证与评审

Node24.19.0/npm11.17.0，专属worktree clean npm ci，无依赖变化。

| 检查 | 当前结果与边界 |
| --- | --- |
| 新模块保护反例 | 19项：18pass，1实际image明确local skip；wrong digest/revision/config/tag、app替换/secret/网络/端口、unknown stop、旧record字段/仅追加1条、数据/ledger丢失、hash/import次数、SQL冒充writer、health/reader/status放宽均拒绝 |
| 指定release源码API | source-map/magicast 7/7；Git archive SHA256 `1e741e08cded6c31ea74af7510070e3a94d7851ab46466035ca4b05063548de8` |
| 指定candidate源码API | source-map/magicast 7/7；Git archive SHA256 `b4feeae1da09b973992c204c50112e56fe60de9ab3e8a004b4e94c0817cf67a3` |
| 类型/格式 | TS7/TS6 app+tools typecheck与lint通过；最终文档检查另绑定提交/PR |
| 本地真镜像 | 未执行；无daemon，不造mock资格结果 |
| 最终Linux CI | 待执行；精确tool head/tested merge/run/attempt与实际pair JSON另封存后才验收 |

独立方案Reviewer1 Blocking0/Warning2：旧deployment原行不能忽略、candidate自身bundle不能复用release。
两个Warning已落入实现与保护反例，且candidate执行前必须精确Stopped；最终diff与原始材料仍须独立review，
这段不预签最终评审通过。正常hooks提交/PR/精确CI和条件合入由协调者承接，不自行合并。

实际diff不改生产源码、prompt/模型/AI语义validator、来源、eval口径或report-gen；A1不执行本工具路径，
eval不适用，未调用真实模型、未预签skip/pass、未拿#438/S2b或main CI补签S2a旧head。

## 私有原材料与剩余项

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/a2-version-pair-20261008/`，目录0700/文件0600。
`source-local-index.json`绑定14文件size/hash（模块source、两个Git archive、source API输出、npm/typecheck/lint/保护测试）：
SHA256 `8cd8c953af2905d659f7413189d77b4e4c484500f45facf85fdf4af0c5fa8af3`。
该索引是本地源码/确定性证据时点，后续修正、最终head和真实CI另增索引，不覆盖原始材料。
调查原registry/CI/publish索引继续保留：`a2-candidates-20261008/archive-index-2.json`
SHA256 `86907d49dfc5eb6ba7e4445e289b975dfe01b137d46d053654000778ad0b90d2`。

工程待办：真实Linux精确两镜像运行、关键失败路径与最终独立review/PR/CI；通过后仅这对的隔离资格建议。
独立缺证/预算：S2a旧head真实质量、真实模型相关业务、外部消费者与真实存量；本轮预算0，不阻止此无模型工程。
生产授权阻塞：当前身份/配置/数据/合格备份容量、全writer/drain/真实SSM状态、实名专项操作/失败接管及解除批准。
**safe_rollback=null、deployment blocked、#435硬阻断保持；未批准回退、未部署或生产访问，不关闭TD-09/TD-19/TD-20整体。**
