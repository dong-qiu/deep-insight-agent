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
失败；`LLM_BASE_URL` 只能是上述固定 HTTPS Coding Plan API root，或控制台签发的
`*.apigateway-cn-beijing.volceapi.com/v1` root／`.../v1/responses` 完整 HTTPS endpoint（不得有 userinfo、query
或 fragment）。适配器只在 URL 尚未以 `/responses` 结尾时追加该路径；不得回退或转发 `ANTHROPIC_API_KEY`。

`anthropic` 保持默认 provider，并可继续从 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 读取旧配置。

## 验收标准

1. `LLM_PROVIDER` 缺失时行为与既有 Anthropic 路径兼容；未知 provider 明确报错。
2. Volcengine 请求只发往 allowlist 中的 Coding Plan Responses endpoint（API root 时为 `${LLM_BASE_URL}/responses`，
   完整 endpoint 则原样使用），使用 Bearer `LLM_API_KEY`，且请求采用 forced function call；模型输出仍由原有 Zod
   schema 校验。HTTP 错误日志不得回显上游 body，任意其他 endpoint 必须在网络请求前被拒绝。
3. `response.completed` 后缺少整个 forced function-arguments final event 的响应，必须先保留 usage、
   成本和 protocol telemetry，再仅由 `LLM_TRANSIENT_RETRIES` 执行有界新请求；耗尽后 fail-closed，且
   不得再进入 validator 外层重试。event 已到达但参数缺失/损坏的响应仍须在 Zod 门失败；两种情况都不得
   把已付费失败静默成零成本。
4. 未核实价格的模型成本必须标 `estimated`；写入 `cost_ledger` 时为
   `amount_minor=NULL, cost_status=unknown`，不能作为已知成本聚合。
5. A1 EvalConfig 必须记录 provider、endpoint SHA-256 和 transport version；任一项变化使历史
   baseline 不可比。
6. `npm run eval:canary-thinking` 必须以当前 provider 实际调用同一结构化路径。它只证明小请求的
   协议/模型兼容；完整 A1 才评估质量，且目前 v2 原型仍不满足正式 baseline/DCP 准入条件。

## 非目标与风险

- Responses SSE 已在实际 Coding Plan account 上完成最小事件序列探测：适配器仅消费
  `response.function_call_arguments.done` 与 `response.completed`，缺任一最终事件即 fail-closed；支持标准 LF/CRLF
  帧界。若 gateway 在前一事件省略 function name，只能以 completed output 中**唯一**的预期 forced function
  call 绑定该 arguments-done 事件；不能回退信任任意 output。`response.function_call_arguments.done` 已出现但参数
  缺失/损坏时，仍保留 completed usage 后交给 Zod 门失败。SSE 的正式 `response.incomplete`、`response.failed`、
  `error` 事件与无终态 EOF 必须分开记录；前三者默认不可重试。无 `response.completed` 的 EOF，以及
  `response.completed` 已到达但缺少整个 forced function event 的协议缺口，可触发由 `LLM_TRANSIENT_RETRIES`
  限制（默认一次）的有界新请求重试；耗尽后不再交给 validator 外层重试。下一次必须重新取得完整终止事件与
  函数参数；不得接受、拼接或推断前一次残片。诊断只能保留终态枚举、
  是否收齐 `[DONE]`/函数参数和失败 HTTP status 等聚合信息；不得持久化 SSE data、原文、prompt、模型输出、endpoint、
  key 或 provider request id。
  `LLM_TIMEOUT_MS` 继续作为流式请求的硬中止；长输出稳定性仍须由 smoke/A1 证明。
- 不在代码内写入火山产品价目或 API key；价格须以实际订阅/控制台为准。
- 不改变 analyzer、validator、coverage 的提示词、引用白名单或报告发布 fail-closed 语义。
- `npm run eval:probe-volcengine-stream` 是传输诊断，不是 A1 或质量门。它经生产等价的
  `callStructured` 路径发送合成输入，默认每档三次（可用 `VOLCENGINE_STREAM_PROBE_ATTEMPTS=1..10`
  调整），只写入忽略目录中的聚合终态/HTTP/延迟信息；不发送原文，也不得被用作 baseline、DCP
  或发布准入证据。
