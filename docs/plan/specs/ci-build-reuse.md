# C5 / TD-17：CI 复用本次 Next 构建

范围仅为 C5。D5 的依赖声明、Node/types 校对及 vendor 补丁退出条件另行实施。

## 验收标准

1. 本地 `npm run test:e2e` 默认仍先构建再执行现有全部 E2E。
2. CI verify 作业通过 `npm run build:e2e` 构建一次，通过明确的 `npm run test:e2e:built` 复用；后者不得隐式重建或在校验失败后降级。
3. 构建成功后才生成收据；开始新构建先作废旧收据。失败、信号退出、构建期间输入变化不得生成有效收据。
4. 收据绑定 worktree 路径、Git HEAD、构建输入内容（含未提交源码、evals 类型检查输入、public/vendor、新增构建配置与环境文件）、Node 版本、NEXT_*、NODE_OPTIONS/NODE_PATH、Babel/Browserslist 环境，以及 CI run/attempt/SHA。环境仅保存哈希，不保存值。
5. 构建产物缺失、内容被替换、源码/配置/环境/HEAD/运行身份变化、收据缺失/损坏、超过一小时或时间在未来均拒绝。校验包含 BUILD_ID、server/static 和 manifests；Next 缓存不作为可复用产物。
6. 原有 E2E 场景、coverage、供应链、prototype 证据及 Docker 作业保留。无应用、AI、引用校验或评测口径变更，无新依赖。
7. 记录固定本地环境两条路径的阶段耗时和构建次数；记录 PR CI 实测结果。历史 CI 观察及单次本地样本不宣称受控 CI 加速比例或 P95。

## 回退

可将 CI 改回 `npm run build` 加 `npm run test:e2e`，恢复重复构建；无 schema、生产配置或数据迁移。本切片不部署、不更新其他会话共享文档。

实施与验证见 [C5 收据](../../verify/c5-ci-build-reuse-2026-10-03.md)。
