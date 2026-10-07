# C：安全修复上线准备清单

## 范围与授权边界

本清单承接 [C 归档索引](c-evidence-archive-index-2026-10-07.md)、
[source-map-js spec](../plan/specs/source-map-js-security.md)、[sharp spec](../plan/specs/sharp-security.md)、
[运维 §8](../launch/operations.md#8-升级)与 [L2 流程](../../skills/L2-workflow.md)。
本轮只读取 Git/GitHub/GHCR 证据及制定计划；没有生产访问、部署、恢复、迁移或付费模型调用。
任何下述生产动作均待专项授权；命令或清单不是授权。D6 本阶段收口不关闭 TD-19 整体，原始审计来源缺口和 D7 后续重核继续保留。

## 候选冻结与证据边界

| 对象 | 精确身份 / 已核证据 |
| --- | --- |
| 安全修复源码候选 | `4477412a3e2b1cb2764fb4357f2284e73952af67`，#427 合并 SHA，包含 #420/#423/#426 |
| 源码 Git tree | `d0309b2e5d95edfb52ba31b0490185fd9de2a2f9`，与 #427 最终 head 及 tested merge tree 相同 |
| 绑定该源码的完整 main CI | [37559263616](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559263616)，attempt 1 / push / full / success |
| 绑定该源码的自动发布 | [37559608396](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559608396)，attempt 1 / workflow_run / success；准入日志读取上述 main CI |
| 不可变标签 | `ghcr.io/dong-qiu/deep-insight-agent:sha-4477412a3e2b1cb2764fb4357f2284e73952af67` |
| OCI index digest | `sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` |
| linux/amd64 manifest digest | `sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c` |
| linux/amd64 config digest / revision | `sha256:d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749` / `4477412a3e2b1cb2764fb4357f2284e73952af67` |
| CI 原生闭包保护 | 实际 standalone Linux 镜像六项 6/6：binding/bundled libvips 加载及 rsvg 清单、SVG RGBA/PNG、损坏 XML、像素上限、WebP、AVIF；sharp 0.35.5 / vips 8.18.7 / rsvg 2.63.2 |
| 启动文档主干 | `473e2eeae119b600b63abd78ce886301bd882235`；其 main CI 37562025600 独立归档，不替代上述镜像候选 CI |

2026-10-07T04:26:37Z 的 GHCR 只读请求：标签返回的原 OCI index 字节 SHA-256、registry digest header、
发布日志 digest 三者一致；index 指向的 amd64 manifest 及 config 字节也分别匹配其描述符 digest，config revision 正确。
未下载/运行全部镜像层；发布 workflow 单独重建镜像，CI 的镜像运行测试不等于已运行该发布 digest，更不等于生产验收。

启动时 `origin/main` 为 473e2ee；4477412 → 473e2ee 仅 #422 的 11 份 Markdown，但完整 Git tree 不同。
本文文档分支及以后主干不能与 4477412 镜像拼接为同一验收对象。
授权部署前重新查询主干与候选之后的差异、公告及发布状态：若出现 runtime/package/lockfile/CI/compose/schema/安全策略变化，
由 reviewer 重新判定候选适用性。若选择更晚 SHA，必须另建该 SHA 自身的 CI、镜像、digest 和评审记录，不自动选择 latest 或留空默认 main。

## A. 生产只读核验计划（待专项授权）

执行人：生产 operator；复核人：安全 reviewer。具体姓名、实例目标、允许端点、时间与命令集合须在授权单中固定。
SSM 可以执行写命令，需先逐条审阅命令；只登记脱敏身份、版本、数量与结论，私有结果权限 0700/0600。
不输出完整 `docker inspect`、环境、cookie、日志、SQL 行或原文；不使用可能初始化/迁移数据库的应用启动入口来做读取。

| 步骤 | 只读操作与应保存的结果 | 通过 / 停止条件 |
| --- | --- | --- |
| A1 目标与运行版本 | 确认授权 AWS 实例/区域、compose 项目与 app/cron/worker 容器 ID；白名单字段读取容器 `.Image`、镜像 OCI revision/source、RepoDigests、创建时间及实际 bundle/version 字面量；部署记录只投影 SHA/digest/时间 | 各来源一致才确认当前版本。OCI label 单独不证明 bundle；deployment record 单独不证明当前容器 |
| A2 镜像对象 | 区分 tag、OCI index、amd64 manifest、config/image ID；从已记录 index 的 descriptors 验证平台关系，再与实际容器 image config、RepoDigest 对照 | 对象不同不能直接字符串比较。无法解释 digest 链或 revision 不符，停止发布判断 |
| A3 原生闭包 | 容器内短生命周期只读 Node 探针读取实际安装 sharp/package 平台目录与 `versions.json`；加载 sharp 后只筛选 diagnostic report 的 sharedObjects，在内存 realpath 后验证实际 binding/bundled libvips；记录 sharp/vips/rsvg、架构、平台及匹配结论。必要时核 ELF/PIE、glibc 和全局库是否参与加载，不装工具或改变库 | sharp >=0.35.5，官方预编译清单 rsvg >=2.63.2，真实加载 bundled 库。版本清单不是任意全局 librsvg 动态版本证明；全局库/缺失清单无法证明时为缺口 |
| A4 source-map / magicast | 枚举实际容器中存在的 source-map-js 和 magicast 副本；如存在 magicast，核 patched builders 字节/PROVENANCE 与精确候选匹配、十个旧内联模块已移除并外联精确 1.2.2。核构建证据中的锁图、vendor 与真实消费路径测试 | magicast 是 dev/coverage 依赖，standalone 可能不包含它；运行容器缺包须明确登记“未打包/未见 runtime 副本”，由候选 builder/CI/vendor 证据证明构建层修复，不能虚构 runtime patch。包未发现不证明所有 bundle 无旧副本 |
| A5 输入可达链 | 基于实际版本的路由、认证/代理配置及构建配置静态追踪不可信 source map → PostCSS previous-map / magicast inputSourceMap，和 SVG/图像 URL → Next 图像优化 / 其他原生解码入口；必要时只读取脱敏配置存在性和既有请求类型计数 | 每条登记入口、认证边界、校验/默认策略、消费函数、证据与未核段。无直接 sharp 调用、默认 SVG 拒绝或 audit 0 不证明攻击路径不可达；不发攻击或边界载荷 |
| A6 调度与并发 | 只读查看 in-flight Run/Job、queued/claimed dispatch 数量、lease/年龄、worker readiness/drain 状态、正在执行的 SSM/部署及恢复/备份维护；只读 SQL 使用 SQLite readonly/query_only 连接、聚合计数，不导出业务数据 | 核实每日 16:50–17:30 UTC（次日北京时间 00:50–01:30）及备份/DR维护窗口；有在途、drain 不明或其他 Session 正操作时暂停安排。drain/stop 本身是写操作，A 阶段不执行 |

A 阶段结束单独交付生产只读收据；仍不自动执行 B/C。若任何 GET 会引起缓存或业务写入，
从 A 命令集合排除并记为缺口；不能只因 HTTP 方法为 GET 就称只读。

## B. 部署前置条件（当前尚未满足）

| 条件 | 授权部署前所需证据 / 当前状态 | 负责人 |
| --- | --- | --- |
| B1 精确候选 | 上表候选与 CI/发布/registry 身份已核；执行前刷新 registry digest、评审后续差异并冻结部署 workflow 的 main revision。`image_tag` 明填 sha-4477412…，核其解析 digest 等于已批准 index | 发布 operator + reviewer |
| B2 生产真值与配置保全 | A 收据尚缺。保留 `/opt/app/.env.local`，不全量覆盖、不输出内容；记录权限、配置备份定位及必要键存在性。仅走 `Deploy Production Image`，禁用旧全量 deploy.sh / rsync 源码构建路径 | operator |
| B3 数据兼容性与备份 | 候选自身不改 schema 不等于与未知生产库兼容。核当前 schema/迁移范围、最近合格 C1 manifest/文件 hash/备份状态、隔离演练条件及磁盘余量；只登记脱敏计数/状态。备份 complete 不等于恢复准入；恢复时间/覆盖的现有阻塞继续保留 | 数据维护 operator + reviewer |
| B4 明确 workflow 副作用 | 当前 `.github/workflows/deploy.yml` 会创建隔离 probe 卷、复制最近备份并迁移演练，停止 writers、改卷权限、备份、迁移、写 deployment record、切换 app/cron/worker 和清理镜像。本轮均未运行；专项部署授权必须覆盖这些既有步骤，否则禁止 dispatch，不用绕门的手工 code-only 路径 | 授权人 + operator |
| B5 安全回退 | **缺口：没有已核验且与生产数据兼容的安全回退镜像。** 现有自动 rollback 恢复上一运行镜像；其 digest/revision 可验证不代表无漏洞。须先核旧镜像是否已含全部修复和原生闭包，或独立评审准备安全回退方案并取得授权；本任务不修改 workflow | 安全 reviewer + operator |
| B6 窗口与 drain | 无在途任务/lease 冲突，有经授权的停止新 dispatch 与 drain 方案、结果收据及超时停止策略；现有 worker drain 最多 2分15秒/fencing 接管不保证任务永不受影响。避开管线窗，与其他 Session 的部署、恢复、备份维护串行 | 调度/生产 operator |
| B7 认证与休眠准入 | 核当前生产相对 B1b 的认证边界、必要 secret 存在性（不输出值），P1 dormant/anchor/dashboard 关闭。跨 B1b 回退先限制外部访问并另授权 AUTH_SECRET 轮换/重建与 cookie 拒绝核验 | 安全/生产 operator |
| B8 人与停止条件 | 指定发布执行人、值守负责人、安全 reviewer 和授权人姓名及联络方式（当前未指定）；允许窗口、预期 SHA/digest、回退对象、失败处置写进授权单 | 用户指定负责人 |

**B1 另有执行闸门缺口**：当前 deploy.yml 只核 revision 和 RepoDigest 格式，没有 expected digest 输入或与批准 index 的比较；同 SHA 的发布重跑也可能重建并覆盖同标签。仅在 dispatch 前检查标签不足以阻断执行时漂移。必须先由独立任务评审并验证“实际 pull 后、任何 writer stop/备份/迁移/记录写入前，严格比较批准 digest”的可执行闸门，或提供等价且获审查的阻断证据；未补齐前禁止触发当前部署 workflow。本任务不改 CI/workflow、不改用手工绕门部署。

停止条件：身份或 digest 不符、原生闭包/内联修复证据不足、无安全回退、备份或兼容性未证明、
在途或并发运维未清、配置缺失、窗口冲突、迁移/记录/health/auth/worker 任一步失败，均停止推进。
SSM 超时/取消后未证明终止时禁止下一次发布。writer stop 前失败不继续切换；stop 后按**已审查且获授权**的安全回退方案处置。
若 workflow 自动恢复了含漏洞的旧镜像，记录为“可用性回退，安全验收失败”，保持预先批准的外部访问限制，
立即交值守负责人；不得因 health 恢复解除限制或声称安全完成。不能以本计划临时授权封网或恢复数据库。

## C. 部署后验收计划（待单独授权）

| 检查 | 验收证据 / 失败处置 |
| --- | --- |
| C1 实际运行身份 | app/cron/worker 对应同一批准 revision、config 与 RepoDigest 链；bundle 字面量、部署记录 SHA/digest 与候选一致。记录容器 ID/时间及 index → amd64 manifest → config 关系，避免把 Docker image ID 当 index digest |
| C2 修复真实性 | 在实际 app 容器重复 A3/A4 的库加载/清单与安装字节核验；确认原生闭包实际存在，source-map-js 与 magicast 按 runtime/builder 所在层分别证明。缺库、旧内联副本或版本不足即失败；health 200 不替代此项 |
| C3 健康与 worker | `/api/health`、三个服务状态、app readiness；核 worker health 连续观察及重启数、dispatch 聚合年龄/队列状态。运维手册写“连续30秒”，当前 deploy.yml 实为就绪轮询成功即退出，不能据 workflow success 自动声称完成30秒稳定性观察；需另做授权后的只读观察 |
| C4 认证 | 未认证既有只读页面/API 拒绝或跳登录；由授权 operator 用现有会话读取允许资源和角色边界，cookie 只在内存。新登录可能产生认证记录，若需重新登录另列授权，不把它混入纯只读集合 |
| C5 代表性业务 | 从授权允许的既有报告列表/详情、只读管理状态选择代表性检查；仅登记 HTTP 状态/结构、引用白名单与显示完整性结论，避免正文/个人数据进入公共收据。先确认端点无业务写副作用；不生成报告或触发模型 |
| C6 结论 | 将实际部署 run/SSM 终态、真实 SHA/digest、修复项、只读业务检查、限制与安全回退状态写新收据，reviewer 独立核验后才能声明该候选已上线并满足本次修复范围 |

不调用攻击载荷，不触发 `/api/cron`、trigger、日报/深挖/追问、恢复、迁移或付费模型来凑验收证据。
部署 workflow 内已有迁移属于 B4 的专项写授权，不属于 C 阶段的只读验收。
健康与兼容性检查不声称复现 CVE/UAF 或证明所有攻击面已安全。

## 维护、回退与交接

magicast vendor 从 2026-10-06 的调查起至少每 30 天核上游，下一次最迟 **2026-11-05**；
用户指定依赖维护负责人（当前待指定）。按 [SECURITY_PATCH](../../vendor/magicast-source-map/SECURITY_PATCH.md)
检查真实发布字节和父契约；退出补丁必须独立 PR、干净安装/全依赖 audit、实际 API 保护、coverage、
typecheck/lint、构建/HTTP/browser 与 full Docker CI，并按 eval-gate 判断适用性。本轮不重新实施修复。

原 magicast、source-map-js 1.2.1、sharp 0.35.4 都会重新引入已知漏洞，不得作安全回退。
撤回本次文档可用独立 revert PR，不改变代码、镜像、业务数据或历史验收正文。
共享 roadmap/ADR/总台账保持原样；需要更新入口时由其维护 Session 明确接收交接，引用本收据即可。
D7 S2 与 A1 零付费准备可并行；生产访问、部署和数据维护不能借其授权或互相并行。

下一步先申请限定目标、命令和窗口的 **A 生产只读核验**专项授权；取得收据、补齐安全回退/负责人/数据前置后，
再申请覆盖 B4 真实副作用的 **实际部署**专项授权；最后单独申请 **C 部署后只读验收**授权。
本次不合并 PR，不清理分支/worktree，不关闭 TD-19。
