# D6 / TD-19 统一证据台账与差异清单

快照：2026-10-06，Asia/Shanghai；GitHub 查询时间见 D6 收据。启动基线为 `6eabc5f671073c377200f7551daf8a143d333989`；后续核对/交付基线 `origin/main` @ `86d824fd5fbe12006679a02cebcc877f71493f73`。
本文件是证据索引与状态解释，不是新状态平台、生产运行证明或实施授权。首次快照/精确历史绑定保留；2026-10-07 的交接与供应链变化见文末追加记录及 [续核收据](d6-followup-2026-10-07.md)。

## 来源与归属核对

- 原编号与验收要求沿用 [治理实施计划](../plan/specs/technical-debt-remediation.md)；原表保持不变。未找到独立“原始 20 项审计全文”，不能声称已逐字核对原始审计；获得原件后须补核。
- 旧并行计划仅位于 `insight-agent-refactor-plan`，HEAD `7342576d2560e6fc7d5af1b116459af521da35a6`，并非本轮主干事实源。其“C2–C5/D1–D7 未启动、下一项 C5”已过期；未整分支合入，也未改它。
- 主 worktree 为 `docs/brief-information-density-plan` @ `21414ab702282a5fc3645cea15afe26f1e042c07`，roadmap/decisions 修改及四份 Brief 专属未跟踪文档仍由原 Session 保留。Brief density worktree 有专属收据修改；没有复制这些内容。
- 本机有多个 Codex Session 进程，cwd 均不能唯一映射文件负责人；没有跨 Session 交接消息证据。D7 worktree @ `f5ea93b951848e26518c92335aa53ec856125ad8` 干净不证明会话结束。
- 首次交付时用户仅交接 README、operations、technical-debt-remediation、L2-workflow、architecture 的本轮修订，roadmap/ADR/Brief 未交接。2026-10-07 追加交接 roadmap/ADR 的状态注记，基于 main 在 D6 worktree 修订；主 worktree 未提交内容与 Brief 不改；其他 worktree 不操作、不清理。另见 source-map audit worktree 的 lockfile 修改不归入 D6；初查未提交变化不作主干证据，后续已由 GitHub #420/精确 main CI 核实合入与验证。

## 差异清单与本轮处理

| 类别 | 差异与依据 | 处理/剩余 |
| --- | --- | --- |
| 可直接修正 | 总入口未集中列 C2–D7 已合入范围；D4 主干收口仍要求读者自行寻找 | 治理计划增加本台账入口及实际状态；保留旧验收表和专属收据 |
| 可直接修正 | D2/C4b/D3 不能记整体完成 | 明确 #414/#416、#415/#417、#418 的阶段收口与部分完成；未保留 D3 生产优化 |
| 可直接修正 | D7 #419 候选成功，但其合入后 main CI 失败；后续独立 #420 已修复 | 原失败绑定精确 SHA/run，#420 主干成功单列；不推断 ID 实现缺陷，不用后续run改写原run |
| 可直接修正 | README 称所有 PR 均须 Docker 构建，且 snapshot/restore 合并为“导出或恢复” | 按实际白名单解释 docs/full；分开输出写入与破坏性恢复，标明本地隔离用途 |
| 可直接修正 | 主 worktree 旧基线的 L2 仍推荐 SSM+rsync；最新 main 已修正为不可变镜像，但 trigger 补跑/SSM 访问的副作用与授权标签不足 | 以最新 main 为事实源，补已有实例/完整证据/读取与写入标签；旧 rsync 内容属于旧基线，不重复宣称本轮修复它 |
| 可直接修正 | operations 在 KNOWN GAP 后仍写旧 replay 退出成功即可启动；冷备代码块仍像推荐恢复命令 | 将旧参数/启动序列标为历史诊断、不作执行入口；保留阻塞与契约链接，不以改参数修复 |
| 可直接修正 | architecture CI/CD 顺序含真实 eval 抽样，与实际 CI 分离策略不符 | 按 workflows 区分确定性 CI、docs/full、单独真模型 eval 和生产部署 |
| 可直接修正 | architecture 成本表仍列 quota/cost_daily/停止cron，备份设计目标写成已实施 | 对齐 C2b/C3 实际 Run/attempt 口径，备份旧目标显式标历史计划并指 C1，未虚构全局费用上界或生产恢复 |
| 可直接修正 | 独立review发现operations残留replay成功可启动、裸compose配置生效、日/月账单/重置表述冲突 | 移除当前恢复放行序列，配置生效指§8固定镜像；明确已落盘兼容估价、日/月各自UTC窗和C2b opt-in边界 |
| 需文件交接 | roadmap M4 仍记 deploy.yml SSH/待 secrets、deploy.sh 首发、早期备份 DR 已闭合；M5 未注明 P1 休眠边界 | 建议只给历史 M4 段加时间语境并指当前 §8/C1；当前 M5 指向 dormant re-entry。2026-10-07 交接后已补独立当前入口注记，历史段保留；不代交 Brief 内容 |
| 需文件交接 | ADR 是历史决定与当前补充的集合，不能批量改写旧决定或带入 Brief 未提交新增 ADR | 2026-10-07 交接后已补 ADR-0017/0026/0037/0038 当前证据注记，历史决定正文不改，Brief 未提交决定不代交 |
| 需范围/状态决定 | TD-04 全局配置注册、TD-10 未接线任务、D7 S2 尚未验收 | 不关闭整体；未来分别确定范围/接口/负责人，涉及模型的部分另需模型预算授权 |
| 需范围/状态决定 | D2 五模块曾是建议；已有 2026-10-06 用户“确认采纳” | 仅采纳已有决定：A/R/G 延期、L/P 保留、本阶段新增必做为空；不新增整体关闭决定 |
| 缺证据保留未知 | 当前生产 revision、C1 完整生产恢复、A1 当前模型耗时/费用/吞吐、D3 生产/冷缓存/并发/HTTP/browser P95 | 本轮禁止生产访问/付费请求；历史证据保留日期，不以健康或 CI 替代 |
| 缺证据保留未知 | 原始技术债审计全文、Actions 长期原产物 | 原审计未定位；本轮核验 PR/main 元数据与专属收据，未重新归档所有旧原 JSON；摘要/hash 不能冒充永久完整产物 |
| 工具后续事项 | cost-backfill 默认预览但以可写 Database 打开；db:snapshot 覆盖旧输出且缺生产拒绝门；db:restore 提示旧 replay | 文档标注实际风险；独立后续实现任务处理，不在 D6 顺手修复 |

## 状态口径与生产边界

“切片完成”仅指专属已确认范围；“本阶段收口”允许保留/延期；“整体完成”须满足原验收或明确已确认的范围决定。
“生产已验证”只指记录日期的实际 revision/镜像及对应业务核验。表中“未核当前生产”适用于全部项目；本轮没有生产访问。
本地/PR CI/main push CI/GHCR/生产分开：下表的证据编号指精确合入与 main CI，专属收据及 PR 最终摘要补充本地/候选/生产层。
旧收据写“CI 待验证/未合入”是提交前时点，保留原文；下方最终证据索引才是当前交付层，不重跑历史 workflow。

## TD-01 至 TD-20

| 编号 / 切片 | 本轮/切片状态；整体状态 | 实际完成范围与证据 | 未完成、保留、warning/未证明 | 下一步/重启；生产证据 |
| --- | --- | --- | --- | --- |
| TD-01 / A2 | 已核；原失败边界完成，D1 后保持 | 初始化成功后发布、失败关闭/可重试；E359/E411；[A 收据](technical-debt-foundation-2026-09-27.md) | 初始化并不证明生产恢复；历史 migration 不重写 | 入口/初始化变更时回归；2026-09-28 A 发布收据是历史生产证据，当前未知 |
| TD-02 / B4 | 已核；本阶段关闭（既有 reader 契约） | reader 门、历史快照例外、集合/API/人工浏览器；E366/E368/E370；[B4 收据](b4-evidence-reader-visibility-2026-09-28.md) | 浏览器端 P95 未测；历史快照通过不代替当前原文 | reader/可见性改变时重核；2026-09-29 生产集合/HTTPS P95/人工验收有记录，当前未知 |
| TD-03 / B1a/B1b | 已核；认证保护已完成 | 登录限速、旧会话撤销、#409 退出迟到保护；E361/E362/E409；[B1a](auth-login-throttle-2026-09-27.md)/[B1b](auth-session-revocation-2026-09-28.md)、#362 最终发布回执 | 旧库/回退须 AUTH_SECRET 轮换；生产未改真实用户造全矩阵 | 认证/恢复改动重核；B1a/B1b 历史生产登录/旧 cookie 拒绝有记录，#409 当前生产未证明 |
| TD-04 / A3+C4a | 已核；部分完成 | 六个危险数值及 chunk 参数、有效配置启动采样；E359/E399；[C4a](c4a-eval-observability-2026-10-03.md) | 全局配置注册/全量启动预检未完成；动态 getter 与加载常量时机保留 | 单独确认剩余配置范围后实施；A3 历史生产核验，C4a 当前生产未证明 |
| TD-05 / A1测试入口 | 已核；完成 | test/coverage 递归 ops 清单、失败/空集拒绝、tools TS 范围；E359；[A 收据](technical-debt-foundation-2026-09-27.md) | JS 未被误称严格 TS；不证明模型质量 | 新测试目录/入口变更时复核；验证设施无需新生产部署 |
| TD-06 / B3报告维护 | 已核；本阶段完成 | 四个报告工具独立快照预览、--apply 拒绝；E364；[B3](ops-write-boundary-2026-09-28.md) | 同报告版本化修复未实现；成本回填不在此切片 | 如需版本化修复另立 spec；历史生产仅核入口代码/运行版，未做生产历史修复 |
| TD-07 / B3生产入口 | 已核；旧路径封闭/当前入口完成 | deploy.sh 拒绝、已有实例唯一不可变镜像入口；E364；[B3 spec](../plan/specs/ops-write-boundary.md) | 空主机 bootstrap、旧 migrate-db.sh 空卷保护仍未完成 | 空主机/数据迁移另立任务；历史 B3 生产部署有回执，当前未知 |
| TD-08 / B2 | 已核；已确认应用诊断/构建范围完成 | logger/Run/API/告警摘要与 Docker 允许列表；E363；[B2](information-boundary-2026-09-28.md)、#363 发布回执 | 框架 stdout、任意无标记自由文本、历史泄露清理未保证；不称全系统安全通过 | 新出口/构建输入需回归；2026-09-28 生产版/镜像核验有记录，当前未知 |
| TD-09 / C1 | 已核；部分完成，不关闭 | 备份/选择性 DR、WAL 修复、候选调查、合成核心/持久登记/新鲜度锚、真实报告删除边界；E378/E379/E387–E395；[生产备份](c1-backup-production-2026-10-01.md)、[分层契约](../plan/specs/recovery-time-coverage.md) | 全量快照 incomplete；生产 issuer/独立单调存储、历史覆盖基线、全部 writer 闸门、可信采样、CLI全调用方/启动收据、同镜像 HTTP/auth/恢复矩阵未证明；reader warning 保留 | 有新备份线索才重搜；后续工程/生产另授权。2026-10-01 机制观察有记录，#394/#395 合入不证明生产部署或完整恢复 |
| TD-10 / C2a+C2b | 两切片主干完成；整体部分完成 | generation signal/deadline/lease loss、opt-in task cap、真实 dispatch/retry/sticky 预算守卫；E406/E412；[C2a](c2a-task-cancellation-2026-10-04.md)/[C2b](c2b-task-budget-2026-10-05.md) | 默认无任务 deadline；独立 followup/collection/无Job eval 未全接；未知费用不作零、无 reservation/跨worker全局账单上界，在途仍可计费 | 先确认剩余入口/严格预算范围与交接；当前生产接线/额度未核，镜像非上线 |
| TD-11 / D1 | 已核；已确认 D1 整体完成 | connection/migrations/startup 职责、readonly 零写、历史 checksum、显式 CLI/controller 保留边界；E411/E413；[D1](d1-database-lifecycle-2026-10-05.md) | CLI/controller 保留入口是兼容边界，不冒称恢复已完成 | 入口/schema变更重核，相关共享文件仍串行交接；当前生产版本未核 |
| TD-12 / D2 | alert 首切片完成/阶段范围收口；整体部分 | E414/E416；[alert 收据](d2-alert-channel-extraction-2026-10-05.md)/[范围收据](d2-scope-disposition-2026-10-05.md) | 已采纳 A/R/G 延期、L/P 保留；helper依赖、provider时序、发布/统一投影、bundle/TTL 风险仍在，五模块不是已重构 | 第二消费者/可复现维护故障/契约稳定且取得交接时重开对应项；当前生产未核 |
| TD-13 / C3 | 已核；已确认 Job 最小持久用量契约完成 | per observable fetch attempt、unknown/partial/reported、幂等/不可变、v48/重启、只读分页；E410；[C3](c3-model-usage-persistence-2026-10-04.md) | 非Job followup/eval/direct SDK 未记录；provider未返回用量不可知，retention/业务UI待后续；这些不等于承诺完整账单 | 接入新入口/增长需独立范围及容量方案；当前生产迁移/使用状态未核，不因Run/attempt/P1相加闭合费用 |
| TD-14 / C4a+C4b | 观测与零付费恢复切片收口；整体部分 | E399/E415/E417；[C4a](c4a-eval-observability-2026-10-03.md)/[C4b](c4b-a1-recovery-performance-2026-10-05.md)；只证明恢复源读取 2→1/局部合成收益 | 整体A1提速、真实模型耗时/费用/吞吐/attempt P95 未证明；C4a不含模块加载/最后发布I/O；reader warning 不消失 | 固定输入/配置/次数/硬请求及重试上限/预算授权后测真实模型；当前生产效果未核 |
| TD-15 / D3 | 首轮测量/取舍收口；整体部分 | E418；[D3](d3-reader-performance-2026-10-06.md)：查询减少但reader P50约8–9%未达10%标准，候选撤回 | 无保留生产优化/分页/索引；其余热点、生产分布/并发/物理冷缓存/HTTP/browser性能未证明；P0c warning 保留 | 先细分测量匹配/归档/SQL，范围/接口确认后优化；本切片生产代码不变，无新上线效果 |
| TD-16 / D4 | 已核；最小 Chromium smoke 完成 | E409/E404；续核E426补图谱effect同步，原断言保留；[D4](d4-browser-smoke-2026-10-04.md)：真实登录/退出、引用展开/空态、图切换/复位、窄屏 | Firefox/WebKit/全业务/生产矩阵和browser P95未测；早期退出缺陷/偶发记录保留 | 关键交互改动重跑受影响 smoke；无需生产部署，不与B4人工验收混称 |
| TD-17 / C5 | 已核；原单作业内重复构建验收关闭 | E396/E397；[C5](c5-ci-build-reuse-2026-10-03.md)：build一次、built额外0、身份/过期拒绝、Docker保留 | 不同runner/cache时长不是受控加速比例/P95；Docker独立build不是重复应用E2E | 构建输入/复用入口变更重核；验证设施无需生产部署 |
| TD-18 / D5 | 已核；已确认 D5 主干验收关闭 | E398/E403；[D5](d5-build-dependency-convergence-2026-10-03.md)：esbuild直依赖、Node24 types、可重复安装及退出登记 | 双编译器/vendor/Node major ignore 保留；最迟2026-11-02复查；当时audit0非永久安全，#420声明依赖、E423内联副本、E426 sharp修复分列；后续安全公告仍须复查 | 按原退出条件及新依赖PR复查，不自动移除补丁；D5无需生产部署，新安全修复非D6授权 |
| TD-19 / D6 | 本轮文档修订/评审/PR验收另见收据；整体未关闭 | [D6 spec](../plan/specs/d6-documentation-evidence.md)及[收据](d6-documentation-evidence-2026-10-06.md)，当前五入口修订、20项台账 | roadmap/ADR注记已追加交接并修订，独立复核/新候选CI待核；原始审计缺口、D7后续复核保留；本台账非未来自动同步 | 核对新候选与后续主干证据；D7后续交付重核；原始审计获得后补核；不访问生产 |
| TD-20 / D7 | S1 已合入，候选通过，后续#420主干覆盖成功；整体部分 | E419；[S1收据](d7-id-capacity-2026-10-06.md)/[审计](d7-id-capacity-audit-2026-10-06.md)：Run/Report/QA/Lead/Opportunity六生成表达式128位，旧ID/URL/FK保留 | S2 Topic/Source/Analyzer/batch/派生Insight/event未处理；外部解析器/已下载产物/真实存量/生产回退未证明；原#419 main供应链失败保留，#420修复后main成功另列 | 核对专属最终收口，S2另确认范围/模型预算/交接；未证明生产上线，不能整体完成 |

## C1、warning 与休眠停止点

C1 2026-10-01 的历史缺口计数属于当时盘点，不是本轮重测：387 个规范路径缺文件、6 个空引用、10 份缺失报告。
已知备份搜索按负责人确认停止；候选内容相符不等于历史字节认证，不减掉尚未恢复的4个新增候选，不重抓/补签/改历史行。
机制、合成恢复及全量生产恢复按 [历史处置](../plan/specs/historical-recovery-disposition.md) 分层，任何部分通过均不放行旧 CLI 或生产 writer。

性能 warning 与独立代码 review Warning 是两类记录。C4b main 的 reader P95 增量 0.053853ms/约30.77%，D3 main 增量 0.0521002ms/约23.71%，
以及 C1 #394 的相对 reader warning 继续保留；各自未同时突破原双门，不能写“无性能风险”。这些值引自各专属收据/最终 PR 摘要，不是本轮重测，也不归因于本切片。
工具和候选 CI 的历史失败原样保留；不通过重跑旧 workflow 消除它们。

P1 继续 [dormant](../plan/p1-dormant-reentry.md)，取消的旧任务不重开，D6 不将旧治理 runbook 变成当前待执行队列。
未来先建立 scoped parent task/验收/负责人，P1-dev 仅隔离合成数据；任何生产启用仍需独立 INSI-25 治理证据、ADR及容器准入。
P0/no-op 与生产外部 seam fail-closed 不因文档同步、CI P1 保护门或 C1 合成锚而改变。

## 当前静态工具风险索引

以下只静态读取脚本与 package/workflow；本轮没有执行表内命令。完整当前手册见 [operations](../launch/operations.md)，不能从表名推断生产授权。

| 入口 | 默认行为/写入 | 环境、前置与有效使用边界 |
| --- | --- | --- |
| seed / db:migrate | 实际初始化/DDL/写入；无预览 | 独立本地库；生产显式迁移仅受控发布流程，单独授权 |
| db:snapshot | 只读源库，写输出；已有黄金快照被删除后替换 | 隔离本地；先核DB_PATH/SNAPSHOT_PATH与输出归属；不是DB+raw/report恢复包，缺生产拒绝门另记后续 |
| db:restore | 实际复制/删DB及WAL/SHM；已有库默认拒绝，--force覆盖 | 破坏性本地操作；production/provenance显式拒绝；须目标核实及授权，不作生产恢复 |
| backup-db / db:backup | 实际写备份/清单并轮转删除合格旧备份 | 受控备份；不是预览，完整性不证明删除覆盖或可启动 |
| backup-integrity --backup-dir | 读取已有standalone备份；不改DB/raw/report | 限定静止备份，拒WAL/SHM；本地complete不证明恢复许可 |
| c1-candidate-audit | 只读快照/候选，独占新建0600私有输出 | 必须清单/hash/静止库；非“完全零写入”，不认证历史字节 |
| a1-status.ts | 只读给定manifest/progress，无.env/DB/模型 | 本地可读产物；缺字段未知、completed≠质量/可比通过 |
| 旧报告四工具 | 独立快照默认只读预览，--apply永远拒绝 | REPORT_SNAPSHOT_DB_PATH静止/独立/standalone；不能活动DB、符号/硬链接别名；新报告经正常发布协议 |
| cost-backfill | 默认业务行预览，但可写DB打开，可创建空库；--apply改Run/audit | 先用隔离副本核读写目标；实际修复另授权，金额只是历史估价；默认不应标严格只读诊断 |
| Deploy Production Image | 实际SSM/备份/迁移/切换/记录/健康检查 | 已初始化实例+可信main完整证据/固定镜像+维护/回退准备+审批，避16:50–17:30UTC；D6不执行 |
| deploy.sh / migrate-db.sh | deploy.sh固定拒绝；旧migrate-db存在未闭合保护风险 | 不作为部署/空卷bootstrap推荐入口；不得借旧脚本绕当前流程 |
| redaction:replay / --restore-time | 旧runner读取外部登记并写恢复库；无安全恢复许可 | KNOWN GAP仍在，不能以退出0启动；新协议尚未生产接线，同镜像矩阵未完成 |
| branches:cleanup | 默认Git/GitHub只读预览；--apply移除合格worktree/分支 | 合入/必要部署核验、文件归属及干净/未锁定/非当前；D6连预览也未执行 |
| p0:observe / probe-alert / trigger / eval:a1 | observe读生产；alert实际通知；trigger写任务/可调用模型；A1实际付费及写产物 | 只读生产也需本任务授权；各类副作用不能混为诊断，D6均未执行 |

## 精确合入与主干 CI 索引

下表由 GitHub PR mergeCommit 与可信 CI workflow 的 main push 元数据逐项匹配；前38组按首次基线 `86d824f` 核祖先，续核E423/E426按最新基线 `5539ec1` 核祖先，历史绑定不改写。
每行有精确40位SHA与run/attempt；“full”表示所选完整应用/Docker路径，“docs”表示文档路径，正常 skipped 不是应用失败。
本轮未重新跑这些作业、未重归档所有历史原JSON，旧收据与最终PR摘要的产物/hash/期限继续为专属证据。
PR链接的最终交付摘要/评论补充提交前收据的时间语境；不拿其他main run代替当前行。

| 证据 / PR | 精确合入 SHA | 合入时间 UTC | main CI / attempt / conclusion | 路径 |
| --- | --- | --- | --- | --- |
| E359 / [#359](https://github.com/dong-qiu/deep-insight-agent/pull/359) | `5f8efa0da00e5658182c659dbfdc728c7f7f832c` | 2026-09-27T15:14:07Z | [36328803794](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36328803794) / 1 / success | full |
| E361 / [#361](https://github.com/dong-qiu/deep-insight-agent/pull/361) | `1ebd9461bffc6912bb4200cc6afac45d8b444213` | 2026-09-27T16:14:51Z | [36332521815](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36332521815) / 1 / success | full |
| E362 / [#362](https://github.com/dong-qiu/deep-insight-agent/pull/362) | `a8865ecf98a0287521a2474996c9863125ebee26` | 2026-09-27T17:04:43Z | [36335585374](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36335585374) / 1 / success | full |
| E363 / [#363](https://github.com/dong-qiu/deep-insight-agent/pull/363) | `0467a433b33bce5bc4763de0a946e7d4198afb97` | 2026-09-28T00:12:07Z | [36361315834](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36361315834) / 1 / success | full |
| E364 / [#364](https://github.com/dong-qiu/deep-insight-agent/pull/364) | `a582ed32c8a4ef0db91b82c1012f93c95ea0a40e` | 2026-09-28T02:43:40Z | [36370925992](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36370925992) / 1 / success | full |
| E366 / [#366](https://github.com/dong-qiu/deep-insight-agent/pull/366) | `8ac46eadbfde1c32aac74e294bd2b1088c06b5e1` | 2026-09-28T13:57:09Z | [36432320032](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36432320032) / 1 / success | full |
| E368 / [#368](https://github.com/dong-qiu/deep-insight-agent/pull/368) | `9995afe16063cb38db394201c63f5ed569f5f57b` | 2026-09-28T16:48:47Z | [36453730741](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36453730741) / 1 / success | full |
| E370 / [#370](https://github.com/dong-qiu/deep-insight-agent/pull/370) | `a44a2e903c520ae8f26f7560dd10a82ca2e5fb4b` | 2026-09-28T19:11:57Z | [36470555916](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36470555916) / 1 / success | full |
| E378 / [#378](https://github.com/dong-qiu/deep-insight-agent/pull/378) | `4becf54d4ba9a350865841bcbce08d57eafc296a` | 2026-09-29T14:41:07Z | [36584510750](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36584510750) / 1 / success | full |
| E379 / [#379](https://github.com/dong-qiu/deep-insight-agent/pull/379) | `31900542afa66524976bddac14b5452042d73cf3` | 2026-09-29T17:50:12Z | [36607755995](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36607755995) / 1 / success | full |
| E387 / [#387](https://github.com/dong-qiu/deep-insight-agent/pull/387) | `735927d4282fb2e457b3d555f1948a1986ce0b6b` | 2026-10-02T14:22:58Z | [37019474293](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37019474293) / 1 / success | full |
| E388 / [#388](https://github.com/dong-qiu/deep-insight-agent/pull/388) | `d66883df1198398a84b2e365334707ef6fbc13c9` | 2026-10-02T14:49:51Z | [37022627952](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37022627952) / 2 / success | full |
| E389 / [#389](https://github.com/dong-qiu/deep-insight-agent/pull/389) | `adf0420af1eb46c983f521b2b818e85823bdc0af` | 2026-10-02T15:04:06Z | [37024336995](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37024336995) / 1 / success | full |
| E390 / [#390](https://github.com/dong-qiu/deep-insight-agent/pull/390) | `59ba8ccb5e453fffd0e78cd6855d715eb02ff76c` | 2026-10-02T15:22:56Z | [37026579419](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37026579419) / 1 / success | full |
| E391 / [#391](https://github.com/dong-qiu/deep-insight-agent/pull/391) | `1f1559e282b2733b6d0f8aa98728fe8a9c295c85` | 2026-10-02T19:50:45Z | [37056753716](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37056753716) / 1 / success | full |
| E392 / [#392](https://github.com/dong-qiu/deep-insight-agent/pull/392) | `e5ff54d0a818136500d55561accf30f5ae0068c4` | 2026-10-03T09:24:27Z | [37112944712](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37112944712) / 1 / success | full |
| E393 / [#393](https://github.com/dong-qiu/deep-insight-agent/pull/393) | `b199bc0381a1ebd2b50fde0e68819e0b884a4383` | 2026-10-03T10:34:47Z | [37116876365](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37116876365) / 1 / success | full |
| E394 / [#394](https://github.com/dong-qiu/deep-insight-agent/pull/394) | `0a965a807216e50a64ec53fdf296010b5859608e` | 2026-10-03T12:36:19Z | [37123412287](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37123412287) / 1 / success | full |
| E395 / [#395](https://github.com/dong-qiu/deep-insight-agent/pull/395) | `bbd827688f9d9d8073bfecc596ffbf4742a4b83b` | 2026-10-03T13:03:45Z | [37124916833](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37124916833) / 1 / success | full |
| E396 / [#396](https://github.com/dong-qiu/deep-insight-agent/pull/396) | `8723db8500fc265eefa951e288eb2d143468b6ff` | 2026-10-03T14:42:04Z | [37130548182](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37130548182) / 1 / success | full |
| E397 / [#397](https://github.com/dong-qiu/deep-insight-agent/pull/397) | `1c40eac4ebd018cce4874d75332ed3f8dc97cabf` | 2026-10-03T14:57:04Z | [37131477845](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37131477845) / 1 / success | full |
| E398 / [#398](https://github.com/dong-qiu/deep-insight-agent/pull/398) | `254aada6e72d90c736e3dde75378ceb9bf2ae27a` | 2026-10-03T15:52:00Z | [37134757999](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37134757999) / 1 / success | full |
| E399 / [#399](https://github.com/dong-qiu/deep-insight-agent/pull/399) | `065dd0cf7a8f06d4becd093da2f133fc552ce201` | 2026-10-03T16:30:06Z | [37137081561](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37137081561) / 1 / success | full |
| E403 / [#403](https://github.com/dong-qiu/deep-insight-agent/pull/403) | `6cdb3df331591fddc84cc3864128b4fb8562e85f` | 2026-10-03T16:11:35Z | [37135945754](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37135945754) / 1 / success | full |
| E404 / [#404](https://github.com/dong-qiu/deep-insight-agent/pull/404) | `142b1e38c0f07d0ff67d80611c2681a5ef11ffc8` | 2026-10-04T09:34:28Z | [37192597531](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37192597531) / 1 / success | full |
| E406 / [#406](https://github.com/dong-qiu/deep-insight-agent/pull/406) | `8a96b862894cbb65fdfd64f301469ad1ba37cdb4` | 2026-10-04T01:20:23Z | [37167709112](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37167709112) / 1 / success | full |
| E409 / [#409](https://github.com/dong-qiu/deep-insight-agent/pull/409) | `823b6d875ceecc66dc35ff4ef37a8699aadbec17` | 2026-10-04T08:58:55Z | [37190666460](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37190666460) / 1 / success | full |
| E410 / [#410](https://github.com/dong-qiu/deep-insight-agent/pull/410) | `c7648986d96e040dcad8c7e6dd01e75759c2bbee` | 2026-10-04T15:32:53Z | [37213415190](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37213415190) / 1 / success | full |
| E411 / [#411](https://github.com/dong-qiu/deep-insight-agent/pull/411) | `4e09ec93923a0d7bece2b282045a18c98eb3a1c8` | 2026-10-04T17:15:48Z | [37219844193](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37219844193) / 1 / success | full |
| E412 / [#412](https://github.com/dong-qiu/deep-insight-agent/pull/412) | `2bb91519a20cea09fdc387bcab0917728e28cdc4` | 2026-10-05T14:12:29Z | [37322850784](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37322850784) / 1 / success | full |
| E413 / [#413](https://github.com/dong-qiu/deep-insight-agent/pull/413) | `64f365682c2a6a4ffa6198f3bb4c57d1e1ab589c` | 2026-10-05T14:21:40Z | [37324076876](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37324076876) / 1 / success | docs |
| E414 / [#414](https://github.com/dong-qiu/deep-insight-agent/pull/414) | `92d684bb5dd1428058e07b6c8341b67e3ec074a8` | 2026-10-05T15:07:09Z | [37330189460](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37330189460) / 1 / success | full |
| E415 / [#415](https://github.com/dong-qiu/deep-insight-agent/pull/415) | `5e90ff49a93c269ac801acbc4560b28ccb186e6c` | 2026-10-05T16:01:30Z | [37337558444](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37337558444) / 1 / success | full |
| E416 / [#416](https://github.com/dong-qiu/deep-insight-agent/pull/416) | `057f265b8df67f22a312ecebafabbb6ee8f2cba1` | 2026-10-05T16:17:48Z | [37339733574](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37339733574) / 1 / success | docs |
| E417 / [#417](https://github.com/dong-qiu/deep-insight-agent/pull/417) | `1d8925f7559bc648a2be288f2e9977336a4e0d17` | 2026-10-05T16:26:15Z | [37340831376](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37340831376) / 1 / success | docs |
| E418 / [#418](https://github.com/dong-qiu/deep-insight-agent/pull/418) | `4855d0c3eec26a7bc5ac6a74dee684b5f2c051f7` | 2026-10-06T00:13:49Z | [37392890817](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37392890817) / 1 / success | full |
| E419 / [#419](https://github.com/dong-qiu/deep-insight-agent/pull/419) | `6eabc5f671073c377200f7551daf8a143d333989` | 2026-10-06T08:42:35Z | [37437928802](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37437928802) / 1 / failure | full |
| E420 / [#420](https://github.com/dong-qiu/deep-insight-agent/pull/420) | `86d824fd5fbe12006679a02cebcc877f71493f73` | 2026-10-06T11:48:30Z | [37458872550](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37458872550) / 1 / success | full |
| E423 / [#423](https://github.com/dong-qiu/deep-insight-agent/pull/423) | `b407b9e61915c33f835966f8f760f3424f0e17f5` | 2026-10-06T17:11:28Z | [37501620737](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737) / 1 / failure | full |
| E426 / [#426](https://github.com/dong-qiu/deep-insight-agent/pull/426) | `5539ec136ca8a087f190670332bae87db5bfdbbe` | 2026-10-06T17:26:21Z | [37503548677](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37503548677) / 1 / success | full |

## D7 交付快照及重核条件

#419 于 `2026-10-06T08:42:35Z` 合入上方基线。候选 `f5ea93b951848e26518c92335aa53ec856125ad8` 的
[PR CI 37397114703](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37397114703)成功，
[最终候选/独立评审回执](https://github.com/dong-qiu/deep-insight-agent/pull/419#issuecomment-6007209673)只证明该候选。
精确 main [37437928802](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37437928802) attempt 1 为 failure：
`npm audit (all deps, high+ blocking)` 报 source-map-js 高危 GHSA-68fv-2mgg-jv7q；完整 Docker 成功，应用汇总失败。
这是实际供应链失败，不能归为 docs-only 正常 skipped，也不据此推断 D7 ID 逻辑失败；D6 不升级依赖或重跑它。
后续独立 [#420](https://github.com/dong-qiu/deep-insight-agent/pull/420) 于 `2026-10-06T11:48:30Z` 合入 `86d824fd5fbe12006679a02cebcc877f71493f73`，仅更新 source-map-js lock entry。
其精确 [main CI 37458872550](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37458872550) / attempt1 / push / full success，完整应用、Docker和必需门均成功；该后续版本包含D7，补充后续主干覆盖证据，但不把原#419失败改成成功。
D6自有工作区正常 fast-forward 同步该main，无其他Session文件提交或实现改动。后续元数据更新写入完成时间 `2026-10-06T12:00:41Z`（仅GitHub元数据，没有生产访问）。
本节保留首轮快照；续核已确认S1最终PR回执，未来S2新交付与主干状态变化后继续核台账/共享入口。后续证据见文末，不据CI关闭TD-20/D6整体或推断生产上线。


## 2026-10-07 追加交接与供应链现场快照

现场读取时间 `2026-10-06T17:17:20Z`（Asia/Shanghai 为 2026-10-07），最新 main 为 `b407b9e61915c33f835966f8f760f3424f0e17f5`。
用户确认 sharp/graph-smoke 修复仍由原 Session 交付，D6 只核验证据；其未提交文件不是已交付证据，不复制或代交。
用户另交接 roadmap/ADR 的本轮状态注记；D6 基于已合入 main 添加当前入口及时间语境，不改历史 M4/DCP/ADR 正文，不提交主 worktree 的未提交内容或 Brief。

- [#423](https://github.com/dong-qiu/deep-insight-agent/pull/423) 于 `2026-10-06T17:11:28Z` 合入精确 SHA `b407b9e61915c33f835966f8f760f3424f0e17f5`，
  [spec](../plan/specs/source-map-js-security.md)/[专属收据](source-map-js-security-2026-10-06.md)交付 magicast 内联 source-map-js 的独立 vendor 修复。
  原 #420 声明依赖修复与 #423 内联副本修复是两层范围；#420 当时 main audit 成功不证明内联副本已安全。
- 该 SHA 精确 [main CI 37501620737](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737) / attempt 1 / push / full 为 **failure**：
  Docker及其汇总成功，应用在 high+ audit 报 sharp/librsvg GHSA-wq5f-xc86-pv6w 与 next 连带条目失败，应用必需汇总失败；docs正常 skipped。
  不以 #423 候选 CI 37461293268 的历史 success 替代该 main 失败，也不据此声称 source-map 修复失败或已上线。
- D6 首次候选 `fdbef987d113847100f0e1f01b90136edc294557` 的 [CI 37460791666](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37460791666)
  attempt 1 图谱 smoke 预期4节点、收到2，6/7通过；attempt 2 browser 7/7通过，但随后同一 sharp 审计失败。
  首次图谱失败根因仍未知；reader P0c attempt 2 增量 `0.04510096ms`/约32.35% warning、双门passed，非生产/browser性能证明。
  完整身份/产物及独立复核保留在 [#422 最终交付摘要](https://github.com/dong-qiu/deep-insight-agent/pull/422)，不改写首次提交前收据或冒称应用全绿。
- TD-18 的原 D5 验收保持历史关闭；本次供应链修复单独核 main/候选与 vendor 维护边界，不等于新的整体安全认证。
  TD-16 的历史最小 smoke 验收保持，新增图谱可靠性问题需独立证据；重跑一次通过不是已修复。
- D7 的 [S1 最终候选/独立评审回执](https://github.com/dong-qiu/deep-insight-agent/pull/419#issuecomment-6007209673)已核实，只收口五实体六生成表达式；
  S2 及当前生产状态仍未知。后续包含 S1 的主干验证按其实际时间和 SHA追加，不改原 #419 失败。

D6 原候选 CI 验收未通过；本轮新交接修订须再次独立审查与新候选 CI。准备续核时原Session已创建 [#426](https://github.com/dong-qiu/deep-insight-agent/pull/426)，冻结候选 `7278d0bc64e23986534254e486304eccd0c28b68`、base `b407b9e61915c33f835966f8f760f3424f0e17f5`，当时CI仍运行；后续实际交付如下。
TD-19 原始审计来源缺口及未来 D7 交付后再核仍保留；P1继续 dormant。本记录不授权合并、部署或生产访问。


### #426 实际交付与后续主干覆盖

[#426候选 CI37502578190](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37502578190) / attempt1 / full success，
tested merge `3e4a662254f70e070941a582defb018666ce3831` 的tree与候选完全相同，parent为上述base/head。
应用、Docker、必需汇总与audit0/browser7/7实际通过；scope/app/Docker原JSON身份与API相同，原ZIP digest/hash/期限分别核验，候选证据一致性独立复核B0/W0/S0。
reader候选warning为增量 `0.04995632ms`/约26.318%，双门passed，不能写成生产性能改善或所有warning消失。

原Session的交付实际于 `2026-10-06T17:26:21Z` 合入 `5539ec136ca8a087f190670332bae87db5bfdbbe`。
精确 [main CI37503548677](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37503548677) / attempt1 / push / full success；
完整应用与Docker、三个必需入口均成功，audit0、browser7/7，docs正常skipped。
main scope/app/Docker证明的head/tested/run/attempt与API一致，checks全pass；main readerwarning增量 `0.05573856ms`/约26.840%，双门passed。
原产物的JSON hash/API digest/期限保留在PR交付摘要；不混用候选与main产物，不冒充永久归档或生产修复证明。
#423 vendor与#426依赖/test同步均由原Session交付，D6没有代写实现、测试或执行合并，仅正常集成已合入main；D6相对该base仍只有文档。

该成功main包含D7 S1，补充后续主干覆盖，仍不改原#419/#423失败；S1最终回执已核，S2和生产状态仍未证明。
#426交付客户端effect就绪检查及渲染值断言；原D6首轮失败没有完整trace，不能宣称其现场根因已逐步认证或全浏览器可靠性通过。
新D6候选须基于此main重新冻结、独立复核和CI验收；原审计来源缺口及未来D7交付重核保持。


### 主干推进后的集成边界

另一Session的 [#360](https://github.com/dong-qiu/deep-insight-agent/pull/360) 于 `2026-10-06T17:39:15Z` 合入 `1bf16e4bb75e9fb04dcc70f9d15ccbdc14b5bb24`，含已提交roadmap/ADR更新。
D6正常集成此main，保留其已提交内容，相对新base仍仅11文档；主worktree未提交内容没有复制或代交。
Brief当前导航沿用其 [收口入口](../plan/pre-rich-brief-closeout.md)，不从旧任务首批步骤重启已收口诊断或模型实验，不冒称S1收益/未来产品已验收。
本轮仅核与文件归属及导航直接相关的摘要/共享差异，不代替该35文件交付的完整业务或模型审查；#360自身PR/main证据仍沿其交付记录。
新候选须核实际base/head/tested/run身份；先前基线5539的CI不替代该新基线候选，所有先前结果保留时间语境。
