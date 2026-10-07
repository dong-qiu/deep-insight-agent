# TD-04 通知数值配置：本地工程收据

对应 [spec](../plan/specs/td04-notification-config.md)。基线为
`81dac77cd27f82d7b554694bf0a12cd82cd0920b`；最终受审 head/PR/tested merge/main CI
由协调者在独立 review 和 CI 后增量登记。本收据不是合入、上线或 TD-04 整体关闭。

## 实际路径与兼容边界

- `sendEmail → smtpPort → nodemailer.createTransport`：缺失/空白/数值 0 保留 465；
  安全整数 1–65535 保留原 Number 转换，465 TLS 推断不变。非法值在 transport 前拒绝。
- `notify → alertTimeoutMs → buildAlertRequest → sendAlert → AbortSignal.timeout/fetch`：
  缺失/空白/数值 0 保留 5000；安全整数 1–2147483647 才进入 Node timer。
  直接 `sendAlert` 参数与默认不变。
- getter 每次消费读取，import 不读两个字段；未配置通知继续 no-op。`notify` 的
  同步 catch、`notifyEmail` 的异步 catch 保留 best-effort；错误不回显配置原值。
- 两个 NaN 配置从静默回退改为消费前拒绝；危险非零值不进入通知 transport。
  原 D2 的 `ALERT_TIMEOUT_MS=0 → 5000` 用例、渠道 fixture、全部 D2 文件零修改。
  原邮件 timeout 参数、收件人 DB 优先策略与报告发布白名单零修改。

## 保护反例与验证

先新增专属测试，在原消费代码上执行：48 项中 **17 fail / 31 pass**。
失败覆盖非法端口仍创建 transport、NaN 静默回退，以及非法 timer 被传入
`AbortSignal.timeout`；保留的安全默认与动态读取等用例通过。原日志保全，
不把预期红当修复后的结果。

实现后真实 facade/消费者反例包括：undefined/空白/-0/0.0/0x0 默认、正整数
上下边界、指数/十六进制/两端空白格式、NaN/Infinity/负值/小数/超范围/不安全
整数、运行期改 env、未配置渠道叠加非法值、配置拒绝早于 IO、通知错误不外抛、
import 期不读取配置。SMTP/fetch/DB/logger mock 仅隔离副作用，实际发送前代码
执行；不证明真实通知供应商送达或模型质量。

| 本地检查 | 结果与绑定 |
| --- | --- |
| 专属 notification-config + 原 email/alert/D2 baseline/D2 boundary/numeric-env | 6 文件、261 项通过，0 skip；专属 48 项 |
| `npm run typecheck` | TS7 与 TS6，app/tools 均通过 |
| `npm run lint` | 全库通过；测试最终类型标注改动后再次执行四个受影响文件 lint 通过 |
| `git diff --check` | 通过 |

第一次 typecheck 暴露专属测试 Proxy 的 TS7053 索引类型缺口；添加
`NodeJS.ProcessEnv` 类型标注后重新运行上述 6 文件测试及双类型检查通过。
原失败日志和该轮测试文件分别保留，不覆盖原件。

没有改动模型/prompt/validator/来源/评测口径；Eval 不适用，未调用模型，
不预签 Eval-Gate skip。无路由、构建或部署改动，未单独运行本地 build/HTTP；
后续正常 CI 门仍须通过。独立 Reviewer 结论及精确 CI 尚待协调者登记。

## 证据与剩余范围

私有根目录：`/Users/dongqiu/.local/share/insight-agent/evidence/td04-notification-20261008/`。
`index.json` 绑定最终提交、测试源码/hash、原基线源码、完整本地日志、命令/结果
及专属文档；协调者核验其 size/hash 和 0700/0600 权限。索引 hash 由最终交接提供，
原材料不入 Git。独立 worktree 保留，文件写入归属 Agent B，未经交接不接手。

本切片只补两个通知字段。spec 盘点的来源、选择、followup、调度/熔断、并发等
配置仍需逐字段分析，不宣称全局注册或全量启动预检完成；TD-04 整体部分完成。
该剩余盘点属于工程待办/待确认语义范围，不能一律归入预算或生产授权阻塞。
未修改批准 policy、safe_rollback、hold 或 #435 生产硬阻断，未生产访问或部署。
