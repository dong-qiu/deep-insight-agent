# D3 / TD-15：读取性能测量与候选撤回收据

日期：2026-10-06（Asia/Shanghai）；正式测量 UTC 2026-10-05T16:56:35.899Z 至 2026-10-05T17:00:14.661Z。

## 结论与收口层级

完成读取路径盘点、隔离基线、保护测试和一个最小 citation 批量读取试验。结果保持等价，
查询大幅下降，但完整 reader P50 改善约 8%–9%，未达预先固定的 10% 保留标准；生产改动已撤回。
最终交付为测量/回归/可复现离线试验，本轮不关闭原 TD-15 的全部范围。
D2/TD-12、C4b/TD-14 保持部分完成；没有整体读取/系统/A1 提速声明。

## 现场、权限与归属

- 从最新主干 `1d8925f7559bc648a2be288f2e9977336a4e0d17` 建 `feat/d3-reader-performance` / `insight-agent-d3`；[精确 main CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37340831376) success。镜像发布不作为生产上线证明。
- `.env.local` 仅复制配置，0600，DATA_DIR/DB_PATH 改成本 worktree 隔离路径；未复制数据、原文、报告或 `.env.development.local`。
- 主工作区 Brief 的 roadmap/ADR 与未跟踪文档保留；旧收口/Brief 和 C4b 会话均回复不占用 graph.ts/analysis.ts 窄窗口。初查未见 D7 活跃实现；C1 schema/发布/删除/恢复/startup/ops 不改。
- 最终生产实现、schema/index/migration、Agent/model/prompt/budget 与共享测试均零差异；仅 D3 专属文件。没有生产访问、恢复、历史修复、合并、部署或分支清理。模型调用为 0。

## 基线与瓶颈证据

真实链路 `ForceGraph → GET /api/graph/drill → insightsMentioningEntity/insightsCooccurring → loadTopicInsightsFiltered → rowToInsight`，
安全门后为每个可见 insight 单独 SELECT citation。EXPLAIN 显示 citation 主键索引查找；主候选查询仍 SCAN insight，
effect 用现有 raw-content partial index。未因 SCAN 直接加索引或改变时间/筛选语义。

A/A v1 只作诊断，2400候选/600可见时 instrumented reader 90.625 ms，SQL执行合计11.323 ms，
其中600次 citation执行3.761 ms（约4.15%）。执行计时不含 prepare、文件或JS，不能把其余墙钟全归因于单一函数。
前期 v1 empty payload 误读target报告、redaction投影少索引，由独立复查指出；正式v2已修正。
v1 A/A也短暂并行原路径定向测试，因此不作优化验收。原v1全部轮次保留本地 gitignored evals/out/d3/baseline-aa.json。

## 固定测量条件

- Node v24.19.0 / npm 11.17.0 / SQLite 3.53.2；darwin 27.0.0 arm64。
- fixture v2：3主题、目标50/400/1200/2400候选，其他主题约1/4；每12候选3 valid共享1正文，固定混入9类不可见记录；6批时间分布，边界包含且同时间保留。
- 3引用/insight，绑定第2；secondary quote不同，含speaker none；7报告中仅4个done可见，redacted/delete_pending/generating排除。
- 新临时SQLite直接创建基础schema和明确的辅助read投影/实际索引，不执行migration runner或应用startup；schema完整性/部署不是这个fixture的证明范围。
- 同进程/静止只读连接/同DATA_DIR，热SQLite/OS缓存，无并发工作负载；每完整调用新evidence context，仍校验当前正文、effect、文件hash、envelope三方绑定和pass/support/audit。
- 4条件分别计reader和API等价payload（reader+links+groups+JSON.stringify）；不含middleware/auth/NextResponse/TCP或浏览器。
- 各条件3轮，每轮10次预热、40个独立单调用样本，A/B交替；nearest-rank P50=index19/P95=index37，汇总取3轮分位数中位数。没有将单次/均值称P95。
- first-read仅是该条件首个记录调用，baseline先且OS缓存未知，后续条件已经受前面预热；不用于收益判定。
- 固定expected IDs/DTO/图计数与绑定先在原实现通过；A/B深比较及payload精确相等；schema/user业务内容零写、只读文件hash稳定。

## 正式 A/B 全条件结果

单位ms；每格为三轮分位数中位数，B为后来撤回的批量候选，不是最终生产版本。

| 目标候选/条件 | 可见/引用查询A→B | reader P50 A→B | reader P95 A→B | payload P50 A→B | payload P95 A→B |
| --- | --- | --- | --- | --- | --- |
| 50/node-all | 14 / 14→1 | 1.874→1.722 (-8.1%) | 2.262→2.110 (-6.7%) | 1.932→1.793 (-7.2%) | 2.260→2.153 (-4.7%) |
| 50/node-window | 11 / 11→1 | 1.457→1.348 (-7.5%) | 1.628→1.805 (+10.9%) | 1.510→1.431 (-5.2%) | 2.181→2.087 (-4.3%) |
| 50/edge-all | 9 / 9→1 | 1.165→1.086 (-6.8%) | 1.309→1.216 (-7.1%) | 1.228→1.147 (-6.6%) | 1.378→1.316 (-4.6%) |
| 50/empty | 0 / 0→0 | 0.087→0.087 (+0.2%) | 0.094→0.113 (+20.1%) | 0.127→0.127 (-0.3%) | 0.150→0.137 (-8.6%) |
| 400/node-all | 102 / 102→1 | 14.212→13.065 (-8.1%) | 15.067→13.903 (-7.7%) | 14.578→13.367 (-8.3%) | 15.499→14.247 (-8.1%) |
| 400/node-window | 84 / 84→1 | 11.639→10.782 (-7.4%) | 12.508→11.833 (-5.4%) | 11.953→10.994 (-8.0%) | 13.006→11.825 (-9.1%) |
| 400/edge-all | 68 / 68→1 | 8.668→7.854 (-9.4%) | 9.474→8.628 (-8.9%) | 8.807→7.935 (-9.9%) | 9.667→8.833 (-8.6%) |
| 400/empty | 0 / 0→0 | 0.097→0.097 (+0.0%) | 0.107→0.108 (+1.5%) | 0.138→0.139 (+1.1%) | 0.149→0.151 (+0.9%) |
| 1200/node-all | 300 / 300→1 | 43.576→39.996 (-8.2%) | 44.954→41.323 (-8.1%) | 44.266→40.568 (-8.4%) | 46.309→41.274 (-10.9%) |
| 1200/node-window | 249 / 249→1 | 36.230→33.344 (-8.0%) | 36.871→35.545 (-3.6%) | 36.778→33.779 (-8.2%) | 38.306→35.442 (-7.5%) |
| 1200/edge-all | 200 / 200→1 | 26.623→24.177 (-9.2%) | 27.189→24.881 (-8.5%) | 26.811→24.362 (-9.1%) | 27.798→24.888 (-10.5%) |
| 1200/empty | 0 / 0→0 | 0.121→0.121 (-0.2%) | 0.128→0.130 (+1.3%) | 0.157→0.158 (+0.3%) | 0.165→0.163 (-1.2%) |
| 2400/node-all | 600 / 600→2 | 88.802→81.343 (-8.4%) | 92.866→85.015 (-8.5%) | 90.079→82.465 (-8.5%) | 97.415→87.184 (-10.5%) |
| 2400/node-window | 498 / 498→2 | 73.794→67.726 (-8.2%) | 78.944→69.964 (-11.4%) | 74.643→68.680 (-8.0%) | 79.244→70.784 (-10.7%) |
| 2400/edge-all | 400 / 400→1 | 53.318→48.637 (-8.8%) | 54.848→50.335 (-8.2%) | 54.283→49.493 (-8.8%) | 57.265→50.850 (-11.2%) |
| 2400/empty | 0 / 0→0 | 0.166→0.167 (+0.2%) | 0.197→0.186 (-5.5%) | 0.205→0.203 (-1.1%) | 0.238→0.251 (+5.6%) |

每轮方向和全部原始样本、完整诊断SQL模板/计划在入库JSON中；50/window与空态的P95回退也保留，未用总体平均掩盖。
查询下降不是完整路径10%改善：因此不保留候选。没有分页、静默截断、通用缓存或新增生产索引。

## 源码、数据身份与可重现性

- [完整正式证据](../../evals/fixtures/d3-citation-batch-measurement.json)，SHA256 `f2af844794eb5f45e89d2f43aaebe281055492f3589e7fadba6675316101ac6d`。
- [离线补丁](../../evals/fixtures/d3-citation-batch.patch)，SHA256 `ae222ab5eae985eedaa3604acdc248bea00249aea1c2d895c6d388a9a010b29f`，仅应用在新建.cache临时源码目录。
- 冻结graph明确调用冻结analysis，共享safety/visibility/normalization/schema字节与base一致；原始hash、import映射、改写hash在证据。
- 当时fixture hash/source hash与临时runtime候选身份由 `evals/d3-reader-evidence.test.ts` 校验；最终离线重建与当时graph/analysis原始字节严格一致。
- 正式证据记录当时runner源码hash。之后为离线复现、严格TS类型、失败清理和输出父目录调整runner；没有再运行选择一次更漂亮数字。
- 复现：`npx tsx evals/d3-reader-benchmark.ts evals/out/d3/reproduction.json --trial`；不加--trial是当前生产reader A/A。详见[spec](../plan/specs/d3-reader-performance.md)。

## 正确性/安全与验证

- 原实现先通过D3 13项保护与既有46项定向回归，再实施候选；候选59项定向测试通过；撤回后14项D3保护/证据验真通过，最终加3项失败清理回归共17项（maxWorkers=2）通过。
- 精确通过IDs 0/1/399/400/401/800/801：原始DTO/order与离线候选严格相等，候选citation执行ceil(N/400)，空集合0查询。
- 固定14条/6组/节点及边计数、same-score/时间边界、3引用次序、绑定第二quote、所有occurrence/4条正常报告链接、空态及不可见类别。
- 下一请求归档missing/corrupt/unreadable/symlink fail-closed；既有reader-evidence回归另覆盖body/hash漂移、旧plain archive、错绑定/旧unknown effect/遗漏限定语。
- reader query_only、total_changes和DB/归档hash证明读取零业务写；API handler只替换getDb为合成连接，其余真实reader/group/serialization。
- 新D3 browser用D4的无.env隔离运行目录与合成库：真实HTTP节点/边、匿名401、viewer admin403、退出后401、missing archive empty；现有D4全套保护页面交互。
- 最终TS6/TS7与lint通过；`npx vitest run --coverage --maxWorkers=2` 258文件/2730项通过，`npm run test:ops` 150项通过。Statements 79.32% / Branches 71.89% / Functions 79.49% / Lines 83.15%，既有门不变。
- 首次 `npm run test:coverage` 与build并行时两项既有测试触发默认5秒timeout；单独40项复核通过，再降低本机workers重跑全量通过，没有改timeout/测试实现/覆盖率阈值。保留首次失败，不称默认并发首次全绿。
- `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` 通过（66.442秒）；`npm run test:browser:built` 复用该实际build，D3真实HTTP2项+D4交互5项共7项通过（22.3秒）。之后改测量工具/失败回归、证据排版/临时路径与收据，不拿旧receipt证明最终head；完整原HTTP E2E suite由最终候选CI再验证。
- `npm run benchmark:report-reader-p0c` passed=true/status=warning（比值1.23091、绝对+0.01667168ms，未同时突破10%/0.1ms）；warning保留，没有放宽政策或重跑选绿。
- `npm run benchmark:metrics-capacity` v4 enforce通过：1200 funnel/400 cost/400 validator，SQLite3.53.2；P1容量门不能证明普通admin全页性能。

## 独立评审与 Eval-Gate

- 使用[pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)与[eval-gate](../../.agents/skills/eval-gate/SKILL.md)。计划/fixture/候选独立评审发现并修正empty topic、redaction索引、quote oracle、source hash/身份与边界；候选复查Blocking 0，版本文案随后修正。
- 最终12文件完整diff独立审查通过，Blocking 0 / Warning 0 / Suggestion 0；输出父目录、初始化失败清理及故障测试共享目录快照的并发问题已修复并定向复查。reviewer独立运行17项maxWorkers=2通过，核验全部正式样本、分位数与源身份；收据评审结果文本随后核对，远端冻结diff仍待PR创建后复查。
- AI输入/输出及判断口径零差异；A1不执行本次reader路径，未运行A1或任何付费模型。最终通过真实路径回归后使用Eval-Gate skip（offline read measurement; production unchanged）。

## 未覆盖范围与后续建议

报告库/详情整体、图装配全量正文与归档、机会页面重复evidence/统计读取、admin全页/用量读侧均未证明提速。
建议下一轮先对候选SQL、entity匹配、审计、归档/normalize与citation装配做更细分段，保持reader门；
机会页按真实列表规模测重复SQL；任何新增索引/schema需另提设计、取得确认/交接，不由本轮实施。
生产分布、物理冷缓存、并发写、真实HTTP/浏览器P95均未测。合成改善不作为生产性能声明。

## PR/CI 停止点与回退

按[交付证据流程](../plan/specs/pr-delivery-evidence-workflow.md)在首次提交前收齐本地验证和独立评审，正常hooks建Draft PR。
最终候选head/base/tested SHA、CI run/attempt、必需checks、full application/Docker与artifact身份/hash/到期追加PR摘要，
不只为CI链接改变head。本收据尚未有最终候选CI，不预填成功。完成PR/CI后停止，等待合并授权。
无生产代码/数据需回退；测量设施可通过普通代码revert回退，原始失败/诊断证据保留。

正式原JSON输出仅压缩纯数值数组排版并去除临时目录机器路径后入库；样本、元数据和结论不变。原始字节SHA256 `ad9d15e32a31501c277a03009a4538cf20a43cd088692560146786559043c03c` 保留于本地输出；入库字节hash见上。
