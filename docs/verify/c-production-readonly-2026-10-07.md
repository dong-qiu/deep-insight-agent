# C-A：生产只读安全修复核验收据

## 授权、目标与观察范围

用户在 [C 上线准备清单](c-security-release-readiness-2026-10-07.md) A 阶段专项授权请求后回复“授权”。
本轮只执行 A：运行身份、库/补丁、输入路径静态核对、在途/dispatch/drain 与并发维护观察。
未授权也未执行部署、drain/stop、备份、迁移、恢复、镜像 pull/build/prune、业务触发或付费模型调用。
前一轮 [C 收据](c-evidence-readiness-receipt-2026-10-07.md) 的“未访问生产”是当时时点，正文不改写。
D6 本阶段收口与 TD-19 整体关闭继续分开；原始审计来源缺口、D7 后续重核、P1 dormant 保留。

启动最新 `origin/main` 仍为 `473e2eeae119b600b63abd78ce886301bd882235`。
沿用本 Session 独立文档 worktree/分支，新增本收据，不操作其他 Session 文件、共享 roadmap/ADR/总台账。
没有复制环境、数据库、SQLite/WAL、报告或原文。

目标从 GitHub Actions repository variables 的 AWS_REGION / PROD_INSTANCE_ID 与 EC2 名称/架构/状态交叉核实：
`ap-southeast-1`、既有 `deep-insight` 生产实例，SSM Online；实例 ID 仅在私有归档目标收据中定位。
生产 operator 为当前获授权的 Codex Session；独立 reviewer 的生产访问未授权，review 只读脱敏证据。
观察时刻为 **2026-10-07T04:44:04Z–04:47:07Z**（北京时间12:44–12:47），不在16:50–17:30UTC管线窗口。
这是一组时点观察，不保证之后没有新任务或其他 Session 介入。

## 生产运行身份（A1/A2）

**生产尚未运行本次安全候选 4477412；实际仍为 10月3日的 b199bc03。**

| 对象 | 实际观察 |
| --- | --- |
| app / cron / worker | 三服务 running、restart_count=0；app/worker 的已记录 Docker health 为 healthy，cron未配置health |
| 三服务 OCI revision | `b199bc0381a1ebd2b50fde0e68819e0b884a4383` |
| 容器配置镜像与 RepoDigest | `ghcr.io/dong-qiu/deep-insight-agent@sha256:b947ee53b22ba26494ac30da7730bd76612a67bc3410a1aafafb57cd8fdd4406` |
| Docker image Descriptor | OCI index，`sha256:b947ee53b22ba26494ac30da7730bd76612a67bc3410a1aafafb57cd8fdd4406` |
| registry index → linux/amd64 manifest | `sha256:4352a9104a7b38c77b8e9c322ded75eef43e3fbe14f7a1f193b896f183b4520a` |
| linux/amd64 config digest / revision | `sha256:188a96886fc3a844e8134768268652b233afdb1884117ea08154b494e87da780` / `b199bc0381a1ebd2b50fde0e68819e0b884a4383` |
| `/app/build-info.json` | git_sha=b199bc03全文同上；released_at=2026-10-03T10:41:58Z；SHA256 `a38276c91bd1f38728ff61c4edc080117fed85d7a96bb90ea3126c580a6eb3d2` |
| 最新 deployment_record（只投影三字段） | git_sha与上述相同；image_digest=b947ee53全文同上；deployed_at=2026-10-03T12:07:39.027Z |
| 镜像创建 / app启动 | 2026-10-03T10:43:04.769033419Z / 2026-10-03T12:07:47.500848852Z |
| Docker环境 | server29.5.3；driver-type=`io.containerd.snapshotter.v1` |

运行镜像label、实际build-info、deployment_record、registry config revision一致。
registry原始index/manifest/config字节的SHA256逐级与描述符digest相符；未拉取镜像层或改变生产镜像。
现场 `.Image` 字面量恰与index digest相同，另读image Descriptor确认它表示index对象；不能把这个字面量当作registry config digest。
三服务镜像身份相同不等于认证/业务/漏洞验收通过；health取的是已有状态，本轮没有发health请求。

`/app/ops/crontab` 与 worker脚本hash分别为
`308865d78847a17c66ff9581255b032d5892f2e8cf552455a67c2a192464458d`、
`ca704a188bbc2d2c27e72f48b6f0f5d326b9bee4ab099a20cebb20a25aaf358a`，
与精确b199源码对应文件字节hash一致。实际server.js及required-server-files hash亦已私有保存。
这些互相支持版本识别，不作为逐层镜像完整性认证。

## 原生依赖与 source-map / magicast（A3/A4）

| 观察对象 | 实际结果与限制 |
| --- | --- |
| 安装sharp及binding | sharp **0.35.4**，`@img/sharp-linux-x64` 0.35.4；未达到本次修复0.35.5 |
| bundled包与库 | `@img/sharp-libvips-linux-x64` **1.3.3**；实际加载官方binding和bundled `libvips-cpp.so.8.18.6`，sharp.versions.vips=8.18.6 |
| librsvg版本证据 | `sharp.versions.rsvg=null`；平台 `versions.json` 未发现。不能从缺清单推断具体运行rsvg版本，也不能拿其他环境2.63.2补证；本次原生闭包/版本保护条件未满足 |
| glibc / ELF | 探针glibc runtime=2.36；Node ELF class2/type2（ET_EXEC）。未核全部库/内存布局与上游利用条件，不据此声称可利用或不存在RCE |
| 全局librsvg | 此次加载sharp后筛选的sharedObjects未发现独立全局librsvg；这不等于证明所有服务器进程或未来解码只用同一库 |
| source-map-js | runtime安装副本 **1.2.1**，未达到补丁1.2.2 |
| magicast | 在实际runtime的72个已扫描package目录中未发现；standalone不包含dev/coverage包时不能虚构runtime内联补丁存在。精确b199锁文件仍为magicast0.5.5、没有#423补丁，不将后续4477412 builder修复证据移植给旧生产构建 |

探针只做FS读取、require sharp加载及筛选diagnostic report，不输出完整report/环境，没有给库输入图片、XML或source map，
没有重跑六项解码测试或调用攻击载荷。package目录扫描有深度/数量上限且不扫描任意bundle字符串；
“未发现magicast安装包”不证明所有内联副本已排除。后续候选的builder层修复仍沿其专属CI/vendor证据验证。
生产目前含已知受影响版本；这足以否定“修复已上线”，但不构成端到端利用证明。

## 输入路径静态核对（A5）

| 链路 | 可证明部分 | 仍未证明 |
| --- | --- | --- |
| 不可信图像 → Next → sharp | 实际required-server-files配置 `dangerouslyAllowSVG=false`、`unoptimized=false`，domains/remotePatterns均为空；实际image-optimizer代码存在local/remote校验、SVG拒绝和require sharp；文件SHA256 `38b92fde5bc72aa23c999d283052da11a6dfb36be75c2d92683d539551065a3c` | 没有网络请求或载荷；未完整追踪反代限制、本地图像可控入口、重定向/MIME/所有解码分支，不声称不可利用或已验证漏洞 |
| 图像入口认证边界 | 实际Node functions-config-manifest的 `/_middleware` 为runtime=nodejs，matcher originalSource明确排除 `_next/image`；与精确b199源码一致 | 不证明外层反代是否限制该入口；也不把应用middleware排除等同于网络层匿名可达 |
| source map → PostCSS | runtime previous-map.js存在source-map-js依赖与sourceMappingURL读取路径，SHA256 `87e1c0148d0be6cfdb835c531347c43b52bd64f193275f167093dae75adc1394` | 尚未建立生产请求受攻击者控制的map进入PostCSS/SourceMapConsumer的端到端链 |
| source map → magicast | 精确b199的src/next.config没有直接API或inputSourceMap调用，runtime包扫描没有magicast；原构建依赖旧0.5.5事实分列 | 未核旧builder产物中的实际inline字节，不能以dev分类或runtime缺包认定无风险 |

读取 `.next/server/middleware-manifest.json` 的middleware entries为空，并不是认证关闭证据：Node middleware的实际matcher
在functions-config-manifest中已找到。02-runtime的 `auth_middleware=false` 只是某experimental配置键的布尔投影，
不具有认证判断含义，本收据不用它作结论。没有为补证执行登录、请求受保护资源或直接发送图像请求。
默认SVG拒绝、remotePatterns为空、Node ELF属性、无直接sharp调用都不能替代安全版本更新或攻击链核验。

## 在途、dispatch、drain与并发（A6）

只用better-sqlite3直接打开既有 `/data/insight.db`，`readonly:true`、`fileMustExist:true`、timeout1000ms；
先确认DB和既有WAL/SHM存在，再设连接级 `query_only=ON`（回读1），在同一读事务内做聚合与部署身份投影。
没有导入应用DB模块、执行schema初始化/migration、checkpoint或写SQL，也没有复制DB/WAL/SHM。

2026-10-07T04:46:11.264Z 的快照：running Run为0，generation_dispatch queued=0、claimed=0、expired_claimed=0、
oldest_actionable_age_seconds=null；generation_lease active/expired_active均0。
没有job表；未读取app内存Job队列，不把这些DB计数扩写成对所有进程/外部任务的全面证明。
worker drain marker在04:45:08.817Z不存在；未发送信号、改变dispatch或进行drain。

保存的前后 `list-commands` 返回投影未见Pending/InProgress/Delayed/Cancelling，但两份字节相同、只含历史Failed，
连本轮成功probe也未出现。请求没有设置状态过滤；**该列表的当前覆盖度/一致性未证，不据此认定所有其他SSM操作已排除**。
容器清单只有app/cron/worker，
进程投影返回backup/migration/recovery/DR同步计数均0，但独立review发现backup规则要求 `node /app/ops/backup-db.mjs` 紧邻，
实际crontab入口有 `--no-warnings`，规则会漏匹配。因此**backup计数0不能作为备份空闲证据**；
其他规则也只匹配固定命令形态，不证明包装shell、其他参数或其他Session没有操作。
本轮不为修正这一解释再次访问生产；备份维护的当前互斥确认仍作为部署前缺口，需要另核准确进程/命令集合。
生产配置文件仅stat：`.env.local`存在、mode0600，没有读取/复制其内容；P1仅输出anchor/dashboard启用布尔均false、lifecycle unset。
配置内容的部署前完整核对和备份状态仍待B阶段，不拿权限正确当作配置完整。

实际crontab字节与b199相同：collect=05/11/23UTC，完整日报=17UTC，backup=18UTC，integrity=*/5分钟；
host DR cron只投影出18:30UTC，不执行任何任务。未来发布避开16:50–17:30UTC，且与备份/DR及其他Session维护串行。
当前队列空和marker不存在不授权停止调度，也不保证未来切换无需drain。

## 私有原始证据与公开定位

本轮独立私有持久归档标识：`c-a-readonly-20261007T044259Z`，位置
`$HOME/.local/share/insight-agent/evidence/c-a-readonly-20261007T044259Z/`，目录0700/文件0600。
与前一阶段归档分开；不覆盖历史原产物。封存40个文件，`sealed-files.json` SHA256：
`8dfb2a9f799d3e96bf1d98fc99b60706e8b8bebf846d863302a13e37f11041ae`。
封存清单逐文件保存路径/大小/hash；command-index、目标/并发API、原始SSM发送参数/终态、源头脱敏stdout、
源Git文件hash与registry index/manifest/config字节均可由该清单定位。
SSM运行自身产生控制面记录/日志；命令正文没有写业务文件、数据、配置或改变容器状态。

| 私有相对目录 / SSM command ID | 终态 / response code | `result.txt` SHA256 |
| --- | --- | --- |
| 01-inventory / 67b40ca6-d42d-4a1b-81e2-536b5093857d | Success / 0 | `2fc879cc7135ca6be570844d388ada0afe7cfe9a21213a0774ad55aa18773681` |
| 02-runtime / 0b100457-3878-43e3-8c83-b8c1c94b70bc | Success / 0 | `461fbb2e067d05ffa23398b778d7aa6273bd84303724389cf649e7e2f2a3878c` |
| 03-readonly-state / 4b6415df-e787-4994-8b96-5f0a17b9b0f6 | Success / 0 | `f3db51dd6d977f0a03a1ceb009b10e006f03173e023bb839705badb31324bd6f` |
| 04-paths-and-image-objects / e8ab5e5e-315c-4620-828f-6dfe54697921 | Success / 0 | `ad228c5fee30c5d0d23df2406aec2c12be35acc091b973fb0ef9de4f4afaba5a` |

SSM API的execution_start/end原字段保留；02/03的end字段早于stdout内观测时刻，本收据不据此计算实际执行耗时或伪造精确时长。
所有公共结果只包含身份、版本、hash、布尔和计数；没有凭据、环境全文、个人数据、业务原文或完整日志。
目录定位/摘要/hash不替代原始文件，原始文件并不因提交本页而变成异地备份。

## 质量、复核与停止点

本轮只新增Markdown；不改运行代码、schema、依赖、CI或安全实现，Eval不适用，不调用模型。
文档检查、独立pre-pr-ai-review和新精确候选CI结果在PR交接摘要留痕；既有文档候选0ba9f878的CI不代替新候选。
独立pre-pr-ai-review通过：Blocking 0 / Warning 0未处理；backup匹配、SSM列表覆盖度和drain判断三处限制已修正并定向复核。
reviewer核验40/40封存文件、四个命令与结果身份、6/6源Git文件hash及registry digest链，未再访问生产；
远端最终diff与新精确候选CI仍在PR交接摘要核验，不以此文档预先宣称其通过。

A阶段读取完成，但输入链全部可达性/原生rsvg动态版本仍有明确缺口，不称全系统安全验收。
**B/C仍未授权**。可考虑的安全修复候选继续为4477412及其已核镜像digest；当前运行b199镜像含旧组件，
不能作为安全回退方案。批准digest的执行阻断门、安全回退候选、数据兼容性/备份状态与值守负责人仍需完成。
当前workflow自动恢复上一运行镜像会恢复本次确认的旧组件；在回退和执行闸门缺口关闭前不得dispatch。
下一步应先独立交付部署digest阻断门与安全回退方案，再核B前置、申请部署专项授权；本任务不代写这些实现。
magicast仍按原计划最迟2026-11-05复查上游、之后至少每30天，退出补丁独立PR。
不自动合并PR、不部署、不恢复/迁移、不清理worktree/分支、不关闭TD-19。
