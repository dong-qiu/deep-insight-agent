# A2：安全回退与数据兼容隔离交付收据

## 工程与授权边界

基线为 fetch 后 `origin/main` @ `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71`，
专属 branch `feat/a2-rollback-contract-20261007` / linked worktree `insight-agent-a2`。
[专属spec](../plan/specs/a2-safe-rollback.md) 定义切片、AC、失败和A3接口。
未复制.env或任何数据；测试用版本化源码导出及全新合成临时目录，仅共享安装依赖，
不共享live SQLite、不读其他Session工作区、不复制生产快照/原文/报告/WAL。

没有生产访问、AWS/SSM、deploy dispatch、drain/stop/restart、生产备份/迁移/恢复、配置覆盖、
付费模型调用、合并或清理。2026-10-07 04:44–04:47UTC的[A生产收据](c-production-readonly-2026-10-07.md)
是历史快照，不能用于当前兼容或维护准入。现有生产硬阻断、policy safe_rollback=null保持原样。
本PR交付模块诊断和隔离测试，**没有接入生产回退执行入口**，不得宣称生产回退能力已完成。

## 候选治理与身份

| 对象 | 来源与本轮判定 |
| --- | --- |
| b199bc0381a1ebd2b50fde0e68819e0b884a4383 | 历史生产快照含sharp0.35.4/source-map-js1.2.1；拒绝安全回退。只导出版本化迁移源码生成合成v46 fixture，没有拉取/运行旧漏洞镜像 |
| 4477412a3e2b1cb2764fb4357f2284e73952af67 | 冻结发布对象及同镜像回退研究对象；①身份已有#435核验，②/③本轮逐路径补证，④/⑤仍未核/未批准；不能解决自身启动故障 |
| e6045adf3233fdded3b7567a0debd6962970c165 | #435合并；发布37595261016 success。相对447源码有ID/模型观测行为变化，未逐对象核OCI/原生/数据/认证reader，不选择为回退 |
| 0d0701caa1a13c22716c6a03c0b675c135b8998a | GitHub发布37599668634 success；只作替代对象调查，未完成身份/实际镜像/兼容资格审核，不选择 |
| 55c1a41ba4f57f4c9a17f2b54558eba6ba10a852 | GitHub发布37603049914 success；同上，不因更晚发布升级为回退 |
| a5253da8a4e9c40f8098235d6976e5a7b7f6eb71 | 工程base；main CI37603495951、发布37604014130 success。不是冻结发布或已批准回退；没有移植其CI到447镜像 |

后四项只是发现的替代对象，不是已经逐项完成资格审核的候选。没有以latest/main/tag默认值凑出回退。
冻结对象仍复用[身份policy](../../ops/aws/security-release-policy.json)及#435真实preflight，不另造OCI核验规则：

| 身份 | 值 |
| --- | --- |
| index | sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe |
| linux/amd64 manifest（实际测试拉取对象） | sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c |
| config / revision | sha256:d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749 / 4477412全文同上 |
| compose SHA256 | 984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd |
| CI / publish | 37559263616 push full success / 37559608396 workflow_run success，均attempt1及精确447；本轮GitHub只读重核 |

本地重用preflight真正GHCR/source路径，通过index→manifest→config与compose字节核验后，在第一个Docker调用处主动停止。
Node需NODE_USE_ENV_PROXY=1；首次直接请求未通过，只记录为失败，不补造成功。该路径没有实际pull/native证据。
普通Linux PR CI自动发现本切片测试，必须执行preflight actual pull/save/config/compose及指定manifest测试，不能skip；
最终精确head/tested SHA/run/jobs和测试JSON在PR摘要补齐，不把本地无Docker升级为通过。

## 静态数据/安全契约

447的48项migration：前47项逐条与[冻结历史checksum](../../tests/fixtures/c3-v47-migration-checksums.json)一致；
v48 `20261004_48_model_usage_attempt` checksum
`b53d8a92d3f7a1ac69c0dce20cb7f37e195966a128e843cc9b08ed97461a1a3c`。
按version排序的`[{version,checksum}]` JSON SHA256
`2856c98a2ddca80108a65fb052a02316cb665ecb47ad37419ad754fded681d49`；
447的schema.ts字节SHA256 `8b83a8fc65c38c0267a0e0d45c9f2648b057205ea225dc3fa505fdd6b977e840`。
迁移逐项提交，不能假定整轮原子；v48 usage依赖run FK、不可删/身份不可改、观测单调。
严格app startup先查最新ledger，再核env digest/最新record/build-info，随后raw/report协调可能产生写入，不能作为生产只读入口。
record CLI显式strict=1才写，否则成功no-op；重复写会追加不同ID。record自身接收GIT_SHA，不能用它代替#435真实身份核验。

发布与研究回退是同一镜像；不提供跨版本downgrade结论。新旧ID仍opaque TEXT，业务关联、文件名、FTS和canonical更新
须保持精确身份；不能截短/重编号。447至工程base schema/migrations/startup/deployment/usage/认证middleware/reader核心及
package/lock/Dockerfile/compose无差异，不以这个静态事实替代实际镜像测试；validate ID生成及runtime模型观测等后续变化单列。

B1b撤销门与退出cookie修复必须保留；跨旧边界/恢复旧密码哈希需另授权AUTH_SECRET轮换、重建与旧cookie拒绝。
reader当前来源须effect/envelope/正文/hash及语义白名单共同通过；历史已发布报告与当前原文可见性分开。
引用blocked/未验证不得发布；取消/fencing guard失效不得提交。恢复§6.1.2及TD-09仍阻塞，A2不改恢复CLI或逆迁移。

## 隔离兼容矩阵与本地验证

| 路径 | 本地证据 | 实际发布镜像证据边界 |
| --- | --- | --- |
| 发布前v46/v47 → v48 | 精确b199(v46)、823b6d875ceecc66dc35ff4ef37a8699aadbec17(v47)源码各生成新合成DB；精确447 migration CLI源码打包升级/重跑；历史checksum、旧Run/失败Report及FK保留 | Linux CI执行同fixture、447真实bundle；未用v48倒删新数据造旧库 |
| fresh v48 / migration重复 | 指定447 provenance/initialization/deployment测试 | 精确manifest bundle初始化/重复migration/ledger及FK |
| 目标新数据/读取更新 | 指定447真实业务函数测试涵盖207用例：ID/报告索引/关联、reader/删除边界、usage、认证状态、白名单、取消/fencing | 镜像SQL fixture仅证usage约束/新长Run保留，不能声称business writer已执行 |
| migration/record失败 | 模块阶段反例及指定源码失败测试 | 镜像CLI checksum/DDL failure、strict record非法身份/插入失败不丢新数据；record重复实际追加 |
| native/runtime | 本地没有Docker，不宣称真镜像运行 | 精确发布manifest禁网六项native及runtime source-map-js1.2.2；builder magicast未打包时不造runtime修复 |
| HTTP/auth/reader完整同镜像 | 未覆盖；源码/当前工程HTTP不替代 | 后续切片待补，不签完整安全/兼容通过 |
| 当前生产schema/配置/备份/hash/完整性/容量 | 无本轮访问；历史观察不够 | 未核、待专项只读授权 |

首次只跑指定447业务测试及生成fixture时56pass；随后新增ledger等值断言，暴露b199仅46项而非假定47项，
全ops出现1fail，独立reviewer也复现。已改为b199的v46阶段及真实823b6d8的v47阶段，
分别校验已执行历史checksum并升级v48；不把旧失败结果作为最终通过或当前生产schema事实。

本地Node24.19.0/npm11.17.0 clean npm ci，无依赖变化。
A2定向57项：56pass/1实际镜像skip；指定447源码12文件207用例、source-map/magicast API7项成功。
全ops294项：292pass/2实际镜像skip（#435与A2各一项）；typecheck TS7/TS6、lint零warning通过。
文档链接/锚点/格式检查通过。原deploy workflow actionlint通过；未改CI/publish的两个既有SC2016
单引号JS提示不属本diff，禁用shellcheck的完整workflow结构检查通过，没有为消提示改共享文件。
首轮工程生产webpack构建17388ms/builds=1；同环境HTTP9/9、browser7/7复用同构建，additional_builds=0。
该本地产物来自提交前A2工作区，并不作为后续probe修正head的精确构建证明，新head完整CI另跑。
这类当前工程回归不代替447镜像证据。

实际镜像测试用本地Docker socket、精确manifest、--pull=never、--network none、只读rootfs、丢弃capabilities，
数据仅tmpfs /data及/tmp，挂载的合成fixture/测试脚本只读；不挂生产卷，不启动cron/worker或访问云服务。
依赖guard失败、preflight失败、镜像native/CLI失败均使CI失败，未用skip兜底。

首轮PR #439 head e74287c384ea29c686e4a1513312591ee732efa5 / CI37613600227 attempt1：
实际preflight及镜像启动成功，但usage身份更新反例同时违反observation单调约束，实际返回
usage_observation_immutable，而测试误期待usage_identity_immutable；A2镜像项失败，原生六项尚未到达。
293/294ops通过、0skip，普通工程Docker通过，不能将此CI写成完整A2镜像兼容通过。
修正仅让反例observation_number递增以单独触发身份不可改约束，保留精确错误断言并加整行不变断言；
另将native子进程reporter显式固定为TAP，避免默认reporter差异使6/6汇总断言产生假失败。
指定447源码复现身份反例通过，新精确head实际镜像及全CI须重新执行，结果在PR摘要留痕。

## 接口、失败与当前阻塞

版本化接口为 `a2-a3-handoff-v1` 提案，**未获A3实现收据或接收确认**。
[A2模块](../../ops/aws/a2-rollback-contract.mjs) 校验声明的operation/holder/operator、release/rollback完整身份、
schema/migrations/config/data摘要、有效期及scope绑定；所有层只标structurally_complete，verified始终false。
伪造全套pass/ready也不能得到生产或回退许可。CLI总是非零退出。未读/验签真实receipt，不称生产准入门。
A3负责真实维护互斥、writer/drain/lease/fencing、SSM终态、持久未知隔离、人工接管和解除批准；A2不签ready、不释放锁。

停writer前失败：禁止进入后续生产变更，原服务保持原状。停后/备份前、迁移中或后、record、
app/cron/worker readiness、回退启动失败：维持或由A3重新建立全部writer静默与维护隔离，交人工接管。
阶段未知按可能已停/部分已启动处理。未来仅允许已批准且兼容的安全回退；当前null，没有可执行回退操作。
不自动恢复DB/逆迁移/删除新数据，不恢复含漏洞旧镜像，不以health成功代替安全验收或解除既有外部限制。

A2独占本PR专属ops/aws/a2-*、spec、收据。共享deploy.yml/identity policy/gate/运维入口完全未改；
由后续集成Session串行接收，独立PR验证真实调用及A3协议全部入口覆盖，现有always hold继续保留。
没有新解锁参数，没有重复实现维护锁/drain/SSM，没有假设其他Session已完成A3。

阻塞清单：合格不同回退对象及逐对象安全/兼容资格；实际发布镜像完整HTTP/auth/reader矩阵；
当前生产对象/schema/config/合格备份hash完整性/容量；A3真实协议/全writer和所有维护入口；
实名operator/oncall/reviewer/approver及联络响应时限、持续停止接受、专项执行/解除授权。
下一专项只读授权须固定实例、区域、允许命令/端点、窗口、副作用及收据范围；本PR不代申请笼统生产授权。
之后才可申请停writer/备份/迁移/record/切换/失败处置执行授权及上线验收授权；避16:50–17:30UTC并与其他维护串行。

## 独立审查与评测适用性

方案独立新上下文review首轮Blocking0/Warning2，strict record实际写入及native六项/builder-runtime分层要求补齐后，
定向复核Blocking0/Warning0，再实施。最终新上下文pre-pr-ai-review通过：Blocking0/Warning0未解决；独立复跑57项56pass/1local skip、
指定447源码207用例及两条历史升级路径，并核真实hold/CI路径。两项Warning（fixture版本、层级措辞）已修正复核。
远端diff与精确CI由独立reviewer另核，PR留摘要。
实际diff只加A2运维诊断、隔离probe/tests、spec/收据；不改src、prompt/模型/AI validator/来源/评测集/迁移/依赖，
按eval-gate真实路径判断A1不适用，未跑付费模型、不预签skip章、不拿现成A1作为A2证据。
不因PR/CI完成批准安全回退或宣称部署条件全部满足/修复上线，不关闭TD-09或TD-19整体。
