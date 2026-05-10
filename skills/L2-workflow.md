# L2 — 流程层 (Workflow)

> 在 IPD 不同阶段，Claude Code 的行为约束。

## Concept 阶段

- 优先文档对齐，不写代码
- 每个新假设要落到 `docs/concept/charter.md` 的「关键假设」
- 范围外需求显式记入「不做什么」

## Plan 阶段

- 新功能必须先有 `docs/plan/specs/<feature>.md`
- 架构变更先更新 `architecture.md`，再写代码
- 重大选型走 ADR (`docs/develop/decisions.md`)

## Develop 阶段

- 改动前确认对应 spec 的 AC
- 跨层调用遵守：`src/app` → `src/lib/agents` → `src/lib/sources`
- 不要绕过 `lib/sources/` 直接调外部 API

## Verify 阶段

- 任何 AI 输出变更需跑 eval
- 回归用例失败不得合并
- 性能 / 成本变化需在 PR 中标注

## 跨阶段通用

- 任何"临时方案"必须留 TODO + 截止条件
- 实验性代码放 `experiments/`（如有），不进 `src/`
