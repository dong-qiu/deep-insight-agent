# TD-04：通知数值配置消费前校验

基线：fetch 后 `origin/main=81dac77cd27f82d7b554694bf0a12cd82cd0920b`。
本切片只收紧两个可导致端口错误或 Node 定时器异常的配置，不关闭 TD-04 整体。

## 范围与归属

执行 Agent B 独占 `src/lib/runtime/email.ts`、`alert.ts` 的两个数值读取点；新增
`notification-config.ts`、专属测试及本 spec/verify。不修改 `env.ts`、
`alert-channels.ts`、模型、prompt、validator、来源、schema、dispatch、followup、
维护接线或主台账。独立 worktree/DB/DATA、端口 3117；不发送真实通知。

## 冻结契约（协调者已确认）

| 配置 | 缺失默认 | 显式有效值 | 消费路径与时机 |
| --- | --- | --- | --- |
| `SMTP_PORT` | 465 | 安全整数 1–65535 | `sendEmail` 每次调用，在 `createTransport` 前读取；465 保留 `secure:true`，其他端口保留 false |
| `ALERT_TIMEOUT_MS` | 5000 | 安全整数 1–2147483647 | 已配置 webhook 的 `notify` 每次调用，在构造请求/fetch 前读取 |

保留 `Number(raw)` 对合法表示的转换（含两端空白、指数及十六进制合法整数），
不因格式增加限制。缺失、空串、纯空白及数值 0（含 -0、0.0、0x0）继续原
`Number(...) || default` 的安全回退。非数字、非有限数、负数、小数、非安全整数或
超范围拒绝；错误复用 `RuntimeConfigError`，只包含字段与范围，不回显原值。
NaN 从旧静默回退改为明确拒绝；其余非法非零值不再进入 transport/timer。
原 D2 wiring 的 `ALERT_TIMEOUT_MS=0 → 5000`、渠道 fixture、身份基线及保护测试
均保留，不重新生成或移植其历史证据。这一通知兼容边界区别于旧六字段严格
拒绝空白/0 的规则，不改旧 `numericEnv` helper。

getter 在消费时读取 `process.env`；import 期不读取或拒绝配置。这里的预检是
**通知发送启动前**，不新增全应用启动检查。未配置 webhook 时 `notify` 仍 no-op；
未满足 SMTP_HOST/收件人/发件人时 `notifyEmail` 仍 no-op，非法端口不触发发送。
`notify` 的既有 catch 与 `notifyEmail` 的异步 catch 继续 best-effort，通知配置
错误不向上抛、不影响已经落库的报告。直接 `sendEmail` 拒绝非法配置且不创建
transport。直接 `sendAlert` 的 timeout 参数及默认 5000、邮件发送 timeout 参数
及默认 10000 不变。不改变渠道、格式、收件人优先级或通知启用条件。

## 有界盘点及剩余工程

盘点仅来自本基线 `src/lib`/`src/app` 数值 env 消费点，不声称全配置穷尽。

| 尚需逐字段分析的配置 | 原消费模块/时机 | 本轮处置 |
| --- | --- | --- |
| RSS_MAX_ITEMS、ARXIV_MIN_INTERVAL_MS | sources/rss、arxiv；模块加载 | 来源范围，后续工程，保留原默认及加载时机 |
| ANALYZE_BATCH_CHARS、CONSISTENCY_WINDOW_CHARS | analyzer、validator；模块加载 | AI/校验范围，需另行确认，不能并入本切片 |
| FOLLOWUP_MAX_CITATIONS、FOLLOWUP_SOURCE_EXCERPT_MAX、FOLLOWUP_RATE_LIMIT | followup agent/API；模块加载 | 与独立接线相关，串行后续工程 |
| PIPELINE_WINDOW_HOURS、PIPELINE_ITEMS_PER_TOPIC、INITIAL_DIGEST_WINDOW_HOURS/ITEMS、DEEP_DIVE_WINDOW_HOURS/ITEMS | scheduler/brief API；调用时（部分显式 opts 优先） | 选择语义范围，后续工程 |
| ARTICLE_FETCH_MAX_PER_RUN、SOURCE_PROBE_MAX_PER_RUN、SOURCE_PROBE_TIMEOUT_MS、SOURCE_ZERO_YIELD_ROUNDS、SOURCE_CIRCUIT_FAILS/DAYS | collector/source-health/run-stats；调用时 | 来源/熔断范围，后续工程 |
| STALENESS_REALERT_HOURS、GENERATION_DISPATCH_REALERT_HOURS | staleness/dispatch-health；调用时 | 独立告警或 A3 重叠，后续工程 |
| PPT_POLISH_CONCURRENCY | ppt-polish；调用时 | 模型并发，后续工程 |

已有有限性/范围保护（如 runtime/env 数值 getter、预算 parser、staleness 首次阈值、
orphan stale、brief freshness、consistency batch/cache）不凭 `Number(...)` 命中重写。
上述清单是工程待办/待逐字段评估，不能统称预算阻塞，也不自动判为安全漏洞。

## 验收、退出与回退

先加保护用例，再改两个真实消费点。测试必须执行 `sendEmail`、`notifyEmail`、
`notify`：缺失/空白/0 默认、两端边界、合法格式、动态 env 变更；非法值在 transport/fetch
前拒绝；未配置渠道叠加非法值仍 no-op；通知入口保留 best-effort，错误不回显
敏感样例；模块 import 不触发配置拒绝。SMTP/mock fetch 只证明控制协议，不证明
真实供应商送达或模型质量。

运行专属测试及原 email/alert/D2 boundary+baseline/numeric-env 测试、双 TypeScript typecheck、lint；
CI 按原正常门执行。本切片无路由/构建/部署变化，不用 A1 冒充通知路径回归。
Blocking 未解、消费路径未执行或原契约反例失败则不合并；调整范围先回协调者。
回退为正常 feature PR revert；不修改线上配置、不部署、不解除 #435 生产硬阻断，
不把工程合入记为上线。最终证据绑定受审 head、tested merge、精确 main CI。
