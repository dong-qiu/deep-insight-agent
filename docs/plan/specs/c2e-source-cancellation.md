# C2e：RSS 与文章源请求的显式取消（待冻结方案）

调查日期：2026-10-08。fetch 后 `origin/main` 精确基线
`cb2f924ee18c14f24b81d1b85679f4d91f5d509d`（#448）；本文件仅方案，未实现、
未运行取消验收、未盖 Eval 章。承接 [C2a](c2a-task-cancellation.md)、
[C2b](c2b-task-budget.md)。C2d collector 候选 `74053b6292f06c1499c071e6db5936e87ff6d399`
只读参考，尚不能以本基线或本方案补签其已接入深层来源取消。

## 实际路径与最小范围

| 实际入口/子工作 | 基线事实 | 首片提议 |
| --- | --- | --- |
| fetchFromSource → fetchRss → applyGoldenSource | registry 无控制；RSS 单独查 robots，再 retry、读取、解析、截断条数与金牌源处理 | 可选 signal 只接 RSS 分支；正常后处理不改 |
| fetchArticle / fetchArticleBody | container 为第二参数；robots、retry、reader 后抽全文，catch 全返 null | 第三可选 options.signal；显式任务取消向外抛，普通失败仍 null |
| safeFetch → DNS → beforeRequest → fetch → redirect | DNS 无取消接口；逐跳 SSRF 检查；HTTP 仅 AbortSignal.timeout，总 timeout 不随跳数重置 | check/真实 await/check，传任务 signal 与既有请求 timeout 的组合；逐跳仍过原安全门 |
| fetchWithRetry | 网络/DNS/timeout、5xx 默认 1s/3s；安全错误与 4xx 不重试 | 显式取消不重试；仅 opt-in 退避可取消，默认分类/次数/时长不改 |
| fetchRobots → readTextCapped | 网络错误 fail-open；5xx deny-all；超限及 PodcastRequestBudgetError 向外抛 | task signal 已取消时保留其 reason，不能被 fail-open 吞掉 |
| readTextCapped | streaming cap 8MB；RSS 截断不包含触顶块并配 XML repair；无任务 signal | opt-in reader 取消与真实 join，保持正常 cap/bytes/正文 |

目标是这两个真实来源入口的显式取消透传及后续工作抑制。来源、解析、正文抽取、
robots 规则、SSRF/逐跳 DNS、安全边界、QPS hook、限额、重试与默认超时策略不变。
不新增全局 deadline、env、任务平台、模型调用或来源策略。源函数不写业务 DB，
不替代 collector 的 ownership/提交 checkpoint，也不证明全 writer 静默。

## 建议接口 v1 与责任

- sources/types.ts 新增轻量 `SourceFetchOptions { signal?: AbortSignal }`，不扩展未被
  消费的 SourceAdapter 框架。fetchRss(source, opts?)、fetchFromSource(source, opts?)
  接收它；fetchArticle(url, container?, opts?)、fetchArticleBody 同步透传。
  旧参数、返回类型、同步/异步错误形式与无 signal 默认路径保持原样。
- registry 保留原非 async switch 函数形态：首先 `opts.signal?.throwIfAborted()`，
  已取消时同步抛原 reason（包括 null/opaque primitive），零 queue/DNS/HTTP。
  仅 live 显式 signal 的 arXiv 在入队前同步 `throw new Error("source_cancellation_unsupported")`；
  不转 rejected Promise、不静默假称支持。signal 为 undefined（含空 options）的 arXiv
  仍返回原 queue Promise；无 signal 的 API/未知类型仍保留原同步 throw，RSS 仍返回
  原异步 Promise。RSS Promise 内取消按异步 reject 向外传播。这是新增 opt-in 参数的
  能力边界，须协调者/Reviewer 冻结后才实现；direct fetchArxiv 不新增参数/取消能力。
- SafeFetchOptions、robots options、readTextCapped options 各加同一可选 signal；
  不改 podcast transcript/program-page 的 options、结构化结果或启用策略。
  source 检查统一使用 `signal?.throwIfAborted()`，保留 null、opaque object/primitive
  原 reason 身份；不能复用 runtime throwIfAborted 的 `??` fallback，也不能只靠
  instanceof Error 判断取消。可复用已有纯 abortableDelay，但其成功与异常后均先
  `signal?.throwIfAborted()` 恢复真实 source reason，再保留未取消的原错误；共享
  runtime 不改。不导入 Job/DB/budget、不开父 scope、不造第二套 cancellation 框架。
- caller 持有首个取消原因与绝对 deadline 作用域；sources 只消费 signal，不重置
  deadline、不创建 task scope、不覆写 signal.reason。组合请求 timeout 只为 transport；
  task signal 已取消后成功/异常边界均重新抛原 reason（对象身份保持），普通请求
  timeout 仍按原重试/fail-open/null 语义处理。取消诊断不得回显 URL/正文/凭据。
- 父 budget 仍由 C2b/C2d 作用域与兼容 Run 估价检查负责。此 API 不清空或放宽父门，
  不新增金额参数/计费/预留。父预算故障未变成 signal 时，源请求仍可能继续，collector
  原 after-await budget checkpoint 拒提交；不能把 signal-only 接口称预算可中止网络。
  collector 未来接线需单独交接，按 source.type 选择有能力的入口，不改本轮冻结源码。

## 异步边界、清理与实际终止

1. 已取消则 DNS/robots/payload/reader/退避零新工作。每个 DNS 与原 beforeRequest
   hook：check → await 原 Promise → 成功或失败后 check。不得 Promise.race 提前返回；
   DNS/hook 不支持 signal 时真实 settle 后才收尾，期间不能宣布静默或发下一 HTTP。
2. 每个 HTTP hop 传任务 signal 与原剩余 timeout 的组合；await 实际 fetch settle 后
   再检查。忽略 signal 的迟到 Response 在抛取消前请求其 body 取消并等待实际清理；
   迟到 reject 不启动 retry。opt-in redirect/5xx 丢弃响应先完成 body cleanup，再
   check 后进入下一 hop/退避；无 signal 的原请求行为不增加策略或 gate 调用。
3. reader abort listener 请求 reader.cancel(reason)，捕获并等待 cancel Promise；
   必须等待已经启动的 read/cancel 真实 settle，再 finally 移除 listener、释放锁。
   cancel 抛错不能遮蔽首个 task reason，不能放任 unhandled rejection；不能在 pending
   read 时 releaseLock 或后台 detach。无 reader 的 text() fallback 也完整 await 后
   check。不能把忽略取消的 reader/hook/DNS 强称立刻停止或严格 deadline-return。
4. 检查所有早返与 catch：取消不能成为 robots allow-all、文章 null、RSS 部分成功、
   网络 retry 或金牌源后处理结果。正常 HTML/非 HTML、短正文、robots 拒绝、网络不可达、
   RSS repair/body_kind/RawItem、源后处理必须与原无控制结果逐字段等价。

## 文件归属、依赖与退出

本 Session 当前只写本 spec，WT `insight-agent-c2e-source-plan-20261008`，端口 3120，
独立 DB/DATA。实施建议独占 sources/{types,index,rss,article,robots,safe-fetch}.ts
的上述小段与新 `*.source-cancellation.test.ts`/integration 文件、专属收据；既有
测试只读保护。其他 Session 的 analyzer/shadow-first-extraction 不接手；共享 ledger、
collector/runtime/dispatch/DB/raw helper、config/schema、package/CI/Docker 不写。

以下是后续工程依赖，不能算预算/生产授权阻塞或整体完成：arXiv 全进程 queue、429
重试与 cooldown 取消；podcast-shadow 的来源 signal、host wait 与 sink/close 生命周期；
raw helper 内部跨进程 fencing；C2d caller 的真实参数接线。DNS/不合作 hook/reader 的
未知终止仍维持维护阻断。共享 helper 未传 signal 的 podcast/arXiv 行为必须原样。

## 先反例、后实现验收

仅 fake DNS/global fetch/真实 Response 与 ReadableStream 替换外部边界；保留真实
registry/RSS/article/robots/safeFetch/retry/reader，无真实来源/模型/生产访问。

| 反例 | 必须证明 |
| --- | --- |
| 入场 abort(null)、opaque object/primitive（含 0/false），首次 reason 后再 deadline/第二 reason | 零 DNS/HTTP/read；逐入口实际抛出/reject 值与原 reason 相同，null 不是文章正常 null 返回；不转 fallback Error/allow-all |
| DNS/hook 成功或异常前取消，忽略取消迟到 resolve/reject | 真 join 后退出，零 payload/下一 hop/retry，零 unhandled |
| robots transport/reader 取消；正常网络失败/404/5xx/超限 | 取消抛原 reason；普通 fail-open/status/cap/onBytes 原语义不变 |
| HTTP in-flight signal、redirect 每跳、5xx/网络退避取消 | 实际 fetch 收到组合 signal；取消零新请求；默认重试次数/延迟及 SSRF 拒绝不变 |
| reader pending、cancel/cleanup reject 与 abort(null)/opaque reason 同时发生，迟到 fetch body、text fallback | read/cancel 真 settle，listener/lock/timer 清理；清理异常不改首 reason、无 unhandled |
| retry delay 成功/异常与 null/opaque 取消竞争 | delay 两种 settle 后 source signal 检查恢复精确首 reason，不采用 runtime fallback；不再发请求 |
| 不传 signal 与未取消 signal，同 synthetic feed/article | RawItem/全文 raw_html/body_html、golden/metadata/cap/repair/container 等价 |
| registry arXiv already-aborted、live signal、undefined/空 opts，原 podcast transport | already-aborted 同步抛原 reason 优先于 unsupported；live signal 同步 unsupported；undefined 返回原 queue Promise，零额外能力推断；无控制 structured outcomes/QPS hooks 不改 |

定向新增测试及原 safe-fetch/robots/article/fetch/parse/golden/transcript 集成回归，
双 typecheck/lint、相称 build；测试从真实 production source 路径取证，wrapper mock
不能证明取消已传给子请求。无修改实现的本方案不运行这些测试、不作通过签署。
触 sources 后须按最终 diff 使用 eval-gate；只有真实正常路径证据证明来源/AI 口径
不变才可判断门，不预签 skip、不以不执行该路径的 A1 代替。若正常策略/输出改变、
资源终态未知或接口不明确，停止实现并交协调者裁定；safe_rollback、deployment hold、
#435 生产硬阻断保持原状。方案与实施需独立 review，接口接收不等于运行验收。
