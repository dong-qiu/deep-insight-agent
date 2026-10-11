# 应用与运维测试并行验收

## 范围与执行

基线 `9852447c4acaa9585671757d271db45ab5bae45d`。本批仅调整 CI 调度及完整应用证明生成时机；不改变业务源码、依赖、测试范围、覆盖率阈值、docs/full 分类、Docker 验证或生产部署。
当前执行者独占本批 CI/汇总门/专属测试及两份新文档。实施前定向检查 84 个工作区，目标路径无未提交修改；历史重构源与其他工作区保留。
用户已授权实施、隔离验证、审查、PR、正常合并及精确 main CI 验收。原有 [CI/发布合同](pr-delivery-efficiency.md) 与 [证据流程](pr-delivery-evidence-workflow.md) 继续适用。

## 验收标准

1. 本地 `test`、`test:coverage` 保持应用与运维测试串行全覆盖；CI 使用已有 `npx --no-install vitest run --coverage`；package 字节保持，以兼容 A2 冻结源码的依赖共享断言。
2. full 范围下 `application_checks` 与 `ops_checks` 分别只依赖 scope，在独立 runner/checkout/临时目录并行。应用保留 lint、TS7/TS6、完整应用覆盖率、P1/P0c 门、一次 build、HTTP/browser、audit；运维保留原自动发现的全部 Node 测试。
3. 两路成功结束时记录实际 checkout SHA、候选 SHA、仓库/事件、run ID/attempt 和 lane。汇总核对成功结果及全部身份。失败、取消、skipped、空/畸形输出、错 SHA/run/attempt/仓库/事件/角色均拒绝，不生成完整证明。
4. 保留 `full application verification` 汇总 job 名及三个必需检查名称。仅汇总通过后调用原 writer，保持 prototype CI/Docker schema 和现有消费者契约。Docker 继续独立；docs 下两路及完整汇总正常 skipped，不生成完整证明或镜像。
5. 用实际 Git/CLI 和下游发布判定测试正反例；完整候选由两位独立非作者审查，PR 后独立核对远端 diff。正常 hooks、保护规则、候选和精确合入 SHA 的 CI 全部通过后完成。

## 耗时与证据

历史 #473 PR run 38128710754/1：完整应用 603 秒，应用覆盖率 212.21 秒，运维 168.66 秒；main run 38129376608/1：完整应用 592 秒。这是现场参考，不是受控性能基线。
记录本批两路及汇总的起止、排队、重叠和总 runner 时间；目标完整应用路径约七至八分钟，以实际结果验收，不推断 P95 或受控加速比例。多一个 runner/npm 安装及汇总安装的费用单列。
提交前收据见 [本批收据](../../verify/ci-test-parallel-2026-10-11.md)。后续 CI/main/镜像身份、产物到期及结果更新 PR 摘要，避免仅追加链接改变候选。

## 回退

通过正常 revert PR 恢复串行调度；回退自身走完整 CI。不触及业务数据、模型、schema、共享维护接口或生产 hold。
