# D2 / TD-12 五模块范围调查与文档交付收据

调查日期：2026-10-05 UTC（本地 10-06 Asia/Shanghai）。基线 `origin/main` @
`92d684bb5dd1428058e07b6c8341b67e3ec074a8`；专属分支 `docs/d2-scope-disposition`。
验收对象为 [五模块候选处置文档](../plan/specs/d2-scope-disposition.md)，不包含实现或整体状态变更。

## 范围与隔离

只新增专属 spec 与本收据。主工作区、C4b、Brief、C1 等 worktree 的 status/branch delta 和
直接相关文档只读核对；没有收到 Session 交接回复，不据 Git 干净判断释放。
评审期间 C4b 从 `64f3656` + dirty 前进到已提交 `bd7519a`，复查仅 eval/spec 范围，
其未跟踪专属收据仍保留；候选文档已更新精确 commit/spec hash，不修改该工作区。
未修改 src、tests、schema/migration、模型/prompt/预算/引用、依赖、CI、roadmap/ADR/architecture。
独立 linked worktree 基于最新 main；只复制 gitignored `.env.local`，0600，已有 DB/DATA
设置改为本 worktree 的绝对隔离路径。无 DB、原文/报告或 `.env.development.local` 复制，无应用启动。
未访问生产、付费模型或完整 A1，不合并、部署、恢复、历史修复或分支清理。

## 证据与限制

现场 #414 mergeCommit 为 `92d684b`；精确 main push CI
[37330189460](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37330189460)
attempt 1 success，full application、full Docker 和必需汇总成功；
[镜像发布 37330921257](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37330921257) success。
仅核对 API 元数据与原 spec/收据，未重跑或重新归档 #414 全套产物；未核生产上线。

逐模块静态阅读核心函数、导入/调用方、测试及直接相关 spec/ADR。测试名定位表示“已有保护”，
不是“本轮运行通过”；尤其 report-gen 集成用例中 mockReturnValue 与 importActual 路径分开记录。
历史恢复工具不混称 Controller replay；Controller 的模型/本地 CAS/只读 ports 不代表外部集成。

推荐：D2-A/R/G 延期，D2-L/P 保留，本阶段新增必做为空。全部等待用户确认；
本阶段范围建议不改变 TD-12 部分完成，也不取消延期责任。
其他工作区快照/未跟踪 spec 可能继续变化，后续实施必须重新确认归属和输入/接口。
定性成本没有工时或性能测量；候选收益和外部正确性未获得证据处明确待确认。

## 本地验证

采用现有 `ops/ci-docs-check.mjs` 的 `checkDocuments` 检查两个普通文档的相对链接、Markdown
锚点、格式、标题和收据结构；再做新文件 diff 空白检查及范围核对。
初次仅检查 spec 时指向尚未创建的本收据，报 broken link；建立本收据后对最终两文件复查。
最终两文件 `checkDocuments` 通过（2 files）；`git diff --cached --check` 通过，
范围仅两文档。相对源文件行号存在，Brief commit-bound 三文档目标经
`git cat-file -e <commit>:<path>` 确认存在；GitHub API 未找到 Brief 本地 commit，
已将三个暂不可达远端链接改为本地 commit:path 定位并注明限制，C4b commit API 可达。
配置 ignored/0600 已确认，不输出其内容。
提交前对最终修正文档再次执行，不把该结果称代码验证。

仅文档改动不运行 typecheck、应用测试、build、Docker 或 A1；文档 Node 工具不需 npm ci。
执行环境 Node `v25.9.0`，不是仓库应用支持的 Node 24 验证；候选 docs CI 使用 workflow 环境。
不用应用测试或付费模型代证范围判断。Eval 不适用，未改 AI 质量面，不盖实现重构 skip 章。

## 独立审查

使用仓库 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)，
新上下文只读 reviewer 核查两文档完整候选，重点证据/建议、活跃文件重叠、可执行验收、
退出/重启、阶段与整体状态。独立预审通过：低风险，Blocking 0 / Warning 0 / Suggestion 0。
reviewer 自行执行两文档 `checkDocuments` 与 `git diff --check <基线>`，通过；
独立核对 #414 的合入时间/SHA、main CI attempt/jobs 与镜像发布 API 结果。
C4b 快照前进已修正复查；Brief 未推送 commit 的外链已改为本地定位并记录限制，无剩余重要分歧。

审查确认五模块调用/安全边界与源码吻合；真实 renderer 与 mock 的测试边界说明准确；
Brief/C1 候选契约没有冒称生产实施。五项均有可执行验收、窗口/交接、退出和重启条件，
不以文件长度要求拆分，全部推荐仍候选。reviewer 未改文件、未运行应用测试/模型/生产。
首次预审 spec SHA256：`6d80bb3d81c449fc82778f6eba1ac1c937219c87bab0c7cef14590928db9d838`。
后续仅将 Brief 不可达远端链接改为本地 commit:path，reviewer 定向复查通过内容。
定向复查发现本收据旧 hash 未同步的 Warning，已按实际字节修正；最终已审 spec SHA256：
`f25fa3b0472fca714e6f3395ca72deec960785b855fc691fe4d526905ca03a29`。
本收据随后仅填实际结论和上述身份修正；最终远端完整 diff 与 PR 摘要仍须独立复核。

## PR 交付与回退

遵守 [文档 PR 证据流程](../plan/specs/pr-delivery-evidence-workflow.md)。
首次提交前冻结完整 diff 并独立审查；正常 hooks 推送并建 Draft PR，创建后独立复核最终远端 diff。
候选 head/base/tested SHA、run/attempt、scope docs、必需 checks、scope artifact 身份/hash/到期和
计时追加 PR 摘要，不为补 CI URL 再改 head。本收据不提前填写尚不存在的候选 CI 成功或 main 合并结果。
文档 CI 只证明链接/结构等；应用/Docker skipped 不能称 full 验证，不生成原型发布证明。
Actions 原产物有期限，hash/摘要不等于长期保存全文。

回退通过普通文档 revert；无实现或数据需恢复。候选 PR/CI 完成后等待用户范围决定和单独合并授权。
