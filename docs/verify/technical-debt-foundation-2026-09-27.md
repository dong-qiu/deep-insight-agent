# 技术债治理第一批：测试入口、数据库初始化与数值配置

日期：2026-09-27。基线：`origin/main` @ `21414ab702282a5fc3645cea15afe26f1e042c07`。
分支：`fix/tech-debt-foundation`。

## 变更摘要

- 落地 [20 项分批实施计划](../plan/specs/technical-debt-remediation.md)，本批仅实施 A1/A2/A3。
- `test` / `test:coverage` 共用 Node 运维测试自动发现入口，补上 gen-env、forward observation、branch cleanup 等测试。
- 双 TypeScript 检查纳入 ops/tests。由此发现的 S3 重载返回类型误用改为 `GetObjectCommandOutput`，前后转译 JavaScript 完全相同。
- `getDb` 完成全部初始化后才发布单例，失败关闭临时连接；`openDb` 的自身初始化失败也释放连接。
- 6 项危险数值配置拒绝非法值；`chunkWindows` 保护显式 size 参数，合法输入算法保持不变。

## 验证

环境：隔离 worktree；Node `24.19.0`。未复制 `.data` 或 live SQLite，未调用付费模型或生产服务。

| 命令 / 实验 | 结果 |
|---|---|
| 新增 DB 反例在修复前运行 | 5/5 失败：连续 guard 拒绝被绕过、失败连接未关闭、修正配置后仍返回旧连接 |
| 修复后的 10 文件定向回归 | 329 tests 通过，涵盖初始化、迁移、部署、env、Analyzer、Validator、LLM |
| `npm run test:coverage` | 212 个 Vitest 文件，2,142 tests 通过；随后实际运行 Node 运维测试 23/23 通过 |
| 覆盖率 | statements 76.48%、branches 69.03%、functions 76.75%、lines 80.38%，现有阈值未调整 |
| `npm run typecheck` | TS7、TS6 均通过，包含新纳入的 ops/tests |
| `npm run lint` | 通过 |
| `npm run build` | 通过；存在仓库已有 middleware → proxy 弃用提示，本批未迁移 |
| `npx vitest run --config vitest.e2e.config.ts` | 复用刚构建的应用，3 文件 / 3 tests 通过；分别使用测试数据库 |
| `git diff --check` | 通过 |
| 运维脚本前后 TS 转译结果对照 | `ops/replay-redaction-registry.ts` 输出 JavaScript 相同，纯类型修正 |
| 本 worktree `.env.local` 六项数值合法性检查 | 通过；不打印值。不是生产配置核验 |

### 确定性行为边界

- DB 测试使用真实内存 SQLite 和真实 migration/deployment guard，连续调用两次；其余注入覆盖 schema、报告协调、raw 协调、方向播种及关闭失败。
- 正常初始化完成后复用同一连接；失败后重试；清理抛错不覆盖原始错误；`closeDb` 可重复调用。
- 窗口测试调用真实 `chunkWindows`，对照修复前算法的 42 组固定输入组合，包含中英文、空白、短文、长文与多种窗口长度；保留逐字连续切片。
- 非法窗口尺寸在实际调用处拒绝；非法长度环境变量在实际 Analyzer 模块加载时拒绝。
- 运维测试发现覆盖嵌套目录、稳定排序、符号链接排除、空集拒绝、子进程非零/信号/启动错误；两个 npm 入口共享该实现。

## Pre-PR AI Review

- 基线：`origin/main` @ `21414ab702282a5fc3645cea15afe26f1e042c07`
- 范围：测试入口/TS 范围、DB 初始化、数值配置与 Analyzer 窗口保护、实施计划与测试
- 风险级别：中
- 结论：通过

独立 reviewer：`tech_debt_foundation_review`，使用全新上下文，只读审查最终代码 diff 与全部新增实现/测试。

### Blocking

- 无。

### Warning

- 无。

### 独立验证

- 6 个 Vitest 文件共 280 tests 通过：initialization、numeric-env、env、analyzer-window、analyzer、validator。
- `npm run test:ops`：23 tests 通过。
- `git diff --check`：通过。
- 审查确认调用链没有初始化期间重新进入 `getDb`；成功路径顺序未变；6 项合法配置解析、读取时机及窗口算法未变。

Blocking: 0; Warning: 0

## AI 输出质量

评测例外：已按 eval-gate 核对，属于确定性失败边界与配置保护；缺失默认值、合法配置的模型输入与重试次数、模型、provider、thinking、prompt、引用/一致性/展示语义均未改变。Analyzer 改动只增加非法尺寸保护并收敛长度配置读取。使用上述对照和真实函数离线回归，不运行无新增覆盖价值的真模型 A1；不声称获得新 baseline、DCP 或模型质量提升。

提交使用 `Eval-Gate: skip (deterministic initialization/config guards; valid-input behavior unchanged; offline regressions passed)`。

## 风险、发布和回退

- **兼容性边界**：6 项环境变量的显式空值/空白、非数值、无穷值、越界或不允许的小数现在报配置错误。未设置仍使用原默认值；合法 `0` 重试 / `0` 退避继续支持。
- 发布前只核验上述配置是否合法，不输出值。旧空值应删除以使用默认值，或填写合法值；本记录只核验本地隔离配置，不代替生产预检。
- 不更改 schema、迁移历史、报告文件和存量记录。可回退代码；不要靠回退恢复非法窗口循环。
- 未合入、未部署；远程 CI 由 PR 运行后单独核验。生产发布仍走现有不可变镜像流程。
- B/C/D 批尚未实施；全局配置注册、认证、读者可见性规则、备份和任务取消等不能据此记为完成。
