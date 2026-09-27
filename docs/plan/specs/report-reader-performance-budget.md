# 报告读取微基准性能预算

状态：Accepted，2026-09-27，用户批准 10% 与 0.1 ms 双条件。

## 范围

仅替换 CI 的 report-reader P0c 性能判定，不修改生产 reader、冻结基线、数据规模、权限、引用白名单、
模型或 AI 判定。保留旧 v3 失败与历史结果，不回填通过。
这不是 HTTP/整页端到端 P95：每个样本为连续 25 次 getReport 的平均单次耗时，各轮取样本 P95，
最后取 5 轮 P95 的中位数。沿用同进程、同 SQLite 连接、同 fixture、交替顺序和预热。

## 判定契约

- baseline/current 均须为有限正数，执行失败、缺失/无效证据继续阻断。
- 当前值超过 baseline × 1.05 时记录 warning，不因此单独阻断。
- 仅当当前值 **同时**超过 baseline × 1.10 和 baseline + 0.1 ms 时性能阻断。
  等价上限为 max(baseline × 1.10, baseline + 0.1 ms)，等于任一决定性边界不阻断。
- 输出 policy/benchmark 版本、相对/绝对增量、两个预算、有效上限、warning/status/passed；
  CI 独立按数值重算结果，不能只信 passed。warning 在 CI 可见，失败产物也必须上传。
- v4 门保持 v3 fixture 和冻结 baseline 不变；仅政策版本变化，不伪称优化了 reader。
- 正确性、鉴权、引用可达性、raw archive 与 fail-closed 测试不降低要求；微基准不能替代这些测试。

## 验证

1. 改阈值前预先固定 3 个独立进程，各自以当前 reader 对照自身（A/A），保留全部结果。
   A/A 仅诊断，不是发布证据；--diagnostic-aa 与 --enforce 不得同时使用，CI 也必须拒绝 A/A 产物。
2. 本地 A/A 只能说明该机器和该次运行的波动，不能证明 GitHub runner 的旧失败根因。
3. 单测覆盖：仅相对超限、仅绝对超限、同时超限、恰好/紧邻阈值、改善、无效数字、伪造产物、
   旧版本、A/A 不能放行；集成测试直接调用生产 benchmark/CI verifier，验证退出码与输出。
4. 固定一次新政策下的 baseline/current 完整规模验证，记录来源、环境和全部轮次，不循环跑绿。
5. 运行受影响测试、typecheck 与独立 review；本次不调用模型、不跑 A1。

10% 与 0.1 ms 是原型阶段接受的工程预算，不是由三次 A/A 推导出的统计置信区间或行业标准。
