# PR 3：应用验证与 Docker 验证并行实施收据

验收：[专属 spec](../plan/specs/pr-delivery-efficiency.md#pr-3应用与-docker-并行)。此为提交前收据；候选/main 的实际 SHA、run/attempt/result、job 起止与计时在 PR 摘要和 Actions 归档，不为追加链接改变 head。

## 范围

PR 2 [#407](https://github.com/dong-qiu/deep-insight-agent/pull/407) 已正常 squash 合入 `0f5d687311e37674f525588108bbf106e65abf8d`；对应 [main CI 37143788050](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37143788050) attempt 1、scope=docs、全部原必需入口 success、完整应用/Docker skipped。文档 checker 64 ms；[发布判断 37143826608](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37143826608) admission success、GHCR job skipped，没有镜像构建/发布。完成该实际 SHA 的主干验收后，才从最新同一 main SHA 建立 `ci/pr-delivery-parallel-docker` 独立 worktree。

Docker job 独立 checkout、独立 Buildx/context/镜像构建与运行验证，没有 download-artifact 或读取 application 产物；`.dockerignore` 明确排除 `.next`，Dockerfile 自行 `npm ci` 和 `npm run build`。确认串行仅为调度依赖后，将 container 的 needs 从 scope+application 改为 scope，与 application 并行。两者 checkout 同一事件 `github.sha`；原必需汇总门和可信 main 发布 admission 继续要求全部成功与相同证据身份。

只改 CI 一处调度、相关 Node 反例、专属 spec/本收据。保留 C5 单次应用 build/E2E/身份、Docker context secret/runtime assets/HTTP/auth/readiness、完整 prototype 证据及原保护。无跨 PR/main 产物复用或生产推广改变。配置仅从主 worktree 复制，0600，DB_PATH/DATA_DIR 显式隔离，未复制数据/SQLite/WAL/报告；其他 worktree 和共享 roadmap/ADR 未修改。

## 本地验证

并行拓扑反例在解除串行依赖前实际失败，定位到 container 仍依赖 application；变更后须通过。新增实际必需门 CLI 与发布判断反例：任一侧失败、取消或异常 skipped，即使另一侧成功，仍阻断对应必需门及发布。

Node24.19.0/npm11.17.0 独立干净 `npm ci` 成功、audit 0，TS6/TS7 app/tools 四项与 lint 通过。初次 coverage 与 typecheck/lint 并行时，既有 `export-qualified-tech-leads-v2` 的 501 条 fixture 用例触发原 5 s 超时；无改门限或测试代码。构建结束后该模块定向 10/10（2.09 s）及完整 coverage 复跑均通过：234 文件 / 2,366 用例，ops 149/149（交付套件 40）通过。

实际 `build:e2e` 27.998 s、builds=1，`test:e2e:built` 6/6、additional_builds=0。`actionlint -shellcheck=''`、本项两文件 docs checker、`git diff --check` 通过。本地 Docker daemon 不可用，候选 Actions 必须补齐完整容器验证才能合并；以上不冒充 Docker 验证。

## 独立审查

使用 pre-pr-ai-review 新上下文审查冻结完整候选，最终提交前审查通过，风险中，Blocking 0 / Warning 0。reviewer 独立复跑 Node24 交付套件 40/40、actionlint、docs 和 diff 检查，并从基线 Git 对象重放串行拓扑失败反例；确认两项同一 SHA、独立产物、汇总/发布失败门、C5 和原 Docker 运行门保留，只读核验前项实际主干证据与保护。Draft 创建后仍须独立复核最终远端 diff，完整候选 Actions 与实际执行区间重叠仍为合并硬条件。

## 证据与限制

真实候选/main job 起止时间尚待 Actions；验收必须确认区间重叠，而不是仅阅读 needs。记录 scope 完成到两项启动的调度等待、应用/Docker 执行区间、全部必需门结束及 run 总等待。

并行减少 Docker 等待应用结束的串行依赖，但两项仍分别使用 runner，重叠期间峰值并发增加，runner 用量按各 job 时间求和；缓存、负载、计费分钟取整会影响费用，不能从单次 wall time 推断费用下降。PR 1 的 143 s / 162 s 和历史观察都不是受控对照，不作 P95 或受控比例声明。

没有模型、prompt、引用校验、来源、数据集/评分、依赖或 vendor 改动，Eval-Gate skip 仅 CI 调度/确定性测试，AI 输出与评测语义不变；不运行无关 A1。无生产部署。Actions 原完整证明契约不变，新增候选/main 结果优先摘要和产物，不创建第四个归档 PR。

## 回退

通过正常 revert PR 恢复 `needs: [scope, application]` 串行依赖；保留两个必需门与发布 admission，回退 CI 本身完整验证。无数据/schema 迁移或生产部署。
