# 应用与运维测试并行：提交前收据

## 范围

基线 `9852447c4acaa9585671757d271db45ab5bae45d`；独立分支 `codex/ci-test-parallel-20261011`。
按 [验收 spec](../plan/specs/ci-test-parallel.md) 将应用检查与全部运维测试拆为独立 job，匹配执行身份后汇总原完整应用证明。Docker、分类、必需检查名称、发布消费者和本地完整命令保持既有合同。
本批仅修改 CI、汇总门及专属测试/文档；不修改重构源、共享接口、依赖版本、schema、prompt、模型、数据源或 Eval 口径。

## 本地验证

- Node 24.19.0 下干净 `npm ci` 成功，Native SQLite 可用。保留 prebuild-install 弃用和四包 allow-scripts pending 提示；未执行批准命令或修改 allowScripts。
- `node --test ops/ci-application-gate.node-test.mjs ops/ci-delivery.node-test.mjs`：47/47 通过，零失败/取消/skip。覆盖实际 Git/CLI、失败/取消/skipped、缺证、角色与身份错配、必需门和发布拒绝。
- `npm run typecheck`：TS7/TS6 app/tools 四项通过；`npm run lint` 通过。
- 首次完整 `test:coverage`：应用 3399/3399 通过，native 750 pass / 2 fail / 4 platform skip（756 total）。原日志 `/tmp/ci-test-parallel-coverage.log` 保留。失败一为新增 script 改 package 字节触发 A2 冻结源码断言，已撤回 package 变更，CI 直接执行原 Vitest CLI；失败二为未修改的 drain 同 owner 并发反例，两个控制器均遇 SQLITE_BUSY，admission 留 open。该 drain 案例隔离诊断 1/1 通过；修正 package 后完整 `test:ops` 752 pass / 0 fail / 4 原平台 skip（756 total，345.43 秒）；日志 `/tmp/ci-test-parallel-ops-second.log` 保留，不把后续通过改签为首轮成功。
- 初次 build（19754ms）和 HTTP 13/13 通过；package/ops 测试输入调整后构建收据失效，最终稳定输入重建 14207ms，一次 build；复用该收据 HTTP 13/13、browser 8/8 通过。文档结构、相对链接和入链检查 2 文件通过；audit high+ 0 vulnerabilities。
- `actionlint -shellcheck=` 语法/表达式检查通过。完整 actionlint 保留原 main 也存在的 SC2016 info：P1 的单引号 node-e 字面量，不改其 shell 引号语义。

## 独立审查

CI/证明生成属于高风险。本批按 pre-pr-ai-review 安排两位新上下文非作者审查完整候选，修复后仅核相关差异；两位非作者完整审查及 package 撤回增量补审均通过（Blocking 0 / Warning 0）；两位均复现受影响测试与 actionlint。PR 后另核最终远端 diff 和摘要一致性。

## 证据与限制

本地验证不替代候选 CI 或精确合入 SHA 的 main CI。候选 SHA、tested merge、run/attempt、完整证明、job 计时、artifact ID/到期和发布行为后续追加 PR 摘要，不为结果链接改变候选。
预计通过并行缩短约 169 秒的运维串行等待，但增加 runner、安装和汇总开销；历史 #473 不是受控基线，不提前声明实际提速。
Eval 不适用：未改 AI 输出语义或触发路径。未运行真实模型、生产访问/切换、备份恢复或清理其他工作区。

## 回退

通过正常 revert PR 恢复串行 CI，本批没有业务数据回退对象；不放松失败门或改变生产 hold。

## 本地原件摘要

以下是本次临时日志的 SHA-256；原日志在执行主机 `/tmp`，不是永久归档。首轮失败日志与后续结果分别保留。

| 日志 | SHA-256 |
| --- | --- |
| `ci-test-parallel-coverage.log` | `e3c591af432cb7df850af174101cd97a4d743efcdefa666647d7b77f89a4745a` |
| `ci-test-parallel-ops-second.log` | `ac7524b5abf9564a9d9774b537f9259764bc05cac14b90551c72bd502a55ba5b` |
| `ci-test-parallel-drain-diagnostic.log` | `0e39d7fa017b8dd21b599cc12594186a8078fe01c947e2442acb5ef0e23eff46` |
| `ci-test-parallel-affected-final.log` | `2f4390ce99ee619e49ec3e0337cc67aab821ef8f3ed8b442c24d05565a177ab5` |
| `ci-test-parallel-build-final.log` | `e6a9b2f91a17836265e400824bc39207746e7d3cc045920612f954f13fd0d5ca` |
| `ci-test-parallel-http-final.log` | `4b84bb25f76df01f263bb3159641cc24efd4c0103daeab326740172f45d2b13e` |
| `ci-test-parallel-browser-final.log` | `2719f2802e0ed232f93059a52e7e54ccb2a23bc8f5a142dd30fdbe3b44ac1c78` |
