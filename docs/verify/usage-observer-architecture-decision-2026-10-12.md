# M1/M2 usage-observer 正式架构决定收据

## 范围与来源

仅原 ADR-0045/0046 架构 owner 对已复核 M1/M2 方向的正式加性文档：
[ADR-0047](../develop/decisions.md#adr-0047-具名迟到账务与独立-usage-observer-operation)、
[架构节](../plan/architecture.md#m1m2-具名账务与独立-observer架构接受未实施)与本收据，三文件。
实际基线 `17a609029b508aa14bfc7224727dbf010f969ddc`，不复制原 native worktree 的旧 dirty ADR 或其它内容。
来源 [S2b spec](../plan/specs/r3-r6-s2b-fixed-domain-contract-2026-10-12.md) SHA256
`5ba890fa20a4b8cb64934b757381ef5ff85ef09fbab9f0ec599a6091486a7196`；已接受决定
`7967e8bf9f9564c9b62bed2851e5f819e7eb9b36e2a373c116b813024a922150` 仅 `M1_M2` 字段，旧 deadline/源码许可不借用。

## 接受与仍阻塞

接受具名迟到 accounting 和独立预登记/非 replayed begin COMMIT+ACK 后激活的 fresh observer。
原 signal/取消首因与 registry/physical/generation/真实 claim/current-run 门保留，不授新 fetch/结果发布或 cap/claim 复活。
Job/父 finish 不终结尚未 settled 的独立 observer operation，也不伪称其已 settled；final/close/失权/死亡保留已知 partial/unknown，不新增后台 SQL interval。
ordinary pre-open/begin/terminal 取消继续严格；任何已确认 COMMIT/ACK 保真，不冲销费用或制造原子完成。

catalog/header/DDL/marker/observer terminal enum、固定事实验证、canonical 原 DB semantic owner 与 Run 状态政策仍未冻结。
standalone schema/SELECT 验收非 model_usage 业务资格；core/九 domain/build/fixture/setup及真实 runtime接线窗口未开放。
本片未实施、未运行 observer，也不关闭 TD-09/TD-10/TD-19 整体或生产阻塞。

## 验证与时态

原作者窗口 2026-10-12T04:05:41Z–04:30:41Z 已超时关闭；三文件 patch 返回后的首个时钟为 04:36:20Z，04:37:11Z 停止并安全保全未审 WIP，不能称按时作者交付。原窗口的 R1 未开始。
独立只读 R1 窗口为 04:41:07Z–05:01:07Z：A 于 04:46:01Z 完成 B0/W2/S0，B 于 04:46:17Z 完成 B0/W1/S0；一次文档检查 04:42:46Z exit/close 0。旧两类 Warning 和超时原件保留，不以检查通过代签评审。
本次独立最小修订与关联最终 R2 从 04:52:30Z 开始，截止 05:12:30Z；冻结本候选时 R2 尚待，不提前签通过。整体最多两轮、不第三轮旧 S2b 算法审查；无 PR/自然 CI，后续交付记录须另绑定实际身份和终态。
文档检查不证明应用/native/DB/模型验收；本片不合并 PR，后续需精确 head/CI/sole merge-owner 门。

## 安全与回退

无本机 DB/native/env/install/model/eval/VM/生产/恢复/清理；预算保持 0。旧 seal、历史失败、warning、未知及各 owner 原件保留。
`safe_rollback=null`、deployment blocked、hold/#435 与全 writer/drain/production false 保持。
文档取舍需回退时另行 feature PR，仅撤回新增决定，不用它迁移/修改旧 DB 或解除任何实际维护门。
