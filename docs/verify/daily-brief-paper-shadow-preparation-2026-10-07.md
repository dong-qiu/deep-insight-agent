# Daily Brief P：论文 shadow 样本与评测资源准备

> 2026-10-07 · 实查 base `49a00b00f5312821c358ac138108d3e5dd9cdd11`，隔离分支 `feat/daily-brief-paper-shadow-prep-20261007`。本波只读旧曝光探索输入并准备私有资源，只提交本文；没有抓原站、运行模型、打开正式留出、修改来源/共享代码或启用生产。P 全文可用性当前阻断，不认证 C1、T03/T04、人评或发布门。

依据：[新版 P 方案](../plan/specs/daily-brief-rich-insight-freshness.md)、[共同 v0](../plan/specs/daily-brief-versioned-evidence-publication-v0.md)、[试点及实验入口](../plan/specs/daily-brief-stage0-pilot-and-experiments.md)、[数据准备收据](daily-brief-stage0-data-protocol-2026-10-07.md)、[原子证据图](../plan/specs/atomic-insight-evidence-graph.md)。软件工程技术负责人/资深开发者的目标及已确认产品方向沿用，不重新询问。

## 实际 inventory 与分母

固定读取 data 树最新 `exploration-review-20261007-v3/input-worklist.json`，SHA-256 为 `bc44d0f3319a0c1877f180fd962be0b3d74f3fbb1fa4d2468d5128a621636810`。重验其 14 个资源指纹全部一致；未重开数据库，不把旧导出当当前生产撤回/版本认证。

| 已曝光探索资源 | 本波实际可核计数 | 解释 |
| --- | --- | --- |
| 完整三次输入 | 3 runs / 3 attempts / 45 occurrences / 23 exact revisions | 无 batch 的失败尝试仍保留；不是只查已刊摘要 |
| 可明确识别的论文输入 | 5 occurrences / 3 exact arXiv revisions | 三个不同论文 work，均为归档 Atom ID 与 URL 一致的 v1；以同一完整输入池为分母 |
| 其他完整输入 | 20 exact revisions / 40 occurrences | 不是本波论文配对样本；不由标题猜测其引用论文是否等于独立论文原文 |
| 摘要与原始归档 | 3/3 revisions、5/5归档观察核验通过 | `source_body_origin=feed`、`source_body == Atom.summary`，均为 API 摘要；归档 hash/size/规范正文/版本绑定逐项核对 |
| 同 v1 PDF 候选链接 | 3/3 | 存在于原 Atom 的 `application/pdf` link；链接存在不代表已下载、可解析或取得权利 |
| 可核 HTML 全文 | 0 | Atom alternate 的 text/html 链接是 `/abs/` landing page，不是全文 HTML 载荷 |
| 可核 PDF 全文 | 0 | 此限定输入及绑定归档中没有 PDF 字节或解析正文；本波未请求链接 |
| 全文章节/表格/图注/限制 ledger | 0已定位，24项 unknown | 3论文×8核心内容域，仅摘要有完整 `[0,length)` UTF-16定位；不把摘要概括扩成正文 span |
| source-specific 权利/使用/保留证据 | 3/3 unknown | 归档 Atom 没有 license 字段，没有新的许可/条款决定；公开链接或内部研究身份不代签权限 |
| 人工事件/重要维度/必要限定/阅读题 | pending | 没有用 AI 盘点代替人工金标或阅读效果 |

摘要正文长度为 1,256 / 1,782 / 1,486 个 UTF-16 字符。版本 URL、完整文本、归档绝对路径和逐样本记录只留 owner-only 私有 inventory，不进入本文或 reviewer 材料。三个论文的 `source_work_id` 仅作 `arxiv:<id>` 候选映射：归档 Atom ID、canonical `/abs/<id>v1` 与 `/pdf/<id>v1` 一致可以核验；当前论文外部状态/作者后续版本未知，本波没有原站核实。

188 是旧曝光 registry 的总 exact revision 数，v3 本次完整输入仅覆盖其中 23 个。其余 165 个 registry 条目未在本波分类；仅凭无 URL/body 的曝光登记不能得出全 188 的论文总数或全文总数。上述全文 **0** 限于此次完整输入中的 3 个论文及其绑定归档，不外推为所有本地资料或原站没有全文。已见家族和这些论文未来版本仍为探索侧，不成为正式留出。

## 已生成的私有资源

本树 `.data/rich-brief-stage0/paper-prep/` 为 0700，文件 0600。最小纯离线 `prepare.mjs` 没有 network/DB/model 调用，仅以 JSON 与已绑定归档读取完成盘点，复用真实 `normalizeBody`、`contentHash` 和 `canonicalHash`；没有复制第三方全文、数据库、WAL 或生产报告。输出不覆写已有目录。

| artifact | SHA-256 | 内容及边界 |
| --- | --- | --- |
| `inventory.json` | `0bd151c25d8f9ac62475d2680649f0dd58bfec31270e6cf13de40094e5d4f432` | 全分母、3逐样本身份/版本/摘要定位/绑定归档、缺全文/权利/human/history状态 |
| `coverage-ledger.json` | `fe64219043bcf06ae4070d08058ba1ccf3142bdf9b1b79c6738c0d8041e4993a` | 研究问题、方法、比较、结果、表格、图注、局限、参考文献逐域 unknown；摘要 span 单列 |
| `eval-protocol-draft.json` | `fe5da70462cbacf6cf07305d67eb63919951e1b9eb6bce615afad8da2049d427` | P专用分层、配对规则、资源缺口与待填数值；`status=not_frozen` |
| `failure-ledger.json` | `fd3b1daa290c666504ea4003def9e39bacab3a26abe9fff284125c620c60683a` | 每样本 `not_attempted/no_bound_versioned_fulltext_and_rights`；不是成功，也不是网络抓取失败 |

准备器 hash 为 `33f0c8360e0af4a1ea19e90898171522307e6e90a9120e7c23a329b307430146`；资源收据另绑定 config/input/四份 artifact。该私有准备器不是生产适配器或正式评测 harness；不作为源码质量/准入证据。真实抓取与模型次数均为 0，抓取/模型费用为 0；准备耗时未仪器化，保持 unknown。真实全文抓取失败、解析失败样本数也均为 0，不能把未尝试的三项叫失败 cohort 或成功率 100%。

可执行命令在当前 paper 树运行；输出目录必须新建，私有 config 已绑定 v3 的绝对路径/hash：

```sh
PATH=/Users/dongqiu/.nvm/versions/node/v24.19.0/bin:$PATH \
  node --import tsx .data/rich-brief-stage0/paper-prep/prepare.mjs \
  .data/rich-brief-stage0/paper-prep/prepare-config.json \
  .data/rich-brief-stage0/paper-prep/run-v1
```

再次盘点使用新的输出目录；不能删除原资源来重写收据。资源/hash、未曝光输入或生产/留出模式不符时拒绝准备。owner 可逐项打开私有 inventory 和 ledger；非作者 reviewer 只审本文及代码事实，不接收原文/生产私有数据。

## P 专用 shadow 评测协议草案

这份草案将专用评测资源化，但没有冻结样本/收益/覆盖/误拒/阅读/token/费用/超时/重试数值，也未收集正式留出。所有数字门当前为 `null/pending`，不得补一个任意阈值让工具变绿。现有三份摘要是已曝光探索素材，可用于核对映射与回退，不能认证全文收益或总体安全。

| stratum | 当前真实资源 | 将来必须独立保存和评分 |
| --- | --- | --- |
| `html_fulltext` | 0 | 官方对应版本 HTML 字节/hash、正文结构/章节、连续 span、表格/图注/公式覆盖与不能解析项 |
| `pdf_fulltext` | 0 | 对应版本 PDF 字节/hash、页码/块/阅读顺序到规范正文 UTF-16映射；扫描/多栏/表格/图像失败单列 |
| `abstract_fallback` | 3 revisions / 5 occurrences | 同版本摘要输入与明确“仅据摘要”标签；只评摘要可支持的事实，不进入 full-text 指标 |
| `acquisition_failure` | 0真实尝试 | robots/HTTP/size/timeout/unknown-version等终态，保留每次重试/bytes/耗时/费用；不只计算成功下载 |
| `parse_partial_or_failure` | 0真实全文 | 空正文、截断、缺表格/图注/公式、顺序漂移、不可定位，影响命题及拒绝/摘要回退理由 |

论文身份/版本配对在模型之前固定。摘要 A 与全文 P 使用同 work/version；P增加正文是独立实验变量，不与 C1“同输入首次提取”混称。HTML/PDF parser及normalizer必须绑定实际 resolved版本、锁文件、配置、输入/输出hash和覆盖账本；优先比较成熟解析器，不新造PDF解析器。当前仓库没有可据本波宣称已选定的parser或测量过的质量/费用。

模型相关 ledger 按臂分别记录 extract、语言修复、引用修复、display primary、独立 quote-only countercheck、validator single/batch 的模型/provider/prompt/cache/thinking/预算及每次实际调用/重试/失败/token/USD/耗时。摘要→全文可刊重要维度增量按已确认事件/维度完整分母评分，未提取/未通过/预算中止留在分母；人工 gold 不喂提取或选择器。全文可用率、章节/关键证据覆盖、可定位引用率、未支持/限定丢失、误接受/误拒、单位可刊成本与完成率按上述分层报告，不能只看句数。

独立审阅须分别判定作者声称、实验实际结果、适用条件、限制及来源所述影响。未知必要表格/图注/公式不能用摘要补正文证据；多段不得拼成伪引语。现行 display-v6仍要求主quote自洽并通过countercheck，未来多span能力需单独版本/eval；URL可达、下载成功、解析出长文本均不等于可刊。真实性硬门维持未支持接受、错误版本绑定、必要限定丢失、跨文档拼接、摘要伪全文均为0；样本零错不是总体零风险。

人工重要性、真实事件、必须保留维度、理解题与盲读效果 pending。沿用原确认；仅在有具体新命题/歧义材料时请求逐项判断。本轮没有本文作者或其他AI自评分，不把待填0/unknown当“没有重要信息”。

新事件的 P shadow 可以在对应版本/权利/来源与样本资源具备后独立准备，不称近期首报，不触发正式阅读卡。旧事件的深读更新 shadow 应配对前刊已发布artifact的命题集合；**生产启用始终依赖不可变命题history、逐项新增重要命题、lineage及共同发布恢复门**。另取新 URL/全文版本不授予续报资格。只有工作推论增量须归I分析回访，P不代签I门。

## 具体缺口与可独立前进的工作

当前阻断是每个论文没有已绑定的同版本全文字节/解析/权利证据，不是模型产生不了长文。可独立继续三项：核对3组归档摘要/官方版本候选链接及来源使用/保留证据；在sources层准备P的结构化全文结果/不可变archive descriptor；建立HTML/PDF解析覆盖与定位审阅工作表。实际来源抓取、模型和数值探索须由集成负责人另行派发，不能以本波文档授权执行。

后续源码入口具体为：

- [arxiv.ts](../../src/lib/sources/arxiv.ts) `parseArxiv`目前只写 `e.summary`，没有PDF/HTML下载。未来在 `src/lib/sources/` 加对应论文版本的shadow acquisition，返回可区分成功/失败/partial的结果及版本descriptor；不把summary正文原地替换。
- [safe-fetch.ts](../../src/lib/sources/safe-fetch.ts)已有SSRF/redirect逐跳检查、超时及流式大小限制；[robots.ts](../../src/lib/sources/robots.ts)已有robots规则。P须走真实网关/策略而非curl替代；二进制PDF读取和逐hop robots/预算需另行实现并评测，不能把readTextCapped当PDF解析。
- [article.ts](../../src/lib/sources/article.ts) `fetchArticle`为HTML文章容器路径，返回null会折叠失败原因，不提供论文版本/页块/表格语义。可复用已核实的网络约束，不因`ARTICLE_FETCH=1`自动取得论文全文或专用证据。
- [collector.ts](../../src/lib/agents/collector.ts)使用归档envelope，既存URL shape受保护；[normalize.ts](../../src/lib/sources/normalize.ts)普通正文50,000字符封顶，[analyzer.ts](../../src/lib/agents/analyzer.ts)普通article仍用前缀截断。P需单独记录截断/解析/章节选段覆盖，不能把摘要article或正文前缀称全文已读。

以上是下一切片责任接口，不是本波新增实现。F、C、I继续各自准备，P缺全文不阻断它们；各专用门互不代证。

## 验证与交付边界

已读取仓库 `eval-gate` 并先核覆盖：本轮只提交文档，私有脚本盘点已曝光输入，不改prompt/模型/来源/validator/dataset标签或报告路径。A1不执行盘点，未跑模型、不盖eval pass章。下一来源/parser/提取实现须走来源重测+A1/适用内部原型安全收据及P独立专用门；旧事件发布还须真实生产路径历史/恢复回归。

实际盘点命令完成，14/14资源、3/3 content-v4/摘要规范正文、5/5绑定归档hash/size/envelope核验。第一次私有准备器运行因把worklist exposure整数计数误当数组而拒绝scope；修正读取后完成，不修改输入、不伪造成功样本。

- Node `24.19.0` 下 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run typecheck`完成；TS7/TS6各app/tools通过。类型检查核对现有树，不包含gitignored私有准备器，也不认证P解析/提取实现。
- 真实 `ops/ci-docs-check.mjs/checkDocuments`：本文1/1通过；`git diff --check`通过。
- 私有准备器 `node --check`通过，资源收据/script/四份artifact hash重新核验一致；private根/子目录0700、全部文件0600，无私有产物进入Git。

非作者审查另由集成负责人安排。只有本文进入Git，私有script/config/artifact均保持gitignored；不push/merge，生产部署/开关仍需具体版本/核验/回退后向用户确认。
