# C：证据与上线准备交付收据

## 范围、身份与文件归属

用户授权保存关键原始交付证据并制定安全修复上线准备计划；验收按本任务的五项完成标准。
启动 `git fetch origin main` 后精确基线 `473e2eeae119b600b63abd78ce886301bd882235`，与 D6 交接相同。
独立分支 `docs/evidence-release-readiness-20261007` 与 linked worktree，只新增本收据、
[归档索引](c-evidence-archive-index-2026-10-07.md)和 [上线准备清单](c-security-release-readiness-2026-10-07.md)。
不复制环境或数据；为遵守最低 typecheck 要求，在独立 worktree 安装依赖，没有业务数据库或模型调用。

共享 roadmap/ADR/总台账和历史验收正文保持原样；本收据交接其维护者引用，未代改其他 Session 文件。
D6 本阶段已收口，TD-19 整体保持未关闭：原始审计来源缺口与 D7 后续重核条件仍在。

## 证据与缺口

10 个选定 run / 12 个 attempt / 31 个现存关键原产物保存于仓库外私有持久目录，目录0700、文件0600。
原包 SHA-256 与 API digest 全部一致；内部 hash、身份、实际结果、逐项期限、来源、下载 UTC、日志与 Git tree 已核，
公开定位及封存 manifest hash 见索引。最终 #422/#427 的候选/main 分列，历史 failure 原样保留。

两个旧 D6 run 的 attempt 1 有 7 个日志所列 artifact ID 当前404，其中5个关键原包和2个附属dockerbuild；
本轮不可恢复原字节，已保存旧 attempt API/jobs/logs与404查询，不用后续attempt原包或重跑伪造历史。
原 AI reviewer 全会话未作为独立产物提供，PR 摘要仅保留其结论；C 独立 review 另行完成。
本次最小归档没有声称保存全部历史 Actions/P1扩展附件或异地副本，详见索引限制。

安全候选是 `4477412a3e2b1cb2764fb4357f2284e73952af67`，完整main CI37559263616与自动发布37559608396成功。
GHCR index digest `sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe`
与原发布日志、registry原字节/hash/header一致；amd64 manifest/config digest与revision逐级核验。
没有下载/运行全部发布镜像层，不能把CI另一次镜像构建的测试冒充该发布digest的执行或生产上线证明。
当前生产SHA/digest/native library/攻击路径、配置数据前置、安全回退镜像和负责人继续未知。

## 本地验证

- `git diff --check`、三份专属文档的链接/锚点/格式/收据结构检查：3/3通过。
- Node24.19.0/npm11.17.0 干净 `npm ci --no-audit --no-fund` 后 `npm run typecheck`：TS7/TS6 app/tools全部通过。
  首次安装误用了系统Node25.9.0/npm11.12.1，仅记录环境warning；随后在明确Node24 PATH下重新干净安装和验证。
  package/lockfile没有改动，不拿首次安装当规范环境证据。
- 归档核验脚本：31/31包digest相符，JSON身份与API/scope/上传日志一致，19个Git commit身份及PR/main对应tree已核。
  21份内部文件hash与原PR摘要声明一致，其余附件是本次新增逐项核验，摘要未声明不伪造背书。
- 本任务只有Markdown；未改变运行/AI/来源/schema/CI/package，Eval不适用，不运行付费模型或重新实施修复。

## 独立审查

使用仓库 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)，新上下文独立 reviewer。
最终审查结论与远端候选CI交接记录写本PR摘要；不会为补CI URL移动已冻结候选。
独立新上下文 `c_independent_review` 最终通过：风险中，Blocking0/Warning0未处理。
两处Warning已修正并定向复核：执行时批准digest阻断门缺口，以及8份reader warning原数值。
reviewer独立重算133个封存成员、31个包、38个内部成员、152个日志成员hash，核19个Git commit/tree和registry digest/revision链；
独立3/3文档检查及逐份未跟踪文档diff格式检查通过。此为文档审查通过，部署准入仍未满足。

## 停止点与回退

上线准备 A/B/C 分阶段制定；现有部署workflow含备份/迁移/写deployment record及自动恢复上一运行镜像，
不是只拉镜像的无副作用操作。批准digest执行阻断门缺口、安全回退缺口、workflow与手册稳定性观察差异、停止条件、负责人指定和专项授权已明确。
magicast最迟2026-11-05复查上游，之后至少每30天；退出补丁独立PR。
原magicast/source-map-js1.2.1/sharp0.35.4不得当安全回退。
文档回退走独立revert PR；不动数据或历史验收。避开16:50–17:30UTC，生产操作与其他Session维护串行。

本轮不访问生产、不部署、不恢复/迁移、不调用付费模型、不自动合并、不清理分支/worktree，也不关闭TD-19。
下一步只申请A生产只读核验专项授权；取得实际真值并补齐B前置后，实际部署及C部署后验收分别再授权。
