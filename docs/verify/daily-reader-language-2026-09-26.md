# 日报诊断与中文结论守卫验证

## 范围与历史结论

基于 `bc2071b`；实现规范见 [spec](../plan/specs/daily-reader-language-diagnostics.md)。
生产 2026-09-25 产业日报出现 14 候选全部被展示引用门拒绝；失败前未保存批次审计，
旧容器日志也已不可用，因此不能确认逐条语义拒绝、流式失败或预算不足各占多少。
本次不回填历史失败，不调整模型/预算，不重跑生产日报，不改生产环境配置。

修复包括失败/成功事件的脱敏诊断快照，以及原 claim 已被证据支持后的单次中文翻译与完整复审。
译文主审同时核验与原 claim 的事实等价；独立 Coverage 仍只接收 quote/locator。
既有 `statement`/quote/locator 保持原文，输出缓存版本为 25。

## 本地回归

- `npm test`：199 个文件、1,806 项 Vitest 测试通过；另 14 项 Node 运维测试通过。
- 最终哈希边界补丁后：analyzer、pipeline、reader-language、coverage-diagnostics、report-gen、
  pipeline-reportgen.integration 六文件 253 项测试通过。
- `npm run typecheck`（TS7 + TS6）、`git diff --check`：通过。
- 使用真实 analyzer→SQLite→buildReport 接线验证 reader hash、来源证据与 blocked 引用不能发布。
- 缓存 miss/全量全拒绝、部分候选后异常、租约丢失、敏感文本剔除、一次翻译、取消、超时、
  改换原事实/删除条件、翻译前后哈希均有回归。

## 真实模型证据

显式环境配置：`LLM_PROVIDER=volcengine-responses`，analyzer=`deepseek-v4-flash`，
validator=`deepseek-v4-pro` / thinking=0，coverage=`deepseek-v4.1-flash` / thinking=1 / maxTokens=2048。
运行命令分别为 `npm run eval:a1:prototype-safety` 和 `npx tsx evals/check-reader-language.ts`。

| 检查 | 本次结果 | 限制 |
|---|---|---|
| 原型安全首轮 `a1-20260926033349-ddcb2f84` | 不完整、exit 1；一次 Coverage Responses 流式请求未完成 | 不能作为通过证据；不是已证实的 token 不足 |
| 原型安全第二轮 `a1-20260926040124-5ae5d2fc` | 完整、exit 0；三分类 12/12；display unsafe 0/8、false reject 0/2；quote-only unsafe 0/4、false reject 0/4 | 1 主题/12 一致性对/10 display/8 quote-only；内部 smoke，非 DCP |
| 中文定向检查 | 2 个正例完成翻译；原始数值扩张未触发翻译；换事实、删条件均被 primary 拒绝 | 5 个人工构造测试，不代表真实日报整体质量 |

第二轮聚合收据：`evals/out/prototype-safety-receipts/a1-20260926040124-5ae5d2fc.json`。
manifest SHA-256：`83487aa9d479ed1ba87afb2ce0ac9be57a0fe44c631de39a93d9a849029124be`；
a1-run SHA-256：`00c8f5f71cdb294e5ca564c53bc4cf20fad1f40aaf29fa0a472008da2fa9f3b4`。
该轮在基线 commit 的脏工作区运行，之后仅补译文诊断哈希与测试，不改模型判定语义。
这是实现阶段证据，不能伪装为已部署版本的运行收据。

定向检查耗时 32.195 秒，31,042 tokens，保守估价约 $0.17175；安全第二轮估价 $0.6234。
这些模型无可核实的本地价目，金额均为 estimated，不是提供商账单。
正常中文/en/mixed 路径不增加调用；触发修复的候选至多增加一次翻译和两次完整复审调用
（共 5 次逻辑调用，底层传输恢复仍遵循原 provider 策略），翻译输出上限 1024、不启用 thinking。

`evals/baseline.json` 为其他模型/数据口径的旧基线，不可作本轮 Δpp 对照；不更新 baseline，
不声称非显然、人评、DCP 或来源许可通过。原型快速门依据 L3 / ADR-0032。

## Pre-PR AI Review

- 基线：`origin/main` @ `bc2071b24413d5c8e30f56babc50815271da9cb6`。
- 独立 reviewer 两轮，高风险；未读取配置、凭据或生产数据库。
- Blocking：无。首轮 P1“译文改换原事实仍可过门”已增加等价约束与真实模型反例；
  P2“失败时丢翻译阶段”已增加受控状态与源哈希。
- 第二轮剩余 P2“预检失败缺译文哈希”已补 `translated_draft_sha256`，并重跑上述 253 项测试和 typecheck；
  此最后补丁由主 agent 验证，不宣称第三轮独立 review。
- 实现提交：`ce0f68c`；[PR #352](https://github.com/dong-qiu/deep-insight-agent/pull/352)。
  PR 已补齐机器检查要求的风险摘要与指标表，明确基线不可比；等待 CI/最终 diff 复核。
  本记录不代表合入、部署或生产日报验收。

## 上线后验收

核实实际运行版本；避开 16:50–17:30 UTC，不覆盖 `.env.local`。观察一个真实日报周期：
中文结论、逐字原文、可达引用锚点和来源链接；若再次全部拒绝，读取该 trace 的
`analysis_coverage_diagnostics` revision 聚合原因。快照不是完整原文/LLM replay，硬杀进程或租约
丢失前来不及落盘的诊断仍可能缺失；不要将缺失解释为零拒绝。
