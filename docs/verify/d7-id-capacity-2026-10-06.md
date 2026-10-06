# D7 / TD-20 S1 验证收据

日期：2026-10-06。S1 五实体、六处生成表达式已实施；TD-20 为切片完成，S2 仍未处理。
验收：[D7 spec](../plan/specs/d7-id-capacity.md)；[ID审计与处置表](d7-id-capacity-audit-2026-10-06.md)。

## 基线、隔离与交接

首次 fetch/盘点基线 `1d8925f7559bc648a2be288f2e9977336a4e0d17`，
[main CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37340831376) success。
实施前 fetch 并 fast-forward 至 `4855d0c3eec26a7bc5ac6a74dee684b5f2c051f7`，
[精确主干 CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37392890817) success。
D3 #418 只新增专属测试、benchmark及证据，没有改变 S1 六处生产文件。
D2/C4b 本阶段收口，而 TD-12/TD-14 仍部分完成；未重复其实施，也不由 CI/镜像元数据推断生产上线。
旧基线的 scheduled A1 [37389721439](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37389721439) failure（A1 threshold/baseline step）；没有归因给本次尚未实施的改动，没有付费重跑或宣称其通过。

独立分支 `feat/d7-id-capacity`、linked worktree `/Users/dongqiu/Dev/code/insight-agent-d7`。
只复制 gitignored `.env.local`，权限0600；DB_PATH/DATA_DIR 改为本 worktree 隔离绝对路径。
没有复制 `.data`、SQLite/WAL、原文、报告或 `.env.development.local`，没有打开业务数据库。
只读核对 D3、Brief、C1 的 worktree/status/相关 diff 与脱敏线程元数据；未读会话正文或日志。
主工作区 Brief 的共享 decisions/roadmap 与四份专属未提交文档保持原样；D3 graph/analysis、Brief pipeline/reader、C1 schema/startup/恢复/删除/ops 均未改。
用户先确认 S1 范围，再明确确认六处生成表达式及专属新文件的工作交接并开通权限；此前仅专属文档、只读审计和不重叠测试。
没有可用的跨 Session 消息接口，未虚构其他窗口负责人直接确认。

## 实际变更与容量

| 实体 | 实际生成位置 | 保留行为 |
| --- | --- | --- |
| Run | runtime/jobs.ts / runBudgetedJob | existingRunId 原样复用；插入在业务前；retry_of、取消、预算、usage范围不变 |
| Report | agents/report-gen.ts / buildReport；db/reports.ts / saveFailedReport | 成功/失败同池；显式 input.id 不抽样；选择、白名单、发布effect和reader不变 |
| FollowupQA | reports/[id]/followup POST | answer 成功后才生成；thread_id同id；失败不分配或重跑模型 |
| TechLead | db/tech-leads.ts / upsertTechLeads | 只有 insert 抽样；canonical update 原ID、人工状态及引用复合绑定不变 |
| Opportunity | db/planning.ts / upsertTechnologyOpportunities | 原分配位置保留，每个有lead的candidate含update仍抽一次；update复用row.id及link |

新增 `utils/object-id.ts` 仅服务 `run/rep/fup/lead/opp` 联合前缀。
Node `randomBytes(16)` → 完整32位小写hex，含前缀总长36或37；128位随机量。
没有新依赖、schema/migration/DDL、reader正则或输入上限变化、碰撞重试或SQL错误吞并。
原 `UUID.slice(0,8)` 为32位；`slice(0,12)` 含连字符，仅44位；完整UUIDv4为122位随机量。
假设每个唯一键池独立均匀抽样，累计 n，`p≈1−exp(−n(n−1)/(2·2^b))`：
32位1万次≈1.157%、10万次≈68.781%；44位百万次≈2.802%；128位百万次≈1.47e-27、十亿次≈1.47e-21。
不是生产存量或增长预测，不承诺绝无碰撞；样本无重复不作为容量证明，PK/unique仍拒绝冲突。

## 先反例与分阶段证据

1. 未改生产源码时，`d7-id-compatibility.test.ts` 合成6/6通过：旧/长Report文件、index/FTS/prev；failed显式ID与unique；mixed Run/retry_of；QA/thread双向格式及FK；直接插入旧Lead/Opportunity后的canonical update；固定URL ContentItem与UUIDv5值。没有先生成再重编号。
2. `d7-id-generation.integration.test.ts` 旧实现12例：六生成表达式及真实发布长度断言共7个红，其余5绿。Lead fixture先修为实际Map/full ContentItem接口后重新跑，7个失败均是旧长度；没有通过改历史fixture掩盖问题。
3. 第一阶段替换 Run/QA/Lead/Opportunity，五个定向接线/冲突例通过；第二阶段替换成功/失败Report，全部18例绿。随后补完整字节、mixed reader列表、签名anchor与真实HTTP/C1 inventory。
4. 新测试的 DTO observed_at、opportunity_lead.added_at、manifest anchor_object_key 按真实类型/schema修正；没有改生产schema或放宽门。

| 风险场景 | 测试/路径与证据 |
| --- | --- |
| 新格式与真实随机源 | object-id.test.ts 5例完全不mock生产Node随机源；integration受控0..15字节精确编码、16bytes调用及六入口接线互补，不以样本唯一性签门 |
| 新旧读取与关联 | compatibility6例；integration真实Lead/Opportunity旧/新列表及详情API，精确citation与lead link；HTTP两个报告的双向邻接及QA/thread |
| 实际报告落盘/索引/通知/导出 | 真实runReportGen读取DB历史发生记录与validation→buildReport→saveReport→getReport，文件字节/index/effect/prev与新Run关联；通知仅mock外部投递，检查准确reportId；真实PPT导出buffer |
| 签名与产物 | 真实saveReport + Ed25519合成key + MemoryAnchorStore，长ID两份artifact manifest/object key及generation/anchor effects committed；没有S3/外部写入 |
| 唯一/FK/重试与失败 | 旧unique/FK错误拒绝；受控Run碰撞业务只执行一次；explicit failed保留；Followup transport失败不抽样/不落QA/不重试；既有canonical update次数不变 |
| 取消/预算/租约/用量与发布 | 专属真实runReportGen取消与fencing拒写；全仓原C2a/C2b/C3/provenance/report测试作为协议回归；未修改这些协议实现 |
| URL/认证/路径安全 | 新旧页面与QA GET匿名拒绝，真实NextAuth合成admin登录；不存在的完整ID与编码slash仍404；anchor traversal、slash、backslash、NUL反例仍拒绝；未放宽任何reader门 |
| C1清单/恢复关联边界 | ops/d7-id-backup.node-test.mjs 调用真实inspectBackup只读检查合成standaloneSQLite：旧/长报告md/html 4/4精确映射。未调用backup/restore、回滚或生产操作 |
| 历史与确定性身份 | 保留全部既有fixture；冻结contentItemId与UUIDv5；同报告输入正文相同、Followup真实system/user字符串相同、PPT inputs hash稳定；canonical/idempotency公式不变 |

所有测试使用独占合成DB/临时目录，只清理测试自建产物。HTTP新增服务从干净临时cwd运行真实Next build，仅显式合成env，避免加载worktree本地密钥；没有真实模型或外部通知调用。

## 验证、Eval-Gate 与独立审查

运行时固定 Node24.19.0/npm11.17.0。初次 npm ci干净安装，无lock变更。

| 检查 | 结果 |
| --- | --- |
| 专属单元/集成 | compatibility6 + generation15 + unmocked helper5，共26例通过；C1 inventory1例/4文件通过 |
| 全仓coverage/ops | 首轮261文件2751例、ops150，通过；覆盖率statements79.58%、branches72.02%、functions79.61%、lines83.46%。最终新增用例后完整复核通过：262文件2759例、ops151例（含C1 inventory） |
| 类型/lint | TS7/TS6 app/tools四项通过；lint通过；最终新增测试后四项typecheck与lint再次通过 |
| 实际构建/HTTP/D4 | 首轮build18631ms，1次；同一C5收据分别复用HTTP7文件8例、browser7例（含D4及D3保护），全部通过。最终源码固定后的候选commit再建立独立build收据；精确head/build_ms与built回归在PR留痕，绝不复用已过期identity |
| 方案review | 独立上下文初审4组Warning修复，定向复查Blocking0/Warning0 |
| 最终diff review | 独立新上下文读完整diff/untracked及spec：Blocking0/Warning0；独立Node24重跑专属25例（增签名anchor前）与C1 inventory通过；增补签名用例独立重跑1/1及文档定向复核通过：Blocking0/Warning0。最终PR候选复核另行留痕 |
| PR/最终候选CI | 已创建 [PR #419](https://github.com/dong-qiu/deep-insight-agent/pull/419)。精确head SHA、最终候选本地build/built、完整CI run链接/结论与独立PR复核在该PR留痕，作为本收据的交付组成部分；本文件提交时CI仍待核验，未预签通过 |

使用 [eval-gate](../../.agents/skills/eval-gate/SKILL.md) 与 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。
最终改动不改变Analyzer/Validator/coverage/prompt/模型/数据源/判断规则，也不改语义event/insight身份。
报告自身ID不进入渲染正文；Followup在回答后分配QA，reportId不同但同内容的实际system/user相同；PPT缓存输入hash保持不变，报告ID只用于归属与确定性页脚。
因此未运行A1：它不执行本次改动路径；按skill跑真实报告接线及相关回归，并在完成后盖 `Eval-Gate: scoped`。
这是仓库可见路径与请求字节的结论，不声称已测真实模型输出；没有付费模型调用。

本地 Docker daemon 未运行，未启动或修改其环境；容器构建和容器协议门交由最终候选 CI 核验，不能以本地 Next build 替代。

## 未覆盖范围与回退边界

- S2 Topic/Source自动ID、Analyzer candidate/batch/派生Insight/event容量仍在，尤其Source/event进入模型输入与A1归一化/恢复身份；须另确认方案及模型范围/预算，TD-20不能整体关闭。
- 确定性截断摘要、Controller FNV32、provider格式、旧eval/temp身份等审计列项保留；没有全量第三方解析器或外部已下载报告兼容证据，也没有生产存量实测。
- MemoryAnchorStore不证明S3/KMS/外部签名恢复可用；只读inventory不证明完整备份或恢复点。没有生产部署/回退/恢复实验。
- 旧生成器源码上的长ID合成消费6例、未修改reader与新旧HTTP/关联证明可读性；回退生成器仍须沿D1/发布契约评估正在执行任务与部署版本，且会重新引入短ID容量风险。不能只写“revert即可”。不删除或改写已生成的新数据、ID、URL、文件、外键或报告正文，不改migration/checksum/ledger。
- 分支/worktree保留。任务到PR和最终候选CI完成即停止；不合并、不部署，不将合入或CI视为生产上线。
