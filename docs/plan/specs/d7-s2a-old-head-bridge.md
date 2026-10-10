# TD20 / S2a：旧 head 外置隔离 bridge

本切片仅NEW工具与专属测试，不修改旧生产源码或现S2b守卫。真实模型预算0；旧235045d的真实质量Blocking持续。

## 对象与归属

生产模块固定只动态加载235045d6424640d79c79874a403749c6bd17b823，新工具基线a51c0579310e9a3c380fc1caf2862ef14870ed75分别绑定head/tree/lock/source bytes。旧tracked dirty、版本/依赖resolve错、缺guard在模型发送前拒绝。旧head无observer/logical ID，工具只作wire-signature attribution，不伪造logical call identity。

B独占NEW signatures/bridge/test、本spec与专属收据；既有runtime/LLM/source/DB/route/guard只读。每个worktree独立依赖/DB/DATA/动态loopback端口/产物，无真实配置或live库复制。主台账root独占。

## 准入与传输

install先global fetch拒绝器再验证/import；install失败或dispose仍永久拒绝，不恢复native/default SDK。缺bridge loader不import旧runtime。固定old完整system bytes+schema canonicalhash+model/role+forced tool/envelope唯一归属七code-owned operations，primary base/翻译扩展分别冻结；未知/overlap/body/model/extra envelope失败都拒。静态字符串只解释冻结TypeScript literals/template/static constants，不eval旧源码；schema用旧types和同旧lock的zod。

native destination永远是指定http://127.0.0.1:<port> exactmessages/responses path。Anthropic logicalURL也要求该origin；仅Responses fixedlogical https://ark.cn-beijing.volces.com/api/coding/v3/responses 通过旧provider原预检后，由外置wrapper映射到fixed127/responses。native不接official URL或DNS；gateway/别名/编码/额外path/port/userinfo/query/hash与default SDK公有URL拒绝。固定fake credentials核后仅送本地；native redirect:error不能覆盖，3xx第二sentinel0。未改变旧request body/配置grammar/exports，无通用rewrite或fallback/live模式。

## 计数、取消与证据

默认admissioncap0；反例可对fakeHTTP显式limits，最多100 conservativeadmissions/20 conservativeretry和创建起absolute+monotonic共同45分钟上限。每个旧SDK retry/Responses EOF与validator applicationfetch都先同步reserve。同segment/model/fullbody重复、SDKretryheader>0、重复analysisgeneration或repair为retry并集，不称真实logical calls。每attempt immutable segment，尚在途禁止切segment。

reserve/admitted与native/sendstarted/not_sent/unknown分别保留，native开始不证明远端已接受；最后send前重查control，IO失败不得回退。首cancel/cap/deadline/identity/schema/未知错误sticky incomplete；正常429/合法EOF可继续旧原有retry，桥不改retrygrammar。检查覆盖native await、bodyread、finish；迟到callback/finish不得恢复完成。独立localserver计数不等同conservativeadmission。


- 每个serialized request body UTF8 bytes ≤ 1048576（1MiB）；只准string POST body。Request对象、ReadableStream/AsyncIterable、Blob/FormData/TypedArray、无body、getter/未知输入全部发送前failclosed，不消费未知body流来猜测内容。真实旧合法fixture超过界时停止报出其bytes/来源，不静默改截断或调整旧模型输入。
- 每个response累计raw SSE bytes ≤4194304（4MiB），包括任意chunk和非SSE错误response；单chunk和所有累计量都逐pull检查。Content-Length不可信，仅可提前拒大值，不能代真实累计。超限立即持久sticky incomplete、abort own signal/cancel reader；已观察≤cap的原bytes保全，不把未知尾部补造完整。无EOF/read挂起共同deadline终止，不能自动续时。
- 一个task≤100 conservative admissions，保存原请求+响应+metadata/filebytes累计≤536870912（512MiB）；每次wx write先核剩余，真实实际写入后核累计。任何write/fsync/space-limit错误sticky incomplete，不能跳过证据写入转而发送。已reserved/started的unknown事实保留；不删除旧请求/响应凑预算、不能reuse/resume。
- 默认cap=0。正控只有本地fake HTTP显式syntheticlimits与fakecredential，没有live模式/原qualitypass收据。loopback server独立计数与native-start/conservativeadmission分列。

AC追加：1MiB边界和+1Byte pre-send0；Request/流/unknownbody拒且read0；单chunk>4MiB与多chunk累计+1Byte；合法response无EOF达到共同deadline，晚chunk不可finish通过；临近512MiB最后wx拒/IO失败前后sticky保留、无fallbackfetch；实际旧七operationpayload检查界并保其原bytes。实际old合法fixture超界先报root，不修改grammar/prompt或用mock小payload冒充覆盖。

## 必要实际验证与退出

实际旧callStructured+Anthropic SDK本地429内部retry、Responses原endpoint预检与EOF重试、真实analyze→双coverage/validator实际payload分类；head/hash/lock/missing/defaultSDK/unknown/overlap/0cap拒绝发送；cap101/retry21拒；firstcancel/deadline/late/noEOF/byte/space/IO失败与dispose后拒绝。原模块不mock/patch，mock仅本地provider transport。Node24/env-i假凭据、独立old依赖resolve/version/lock与source冻结；任何网络隔离失败failclosed。

定向受影响测试、四TS的npm run typecheck、scopedlint；最终diff使用pre-pr-ai-review/eval-gate判断，不预签skip，不以不执行工具路径的A1补签。两位非作者方案/最终源码与实际证据复核后，由root正常Git/PR/CI/conditionalmerge处理，tested/head/main分开。

CI准备进程与business child分离：本地没有固定旧commit时只取origin refs/pull/430/head，FETCH_HEAD必须逐字等于235045d；缺失或身份错直接失败，不skip、不用新main替身。旧worktree必须使用旧lock独立npm ci，business child只继承PATH/NODE_ENV与列出的fake credential/control值，不加载真实配置。

每个新建business child有独立父级65秒期限，随后只向该own PID发送SIGTERM；1秒后SIGKILL，再1秒仍无close则封存local terminal unknown并结束父级等待。退出/kill不证明远端终止；结果保留PID、signal、timeout和local terminal事实，不探测或清理其他Session。

512MiB容量case独占fresh child：保留真实HTTP/write/fstat/file size与字节界，仅临时将fsyncSync置no-op，finally恢复。它证明容量控制，不证明真实fsync耗时或crash durability；其余控制/IO反例使用真实fsync。首轮真实fsync容量case触deadline/父级timeout是failed材料，永久保留，不能改写为容量通过。

此片不实现full安全专项runner/跨进程actorlease/prepare/真实model授权/质量收据；这些仍工程与预算分别待办。安全回退null、deploymentblocked、hold/#435不变，生产/历史数据/配置/清理动作不授权；TD20整体部分，不称旧head质量通过或全harness完成。

## R1 五文件恢复移交与窄修复（2026-10-09）

用户已明确授权仅本 spec、专属收据及 bridge/signatures/test 五文件从 executor_b 恢复移交。原冻结 head 为 `570ec795cfbe9e9581f7e3533bb30229daafb74a`，新实现基线为 `08511c458163f52315128efc7fe0cbb9a4d668b9`。协调者 `/root` 负责两份文档，实现 Agent `/root/r1_implementation` 独占三个 TS 文件；原工作区、旧 235 源码与私有原件保留。该移交不释放其他源码或三份主台账。

旧 #463 已耗尽原批评审轮次且有可变控制 Blocking；本轮必须先产生实际修复增量，再按新窄范围独立评审，不重新审查未改的旧 Blocking。旧失败、Warning 与评审结论继续保留。

新增验收标准：

1. install 在任何 await 前只接受明确必需/可选自有数据属性；拒绝 getter、继承字段、未知字段、symbol 和 Proxy，拒绝时不执行 accessor/proxy trap。内部字段映射不得继承原型：缺省可选 limits/signal 不能通过 Object.prototype 的 getter 或数据属性注入，缺省 admissions/retries 仍为 0。必需路径/origin、数值 limits 和原 AbortSignal 引用复制到内部不可变快照；所有后续检查、写路径、事件解绑均不回读调用方对象。
2. 安装前验证与安装期间/之后的外部变更均不能扩大已捕获 admission/retry/window 上限或改变证据目录、旧 candidate、传输 origin 及取消身份。cap=0 后改为正值仍零本地 HTTP；已捕获数值与 snapshot 一致。AbortSignal 本身不冻结，原信号仍可实时取消；替换 options.signal 不能失去原取消或解绑错误对象。信号须通过原生 aborted getter 的品牌检查；后续取消读取及监听器绑定/解绑使用原生 getter/EventTarget 方法，不执行信号的自定义同名属性或方法。伪造 prototype 与 genuine signal 的 shadow 属性均有独立反例。
3. 默认测试准备仅 canonicalize 新建受控临时目录，覆盖 Darwin 默认临时路径及 `/tmp` 别名；生产 bridge 对调用方非 canonical parent、权限或身份错误的拒绝不放宽。默认 evidence 与新建 old candidate 必须使用 canonical 路径。
4. 新增反例先在原恢复源码上复现失败，再在修复后通过；保留原真实旧 SDK/七 operation/429/Responses EOF、发送上限、取消、迟到、目录及 IO/容量回归，不改判定、阈值或业务模型输入。
5. 测试业务 child 使用 Node 24、空白/白名单环境及假凭据，只发真实 loopback HTTP。真实模型预算继续为 0，A1 不执行本工具路径；不生成真实质量通过或旧 head baseline/DCP 证明。

通过本窄片不关闭 TD-20，不证明 full harness、跨进程 actor lease、真实 SSM、全 writer 静默或部署放行。正常 PR/CI/条件式合入沿用用户授权；不操作生产，不清理原工作区或证据。

继承测试覆盖边界继续保留：原 AC 中单 chunk >4MiB、deadline 后晚 chunk、部分 dirty/hash/lock/依赖 resolve/overlap 身份错误及更多未知 body 形态，当前没有逐项独立反例证明。已有同步拒绝、逐 pull/await 后检查，以及真实累计超限、noEOF、错误 head、字节和 IO 回归不等于所有 AC 完成；本轮只收口 R1，不补签这些范围。
