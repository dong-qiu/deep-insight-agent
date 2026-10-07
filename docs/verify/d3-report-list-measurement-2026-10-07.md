# D3 / TD-15：报告库列表测量与取舍收据

日期：2026-10-07（Asia/Shanghai）。正式测量：UTC `08:26:42.610`–`08:27:26.984`。
按[专属冻结方案](../plan/specs/d3-report-list-measurement.md)收口本轮测量与取舍；TD-15整体仍部分完成。

## 结论与取舍

已找到局部合成数据上的主要读侧成本：三类报告筛选项聚合遍历全部可见历史，成本随库规模增长，
即使搜索结果为空也执行。2400报告的默认入口P50为10.204ms，诊断中三次facet调用的合计中位数
6.795ms，占**诊断自身**墙钟的配对比例中位数65.5%。这些调用不重验当前引用/归档。

建议优先为“同请求内复用可见报告集合，保持三类facet完整语义”准备独立离线A/B方案；
当前完整入口仅约10ms，绝对收益有限，不急于加入生产优化。是否能节约>=1ms且P50/P95均>=10%
仍未知，本轮没有候选或A/B，不能把6.8ms全当作可消除成本。
不改分页、索引、缓存、查询或证据门；不因此关闭TD-15或宣称生产/浏览器提速。

## 范围、现场与文件归属

- fetch最新main后从`41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1`建立
  `feat/d3-report-list-measurement-20261007` / `insight-agent-d3-report-list`。
- 提交前再次fetch，main已推进为`e6045adf3233fdded3b7567a0debd6962970c165`（#435部署门）。
  正常fast-forward集成其7个既有文件；本轮相对新base仍仅专属新增文件。
  测量依赖的生产/工具字节hash均未改变，原样本仍绑定初始测量base，不重采或改写原身份。
- 只新增D3专属spec、fixture、benchmark、tests、摘要和本收据；生产src、schema、共享测试、
  package/lock、CI、graph/planning、report-gen、roadmap/ADR/台账零差异。
- 核对本机worktree、各分支相对main文件集合、status和open PR。Brief/C1涉及reports/schema/共享
  文档；这些文件没有逐文件交接，保守保留归属。用户没有提供所有Session实时占用信息，
  不由Git干净或已合入推定释放。专属新增文件可继续，无需改测机会列表。
- 不复制.env或任何数据；没有生产访问、模型请求、数据库恢复/历史修复、合并、部署或worktree清理。

真实链路：`ReportsPage → listTopics/listSources → distinctIndexValues × 3 → queryReportIndex
→ rowToIndex → ReportCard → React静态markup`。唯一替换为getDb注入隔离readonly连接；
esbuild仅转换当前页面及其实际源码依赖，真实页面函数在保护测试中与bundle输出完全相同。
包含页面函数和React静态渲染，**不包含Next/RSC请求、layout、认证、middleware、HTTP或browser**。

## 调用、资格判断与读取契约

每次请求固定14次prepare/SQL执行，不随100张卡片增长：2次配置读取、8次sqlite_master表探测、
3次distinct聚合、1次索引查询；SQL相关子查询在同一statement内执行，不是应用层N+1。
归档/报告文件读取次数和bytes均为0，当前citation资格检查为0。真实归档正控能捕获读取和错误。

四个列表/聚合SQL均保留done、永久redaction和lifecycle门。探测重复4次是可测的重复工作，
2400/default的片段构建诊断中位数仅0.148ms（含嵌套SQL探测）；不因为存在重复就认为值得缓存。
predicate本身在SQL中执行，无法从这些观测单独分离其逐行耗时；必要可见性门不能删掉。

[B4](../plan/specs/evidence-reader-visibility.md#历史快照例外)允许历史发布索引可见，即使原文后来
丢失、不可读或不匹配。列表不回填当前正文、不重新认证引用；它不是新发布许可。
blocked/unchecked仅在未入选边界洞察，不能装入历史报告集合。

EXPLAIN：facet经现有status/报告主键查找、相关redaction/lifecycle索引及json_each展开，
DISTINCT使用临时B-tree；日期列表使用现有date索引。没有据SCAN/临时B-tree直接加索引。
每类facet覆盖全部可见报告，source/tag/entity各一次；这是筛选项全库语义，仍需A/B才知道复用收益。

## Fixture与身份

真实openDb + 显式migration runner只初始化本worktree下新建合成库；FK/quick_check通过，
checkpoint转DELETE后关闭writer。采样只用`openReadonlyDb(readonly,fileMustExist,query_only)`；
DB bytes/hash/mtime、sidecars、total_changes及合成文件hash/权限前后不变。
这证明静止隔离库读取零写，不证明生产启动协调、在线并发或恢复许可。

4topic/8source；每12份8可见，其他为redacted/delete_pending/generating/failed；
新旧ID、六日期桶及边界ties、重复JSON值/历史关系、FTS不同词频、source已删除后的标签回退、
隐藏记录独占facet哨兵均覆盖。当前证据正例及missing/unreadable/corrupt/mismatch/plain/ineligible/
blocked/unchecked走真实reader，只有valid进入当前证据集；合法历史列表仍保持可见。
报告metadata直接seed，模拟既存历史快照与旧脏索引，不绕开trigger/FK或执行发布/修复。

| 输入报告 | 可见报告 | DB bytes | 逻辑fixture SHA256 |
| --- | --- | --- | --- |
| 50 | 34 | 1601536 | `0f394afb96d74ddbc5318d963068f65f821686940d62aa34abe3c9515d09ebd5` |
| 400 | 268 | 3731456 | `734405ba883d6ae734aa7153fa160b37590a8a8064c9c393c3dea7774010194b` |
| 1200 | 800 | 8548352 | `5ddb45b45cfe93f7de27b051c76e8fcea6dcc5fbe64da4c5e9ee91afa9758ed8` |
| 2400 | 1600 | 15769600 | `cef1cb45b8918e6a43cfae2b2a9421a7eab5abf23ba0d0a85e680034cb919455` |

逻辑hash可跨重复构建重现；SQLite字节含真实helper生成的随机effect ID/时间及绝对路径，
DB hash只绑定本次实例，不宣称逐字重建相同SQLite。生成bundle也含worktree绝对import路径，
跨机器以原始源码hash、转换规则和依赖身份对齐，不能要求bundle字节hash相同。
全部库schema hash为`b75613b77e83a11a37f754f0f85ce81959e44add58c212cde155f44d0b9bfc66`，
ledger版本/checksum hash为`2856c98a2ddca80108a65fb052a02316cb665ecb47ad37419ad754fded681d49`。
合成分布不等于生产分布，未复制live SQLite或默认使用生产脱敏快照。

## 环境、统计与原样本

Node24.19.0/npm11.17.0、SQLite3.53.2、darwin27.0.0/arm64、Apple M4/10核/16GiB；
锁文件SHA256 `63427dc25bd41f83b2db7c4842966df364b73d110d7c95c8f693b77eaebbcad2`。
依赖由该版本npm ci安装，实际版本及native binding hash在摘要。
首轮误用系统Node25安装的engine warning保留；正式安装/采样使用正确版本。

每规模/条件3轮×40个单调用样本（每轮10预热），轮内nearest-rank P50=index19、P95=index37；
摘要为3轮分位数中位数。全2880基线样本、960诊断配对（另1920调用）、IQR/MAD/min/max、
逐轮统计、输入/可见/匹配/limit/输出数、SQL logical返回bytes和markup bytes全部保留。
13/24条件按固定max/min或尾部规则标noisy；无丢弃慢样本、无flush、无重采挑绿。
主采样期间未跑本任务重负载，host检查未发现已知build/test/typecheck/lint/install进程；
1分钟loadavg约1.77–2.50。这不是所有系统干扰均被排除的证明。

raw：私有gitignored `evals/out/d3-report-list/baseline-v1.json`，0600，13328322 bytes；
SHA256 `fc0658fa235d50ee79c06b8233d112e4f9f8dfeefa7bf05b9cae6807696ab37f`。
各隔离fixture和bundle身份保留在本worktree `.cache/d3-report-list/run-*`（0700），不提交。
入库仅[脱敏聚合摘要](../../evals/fixtures/d3-report-list-baseline.v1.json)，没有原文/单样本数组/机器路径。
采样时Git HEAD仍为base，未提交工具由逐文件hash绑定；最终head须与这些hash一致，不能拿base SHA
单独证明测量工具身份。提交后精确head/CI写PR摘要，不为追加CI链接改变head。

复跑（正确Node/npm，无其他重负载，使用新的输出名）：

```bash
npx vitest run evals/d3-report-list.test.ts evals/d3-report-list-summary.test.ts --maxWorkers=1
npx tsx evals/d3-report-list-benchmark.ts evals/out/d3-report-list/reproduction.json
npx tsx evals/d3-report-list-summary.ts evals/out/d3-report-list/reproduction.json .cache/reproduction-summary.json
```

保留第一次正式测量，复跑只能验证可重复性，不能替换收据挑选更漂亮数字。
生成新合成库需写入/迁移，reader计时阶段继续实际只读；不用DB_PATH/.env或模型。

## 全条件主结果

单位ms。每格为3轮分位数中位数；n=40/轮。N标为noisy，不给确定尾延迟/收益结论。
匹配→输出（50/400/1200/2400）：默认/两种排序34→34、268→100、800→100、1600→100；
FTS9→9、67→67、200→100、400→100；组合7→7、45→45、134→100、266→100；空0→0。
各条件过滤比例与limit排除数单列于摘要，没有把结果变少计为优化。

| 条件 | 50 P50/P95 | 400 P50/P95 | 1200 P50/P95 | 2400 P50/P95 |
| --- | --- | --- | --- | --- |
| 默认 | 1.652/2.079 N | 4.672/5.944 N | 6.705/8.574 N | 10.204/12.460 |
| 日期升序 | 1.560/1.756 | 4.475/6.020 | 6.763/8.186 N | 10.423/11.788 N |
| 重要性 | 1.575/1.770 | 4.717/6.123 N | 7.412/18.103 N | 11.549/22.873 N |
| FTS | 1.018/1.239 N | 4.532/4.823 | 9.355/11.158 | 13.534/26.399 N |
| 窗口+JSON | 0.793/0.884 | 2.883/3.550 N | 6.792/10.120 N | 10.203/11.613 |
| 空 | 0.562/0.694 | 1.485/1.665 | 3.726/4.236 N | 7.520/7.854 |

2400/default：主页面函数P50=7.288ms、静态渲染P50=2.921ms；完整墙钟单独P50=10.204ms。
各分位数不能简单相加替代整体。SQL执行包括native行materialization，不是磁盘bytes或完整页面。
每次逻辑SQL返回约66KiB、markup约75KiB；空结果仍约7.6KiB/6.3KiB（配置/facets/form）。

## 诊断、瓶颈排序与未知

1. **已证明的局部主成本：facet聚合。** 默认诊断三调用合计中位数随输入50/400/1200/2400约
   0.29/1.19/3.33/6.80ms；2400空结果占诊断墙钟约93.7%。SQL执行中source/tag/entity分别约
   1.495/2.556/2.531ms。读取完整可见历史是必要语义，重复门/遍历能否复用是尚未验证的候选。
2. **输出装配/渲染：** 100卡片静态渲染约2.9ms（FTS约3.5ms），约随返回量增长。
   当前100条rowToIndex诊断仅约0.071ms；不能把页面残差全归因于JSON解析或某helper。
3. **查询排序/搜索：** 2400默认queryReportIndex诊断约0.402ms，重要性1.681ms、FTS2.969ms；
   这些含SQL准备/执行、门片段构建和行装配，不能再与SQL/row计时相加。尾部有噪声，
   不足以证明FTS/排序索引或分页收益。没有重复当前归档读取热点。
4. **尚未证明：** 同请求可见集合复用、SQL/JS facet去重排序等价（尤其Unicode/空值/旧来源）、
   报告真实规模/分布、并发写、Next请求/HTTP/browser、物理冷缓存和生产端绝对意义。

diagnostic另40配对plain/observed交替先后，完整输出hash一致；观测开销中位差约0.032–0.369ms，
20/24条件触发>5%或>0.1ms instrumentation warning。主基线始终无观测；诊断比例用配对自身
observed墙钟作分母，不把diagnostic和baseline分项混合。可见性fragment时间嵌套SQL，row时间
嵌套reader，表内这些项目不能相加。也不把负配对差或失败/空结果更快称为优化。

fixture构建约69–662ms、readonly open约0.08–0.18ms、初始化后首调用约11–22ms单列。
首次调用还受模块/JIT和缓存未知影响，不公平比较规模或用于P95；没有进程冷启动/物理冷缓存测试。

下一阶段若获独立授权：仅离线尝试同请求复用可见集合，先定义完整三类facet的值/排序/历史例外
及下一请求删除可见性反例，再固定公平A/A/A-B计划。1200/2400同一非空条件完整入口P50/P95
均>=10%、每轮方向一致、绝对P50>=1ms且高于噪声、完整DTO/markup/门等价才考虑生产实施方案。
本轮13个noisy条件不能直接充当候选收益验收基线；届时需先解释/控制噪声并独立冻结新计划，
不得降低阈值或重复采样挑绿。当前没有证明必须立即优化，保留“不实施生产优化”的决策。

## 本地验证、质量门与独立审查

- 采样前真实入口/fixture/observer/边界及reports/redaction/lifecycle/reader-evidence/旧D3定向测试
  8文件160项通过（maxWorkers=2）。摘要后另验证聚合与原样本统计、hash/范围/失败拒绝。
- TS7+TS6 `npm run typecheck`、`npm run lint`和专属2文档链接/anchor/格式检查通过。
  新增摘要校验后2文件14项专属测试通过；全部测量输入hash由版本化测试重核。
  生产/依赖hash对照冻结测量base的Git对象，专属工具对照本次字节；不把历史测量变成未来生产
  文件必须永远不变的门。CI full checkout保留完整历史；本轮最终生产字节仍由独立审查核对等价。
  不改构建/路由/部署，不追加本地build/HTTP/browser；full候选CI仍按现有规则执行。
- `npm run benchmark:report-reader-p0c`单独执行一次：passed=true、status=warning；
  baseline0.07353336ms→current0.08986332ms（+22.2076%/+0.01632996ms），未同时超10%/0.1ms。
  这是既有getReport/25次平均样本的回归门，不是本入口收益标准或生产性能证明。
- 最终diff仅离线测量设施/合成fixture/测试/摘要/文档，无prompt/模型/validator/source/dataset/
  report-gen语义修改；eval-gate触发面不适用，不预签skip、不运行不执行该路径的A1或真实模型。
- 使用[pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)：独立计划审查指出FTS
  top-k oracle不足，冻结前修正为精确数量/无重复/完整匹配排名边界（仅ties自由），定向复核通过。
  正控与facet哨兵建议已落实。最终10文件独立审查通过，Blocking0/Warning0/Suggestion0；
  reviewer独立跑14项专属tests，并重算2880主样本/960诊断配对的全部分位数、离散程度、噪声、
  observer开销、函数/SQL聚合、58个输入hash、bundle/fixture/hash/0600权限与sidecar边界，全部一致。
  随后历史输入hash检查改为对照冻结生产base，独立定向复核再次核验58个当前输入与冻结Git
  对象一致，14项专属tests通过；Blocking0/Warning0/Suggestion0保持，不重采主基线。

性能noisy、instrumentation与P0c warning不等于代码review Warning，分开保留。

## PR/CI停止点与回退

本收据为提交前本地证据，候选head和CI尚未完成，不预填成功。正常hooks创建Draft PR，独立复核
远端完整diff与精确SHA；新候选full CI的base/head/tested/run/attempt、必需checks、应用/Docker
和artifact hash/到期时间优先追加PR摘要，不沿用#418或其他Session通过证据。
本轮至测量与取舍阶段收口；不自动合并、部署、访问生产、业务迁移/恢复或清理分支/worktree。
没有生产优化需回退；离线设施可由普通代码revert回退，私有原样本与历史warning保留。
