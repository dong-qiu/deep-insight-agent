# C4b / D7：双格式测试适配收据

2026-10-07。本切片仅交付测试兼容性，不重启已收口的 C4b 恢复优化，不承接 TD-14 / #431 性能诊断。
验收依据：[D7 S2 spec](../plan/specs/d7-s2-id-capacity.md)、[C4b spec](../plan/specs/c4b-a1-recovery-performance.md)。

## 基线、交接与归属

- 重新 fetch 后基线为 `41270a7aa02d3880d96fcd6ba7f9a2cbb54a3b99`；分支 `test/c4b-d7-dual-format-20261007`，独立 linked worktree `insight-agent-c4b-d7-tests`。
- 评审期间 #431 合入，最新 main 推进到 `75c189d883a701943ad0308a07ba4f4542d878be`；正常 rebase 无冲突。该提交改变恢复身份/helper/runner/fixture，本切片重新运行组合回归与类型检查：原四文件加 `evals/run-a1-attempt-diagnostics.test.ts`，5 文件 62/62 通过，双 TS app/tools、定向 lint、收据检查与 diff 检查再次通过；前面的启动基线及红证据不改写。
- 指定旧交接路径已不存在。仓库外 `insight-agent-handoffs/d7-s2-closeout-2026-10-07/README.md` 的后续清理记录说明交接包已迁至此处，旧 worktree 已由此前获授权的 Session 移除。本任务没有操作或清理其他 worktree。
- 先读 README、C4b-session、SHA256SUMS；`shasum -a 256 -c SHA256SUMS` 两项均 OK。限定补丁 SHA-256 为 `071ca8ae1b2d73629095e559d22a4b7ec4c337f57f06a8d0c5dc8738a3d0074a`，独立阅读确认只含 `evals/c4b-recovery-measurement.test.ts`。
- 在本 worktree 对该补丁运行 `git apply --check` 通过；实际编辑使用 `apply_patch`，没有整批 cherry-pick 或覆盖旧文件快照。旧候选 `e59b304e64b5730646adf843ae42e38f7bb8a68e` 的测试结果仅为历史材料。
- D7 原 Session 的 C4b-session 明确释放此处正则和反例。另核对活跃 TD-14、Brief、证据 Session 最新状态，以及 #431/#433 实际 PR 文件列表、TD-14 专属 spec、Brief 第一/二波独占文件表和全部 linked worktree 的目标文件状态/分支差异，未观察到新增重叠。这个结论来自现行范围记录与状态的交叉核对，不是“分支干净即释放”的推断，也不宣称其他 Session 释放整个 eval 窗口。
- 测试夹具自建临时合成输入，子进程隔离环境并拒绝真实网络；本任务不需要本地凭据，没有复制 `.env.local`、数据、SQLite/WAL、原文或报告。

## 先失败、后适配

先只增加专属契约，保留 main 的旧正则，执行：

```bash
npx vitest run evals/c4b-recovery-measurement.test.ts -t 'D7 S2'
```

退出 1：新增 1 项失败，原 2 项按名称过滤跳过。旧规则把 32hex batch 替换为 `batch_0` 加 24 个残余 hex，32hex candidate 保持未映射；与旧格式对象的整体映射不相等。
失败时测试文件 SHA-256 为 `f0bda0500b44723a1ed2c4799daae27c9c5fd7304f007db20da20c131f780222`，本地失败日志 SHA-256 为 `df7181133c23f43090bea9c35d588522b0ebe59ce9b03d4a679bd304434e1794`；日志留在本 worktree 的 gitignored `.cache/c4b-d7/red.log`。

随后只替换一处正则：batch 的 32hex / 8hex、candidate 的 32hex / 8hex-3hex，长格式优先，分别保留 hex 和 hex/hyphen 尾部负向边界。
专属反例覆盖两格式整体等价、派生 insight/event 共根、混合格式有序双射与重复身份复用、同前缀不同末位的完整根、9/31/33/40hex 非法长度及 candidate 尾部 hex/hyphen 拒绝；非法值不进入映射表。
source commit、dirty fingerprint、恢复 digest、config 模型与参数分别变化时仍可区分，原值也保持逐字段相等。

最终测试文件 SHA-256：`640c783133ec9b9f3d5f1128bb8dfe2a235f2c6b0ea071f656681c44b53f75cc`。
原两项真实 runner 合成测试及其 hash 校验、派生 digest 重算、请求计数、读策略测量断言没有修改；没有开启 `C4B_MEASURE=1` 或建立新性能样本。

## 本地验证与质量门

最终测试字节上使用 Node `24.19.0` / npm `11.17.0` 干净安装依赖，lockfile 无改动。

| 检查 | 结果 |
| --- | --- |
| `npx vitest run evals/c4b-recovery-measurement.test.ts evals/a1-recovery-identity.test.ts evals/a1-quality-checkpoint.test.ts evals/run-a1-source-state.test.ts` | 4 文件、44/44 通过，含 C4b 原 2 项及新增 1 项 |
| `npm run typecheck` | TS7 / TS6，各 app / tools 均通过 |
| `npx eslint evals/c4b-recovery-measurement.test.ts --max-warnings=0` | 通过 |
| `git diff --check` | 通过 |

主 Agent 完整读取 [eval-gate](../../.agents/skills/eval-gate/SKILL.md) 与 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。
本次没有修改 AI 生成器、模型、prompt、校验、恢复源码、数据源、dataset、baseline、性能输入或判断口径；A1 不执行这个测试归一化函数，因此未运行实模型 A1 / prototype-safety，没有签 `Eval-Gate: pass/skip/scoped` 或设置 ACK。
正常 pre-push/CI 的确定性触发器不把此测试文件列为 AI 敏感路径；真实模型请求为 0。
定向 lint 与恢复回归覆盖实际风险。没有额外本地全仓 coverage 或 Next build；覆盖率配置度量 `src`，不度量本次测试 helper，完整 coverage/build/Docker 等由最终 PR CI 按仓库 scope 执行。

## 独立审查与交付身份

独立 reviewer 在新上下文读取最终 diff、spec 与恢复身份契约，独立复现启动基线上的四文件 44/44 通过；在隔离副本只还原旧正则并引用实际 helper，独立复现 1 failed / 2 skipped。两文件代码/收据审查 Blocking 0、Warning 0。rebase 到 `75c189d` 后独立重跑最低四文件 46/46 通过，新增 2 项来自 #431 诊断身份测试；没有混写为旧基线 44 项。PR 的最终 head、tested commit、run/attempt、CI artifacts 核验记录随 PR 交付。
本文件的测试 SHA-256 绑定上述本地验证字节；提交与 CI 身份以 PR 最终记录为准，不能用旧候选或旧 main CI 替代。

## 停止点与后续交接

到本次 PR / 精确候选 CI 核验完成即停止；没有合并、部署、生产访问、迁移、恢复、历史修复或分支/worktree 删除授权。
不关闭 TD-14 / TD-20 整体，不声明真实模型质量、费用、整体提速或生产效果。D7 的[真模型申请](d7-s2-model-evaluation-proposal-2026-10-07.md)保持独立未执行。
S2b 接收方应从已交付的本切片测试版本开始，不再覆盖为旧候选文件；合入前可用 PR 精确 head 核对或限定取本测试提交，并重新绑定自己的验证身份。
回退本切片只会撤回测试双格式支持，不改变生产生成器或既有数据；不回退旧 C4b 安全保护。
