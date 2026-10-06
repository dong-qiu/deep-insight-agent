# L2 — 流程层 (Workflow)

> 在 IPD 不同阶段，Claude Code 的行为约束。

## Concept 阶段

- 优先文档对齐，不写代码
- 每个新假设要落到 `docs/concept/charter.md` 的「关键假设」
- 范围外需求显式记入「不做什么」

## Plan 阶段

- 新功能必须先有 `docs/plan/specs/<feature>.md`
- 架构变更先更新 `architecture.md`，再写代码
- 重大选型走 ADR (`docs/develop/decisions.md`)
- **ADR / spec 里"评审背书过的方案"也是待验证假设**：越是被反复确认、越有理由直接照着实现的方案（尤其带"必然 / 构造安全 / 这才是真解"强保证语气的），越值得在写第一行实现前用最便宜方式（离线 eval / 真数据）量化一次。求证对象从"别人的归因"→"自己刚写的论断"→**"权威文档背书过的方案"**，最后一档最难自觉。数据驱动的方案有时要先部署能产数据的前置件，再用真数据定参/证伪，别在纸面把它设计到底。经验来源：`docs/practice-log.md` 2026-06-23（ADR-0010 (1c) 阈值被离线 eval 证伪）。

## Develop 阶段

- 改动前确认对应 spec 的 AC
- 跨层调用遵守：`src/app` → `src/lib/agents` → `src/lib/sources`
- 不要绕过 `lib/sources/` 直接调外部 API

## Verify 阶段

- 任何 AI 输出变更需跑 eval
- 回归用例失败不得合并
- 性能 / 成本变化需在 PR 中标注

## Launch / 收尾阶段

- 收尾"待办清单"先核验真实状态再动手——roadmap/gap 的"待办"标记常滞后于现实（已满足 / 根因已变）。关条件前去现场（DB、repo settings、生产容器）查当前状态，别照文档执行已完成的事。
- 关条件先分类：门（MVP 必达）vs 非门（可选优化 / post-MVP）。OR 条件优先走不卡外部依赖的分支；一个外部依赖（如直连 key）缺失只该挡住优化，不该挡住签字。关条件最便宜的方式常是"正确分类"而非"做完它"。
- 验证结果要连同"为何看起来成功 / 失败"一起写进结论：CI 红/绿、HTTP 200 都可能是表象（子集伪失败、没真落库），别只标"已闭合"。
- 经验来源：`docs/practice-log.md` 2026-06-15（4 项 MVP 待验证条件收尾）。

## 部署 / 运维核验（生产在 AWS EC2，工具在 `ops/aws/`）

- **合入 ≠ 上线：验证任何"修好了"之前，先核生产真在跑哪版**——查运行镜像 `created` 时间 / bundle 内容 / **字面量特征**（grep 一个该改动引入的独特字符串，如某新功能的中文/emoji 串），别信"合了 main 就上线了"。并行开发下还要防"上线的那版不是我部署的"（可能已被别的会话部署，别重复部署）。
- **已有生产实例 code-only 发布只走 GitHub Actions `Deploy Production Image`**——等可信 main 完整 CI / GHCR 不可变镜像就绪，获部署授权后在受控窗口触发健康切换；前置与回退见 [运维手册 §8](../docs/launch/operations.md#8-升级)。旧 `deploy.sh` 已停用，不能以 SSM+rsync 源码构建替代；全新主机 bootstrap 另立任务。历史上源码投递会覆盖生产 `.env.local` 并令成本熔断/推送静默失效。
- **生产配置与发布分离**——`/opt/app/.env.local` 由 operator 单独维护；不要对该目录运行 `rsync --delete` 或从本地开发环境全量覆盖。历史同步风险仍见 `docs/practice-log.md`。
- **部署避开每日管线窗**（brief 钉 17:00 UTC，避 **16:50–17:30 UTC**）——撞窗可能孤儿化在途 Run；`ops/trigger.mjs` 是实际写入/生成入口，补跑可能调用付费模型，须独立授权，不是只读诊断。
- **获授权后查生产真值走 `aws ssm send-command`**（只读核验示例：`docker exec deep-insight-app-1` + `node` 读 `/data/insight.db`）——读取生产也属于生产访问，文档盘点不自动授权。SSM 本身能执行写命令，只有核实具体命令后才能称只读；cloud 定时 agent 无 aws 凭证不能查。
- 经验来源：memory `verify-check-deployed-version-first` / `deploy-collides-with-cron-window` / `aws-deploy` / `prod-db-is-docker-volume`；`docs/practice-log.md`（#47/#57/#142 及 07-04 #154 部署）。

## 跨阶段通用

- 任何"临时方案"必须留 TODO + 截止条件
- 实验性代码放 `experiments/`（如有），不进 `src/`
- 阶段结束时，回顾本阶段在 人机协同 / SPEC / Skill / AI 代码质量保障 上的经验，主动提议补入 `docs/practice-log.md`（元目标产物）
- 平时遇到值得记的经验 / 教训也可随时提议补录，不必攒到阶段末
