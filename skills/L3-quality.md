# L3 — 质量层 (Quality)

> 测试策略、代码评审与上线门槛。

## 测试要求

| 改动类型 | 强制最低测试 |
|---|---|
| 工具函数 (`lib/utils`) | 单元测试 |
| 数据源适配器 (`lib/sources`) | 集成测试 + 录制响应 |
| Agent 逻辑 (`lib/agents`) | 单元测试 + AI eval 用例 |
| API 路由 (`app/api`) | e2e |
| UI 组件 | 关键交互的 e2e |

## 代码评审清单

- [ ] 是否有对应 spec / ADR
- [ ] 是否新增数据源 → 是否在 `lib/sources/` 适配层
- [ ] 是否影响 prompt → 是否更新 eval
- [ ] 是否引入新依赖 → 评估安全 / 体积 / 维护性
- [ ] 是否有不必要的抽象（参考 L0 的简洁原则）

## AI 输出准入

详见 `docs/verify/eval-criteria.md`。任何修改 prompt / 模型 / 数据源的 PR 必须附上 eval 对比结果。

## 上线门槛

- [ ] CI 全绿
- [ ] eval 不低于基线
- [ ] 关键场景人工验收通过
