# C2e：RSS/article 显式 source 控制首片收据

本机隔离工程候选，等待最终独立审查/PR/精确 CI；未合入、未上线、未盖 Eval 章。
复 fetch 基线 `cb2f924ee18c14f24b81d1b85679f4d91f5d509d`；继承已冻结方案
`6d2f1205c0e6681f56beeb8d64408c63bbb0065f`（本分支正常 cherry-pick 为 `205b72d`）。
最终提交及全部源码 hash 绑定私有 index；[spec](../plan/specs/c2e-source-cancellation.md)。

## 实际实现与反例

只改六 source 文件及新 `source-cancellation.integration.test.ts`、
`source-return-gap.integration.test.ts`。无 collector、
runtime、arXiv、podcast-shadow、DB/schema、默认配置、CI/Docker、主台账改动。
SourceFetchOptions 只含 signal；registry/RSS 与 article 第三参数透传同一 signal。
入场检查、DNS/hook/fetch 成功异常边界与 body reader/retry 使用 native reason，
null/0/false/opaque object 不经 runtime fallback 替换。仅复用纯 abortableDelay，
成功/异常后 source 再检查原 signal。请求仍保留原 timeout、逐跳 SSRF/DNS/gate。

| 实际受控原路径 | 本机结果与精确限制 |
| --- | --- |
| 七异步入口 + 非 async registry，already-aborted null/0/false/string/object | 同步 throw / 异步 reject 原 reason；零 DNS/HTTP/reader；文章 null 失败返回不冒充取消 |
| registry arXiv 分支 | already-aborted 首因优先；live signal 同步 unsupported、零入队；undefined 原 Promise/queue，API/unknown 原同步 throw |
| 原 DNS 与 QPS hook，晚 resolve/reject | 等真实 settle，取消前 pending；之后零 HTTP/下一 hop/重试，不以 race 宣称提前停止 |
| 实际 fetch，迟到成功/reject | 收到 task+请求 timeout 组合；迟到 body cancel 与 rejection 真 join，cleanup error 不遮 null/opaque 首因 |
| robots/RSS/article 已拥有 Response 的 child-return await 窗口 | 三入口各 cleanup resolve/reject，cancel 恰一次、bodyUsed=true；真实 cleanup pending 期间 source 不 settle，null/opaque 首因保持 |
| redirect 与网络/5xx 退避 | 每跳保留 gate/SSRF；取消不继续下一跳/重试；受控 fake timer 证明 retry timer 清除 |
| reader pending/cancel reject/releaseLock throw，真实 ReadableStream，text fallback | read/cancel 两者真实 settle 后才移除 listener/释放锁；reject 被消费；首因不改。忽略取消的 pending reader 不能签已终止 |
| RSS/article robots 与 payload 的真实 stream 取消 | robots 不 fail-open、文章不 null；feed/article payload 均收到取消，两个 abort 保留第一个 reason |
| 默认与 live 未取消正常路径 | 原输出逐字段等价：RawItem、golden 标题筛选/转写 URL、播客 show_notes metadata、RSS repair/truncate、raw_html/body_html/container；不抓转写 |
| 原正常失败、status、onBytes、body cap、timeout | robots 普通网络/timeout fail-open、404/5xx/cap/accounting 保留；文章非 HTML/短正文/失败仍 null；真实普通网络保持原 1s/3s 两次 retry |
| 原共享 no-signal arXiv 与 podcast consumer | 原 queue 及 transcript/program-page structured outcomes、gate、bytes/status 原测试回归；本片不向它们授予取消能力 |

source 函数没有新增 DB writer；collector 消费 signal 尚未接线，不以本片证明在用
collector 已获得深层停止。预算保持原父作用域/Run 兼容估价，source 没有新增预算 scope。
预算未转 signal 的在途网络仍可能继续，不能宣称费用上界或预算中止网络。

## 验证及失败保全

Node 24.19.0 / npm 11，独立 WT、PORT3121、DB/DATA、本地配置 0600；无真实 source
网络/模型/通知/生产。替换只有 DNS/global fetch/stream 边界，真实 source 函数、解析、
safeFetch/retry/robots/reader、Response/ReadableStream 与原共享调用链保留。

- 实现前保护运行：26 项，21 failed / 5 passed，旧 log 原样保留。该未提交保护测试
  后续有 fixture 修正与新增反例，不将旧 log 签给最终 33 项测试版本。
- 首轮 8 文件：117 pass / 2 fail。两个 fixture 缺陷已定位：stream 自动预取不等于
  getReader 进入；Response.clone 的另一条 tee 分支未消费导致真实 cancel 等待。
  修正为实际 getReader barrier 和独立响应，不用 race 绕过真 join。失败及首轮 TS
  fixture typing 错误原 log 保全，第二轮 119 项及双 TS 通过。
- 后续 18 文件 285 项先通过；收尾发现 retry 包装器的 child-return await 窗口需
  复查。新增真实 Response/status 微任务反例先失败（晚响应错误返回成功），补最小
  source 检查/cleanup 后完成最终回归。这个内部发现不冒称独立 Reviewer 发现。
- 旧 `3947e2dba7bb15e5bf786210e2cb00534275cab5` 的 18 文件 **288 项通过，
  无 skip/未处理拒绝**；包含全部 sources、collector、
  podcast-shadow/store、jobs cancellation、task-budget/unit/integration。
- 旧 `3947e2d` TS7/TS6 各 app/tools、ESLint 与生产 build 通过。原 middleware→proxy
  deprecated warning 保留，不标已消除；旧 build 仅绑定旧 head，不签修复后构建。
- 第二位独立 Reviewer 在旧 `3947e2d` **Blocking 1 / Warning 0**：robots/RSS/article
  已拥有 Response 的 child-return await 窗口取消后，原 reason 正确拒绝，但未发起
  body cleanup，source 提前 settle。其独立原三例 test/redlog/review/index 原字节
  保全；作者在旧 head 用同一 test 字节实际复现 3/3 failed，不冒称静态发现。
- 本轮最小修复仅三个上层 response await 后若 signal.aborted，则 await 原
  discardResponseBody，再拒绝首因；新增永久三入口 × cleanup resolve/reject 六例。
  修复后同选择加新文件 **19 文件 294 项通过，无 skip/未处理拒绝**，双 TS7/TS6
  app/tools 与 affected ESLint 通过，等待两位 delta 独审，未自行清零 Blocking。
  此 source-local 控制修复不改路由/构建配置；本轮不无目的重跑旧 build，PR CI
  对精确 tested 对象的必要构建仍由协调者核验。
- git diff --check 通过。未运行 A1/多源真实质量评测：本轮真实模型预算为 0；本收据
  只签显式控制与所列正常 source 输出等价，不补签历史质量。源码触发 eval-gate，
  已完整读取；最终门由独立审查确认实际 diff/真实路径后判断，未预签 skip。

所有原 logs、源码原字节与最终 diff 私有非覆盖保全，index 记录 size/hash，目录
0700/文件 0600；不将敏感原文/真实报告或日志入 Git。arXiv 与 podcast 专属实现片段未变及
最终受审 head 由 index 核对；PR/tested merge/精确 main CI 由协调者后续登记。

## 保留项与退出

arXiv 全进程 queue/cooldown/429、podcast-shadow 深层 signal/lifecycle、raw helper
内部跨进程 fence、collector 真消费分别为独立工程依赖。DNS/hook/reader 不合作时
必须等待实际终止；不承诺 strict deadline-return、source 子树或全 writer 静默。
原 request timeout 使用平台 AbortSignal.timeout 的行为保留；本机 retry timer 与
reader listener 清理证据不扩称所有平台内置资源可被用户层强制释放。
safe_rollback=null、deployment blocked/hold 与 #435 生产硬阻断保持；无生产授权。
任一未覆盖接口、正常来源语义变化、Blocking 或未知子工作终态均继续阻断对应验收。
本收据不授予维护/部署/回退/生产许可，不清理 WT/分支/原证据。
