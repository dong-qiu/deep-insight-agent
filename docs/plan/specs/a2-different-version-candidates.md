# A2 不同版本候选资格调查（2026-10-08）

## 切片与退出条件

工程基线 `81dac77cd27f82d7b554694bf0a12cd82cd0920b`，只新增本 spec 与专属调查收据。
唯一写入负责人为本轮执行 Agent B；既有 A2/A3、#435 policy/gate、deploy workflow、主台账只读。
不重做 #443，同镜像不能解决自身启动故障。本切片不产生批准身份、兼容通过或回退许可。

有界调查三个已发布、447 安全修复之后的不同 revision：S2a `eb2bd4d`、S2b `a5253da`、当前工程 `81dac77`。
它们是相对于冻结发布 `4477412` 的其他版本，不是已批准降级对象；与未来新候选的前后关系须重新冻结。
447之前已知含 sharp/source-map-js 漏洞版本排除，不拉取/运行；不进行全 registry/历史镜像搜索。
原 index/manifest/config 字节、descriptor size/type、linux/amd64唯一性、config revision、指定 compose hash，
以及精确 main CI、publish run/attempt/jobs分别核对并私有保全。tag仅作发现，资格建议绑定digest链。
没有 Docker pull/save/运行层时必须列为缺证，不能用CI Docker工程构建或447原生/HTTP收据移植。

资格分层：身份元数据 → 实际拉取身份 → builder/runtime修复闭包 → 实际HTTP业务与新数据兼容 → 当前生产兼容 → 操作批准。
当前仅调查第一层及指定源码差异，安全版本继承不等于实际镜像完整闭包。
Source ID 的 S2a 旧head质量缺口保留；S2b收据/新main CI不能补签该缺口；本轮模型预算0。

## 验收与有界后续方案

1. 指定不同对象真实registry读取与hash/descriptor/config/revision绑定，精确Git源码与CI/publish元数据复核。
2. schema、迁移、启动协调、部署记录、auth/reader/报告白名单与依赖/构建契约单列；静态相同不冒充运行通过。
3. 未批准、身份缺失、旧漏洞、质量或兼容缺失、未知SSM终态均继续hold；`safe_rollback=null`、deployment blocked不改。
4. 缺合格对象或缺必要资格证据时以调查结论退出，记录工程、缺证、模型预算及生产授权各层。

只有身份与源码安全预筛通过、质量缺口已具明确处置且协调者/独立Reviewer冻结方案后，
才进入逐对象隔离资格验收；实际拉取、原生闭包和业务兼容由该验收补齐，验收通过也只形成资格建议。
该方案每次固定一个 release→candidate 对，新的完整OCI链/compose/源码、最小无凭据env与独立合成卷；
禁网/non-root/read-only rootfs/cap-drop ALL，无cron/dispatch/抓取/通知/真实模型。
先核真实pull/save/inspect与builder source-map/magicast、runtime六项native，再对release业务产生的新长ID/关联/报告快照，
调用candidate原migration/record/server真实入口核auth/revocation/reader白名单、失败后保全和重启。
不得倒删schema、逆迁移、重编号或用SQL fixture冒充HTTP writer；数据/身份/取消/终态未知即停止。
至少ops/typecheck/build/HTTP/Docker实际路径和独立review，精确head/tested merge/main CI分别绑定。
本轮未冻结实际实验、不安排CI自动跑候选、不增工具框架；调查收口不表示这部分工程已完成。

生产读/执行、SSM、备份恢复或解除hold必须另有精确目标/命令/窗口/副作用/实名人员与失败处置专项批准。

依据：[A2协议](a2-safe-rollback.md)、[同镜像边界](a2-same-image-business-matrix.md)、
[#435安全门](security-deploy-preconditions.md)、[A3维护](a3-maintenance-protocol.md)、
[恢复边界](recovery-time-coverage.md)、[本调查收据](../../verify/a2-different-version-candidates-2026-10-08.md)。
