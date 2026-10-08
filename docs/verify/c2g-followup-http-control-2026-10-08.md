# C2g HTTP followup 请求取消接线收据

2026-10-08。此收据记录作者隔离实现与实际路径验证，尚未独立最终审查、Eval、push/PR、候选CI、
合入或上线。工程基线 `3c6b8b0f0eb4a5335c7a5dd67469cdf7932748d0` 的成功CI不能签本片通过。
专属spec来自已冻结1938方案，两位方案B0/W0只签方案。七文件内容归属B；协调者之后接Git/meta另行交接。

## 实际变化与验证对象

POST持有自身 `createTaskCancellation({signal:req.signal})` 至整个请求finally，在授权成功后、params/body
await后先检查取消，向原 `answerFollowup` 第四参数传canonical signal；现父ALS预算只在core/成功副作用
checkpoint检查。core返回、QA写入、asked审计、成功log和200之间均检查。首次取消不被二次诊断覆盖，
取消早期不为诊断另开DB。普通auth/params/DB/logger早期异常仍rejection，未取消的原响应/普通失败保持。
GET、真实core/模型/prompt/validator/schema/DB/audit/缓存/预算/runtime/UI/middleware/原测试与配置均只读。

真实native saveFollowup COMMIT后私有wrapper取消，原QA行保留且asked/成功log/200被抑制；asked已提交
后取消也保该行。没有QA删除、虚假回滚、跨进程atomic fencing、全writer quiet或provider终态认证。
父预算0在真实SDK前拒绝；adequate/default SDK请求字节语义及结果字段一致，budget不翻译成网络abort。
引用池实际仅pass/support，flagged/blocked不进入请求；普通实际SDK judge400保原errored降级回答。
上述合成输出不证明真实模型质量或旧S2a通过，不使用不执行POST的A1替签。

## 原失败与隔离遗漏（不能由安全重跑倒签）

所有原日志均在私有根 `~/.local/share/insight-agent/evidence/c2g-followup-http-20261008-v1/` 非覆盖保留：

- `route-old-red-first.log`：47个beforeEach失败，fixture非法consistency_reason导致，未进入POST；不是产品红例。
- `route-old-red-behavior.log`：原POST阶段31失败/16通过，另有旧two-request未await双方导致的一个
  late database-closed未处理拒绝，以及旧rate fixture仅第一回复是generation的问题；保留这些准备缺陷。
  其中body取消且question为`?`的case遗漏transport stub，官方SDK使用默认Anthropic endpoint，收到
  `http_error_403`，约1136ms。原输入本身未即时capture；`route-old-red-behavior-input-reconstructed.ts`
  仅从作者自己的编辑序列重建，明确缺证，不能标成当时原件。
- `isolation-omission-v1.json`的最初摘要误写operation_failed；非覆盖`isolation-omission-v2.json`纠正为
  HTTP403已观测。SDK当时没有发送spy/observer dump，精确发送数及Anthropic/中间层身份未知，不探测或查账户。
  **potential externalattempt1，无观测到真实模型成功；不能笼统宣称整个测试准备阶段外部调用0。**
  key由该测试硬编码合成值，无真实key/生产配置；记录只含其hash。SDK/application transient retries均0。
- `route-old-red-final.log`保留中间准备状态；`route-old-red-corrected.log`已从模块首调用前固定loopback
  base和默认fake fetch，31失败/16通过、无unhandled；仍与下述严格URL硬拒版本分开绑定。
- `safe-red-input-route.control.test.ts`、`safe-red-input-fixture.ts`、`old-route.ts`均在安全原路径执行前
  capture；`route-old-red-safe-guard.log`实际31行为失败/16通过、无unhandled。严格fake fetch先拒非
  `127.0.0.1`，SDK显式loopback地址；先保存green源，再仅在作者自有POST临时恢复精确旧源，finally恢复。
- `route-green-first.log`47通过；`regressions-final.log`扩展阶段195通过/2超时：合成judge503触发
  原relay capacity恢复门与后续共享等待，并非本片改变恢复策略。更换普通非capacity400后新日志通过；
  原源/retry/recovery策略保持只读，未放宽超时或修改公共门。

安全路径直接POST测试的global fetch必须先过loopback URL硬拒，再进入fake transport；SDK首创建前显式
loopback base，synthetic key，无实际网络provider。built HTTP/browser child仅显式合成env、loopback provider。
旧遗漏HTTP403不能通过后续成功反例消除，也不构成新预算授权。

## 实际命令与结果

所有作者执行用Node24.19.0和`env -i`，仅PATH/HOME/必要合成fixture路径；没有加载复制的`.env.local`。

| 命令/产物 | 实际结果与绑定 |
| --- | --- |
| 原POST+严格URL guard的47项保护 | `route-old-red-safe-guard.log`31失败/16通过，原输入事先保全 |
| `vitest run`专属54项+原followup/C2a/jobs/cost/usage/DB/diagnostics共12文件 | `regressions-final-fixed.log`197通过，无skip/unhandled；旧fixture/超时日志不删 |
| `npm run typecheck` | `typecheck-frozen.log`最终54项测试源的TS7/TS6各app/tools四套通过；原typecheck日志保留 |
| 五TS文件定向eslint `--max-warnings=0` | `lint-frozen.log`最终源码通过；原lint日志保留 |
| `npm run build` | `build-first.log`真实Next build成功；从992个tracked/作者owned输入复制到0700 clean私有cwd，无.env，node_modules仅链接作者WT |
| 专属built HTTP `vitest --config vitest.e2e.config.ts` | `http-first.log`4通过；真实Auth.js/middleware401/403、POST/GET、SDK/nativeDB及断连 |
| 专属Chromium `playwright test --config tests/browser/playwright.config.ts` | `browser-first.log`1通过；实际登录、报告页POST、reload历史+GET，无外网请求/未改UI |

初轮regression命令有两个不存在的旧过滤名，没有计为运行；最终精确12文件名单在最终日志及验证绑定JSON中，
未把空过滤当通过。build至最终只有测试、helper、spec/收据变化；生产src/config闭包另核hash，真实app构建结果
按该未变字节闭包复用，未为了同代码无目的重建。最终PR/latestmain/tested merge及Linux/Docker必需门待协调者核，
作者本轮未运行Docker，不声称Docker通过。

## 框架映射与剩余边界

真实Node HTTP socket断开，held synthetic provider在release前关闭连接，native failure审计message为cancelled，
QA数量不增加。`http-first.log`保存`observed_canonical_cancelled`、`request_signal_injected:false`，没有
手动new Request冒称框架映射。客户端已无可读响应，不声称观察到了handler的HTTP500；该结果仅绑定本轮
built Next/本机环境，不推广为生产代理/所有连接映射或远端终止证明。已经消费cache/usage与COMMIT不逆改。

真实模型成功未观测；后续安全验证全部合成，无模型/生产授权或付费实验。TD10整体仍部分，未知provider/
subwork、全writer、生产执行继续阻断。safe_rollback=null、deployment blocked、#435和现hold不动。
独立最终审查、事后Eval判断、候选CI/精确main与归档索引属于后续步骤，不在此预签。

worktree/branch/所有原证据保留；私有目录0700、文件0600，原受审源/红绿输入、日志、构建source/artifact
索引与合成SQLite终态由专属`archive-index.json`列size/hash。没有敏感原文/日志入Git，没有清理其他Session。
