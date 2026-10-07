# 安全部署前置治理：身份门切片交付收据

## 范围与授权

用户明确确认先交付“身份执行门＋不可变绑定＋反例＋生产切换硬阻断”切片。
[专属 spec](../plan/specs/security-deploy-preconditions.md) 定义完整缺口、风险、AC和停止条件。
启动基线8345f89，随后仅正常fast-forward接纳#434的测试/收据，最终工程基线
`41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1`；候选镜像仍4477412，未用最新main替换。
专属branch `feat/security-deploy-preconditions-20261007` / linked worktree，只复制必要gitignored配置并0600，
DB_PATH/DATA_DIR均隔离；未复制数据、WAL、报告、备份或.env.development.local，未操作其他Session工作区。

本Session没有生产访问/探针、workflow dispatch、AWS/SSM、生产drain/stop/restart/备份/迁移/恢复/配置覆盖、
付费模型调用、自动合并或branch/worktree清理。04:44–04:47UTC的[A历史收据](c-production-readonly-2026-10-07.md)
是时点观察，不是当前核验或本Session授权。历史C/A正文保持原样。

## 工程结果与边界

真实部署workflow调用 [gate](../../ops/aws/security-release-gate.mjs)：四个输入缺一不可，必须与
[冻结身份policy](../../ops/aws/security-release-policy.json) 一致。逐级核tag→index→唯一amd64 manifest→config的
原字节hash、descriptor大小/type/platform和revision，下载精确候选compose并核字节hash。
runner强制本地Docker socket，按manifest digest实际pull，inspect/save本地config原字节；不把Docker ID/Descriptor当config。
真实Compose解析migrate/deployment-record/app/cron/worker，五项只能绑定同一批准manifest且平台不冲突。
save只读解析，不解包；重复/穿越/非普通/未知扩展格式/缺失/超限/损坏对象均失败。

workflow独立always步骤**无条件失败**，没有解锁开关；全部AWS/SSM权限和旧生产变更/自动恢复上一镜像路径被移除。
因此身份通过也没有probe卷、writer stop、业务备份、权限修改、migration、deployment record、切换或rollback。
身份证据始终 `deployment_permitted=false` / `location=isolated-runner`，异常不保留旧成功output。
这证明runner预检及工程切换阻断，不证明生产host实际拉取、服务切换、全writer drain、维护锁或SSM终态协议已实现。
本PR未合并前，main工作流不会因本地候选而改变；工程交付不代表修复已上线。

## 身份与只读证据

| 对象 | 身份 / 证明边界 |
| --- | --- |
| 修复源码 | `4477412a3e2b1cb2764fb4357f2284e73952af67`，含#420/#423/#426/#427 |
| OCI index | `sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` |
| linux/amd64 manifest | `sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c` |
| linux/amd64 config | `sha256:d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749` |
| 候选compose SHA256 | `984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd`，精确Git对象与raw源码相同 |
| 候选可信CI / 发布 | 37559263616 push full success / 37559608396 workflow_run success，本轮GitHub只读重核SHA与结论 |
| 原归档 | [C索引](c-evidence-archive-index-2026-10-07.md) 的封存hash与registry三份原字节hash已重核；未改封存 |
| 本轮GHCR | 真正gate的registry/source路径逐级通过；随后在调用Docker前主动用runner seam停止，不冒充本地实际pull |
| 安全回退 | **null / 未批准**。历史b199含旧组件；没有新造digest或把candidate CI冒充数据兼容许可 |

CI曾验证#427的另一次镜像构建原生六项；发布digest与构建源码绑定不等于在该发布digest上执行了原生测试。
本切片的普通PR CI另行验证准确发布manifest的实际pull/save/compose，不启动容器或跑原生解码，仍不构成安全回退/数据兼容批准。
若冻结tag漂移，本PR真实集成门应红，而不是用更新标签补证。

## 本地验证与反例

Node24.19.0/npm11.17.0干净npm ci，无依赖变更。首次登录shell误用系统Node25仅作为失败环境记录，随后明确PATH重装。
测试先写：新CLI尚缺时测试失败；另对精确基线workflow验证缺少required approved_index_digest，旧入口反例成立；
实现后反例覆盖四输入缺失/非法/未核准、tag漂移、完整hash链下错误revision/platform、descriptor错配、
实际pulled对象/保存config不符、tag再绑定、五服务错绑及platform、archive边界、工具不支持、异常及旧证据清理。
真实workflow接线/CLI和always halt均测试；未核/旧漏洞回退、并发维护、drain超时、lease、SSM未知、伪ready均不能解锁。
这些是**硬阻断无法放行**的证据，不能写成那些延后协议的行为测试已经通过。

本地完整ops、typecheck、lint、actionlint、文档/格式检查及生产构建/HTTP/browser结果在最终PR摘要逐项绑定。
最终41d40ed基线与本切片工作区的本地验证：

| 验证 | 结果 |
| --- | --- |
| gate定向测试 | 73项：72通过，1真实Docker集成本地skip |
| `npm run test:ops` | 237项：236通过，1相同集成skip；保留全部既有保护 |
| `npm run typecheck` / `npm run lint` | TS7/TS6 app/tools通过；lint零warning |
| `actionlint .github/workflows/deploy.yml` | 通过 |
| 文档/链接/锚点/格式及 `git diff --check` | 三份文档与完整diff通过 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 生产webpack构建13961ms / builds=1 |
| 相同环境 `npm run test:e2e:built` / `npm run test:browser:built` | HTTP9/9、browser7/7，additional_builds=0 |

C5构建输入SHA256 `75b4b04ab0fc3343e0f82bef027a8b506013d15e6ffb006837530115185e6afc`；
构建产物SHA256 `834c045cf8ce8a6e014c1740426b895a96ad614ea021a906c64e7bb440e5838e`。
本地收据head是工作区基线，不冒充尚未冻结的PR head或Linux远端证据；完整最终CI须另绑定。

本地daemon未运行，不擅自启用Docker；真实gate集成项明确skip，GitHub Actions Linux普通PR CI必须执行、不可因daemon缺失skip。
ops自动发现该测试；最终CI既执行真实manifest的pull/inspect/save/compose，也执行当前工程源码的既有全应用/Docker/安全门，分别核验。
HTTP/browser共用同一次C5构建；曾因ops输入变化和不同NEXT_TELEMETRY_DISABLED环境被正确拒绝复用，未弱化收据门，随后统一环境验证。

## 独立审查与评测

方案新上下文 `deployment_plan_review` 首轮发现真实gate集成证据缺口及compose隔离/API/权限说明问题；
spec修正后独立复核通过，Blocking0/Warning0，再开始实施。反例与实现审查使用
[pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)，读取完整skill并按高风险部署范围审查。
最终完整diff/未跟踪文件、远端一致性和精确PR CI由另一新上下文reviewer复核，结论写PR摘要；本文不预签最终CI。
最终新上下文 `deployment_final_review` 完整七文件pre-PR审查通过：风险高，Blocking0/Warning0/Suggestion0。
独立Node24.19定向73项/72pass/1真实Dockerskip；另构造checksum、缺单/双终止块及PAX扩展四个反例均拒绝。
核workflow权限/always硬阻断、实际CLI接线、digest/config/archive/compose绑定、普通PR CI集成与评测边界；
未访问生产。远端完整diff与精确CI仍在冻结PR摘要另行复核。

最终范围只涉及deploy workflow、身份gate/policy/专属测试和运维/spec/本收据；不改AI agents、模型、引用校验、数据源、
ID、业务schema、迁移、依赖或评测集。按实际diff及eval-gate适用路径判断，AI eval不适用；A1不执行本次部署入口，
不调用付费模型，不拿无关A1/跳过章冒充质量证据，现有hooks/CI不弱化。

## 仍缺条件、下一步授权与失败处置

继续阻塞：安全回退精确对象及实际修复/闭包/数据兼容；当前生产版本/配置/合格备份/容量证据；
全writer任务准入停止与有界drain（含进程内任务、queued/claimed/expired lease）；跨部署/恢复/备份的维护互斥；
SSM终态未知的持久隔离与人工解除；operator/值守负责人/reviewer/批准人实名联络及响应时限。
未来解锁PR须恢复原配置presence/P1 dormant保护，逐阶段失败演练，不得仅删halt、填布尔值或改用手工部署。
不要求或宣布TD-09完整历史恢复已完成，不解除运维§6.1.2的恢复启动阻塞，不关闭TD-19或宣称全系统安全通过。

下一专项先限目标/命令/窗口授权只读核前置：当前生产对象及三服务身份、只读schema/迁移范围、合格备份manifest/hash/容量、
必要配置presence/权限与私有保全位置、在途及真实维护操作覆盖。此列表不是生产访问授权；命令必须逐条审阅。
随后独立PR实现并验证安全回退/维护协议，再申请覆盖probe/stop/backup/migrate/record/switch/失败处置的部署专项授权；
部署后实际对象与修复范围验收另授权。避16:50–17:30UTC，与恢复/备份及其他部署串行。

本切片失败：工作流失败，生产保持原状态，无rollback执行；不要因为旧服务health正常解除安全阻塞。
未来stop后失败：仅执行已批准且已验证数据兼容的安全回退，不自动恢复DB/逆迁移；无法证明或启动失败则writer保持停止、
保留获授权的外部限制，立即交指定值守负责人。批准单先接受持续停机及人工接管风险，health恢复仍待独立安全验收。
