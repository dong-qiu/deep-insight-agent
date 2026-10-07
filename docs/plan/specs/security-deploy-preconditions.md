# 安全部署前置治理：身份阻断门切片

## 范围与身份

用户确认先交付批准 digest 的执行核验、不可变对象绑定、反例测试和部署入口强制阻断。
本切片**不提供生产切换能力**：Deploy Production Image 在 GitHub runner 完成镜像身份预检后必须失败，
不申请 AWS 凭据、不调用 SSM、不访问生产。未来恢复生产切换须另一个独立评审 PR；不能删除一个开关直接放行。

启动 fetch 后工程基线 `8345f89a6d2ee0379690fa6c3c5f2a8b00354194`；安全镜像仍冻结
`4477412a3e2b1cb2764fb4357f2284e73952af67`。后续主干有 runtime/ID/eval 改动，不能移植其 CI 到旧镜像。
实施期间正常fast-forward接纳 `41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1`（#434的两份测试/收据）；未改其内容。
历史 [A 收据](../../verify/c-production-readonly-2026-10-07.md) 的 04:44–04:47 UTC 观察不代表本 Session 当前生产状态。
历史准备文档的 A 待执行以该较新收据为准；不重写历史正文或继承其生产授权。

## 代码审计与缺口

审计原 `.github/workflows/deploy.yml`（本基线 Git 对象），不是根据手册推定保护存在：

| 真实顺序 / 缺口 | 风险 | 本切片处理 |
| --- | --- | --- |
| image_tag 可空，默认 main；按 tag 拉取后只核 revision 和 RepoDigest 格式 | 同 SHA 标签重建覆盖；批准 digest 未绑定 | 四项身份显式输入；与仓库冻结身份核对；无 latest/main 默认 |
| 下载候选 compose、配置/P1 检查 → pull → migration probe 卷/备份复制及演练 | 未核批准对象即开始前置副作用；最新备份仅按目录时间选择 | 身份预检仅在 runner，无生产卷/probe/配置操作 |
| 保存旧 compose/镜像、注册 EXIT rollback → 安装 compose → stop 三 writer → chown → backup → migrate → record → app/HTTP → cron/worker | 有 writer stop，权限及数据写；没有全 writer drain/互斥 | 移除可执行生产切换序列，预检后无条件非零退出 |
| EXIT rollback 将上一 app 镜像重新打 tag，恢复旧 compose，记录/启动旧 writer（错误用 `|| true`） | 已知旧漏洞重启；health 不能证明安全；迁移后数据兼容未证 | 本切片不运行任何 rollback；现有服务保持原状态；后续回退协议另审 |
| Actions concurrency 只覆盖本 workflow；SSM 540s执行/600s等待/70s取消 | 手工恢复/备份及其他 SSM 不受锁；取消不证明进程终止 | 无 SSM 入口，未知终态不提供下一次切换许可；维护协议保持阻塞 |
| worker SIGTERM 最多 lease 窗口，compose grace 135s | app 内存任务、queued/claimed/expired lease、API新写入未全部覆盖 | 不以 worker drain 或历史计数替代 writer 静默证明 |
| migrate 演练只基于最新备份；backup complete 与现有恢复边界不同 | 备份时间/hash/完整性/容量及新旧数据兼容未证；TD-09未闭合 | 未核项保留；不改变 DB 恢复/schema/迁移 |

## 最小方案与改动文件

1. `ops/aws/security-release-policy.json` 保存**身份核准**对象：repository、revision、linux/amd64、index、manifest、config。
   数值逐项来自 [C 准备清单](../../verify/c-security-release-readiness-2026-10-07.md#候选冻结与证据边界)
   与已封存 registry 原字节（封存 hash 见 [C 索引](../../verify/c-evidence-archive-index-2026-10-07.md)）。
   这不是部署批准单；安全回退为 null，生产前置阻塞逐项列明。
2. `ops/aws/security-release-gate.mjs` 为真实 workflow 调用的无额外依赖入口。
   校验输入格式/冻结身份；只读读取 GHCR 原 index、manifest、config，分别 SHA256 原字节并核 descriptor 大小/type/platform/config revision。
   tag 必须仍解析到批准 index；index 中 linux/amd64 必须唯一并指向批准 manifest；manifest 必须指向批准 config。
3. 输入固定为 `image_tag`、`approved_index_digest`、`approved_manifest_digest`、`approved_config_digest`；
   repository/platform由policy固定，revision从tag派生。runner要求Docker API >=1.48和Compose v2，记录版本并真实执行所需命令；不支持则失败。
   强制runner本地 `/var/run/docker.sock`，不接受继承的远程Docker context/host/API版本覆盖。
   在 runner **按 manifest digest、显式 linux/amd64 实际 pull**，不用 tag pull。
   通过同一 digest 的 `docker image save` 的 manifest.json/config 原字节核批准 config，以及 inspect 的平台/revision/RepoDigest。
   Docker ID/Descriptor 可因 containerd image store 表示 index/manifest，不与 config digest直接比较。
   解析实际对象失败，包括未知 save 格式，fail closed；不作兼容性猜测。archive不展开到文件系统；只从普通成员读有限config/manifest字节，
   多个manifest条目/重复config成员/路径穿越/symlink config/缺config/超限字节/损坏JSON均拒绝。
4. 从精确4477412源码URL取得compose并核仓库冻结字节hash，不使用当前main compose。
   下载到任务专属临时目录，建立空合成 `.env.local` 与显式空 `--env-file`，清除COMPOSE_FILE/COMPOSE_ENV_FILES等隐式配置污染。
   同一批准 manifest 对象传给 `INSIGHT_IMAGE`，调用候选 compose 的真实 `docker compose config --format json`。
   app/cron/worker/migrate/deployment-record 全部必须解析为同一 repository@manifest；只校验配置，不启动容器。
   验证后 tag 再漂移不影响本次不可变对象；任何改用 tag 或服务错绑均拒绝。
5. `.github/workflows/deploy.yml` 显式调用上述入口，保留 main/production Environment/串行规则，去除 AWS/SSM和生产变更路径、
   `id-token: write`和AWS target环境变量；测试扫描完整workflow包括always/cleanup/失败步骤。
   成功身份预检也必须触发硬阻断，不能因环境变量、回退候选、旧 drain 收据或 health 假绿放行。
   `ops/aws/security-release-gate.node-test.mjs` 通过隔离 registry、真实 CLI 子进程和 mock Docker runner 覆盖实际 workflow 接线。
   同一自动发现测试文件在GitHub Actions Linux普通PR CI执行真实gate集成测试：实际GHCR批准manifest的pull/inspect/save/tar/compose解析，
   检查生成identity-only证据，随后执行workflow硬阻断步骤；Docker缺失或gate失败必须使CI失败，不能skip。
   本地没有daemon时仅该集成项明确skip，其余反例必须运行；既有full Docker构建只证当前工作区镜像，不能替代该集成项。
6. 仅更新 `docs/launch/operations.md` 的当前发布契约，加专属交付收据；不改历史安全验收、共享台账、业务代码或依赖。

## 安全回退与未来解锁设计边界

**当前没有合格安全回退对象，不填占位 digest，不默认恢复上一镜像。** 可以评审同一4477412对象是否可作为失败后的
安全保留版本，或另一个已修复对象；前者不能假设能修复同版本启动失败。两者均缺少对实际发布 digest 的原生六项测试、
builder source-map/magicast证据绑定、认证边界及实际数据兼容证明；故当前都没有批准身份。

后续最小回退协议应在任何停 writer 前验证安全回退 index→manifest→config、revision、实际拉取对象、修复/原生闭包、
新数据兼容，以及版本化 compose 五项绑定；用同一不可变对象执行。需分别演练 stop、backup、migration、record、
app/worker readiness 后失败。不得自动恢复 DB 或逆迁移。迁移后兼容未证或安全回退启动失败时保持 writer 停止、保持已授权的
外部访问限制，由指定值守负责人接管；不得因 health 恢复宣称安全通过。停机可能持续到专项人工处置完成，批准人必须事先接受。
本切片没有服务停止或启动，失败后的生产服务状态保持原样，不替旧版本安全性背书。

技术依据：[OCI descriptor](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)、
[OCI index](https://github.com/opencontainers/image-spec/blob/main/image-index.md)、
[Docker save的平台/API契约](https://docs.docker.com/reference/cli/docker/image/save/)。

未来解锁 PR 必须同时提供：跨部署/恢复/备份的统一维护锁及所有调用方覆盖，非等待并发拒绝、异常释放与未知终态保留语义；
停止新任务的授权入口、全 writer/进程内任务静默及 queued/claimed/expired lease检查、有限 drain 超时后不得进入备份/迁移/切换；
SSM未知终态的持久隔离及人工核实后才能解除。不能只用历史SQL计数、Actions concurrency或会自动释放的本地flock证明全覆盖。

数据前置单独核当前库/schema/候选迁移范围、合格 C1 文件/manifest/hash、容量及备份/恢复边界。
未来生产执行须恢复并验证原有DISPATCH_WORKER_SECRET存在性与P1 dormant/anchor/dashboard禁用门，不能仅删除本切片halt步骤。
配置由operator保全 `/opt/app/.env.local`，只记录权限/hash和私有备份定位，不打印/覆盖密钥；本切片完全不读生产配置。
不要求或宣告 TD-09 完整历史恢复完成，不解除运维 §6.1.2 的恢复启动阻塞。

## 验收标准与反例先行

| AC | 必须证明 |
| --- | --- |
| AC1 | 四项身份缺失/非法/未核准即停；tag 漂移、revision、平台、descriptor和原字节hash错配拒绝 |
| AC2 | 实际 pull 只有批准 manifest；拉取/inspect/save config不同即停；Docker ID与OCI三类digest不混比 |
| AC3 | compose真实解析五服务同一批准对象；核验后服务改用 tag、app/cron/worker错绑拒绝 |
| AC4 | 入口始终阻断生产：未核/旧漏洞回退、并发维护、drain超时、SSM未知及伪造ready状态均不能解锁 |
| AC5 | 所有失败及身份通过路径均无 writer stop/probe/业务备份/migrate/record/up/rollback/AWS/SSM 调用；异常退出不传递许可 |
| AC6 | workflow显式接线真实CLI，不仅helper；state/output仅在完整身份核验后生成不可变证据，证据不表示部署许可 |
| AC7 | 独立方案审查后再实施；反例测试先红后绿；运维测试/typecheck/workflow/docs/build及风险相称回归；独立完整diff及远端复核/精确PR CI |

未知项必须作为阻塞，不伪签证据。真实gate集成与既有当前源码Docker/HTTP/browser各自报告；mock不冒充真镜像层验证。
普通PR CI不调用deploy workflow/SSM、不启动生产容器或挂载业务卷；只下载公开GHCR镜像和解析隔离compose。

## 授权、停止条件与负责人

本 Session仅授权隔离实现/测试、Git/GitHub/GHCR只读核对、独立审查和PR。不访问生产，不dispatch工作流，
不drain/stop/备份/迁移/恢复/配置覆盖/付费模型，不自动合并或清理branch/worktree。原生产只读授权不继承。

任何身份错配、不可解释对象、回退/数据/维护/配置/负责人缺失均停止。生产解锁后执行仍须专项授权单固定实例/区域、
命令、时间窗口、副作用、rollback及人工接管；避16:50–17:30 UTC，与恢复/备份/其他部署串行。
授权单必须实名列operator、值守负责人、独立安全reviewer、批准人及联络/响应时限；当前均未指定，不以本PR作者代填。
本切片工程完成不等于全部部署条件满足或修复上线；不关闭TD-19，不宣称全系统安全通过。
