# Daily Brief 阶段 0：完整输入标注包与 T04 冻结检查器

2026-10-07；基于 `origin/main` `473e2ee` 的隔离 data worktree。仅离线准备工具，不修改生产提取、来源、validator、schema 或 report-gen；B1 保持 no-go，T04 尚未冻结，本切片新模式未启用；本轮未访问生产，不认证现场开关状态。

## 实际核实与交付

只读重算旧私有 T03 manifest，SHA-256 为 `a03f28f90df8e6f7778297097a8ad636de084b2f34f206574a083039b582e1ab`：188 个已曝光 exact source revision、83 个既有家族组件、7 条已知边、正式留出 0。组件只代表已知关系下界，未宣称完成全部语义家族识别。全部旧曝光保持 exploration，未来连通家族排除正式留出，关系不明须隔离。

原确认索引 SHA-256 为 `90713c17b0b556f93fd669f79776b299039c7c6ae12e870417ed3307fb50bd80`，30 个已确认事件，其中软件工程 10 个；原待重要性/题目键均为空。保留该索引原件及 hash，不重问已有确认，也不将它冒充完整输入金标。

对 10 月 3、4、5 日实际存在的三个 raw-verified 导出重验 manifest/JSONL/stage-loss hash，生成 **3 个预登记运行、3 次尝试、45 个 source revision occurrence、23 个不同 exact revision** 的私有标注包。三次候选总数为 47、unknown、99；失败原尝试保留，unknown 不补成 0。45 个输入在既有导出的 body/raw 核验结果中均无 gap，均在旧曝光探索集合内。本工具没有重新打开原 DB，也不宣称这是当前撤回状态或生产发布认证。

23 个 exact revision 与原 10 个软件工程事件确认索引的 exact refs 交集为 0，因而不自动移植原事件归属；新缺项是这 23 份完整来源在三个运行中的人工事件、独立重要维度、必要限定和固定理解题。已知家族连通分区不能替代这项人工语义判断。

软件工程试点读者为需决定工具链采用、试验与适用条件的技术负责人和资深开发者。正文、金标工作表和所有新私有产物只在本树 `.data/rich-brief-stage0/` 下，目录 0700、文件 0600；原资料只读，不复制 DB、配置或其他 worktree 产物。

## 可执行接口与完成门

`evals/rich-brief-stage0/data.ts` 的 `prepare` 接受私有 JSON config：`topic=t_code_agents`、读者目标、旧分区及原确认索引的绝对路径/SHA、预先列出的全部 `run_id/scheduled_at/export_dir`。缺失导出允许 `export_dir=null`，运行保留为 unknown。只适配已有 `brief-density-s0-v2` 导出 envelope，并复用 `EntityRef` 类型；不复制 exporter 的 SQLite 实现。

每次分析开始的 exact `input_refs` 决定该次尝试的 occurrence；不同开始、重试、cache reuse 分别记账。缺 batch 保留候选总数 unknown；缺开始链、输入或快照保持 unknown。batch 中多个开始链的来源 union 不冒充每次尝试的完整输入。输出 worklist、pending 人工 labels、逐 revision 全正文工作表和待办索引；金标在独立 scorer 文件内，提取输入不含金标正文。原确认索引只存资源指针，不注入 extractor 输入。

`check` 输出仅状态、阻断码和 counts，blocked 返回 2。`freeze` 重新从 hash 绑定的原 config/export 准备输入，拒绝漏掉/篡改的 occurrence；再验全部资源，最后写不可覆写的 frozen artifact。两个工具源码也作为输入资源绑定。原包不会覆写；工具修订后须重新 prepare 新目录，旧包仍可供相同正文的人工审阅，但不能用旧工具资源 hash 冻结新协议。数值协议和模型配置必须实际填写，不以零或任意样本阈值补空。

冻结前必须有：

- 全部输入人工归属或有理由的范围外判定；重要事件的独立 must/secondary 维度、原文连续 span、必要限定完成声明及固定理解题；每个输入的家族语义审阅。人工确认须带 human 收据，AI 状态不接受。收据是责任声明及 hash 绑定，工具不能独立证明填写者身份或替代人评。
- 数值协议的适用样本数、可刊新增重要维度数/比例、事件与维度非劣、重报/空刊、unknown、全刊事实及阅读预算、盲读人数、前瞻运行数、失败/token/成本/时间及停止门。每项必须有理由、依据资源 hash 和 human 确认，非劣门不得容许事件/维度下降或重报/空刊上升。
- 每臂单独登记 input、model/model revision、provider、prompt hash、token/cost/time/attempt budget、failure/cost accounting/stop、ledger schema hash。必须列齐 extractor、reader-language repair、citation repair、display primary、quote-only countercheck、validator single/batch 七个 operation 的模型/provider/transport、prompt/策略资源绝对路径和 hash、输出预算及明确 known/not-applicable 的 cache/thinking；未知/缺项均阻断。cache read-write 必须绑定隔离 namespace 与冻结 snapshot，thinking 开关/预算必须一致。模型/provider 身份资源采用版本化 JSON 描述并逐字段与角色匹配；prompt 资源必须按路径和 hash 同时绑定，不能用资源列表里任意相同 hash 充当。六类输出 schema/归一化/原子展示审计/locator/历史选择/成本失败停止策略资源也必须列齐。baseline/C1 的输入、模型/provider/version 和预算配对；除首次提取 prompt 外的全部 operation、cache/thinking、策略和预算保持配对。模型分离沿用生产 assertCoverageModelSeparation 的三个不同模型要求，display primary/citation repair/validator batch 与 validator single 保持同一 validator 路由，reader-language repair 与 extractor 保持 analyzer 路由。prompt 是 C1 的实验变量。P/C/I/F 可另登记独立 task，不能混入 C1 收益。此工具只冻结登记，不运行或认证这些实验。
- 未收集、未打开、未看正式结果的前瞻声明，明确全部定时运行/尝试与家族审计。开始时间须晚于真正 freeze 时间，run IDs 不能重复或使用旧曝光运行；之后正式输入家族审计和结果/运行收据仍是下一波独立门，声明本身不是通过证明。
- 来源支持、错并、限定缺失、blocked/无记录引用、unsafe accept 的零容忍；`production_enabled=false` 与 `b1_status=no_go` 不可改成准入。冻结仅固定评测协议，不等于 C1、S1、产品、来源或生产准入。

实际 `check` 已返回 2/blocked：`human_gold_not_confirmed`、`full_input_event_or_family_gold_pending`、`source_event_or_negative_decision_missing`、`t04_protocol_schema_or_numeric_decisions_pending`。重要事件与重要维度为尚未填的 0，而非人工证明不存在。正式留出 0，未读取任何正式留出结果。

## 验证和 eval-gate 路由

使用 Node `v24.19.0`、npm `11.17.0`，本树独立 `npm ci --ignore-scripts` 完成，0 vulnerabilities；未修改共享依赖或配置。先前默认 Node 25 的 engine warning 已纠正并在 24.19 下重装，不作为有效测试环境。

实际命令：

```sh
npx vitest run evals/rich-brief-stage0/data.test.ts
npm run typecheck
npx eslint evals/rich-brief-stage0/data.ts evals/rich-brief-stage0/data-review.ts evals/rich-brief-stage0/data.test.ts --max-warnings=0
```

19 个针对分母、hash、失败 unknown、连通家族、漏标/假 span、AI 收据、数值缺项/无依据、预算不配对、已见/过去留出、资源变更、输入删除、私有路径/覆写/symlink、生产/B1 放行的 synthetic 回归通过；TS7 和 TS6 类型检查通过，定向 lint 通过。测试内人名、门槛和 future 时间是合成 fixture，不是实测金标或预登记资源。

已使用仓库 `eval-gate` 的路径覆盖判断：本切片只新增离线准备/冻结工具，不修改 prompt、模型、来源、生产校验或 dataset 标签。未运行 A1，因为它不执行本次路径，不能当作标注或 T04 验收。这里只提供 scoped 工具回归；后续 C1、P/C/I/F 的真实提取和证据门仍需分别运行相应 eval。未跑 build，未修改构建/路由/部署；未 push/PR/merge。独立非作者评审由集成负责人安排。

## 下一波可运行入口

在 data worktree 的私有 config 已存在时（所有位置都是绝对路径且输出目录必须新建）：

```sh
node --import tsx evals/rich-brief-stage0/data.ts prepare /abs/private/prepare-config.json /abs/worktree/.data/rich-brief-stage0/new-review
node --import tsx evals/rich-brief-stage0/data.ts check /abs/private/input-worklist.json /abs/private/human-labels.json /abs/private/t04-protocol.json
node --import tsx evals/rich-brief-stage0/data.ts freeze /abs/private/input-worklist.json /abs/private/human-labels.json /abs/private/t04-protocol.json /abs/worktree/.data/rich-brief-stage0/new-freeze
```

先分批提供 5 份来源的紧凑候选标注材料供人工逐项判定，最终覆盖完整 23 revisions/45 occurrences；五份预览不缩小正式分母，也不算阅读卡效果评测。探索金标和人工阅读初测未补齐前，T04 维持 blocked；C1 可继续准备执行器、各臂 ledger 和独立证据审阅资源，不启动正式留出评分或生产开关。

独立非作者首轮评审验证 15/15 回归通过，并指出 runtime 角色资源不完整的 Warning；后续修订强制全部 operation、cache/thinking、模型分离及策略资源，新增 4 个拒绝回归。该审阅发现已修复，仍须非作者复核新提交。
