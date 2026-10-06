# Daily Brief 解析与提取小样本试验

> 2026-10-01 · 探索集试跑，不是 S1 留出验收或生产启用依据。

## 边界与输入

- 在独立 worktree `feat/brief-density-extraction-probe`（起点 `911e2d2`）执行；`.env.local` 为 0600，`DB_PATH`/`DATA_DIR` 指向本 worktree 的隔离路径。只读使用 S0 的离线快照、同版本原文归档和编辑标签，没有重抓网页、业务 DB 写入、通知或发布。
- 输入池 `export-6815e74/candidate-pool.jsonl` 的 SHA-256 为 `83c88f8274111c792ab4d45698dfefc8e52533103c7b600d509c08b5480ea207`。31/31 份材料的正文 hash、归档文件、内容版本和证据缺口检查通过；101/101 个既有标注片段在已采正文中按 UTF-16 位置及文本 hash 匹配。31 份分为 arXiv feed 摘要 13、RSS feed 文本 11、RSS 文章页 7。标签仅覆盖已采正文，尚无独立原始网页／论文全文语义审计。
- 私有脚本、模型原始输出、用量收据和原文均在 gitignored 目录 `.data/brief-extraction-probe/`，仅汇总数字与观察进入此文。试跑脚本的 SHA-256：Readability `5cd4cef3e4fab5f696361f43837bce5c60a5937021455e17d1d3731426cfea94`；直接模型 `c31808049de4c60ea40f1a4699711252b9ac18deeb5157b76e9ebd5fe4e72da7`；LangExtract bridge `8ef2cad0a41b117a8663546ab667541df3289fd40e99d7bc3de42c23e34d90f9`、runner `fc6315eaddd2922627ae532196f9e9a26f7d4f11a5c56dc32540a41eed25be43`。

## P：同版 HTML 的 Readability 对照

使用 Node 24.19.0、`@mozilla/readability` 0.6.0、`jsdom` 26.1.0，输入 7 份归档 envelope 内的原始 `article_html`，不访问线上 URL。7/7 解析成功；原有 24/24 个标注片段可在解析结果中经空白归一后找到。解析结果长短都有变化：例如 E19 从已采正文 1,933 字缩至 913 字，E21 从 1,642 字增至 3,771 字。长度和原有片段留存不能证明增加的重要事实或噪声减少；新解析文本尚未做独立原文标注，也未建立回原始 HTML 与规范化 ContentItem 的生产级 locator。

**当前判断：** Readability 能直接调用，但暂不替换现有解析器。先确认哪些文章页确实漏掉重要正文，再在这些页上检验正确增量和引用安全。

## C：固定来源输入和模型的首次提取探索

同一来源版本、同一可见正文和模型 `deepseek-v4-flash` 下，对比：现有 analyzer system/schema 的单源原始输出、直接字段化事件／事实提取，以及 LangExtract 1.7.0 加自定义薄 provider 适配器。LangExtract 调用同一项目运行时的 `callStructured`，由包自身完成提取格式、片段解析和位置对齐；每源一次模型请求，未换模型。三个源分别代表 arXiv 摘要 E02、文章页 E03、长 RSS 正文 E24。每请求 `maxTokens=6000`；E24 两个直接臂都仅见当前默认前 10,000 字。此试验的单源用户提示不等于历史多源 batch，且三臂系统提示和输出 schema 不同，因此只是策略可行性对照。

| 材料 | 现有 analyzer 原始输出 | 直接字段化输出 | LangExtract 输出 |
|---|---|---|---|
| E02 | 4 条 insight；5/5 quote 在可见正文唯一逐字匹配；输入/输出 token 4,349/1,100 | 1 个事件、6 条事实；6/6 quote 唯一匹配；1,095/481 token | 8 个片段、8/8 `match_exact`；881/623 token |
| E03 | 3 条 insight；6/6 quote 唯一匹配；4,354/996 token | 1 个事件、6 条事实；6/6 quote 唯一匹配；1,100/546 token | 7 个片段、7/7 `match_exact`；901/665 token |
| E24 | 4 条 insight；7/7 quote 唯一匹配；6,344/1,255 token | 请求超时，无可评分结果或可确认的 usage | 未运行 |

E03 的现有 analyzer **原始候选**把来源 `$3.36 billion` 写成“36 亿美元”，虽然引用逐字可达；字段化输出及 LangExtract 属性保留了“33.6 亿美元”。现有候选还未经过展示审计和 validator，不能据此声称错误会进入报告。字段化输出提到了票据在 IPO 完成后转股，而该细节不在此次单源 analyzer 输出中。E02 的现有输出分成 4 条 insight，字段化输出归为一个事件；LangExtract 的 `event` 属性却把同一研究标成 8 个不同事件，表明精确定位并不能代替事件归组。E03 的 LangExtract 属性部分仍为英文，也需下游改写与独立校验。各臂的事实／片段数量不可直接视作重要信息覆盖率。

LangExtract 首次适配的 JSON 形状与包的解析约定不符，E02/E03 各发生一次**有 token 用量回执但零片段**的请求；修正为包要求的 `fact`/`fact_attributes` 格式后才得到表中结果。这两次失败也属于真实实施成本，未从试验记录剔除。E24 字段化请求设置 90 秒 caller deadline，最终约 154 秒后以 `TimeoutError` 结束；没有最终 usage 回执，不推断为零成本，也不重试凑结果。表中是 provider 返回的输入／输出 token；E03/E24 现有 analyzer 另有 cache-read token。模型价格使用运行时估算兜底，不能据此比较实际美元支出。以上 quote/位置检查都是机械必要条件，未做独立语义支持判定或读者理解试测。

## 决定与后续门

直接字段化提取值得作为 **C1 的首个正式候选**：E02/E03 展示了事件内互补事实的可行性；同时 E24 的超时与额外背景事实表明需要预算、优先级和失败降级。LangExtract 已证明可通过薄适配器复用现有模型与精确对齐，但本配置未展示独立的内容质量或归组收益，暂保留为定位方式候选。Readability 只进入已证明正文缺损的 P 对照，论文全文工具仍须等待受控全文输入。

先完成 S0 的来源家族筛查、逐事件事实供给核对、独立原文审计与留出封存；再在固定候选全集上按协议比较 P、I、C1、C2，人工盲评重要事实、限定、归组、阅读与引用语义。此次没有修改生产 prompt、模型、数据源、validator 或评测集；A1 不执行本私有试跑路径。`npm run typecheck`、`evals/brief-density/export.test.ts` 11/11 及私有脚本语法检查通过。S0 草稿 PR 保持未合并，本分支试跑也不作生产接线。
