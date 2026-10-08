# TD-10 C2g：HTTP followup 入口取消接线（方案）

2026-10-08，工程基线 `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0`；精确 main CI
`37710999247 / attempt 1 / success` 已归档。方案尚未实现、冻结或验收，不能引用父 CI 为新入口通过。
现阶段用户已授权逐个独立任务入口取消/预算传播，本片不重开延期任务，不需要模型或生产调用。

## 原始路径、目标与边界

实际 `POST /api/reports/[id]/followup` 在鉴权、报告状态、问题与限流后，调用
`answerFollowup(db, report, question)`，随后无请求取消检查地保存 QA、写 `followup_asked` 和返回200。
C2c #444 已为真正 followup core 增加可选 signal/deadline/budget 控制，真实SDK/cache/judge路径已有保护；
原历史切片明确未接 HTTP，本片只消费该既有第四参数，不复制或改 core。

目标：将 `Request.signal` 的规范化取消贯穿真实 POST→core→SDK 和 caller 的持久化/成功返回边界；
在 caller 已观察取消时，不启动下一模型操作、保存新QA、记成功审计或返回200。
未观察取消之前已发生的实际 COMMIT 不回滚；等待中止不证明 provider/子Promise终止，也不能撤销费用。
本片不提供全 writer quiet、A3 admission、业务 lease fencing、生产 stop/drain 许可。

保持现 auth、GET、404/409/400/429与普通成功200、普通失败500契约，失败仍
`{error:'followup_failed', message:<现有安全诊断>}`。不新增499、QA状态、API body/预算字段、任务队列或UI取消控件。
模型、prompt、来源、validator/引用白名单、输出 schema、评测口径、历史 DB schema 与审计字段不变。
不读取全系统费用配置为本入口新默认值，不新增 deadline，不声称全系统费用上界。
`safe_rollback=null`、deployment blocked、#435硬门、既有hold不动；模型预算/实际调用均0。

## 归属与环境

方案文件由协调者唯一写入，冻结后明确移交 B，B 串行完成 consumer 修复并冻结后才能实施本片。
不接手其原五路径或 A 的 runtime/dispatch/维护/SSM文件；干净 worktree不释放源归属。
未来 B 唯一内容窗口为以下七路径：

| 路径 | 内容 |
| --- | --- |
| `src/app/api/reports/[id]/followup/route.ts` | POST 生命周期/取消及现有父预算检查；GET不改 |
| 同目录新 `route.control.test.ts` | 真实 core/SDK/native DB 控制反例及有限 caller seam |
| 新 `tests/fixtures/c2g-followup-http.ts` | 仅测试的独立合成 DB/loopback fake provider/clean-cwd服务辅助 |
| 新 `tests/e2e/c2g-followup-http.e2e.ts` | 真 built Next HTTP、auth、POST/GET及取消观测 |
| 新 `tests/browser/c2g-followup-http.browser.ts` | 真浏览器登录/请求与既有报告交互回归 |
| 本 spec | 最终接口与验收事实 |
| 新 `docs/verify/c2g-followup-http-control-2026-10-08.md` | 专属原始证据、受审对象及明确缺口 |

core/followup、runtime取消/预算/LLM/cache、DB/reports/followup/audit/schema、GET、UI、middleware、
现 browser fixtures/seed/config、e2e config、Docker/workflow/policy/gates及主台账均只读。
若这七路径无法满足真实验证，先报告具体差异；不能自行扩大实现或改框架 Request.signal 行为。
helper不是新调度平台/产品代码，不导出生产故障或模型解锁入口。

新独立 worktree/DB/DATA/端口/私有产物；按AGENTS仅复制 `.env.local`，0600并替换隔离 DB/DATA 后才运行。
测试/build使用明确 synthetic 环境；built Next运行在无 `.env*` 的 clean cwd，不能加载复制的真实配置。
只有本机 loopback fake provider可接触；不触发抓取、通知、业务cron，不注入生产/AWS凭据。
测试私有根0700、文件0600；正常临时 fixture cleanup不冒称保留原件，需保全的日志/反例先非覆盖归档。

## 冻结候选接线

1. POST 创建自身 `createTaskCancellation({signal:req.signal})`，其生命周期包括 body解析、core、QA/audit、返回；
   `finally`在所有早返回/抛错清理 listener。规范化任意 abort reason，保留现 C2a 首原因。
2. 合法无取消请求的 auth/报告/问题/限流顺序与响应不变。检查取消须位于每个相关 await 后、
   core开始前以及body解析catch后的明确关口；body读取因abort失败不得降成空问题后继续模型调用。
   无需让未授权请求获得新的行为；forbidNonAdmin仍优先，报告错误/非法输入的既有优先级以反例冻结。
3. `answerFollowup(db,report,question,{signal:cancellation.signal})`；不向core增加 deadline/budget默认值。
   caller checkpoint先 `cancellation.check()`，再消费已经存在的父 ALS `checkTaskBudget()`，不创建全局预算。
   真实 core自行继承现父预算；显式为0的父预算必须在首 SDK发送前拒绝。
4. core resolve 后、`saveFollowup`前、`appendAudit(followup_asked)`前、成功log及返回200前检查；
   同步检查至下一同步写之间不声称跨线程/进程原子 fencing。QA已COMMIT后观察abort则保QA原行，
   不再写asked/返回200，不补删除/回滚，不声称QA与audit是同事务。
5. 取消进入现失败500路径，message使用稳定规范化首原因；失败审计允许存在。
   失败诊断不可覆盖首取消原因。普通 provider/judge/DB失败仍按现安全诊断和失败审计。
   core如果已完成cache/usage记录，caller不逆改它们；late provider completion仍unknown。
6. 每请求有独立生命周期；一个请求abort不影响另一个，也不使进程signal/全局limiter变成取消对象。

此处不要求browser连接断开必然映射服务端signal：必须实测所用Next/HTTP映射。
如果 framework 的abort映射未观测，不以手动 new Request.signal 冒充浏览器断开证据；报告确切限制，
本片只保证真正被传入并已观察的Request.signal。不得为抹除该限制改框架/反向代理或宣称远端终止。

## 必须真实验收与反例

| 场景 | 真实要求 |
| --- | --- |
| pre-aborted signal，包括0/null/普通Error | 真 POST调用真实core边界；SDK发送0、QA0/asked0/非200，规范首原因；不以A1证明 |
| body读取期间取消 | 真实Request.json或明确私有read seam抛取消；不中转为模型调用，原输入失败逻辑有无取消正控 |
| generation/judge中途取消 | POST→原core→实际SDK→无网fake fetch/loopback；真实signal传递、late resolve/reject被消费，无新QA/asked/成功200；不称provider join |
| core完成至caller continuation间取消 | 有限core返回seam可证明caller gap，但另有完整真实core正控，mock不作模型质量证据 |
| QA真实COMMIT后取消 | 原native saveFollowup实际提交后私有wrapper触发abort，QA行保留、asked0/非200；没有新schema/补删除 |
| cancel与预算/DB错误竞争 | 首取消优先，现父sticky预算保留；实际POST父预算0使SDK0；没有显式预算/未取消的合法默认行为保持 |
| 两请求与cleanup | 只一请求取消，另一正常200；listener在早返回/成功/失败均清理，late reject不unhandled |
| 原行为与质量红线 | auth拒绝、404/409/empty/long400/rate429/普通失败500/成功200与GET历史；实际白名单support/flagged/blocked引用池回归，golden合法正常输出保持 |
| built HTTP | 正常合成报告、真auth、POST/GET+loopback fake provider；client abort的真实框架结果原样记录，cleanup不遗留本机server |
| browser与build/Docker | 真Chromium登录/报告页请求/无外网/无UI修改；Next build和必需CI Docker门，local Docker缺失记缺证，不能将skip当pass |

第一轮先保护真实红例，再实施；只对查明原因的失败重跑，同head有效app/build结果可按字节闭包复用。
实际命令需四TS、定向lint、上述路由/core/取消预算/白名单/native、定向HTTP/browser及build。
本片不改AI语义，使用eval-gate选择实际受影响路径回归并事后判断纯接线例外；预算0，不跑无关A1、
不预签skip，不把mock质量/新main CI补签旧S2a质量。需真实模型、语义规则变化或额外费用即停止申请。

两位独立完整方案审查和协调者冻结后才能实现；最终独立审原全diff/实际反例/私有index，不审本人代码。
合并须无Blocking、Warning明确处置、最终受审head/tested merge/最新main关系和必需CI核清，原证据先保全。
精确main CI通过并归档才合下一依赖切片；正常hooks，不直推main，不绕门，不部署。
退出时分别记本片工程、合入、上线，TD10整体仍部分。若需跨A的共享入口/旧数据契约/安全边界，
暂停该差异并提交实际必要项，不以model-budget0掩盖仍可完成的隔离接线工程。
