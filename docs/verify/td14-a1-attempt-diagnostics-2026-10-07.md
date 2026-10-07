# TD-14 / A1 后续切片：零付费诊断准备收据

启动与集成基线 `origin/main`：`473e2eeae119b600b63abd78ce886301bd882235`（D6 #422）。
独立分支 `perf/td14-a1-attempt-diagnostics` / worktree `insight-agent-td14`。
[实施 spec](../plan/specs/td14-a1-attempt-diagnostics.md)。真实模型请求 **0**；本轮未选择性能优化，TD-14 保持部分完成。

## 已证明的范围

实际 A1 从模块加载后setup到quality、consistency、display/quote benchmark、汇总/review CSV/hash/manifest/rename/pointer。
quality按topic顺序执行，但analyzer内部候选coverage有Promise.all扇出，不受independent mapper的c=1完全串行化；independent mapper可并行judge/benchmark（当前有效值1）。并行stage从起止取墙钟，request latency之和不是阶段wall。
C4a继续记录setup/quality/consistency/coverage_benchmark/finalizing及main wall；父进程spawn→close补模块加载/退出，IPC补最后progress/hash/manifest/rename/pointer的真实publish wall。
外层与main差值是模块加载、发布、退出和observer混合残差，不给各部分编造精确耗时；失败边界可能重叠，不能再减publish来冒充module时间。

callStructured边界logical UUID与fetch attempt UUID/序号按C3规则；同时使用Job时复用C3身份，默认无诊断不改变Job用量writer/fencing/预算。
SDK内部retry重入真实fetch；Responses EOF retry/refusal在同logical call内增加attempt；validator外层retry、split、主审计、countercheck、语言repair为新call。
per-role/operation的raw call/attempt墙钟及nullable raw usage保存；SDK自发retry header单独记录，其他同callattempt不猜原因。
attempt wall是本地dispatch到body EOF/error/local cancel，包含传输和消费；不是纯provider服务延迟。reported usage与HTTP/协议/质量/取消终态独立。
unknown/partial不变成0金额；所有诊断估价null/unknown，不把legacy fallback或Coding Plan请求数说成金额预算。

cache盘点：runner未传ConsistencyCache实例，故该A1验证不自动复用Job cache；prompt cache按当前getter采样；恢复只能显式经C4b身份/hash守卫。
P0 analyzeChunk不调用coverage backfill；导出的repairCoverage仍在独立真实SDK合成入口验证，不能算成本次实际A1放大。
完成topic可显式恢复其analysis+validation，partial仅复用完整审计chunk，后续validator/所有benchmark仍执行。没有自动恢复/重跑、源checkpoint不改。

## 硬限制与反例

必须成对显式设置attempt上限和共同窗口，缺失/非法值请求前拒绝；0禁止transport。
门在每次actual fetch前同步检查并计数，没有await授权竞态；N+1拒绝后sticky incomplete并abort该作用域。
C2a绝对deadline与请求signal合并传至SDK/fetch/退避，timer未被调度时dispatch/checkpoint/publication仍同步检查Date.now。
父测量wrapper将cold module loading也计入窗口，SIGTERM后最多1s本地退出grace再SIGKILL；不保证provider停止计费或严格物理毫秒退出。

合成测试覆盖：0/1/2/3 cap、同作用域并发、SDK500内部retry、Responses EOF retry、split child、新language repair、countercheck、validator外层retry、exported backfill。
超时/实际SIGTERM、忽略取消的迟到fetch成功、失败后成功回调及finish(true)不能复活不完整；raw snapshot关闭后不追加产物。
invalid/truncated/coverage unavailable/validator基础设施失败不生成不完整completed checkpoint；合法uncertain/not_support保留原verdict。
同限制显式恢复可用，不同上限/诊断关闭恢复零请求拒绝，源hash保持；cold-only防止.env重新注入resume。
prepare-only经真实runner setup采样，网络拒绝哨兵且未请求；退出0仅准备成功，manifest failed/not_evaluated、execution_complete=false，无可复用completed checkpoint。
发布守卫覆盖manifest写后及目录rename后pointer前；rename后失败回写自己的final目录，不重建tmp、不更新latest。IPC确认后退出，parent measurement_complete与质量状态分开。

## 冻结身份及实际准备结果

零请求配置准备使用干净实现提交 `e46452580d8f65aed437851fca14e126d6833a25`，dirty=null / identity_complete=true。
Node24.19.0、npm11.17.0、macOS；lockfile SHA-256 `63427dc25bd41f83b2db7c4842966df364b73d110d7c95c8f693b77eaebbcad2`。
所有模型配置从本worktree复制的0600 .env.local与实际runner/getter核实，不引用历史默认profile。
当前provider Responses；analyzer deepseek-v4-flash、validator deepseek-v4-pro、coverage glm-5.2；thinking false/false/true（coverage explicit）。
协议 `volcengine-responses-forced-function-v3`；analyzer prompt hash `1481ae6c5c7eb7dad82f5a887383236bba281d2777bb473b6de52f72de104d20`，validator contract `deepseek-v4-pro|40e26db3eba1|t0`。
primary/countercheck prompt hashes为 `fb9a0a0e766f4eee5eda95bee16b0341a57edb0843ff63eec7c8fbe7fe7ceece` / `8d34e5bca9b784df93270ee38f8a3fe95b85c3acb78466557053dd32ff7a0bce`。
coverage maxTokens **2048**、primary maxTokens2048、每call1 claim；validator_batch=false；independent concurrency1。
LLM timeout120000ms；topic1800000ms；judge/coverage300000ms；Responses pre-terminal EOF额外retry1、backoff750ms；SDK/validator外层retry不适用（null）。
body10000/batch30000/select1000/consistency window600/batch max8。prompt_cache=false；无resume；无validator cache；P0不backfill。

固定dataset原顺序前1 quality / 12 consistency / 14 display / 8 quote，topic实际1个chunk；这些是未来申请候选，不是付费实验结果。

| 身份 | SHA-256 |
| --- | --- |
| quality原文件字节 | ce284f10d469ffc0d20924e0fc1bf52df29818e25b37de7d7b9282a3a3a84e00 |
| consistency原文件字节 | 0879cbcd63e5b9a65d947a23d09f36d9e13c873144a5ddf9297046acda65b8f7 |
| selected quality canonical JSON | 186ff6ea7547d25c3c302e460de9c07a95b2684495aff1e1cb993eebb07cb82f |
| selected consistency canonical JSON | 21b61d00318c52efd5fa58f60e8acd532c923d9e75199ac395eca214395893b9 |
| selected display canonical JSON | 36064f79d87eef7c2020bf0f4cda07e03301be6c5206d248e446c0dc5898e791 |
| selected quote canonical JSON | 29aeef7782a94cb9b3ec43015dd7b6943d8b35230ccfdcc5f6128e6e9efced09 |
| EvalConfig canonical JSON（键排序） | 22d79dcecb79b1dae6dbe830dac3a6ca30f1814aa37ebedb01b29793d75fa288 |
| 私有diagnostic-plan.json字节 | e335e4c157450532e7ac9bbc4b504be71dd55aca99b02436d1d85668b232310f |

准备wall260.518ms / main35.155ms / publish0.696ms，实际transport0。没有执行quality/模型服务；这些数值只核边界，不是A1服务性能。
未来源码commit/dirty/config/输入变化必须重新prepare并冻结，不能用本准备run恢复真实执行；文档提交本身也会改变C4b保守源码身份。
D7 S2启动有独立worktree，至本次fetch main仍为交接SHA、没有已交付S2 PR；设施可并行，真实测量必须择一明确基线。
D7输入ID变化后的数据/config/源码身份不能与此表混用，不绕checkpoint拒绝。

另保留本轮专用合成接线样本n=1（不执行C4b旧两臂实验）：2 topic/1 pair/display1/quote1，cold/no resume、mock Responses、synthetic-a/v/c、thinking off、SDK/validator外层retry不适用（null）、EOF额外retry1/backoff0、timeout120s/各case30s、cache/backfill off、concurrency1。
源码仍e464525，但收据未提交导致dirty fingerprint `d1a001174a2a16f4696ddbb4b8a4a98c3eab88f764158e06d9fd25f984c1cb69`；与干净配置准备分开。
合成quality/consistency文件字节hash为 `f982436748bd428b70aab7c75773e3bf56bd4eedeaae6057f371f1091aa4281c` / `53163ae37ab89464a664128cc97471e31ae71b605bb9eefb0c03ca8bc3777b19`。
logical10/实际fetch10/observed attempt10；generation2、primary2、countercheck3、consistency_single3；usage reported10、金额仍unknown/null（不是模型费用）。
outer484.139ms/main283.755ms/publish1.583ms；阶段setup32.906、quality25.188、consistency1.490、coverage1.520、finalizing222.642ms。
completed/smoke/incomparable/exit0；原始manifest、checkpoint与请求计数保存在私有目录，脱敏metadata投影为review-evidence.json。
该合成样本只显示finalizing阶段墙钟；此阶段包含CSV子进程等工作，未对CPU/I/O/子进程单独归因，不能推断真实模型瓶颈，不报告P95或提速比例；没有同时运行本会话重负载，不主动flush OS cache。

## 测试、Eval-Gate与独立评审

最终完整coverage/ops退出0：267文件2809测试通过；ops164通过。Statements79.57%、Branches71.98%、Functions79.58%、Lines83.49%，保留原下限。
专属4文件33项、既有runtime/A1回归及C2a/C2b/C3保护随全量门通过；双TS7/TS6 app/tools typecheck、lint零warning、diff-check通过。
首轮coverage2809 assertions通过但6个unhandled rejection、exit1，保留私有原log；修正exit helper在被mock的process.exit返回后继续执行的错误后，全量重跑exit0、无unhandled错误。不以首轮失败冒充通过。
本地不额外build：默认运行模型/参数/应用路由/依赖未变；最终PR full CI必须补构建、HTTP/browser、Docker和现有质量/性能门。

按eval-gate判断为显式opt-in诊断/确定性失败关闭设施；正常请求hash/成功判断及评分、模型/prompt、dataset/baseline、发布白名单不变。
`Eval-Gate: skip (opt-in A1 diagnostic infrastructure; normal model inputs, judgments, scoring and datasets unchanged; real-runner SDK regressions)`。
真实模型A1/scoped safety未获授权且不执行，不提交新质量指标、不做baselineΔpp表或假pass。

独立方案审查要求补无Job上下文/信号、恢复身份/迟到冻结/发布墙钟，均落实。按pre-pr-ai-review新上下文审最终diff，修复提前关闭deadline与空串resume重新注入、rename后失败回写/IPC收尾；最终Blocking0/Warning0。
独立证据审查也为Blocking0/Warning0：核对hash/config/合成计数，修正Responses retry null与finalizing归因边界；未冒称独立重跑全量。
reviewer独立跑29专项+59 C3/C2b+4父进程，最后修正复查3文件52项，均Node24退出0；不是本会话冒称独立。

## 待验证瓶颈与最小真实测量申请

静态调用树证明候选数量会放大primary/coverage audits，引用数量会放大validator judge；split与retry进一步放大请求。
当前Responses只允许EOF恢复，不能从旧Anthropic实验的重试尾部推断当前瓶颈。
尚无实模型墙钟样本，不能判断服务时间、thinking输出、audits还是setup/finalizing为主要耗时，更不能给before/after比例、吞吐或attempt P95。

专项申请候选：上述固定1/12/14/8，**一次**冷进程，无resume/cache复用，保留实际prompt cache=false；最多80 actual attempts（含全部SDK/runtime/repair/split/审计入口），总窗口45分钟，EOF额外retry1、不增并发。
问题是本版本墙钟与调用放大来源；若80触顶或执行缺失，只保留失败原样，不扩大额度、不自动重跑。
停止条件：cap/deadline/取消、源码/input/config身份漂移、基础设施不完整或必要产物发布失败。
Coding Plan金额与套餐额度未知；request cap不是金额cap，在途费用不能强撤。产物仅私有raw样本/阶段/publish/outer wall、usage、checkpoint/hash、质量/争议与baseline状态。
一次样本不能估P95；不作为完整A1、可比before/after、DCP或整体质量证据。真实执行前须重新冻结最终源码，并等待用户明确授权。

低风险候选暂只保留待测假设：减少已证明重复的确定性setup/发布工作（需CPU/I/O分段证据）；同一运行内复用严格相同输入的确定性准备（需identity与产物等价测试）；新跨运行模型缓存涉及语义/身份，另立方案与授权。
本轮不实施这些优化。若实测不是这些热点，放弃候选；不提高并发、不减必要校验/coverage、不放宽白名单、不将更快失败算提速。

原产物在worktree `.private/td14/`（本地exclude、0700）与隔离合成测试目录，不入仓；只复制.env.local且0600，DATA_DIR/DB_PATH为该worktree绝对隔离路径；没有复制.data/SQLite/WAL/原文/报告/.env.development.local。
不访问生产、不合并、不部署、不恢复/清理；最终候选CI核验与质量证据后停止。PR身份/CI/性能warning在PR交付摘要追加，本收据不预先称CI绿灯。
