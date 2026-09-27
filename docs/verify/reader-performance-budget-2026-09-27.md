# Reader 双预算性能门验证

用户批准：5% 保留告警；仅在相对退化严格 >10% **且**绝对增加严格 >0.1 ms 时阻断。
基于 `5a441b1`，不修改生产 reader、冻结基线、v3 fixture、模型或引用/鉴权规则。政策见 ADR-0035。
此次是预算改变，不宣称修复了旧 CI 性能波动；旧失败 run 36296410930 及其 v3 产物不修改。

## 先观察：固定三次跨进程 A/A

先加入只作诊断的 `--diagnostic-aa`（不允许与 `--enforce` 共用），尚未修改旧 5% 判定；
预先写 count=3 计划，独立进程顺序执行、无挑选或追加。两个通道均调用真实当前 getReport。
环境：Node v24.19.0、SQLite 3.53.2、macOS arm64 / Apple M4；不代表 Linux GitHub runner。

| 次数 | A P95 ms | A′ P95 ms | 相对差 | 绝对差 ms |
|---|---:|---:|---:|---:|
| 1 | 0.085735 | 0.08754836 | +2.1151% | +0.00181336 |
| 2 | 0.08211832 | 0.08332164 | +1.4653% | +0.00120332 |
| 3 | 0.08650836 | 0.08679832 | +0.3352% | +0.00028996 |

均未触发旧 5% 门；只能说明本机本轮差异，不证明旧 CI 噪声来源，也不是新预算的统计校准。
原始轮次及预先固定计划保留于 gitignored `evals/out/reader-perf-aa-20260927/`。
plan SHA256 `f47e912e5a4bb5bfc921ee2ae02098f2f6111d086a0ceeb6d11d7fa8d6a8028b`；
run-1 `3524d3e9bc7a0c20672ef83daf349f7148fc93091e70fa9b8a5a83ed375620b1`；
run-2 `33baa9687e0e720310f4ea1b83214cec57d770a2d697aefef9cbe0b3735d6313`；
run-3 `1d4ca2722a75a2ed4a24d5d3a0e84fa39875f2d5ce9ed05235ec6c20e11c5091`。

## 实现后：固定一次完整 A/B

`npx tsx evals/report-reader-p0c-benchmark.ts --enforce`，默认完整 v3 fixture，benchmark 升为 v4。
906 snapshots、64 KiB body、20 warmups、100 samples、5 rounds、25 operations/sample 均不变。
冻结基线 0.07741336 ms，current 0.07883164 ms：+1.8321%、+0.00141828 ms，status=pass。
本地路径 `evals/out/reader-perf-v4-20260927/evidence.json`，SHA256：
`55200af5535a079dc21fd57183b5a35c2de3427ae6d2aaad10460bc5a62511c6`。
预先计划 SHA256 `3a1fc2c35eccbd3d44d0bb556b9ca681df7b62d6696f9719bdf6e78b8b83b7c3`，
记录实际测量时的脏工作区源码指纹，不把其中 HEAD 当作最终提交已运行新代码的证明。

独立 review 首轮指出 evidence verifier 接受空元数据/不一致轮次；随后补齐冻结 fixture/source/
环境/采样/轮次数量、median 与 policy 重算。只用加强后的 checker 复核上述同一产物，未再测一次选绿。
最终 checker SHA256 `187c18f8e6007234a3f66ae9823564f5ade6097c2ffffd7c8510fd81272be6f7`；
policy SHA256 `f59e7f44306407df60c5123b55106a8f73fb5af94ba695a58add693cd4e4ed50`。

## 测试与评审

- 相关 3 文件 41 项测试通过：两类单独超限/同时超限/恰好边界/浮点/无效数据、旧版及 A/A 拒绝、
  缩小采样拒绝、来源和轮次不一致拒绝、真实 reader benchmark 接线及 CLI warning/退出码。
  自动接线测试缩短采样只用于验证代码，明确不能作为 CI 性能通过证据；synthetic CLI 样本单独标识。
- 全量 `npm test`：209 文件、2,059 项 Vitest + 14 项运维测试通过。
- TS7/TS6 typecheck、受影响 ESLint、diff 检查及 `npm run build` 通过；既有 middleware 弃用提示保留。
- 独立 pre-pr 两轮完成，第二轮 Blocking 0 / Warning 0；reviewer 独立运行 policy 38 项通过，
  未读取本地 raw benchmark 产物。未调用模型、未跑 A1；A1 不执行本次性能门逻辑。
- CI 仍需在 Linux runner 对最终 PR 提交执行完整 benchmark；本地通过不替代远程结果。
