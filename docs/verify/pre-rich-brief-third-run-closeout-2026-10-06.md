# 旧 Brief 收口：第三次实际运行与停止决定材料

> 2026-10-06 · 只读补证，不改生产行为或原 S0 完成门。第三次观察已经完成；T03 完整输入标注门未通过、T04 未冻结，#360 仍须保持 draft。

## 实际运行和首份备份

第三次软件工程 dispatch 冻结 `window_end=2026-10-05T17:00:47.347Z`，trace `trace_685a92090dad412fa0f60a286bb3b03b`。分析 `17:00:51.646Z` 开始、`17:08:04.861Z` 完成；`batch_11bcff19` done，`rep_7cc7c371` 于 `17:10:05.026Z` 生成、发布完成，trace 于 `17:10:05.067Z` done。

首份运行后备份区间 `2026-10-05T18:00:00.295Z–18:00:03.018Z`，逻辑 asOf 为终点，早于预登记下一轮 `2026-10-06T17:00:00Z`。S3 当日仅该前缀；生产只读目录列表及当前撤回查询 SSM `8be14699-59e0-44f3-b1ac-15bbb9b72a20` 于 `2026-10-06T08:38:49.788Z` 确认当日仅该目录，redactions=0、requests=0。不以预定备份时间作证。

- DB 原件与隔离单文件副本 SHA：`ef0a352247e8cddeb7892935d8c8ce3ef929ef6ab8c9f83e8697b1e6eadf01c7`；229,064,704 字节，quick_check=ok，DELETE journal、0400。
- 清单 SHA：`d1a1ed3cc0692b48a5768cd8902d50a7ed10c2c09a2e7583558b4413f7eaac5b`。
- 所选 15 份 raw：S3 原件的大小/hash、清单、生产 envelope/body 版本与 quote/locator 核验通过；exporter 记录的输入证据缺口为 0。
- 报告 MD SHA：`c19807150beefa4b5043b369869f32bb251d529bfb2e5e72cb0fdd1d6265d634`；HTML SHA：`8aaafd1a80c920903e8a7e74640133c1c5d4cdd6e719c8fab7cf38570fb127bb`。两份字节与备份清单一致，4 个发布成员与报告保存成员一致；artifact 使用英文 source-quote 投影，不以 live 中文 reader_statement 代替发布文本。

备份整体 **incomplete**：19,259 引用，17,036 present、415 missing、1,808 unmapped。所选输入通过不等于完整恢复点。导出实现 SHA 为 `e75c860b1a83fefc77c09c234115388079acc39f`，生产/私有数据不提交。

## 候选终态与 B1 适用边界

99 个候选互斥终态：展示审计拒绝 62、历史/新鲜度过滤 20、补充发现额度过滤 13、发布 4。机器初筛 37 仅表示保留文本、kept/kept_degraded、逐引用 pass/support 与所选原文绑定通过，不签事件身份、重要性或历史新颖。

实际 generate_report 终态 metrics：includable=37、freshness_filtered=35、supplemental_candidate=15、supplemental_published=2。因此当前主通道只有 2 个近期候选，分属工具安全引擎发布和软件移植实验；它们是两件不同事件，各只有一个候选。另两个刊出成员来自较早摘要中的两件独立产业事件；不是同事件互补成员。`supplemental_limit` 由旧证据补充发现分支生成，不代表 Insight.type=supplemental；本次 37 个 retained type 都是 aggregation，不能用 type 或 reason 名称冒充语义标签。

按 scheduler 的默认 48 小时与 source published_at/fetched_at 重建得到 6 个 fresh 输入、2 个 retained fresh 候选，与 select/report metrics 一致。当前生产 `BRIEF_FRESH_HOURS` 未设置，SSM `fe51d96d-6620-46f5-bce0-8c5ea1b520f5` 在 `08:46:19.278Z` 核验；当前配置本身不认证昨日没有临时 override，实际落库 metrics 是上述 2/35 分层的直接依据。

快路径明确不启用补充发现成组；13 个较早补充候选、20 个已刊过滤及62个拒绝草稿不能补算首发新事件互补供给。保留草稿归属、完整输入事件金标和全史语义未知，不能把 source 级不可见候选或无 batch 失败计成没有重要事件。

三次固定普查中：首轮已确认的合格同事件机会 0；第二轮失败、总候选 unknown；第三轮主通道无多成员事件。**未满足“至少两个不同新事件各有双重要维度”的启动条件，现有 B1 首发路线 no-go，S1 不准入。** 这仅是当前路径和固定窗口的保守工程决定，不证明来源本身没有更多可提取事实，不批准任何候选发布。首次提取 C1 仅保留为后续离线备选，本轮不实施。

## 标签保全、探索分区与原门

原 31 份标签/30 个事件（每主题10个）的标签文件 hash、source id/revision/body hash 与 annotation inventory 对齐；待优先级/问题确认键均为0，既有人工确认与来源支持修订保留，不重复询问。该检查证明元数据/确认保全，不是新增完整原文人评。

第三轮两份导出向原184版本曝光全集补入4个新版本，共 **188**；22份已存候选池与两份补样 inventory 的既有范围保留，集合反连接遗漏0。私有分区 manifest SHA `a03f28f90df8e6f7778297097a8ad636de084b2f34f206574a083039b582e1ab`；旧manifest按原SHA保留。全部探索、正式留出0；已知83组件及边不删，未知语义家族关系仍 unknown，不声明未来家族隔离已穷尽。

[T04](daily-brief-density-experiment-protocol.md)仍缺完整输入金标、资源版本与有依据的数值/预算、未见前瞻留出。X/Y各120秒且主观无差别，只是重复曝光探索记录。**本页不将“停止 B1”写成“T04 已冻结”，不授予 #360 合入资格。** 三次观察/分区补证与工程 no-go 可独立审阅；原 S0 总门继续未通过。

## 可供用户裁决的范围修订建议（尚未生效）

建议仅将 #360 的合入范围改为“只读诊断、已完成的材料/三次有界普查、原标签探索分区、T04 停止与缺口记录，以及 C1/清理移交”。修订后仍明确 **T03 完整输入标注门未通过、T04 未完成、S0 未取得进入 S1 的资格**，保留数值协议为后续独立工作；正式 S1、生产新格式及新版 P/C/I/F 都禁止由该 PR 启动。

这是原收口计划第3项第5条要求单独确认的完成门变更。用户恢复访问并要求继续，不视为同意该修订。未取得明确决定前，只能更新 draft；如果保留原门，则保持 draft 并先补齐协议所缺证据，不能以本页替代冻结协议。
