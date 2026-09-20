# Volcengine Responses Provider（原型）

- 状态：实施完成，生产准入待 canary / A1
- 关联：ADR-0031、`eval-gate`、`docs/verify/eval-criteria.md`

## 目标

在不弱化报告引用校验的前提下，使 Insight Agent 可以通过 Volcengine Coding Plan 的 OpenAI Responses
endpoint 运行 analyzer、validator 与 coverage 三个独立模型。此规格只覆盖 provider 边界和评测证据；
不授权把内部 A1 原型结论升级为 DCP 或对外发布。

## 配置契约

```dotenv
LLM_PROVIDER=volcengine-responses
LLM_API_KEY=<Coding Plan key>
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
ANALYZER_MODEL=glm-5.3
VALIDATOR_MODEL=deepseek-v4-pro
COVERAGE_MODEL=kimi-k3
VALIDATOR_THINKING=0
COVERAGE_THINKING=0
```

`ANALYZER_MODEL`、`VALIDATOR_MODEL`、`COVERAGE_MODEL` 必须彼此不同。模型只是待测配置示例，
不是质量结论。缺少 `LLM_API_KEY` 或 `LLM_BASE_URL` 时，Volcengine provider 必须在任何网络请求之前
失败；不得回退或转发 `ANTHROPIC_API_KEY`。

`anthropic` 保持默认 provider，并可继续从 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 读取旧配置。

## 验收标准

1. `LLM_PROVIDER` 缺失时行为与既有 Anthropic 路径兼容；未知 provider 明确报错。
2. Volcengine 请求只发往 `${LLM_BASE_URL}/responses`，使用 Bearer `LLM_API_KEY`，且请求采用
   forced function call；模型输出仍由原有 Zod schema 校验。HTTP 错误日志不得回显上游 body。
3. 被 provider 返回但缺少/损坏 function 参数的响应，必须在 Zod 门失败，同时保留 usage、成本和
   telemetry；不得把已付费失败静默成零成本。
4. 未核实价格的模型成本必须标 `estimated`；写入 `cost_ledger` 时为
   `amount_minor=NULL, cost_status=unknown`，不能作为已知成本聚合。
5. A1 EvalConfig 必须记录 provider、endpoint SHA-256 和 transport version；任一项变化使历史
   baseline 不可比。
6. `npm run eval:canary-thinking` 必须以当前 provider 实际调用同一结构化路径。它只证明小请求的
   协议/模型兼容；完整 A1 才评估质量，且目前 v2 原型仍不满足正式 baseline/DCP 准入条件。

## 非目标与风险

- 初版不实现 Responses SSE：在真实 Coding Plan account 对事件序列通过 canary 前，不能猜测流事件格式。
  `LLM_TIMEOUT_MS` 为非流式请求保留硬中止。
- 不在代码内写入火山产品价目或 API key；价格须以实际订阅/控制台为准。
- 不改变 analyzer、validator、coverage 的提示词、引用白名单或报告发布 fail-closed 语义。
