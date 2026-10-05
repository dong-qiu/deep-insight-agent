# D2 / TD-12 首切片：告警渠道职责拆分验证收据

日期：2026-10-05，Asia/Shanghai。验收见 [专属 spec](../plan/specs/d2-alert-channel-extraction.md)。
行为基线 `2bb91519a20cea09fdc387bcab0917728e28cdc4`，交付基线
`64f365682c2a6a4ffa6198f3bb4c57d1e1ab589c`（新增 D1 文档，src 树不变）。
本收据为首次提交前本地结果；候选 SHA、远端复核、full CI/run/attempt/tested SHA 和原始
产物身份后续写 PR 摘要，不提前签 CI 成功、不为补链接改变 head。

## 现场与隔离

已读取 AGENTS、architecture、TD 治理、D1 spec/专属收据、C3/C2b 收据、相关产品推送
契约、operations §12、ADR-0003/0008、L0/L2/L3、交付流程及只读并行计划。
D1 #411 已合入 `4e09ec9`，精确 main CI 37219844193 成功；C2b #412 已合入
`2bb9151`，精确 main CI 37322850784 成功。交付前 #413 D1 文档补记已合入
`64f3656`，其精确 CI 37324076876 docs/success，正常 fast-forward 包含；不当 full 证据。
不把合入或自动镜像构建视为上线，不访问生产。

从最新 main 创建 `refactor/d2-hotspot-pure-slice`、linked worktree `insight-agent-d2`。
只复制 `.env.local`，0600，DATA_DIR/DB_PATH 固定为本 worktree 独立路径；不复制
`.data`、DB/WAL、原文/报告或 `.env.development.local`。依赖由 Node 24.19.0 /
npm 11.17.0 正常 npm ci 安装，锁文件不改。

盘点所有 linked worktree status/branch delta 和可见 Codex 进程；不能可靠映射全部 Session，
不据干净状态冒充交接。C2b 已合入但仍保留其指定文件/测试占用，D2 完全不重叠。
主 worktree ADR/roadmap 修改和4份未跟踪 Brief 文档、Brief density 的3份修改和2份
未跟踪文档均保留。提交前再次核对，无 alert 文件活跃 diff。其他 Session 工作区只读。

## 前后职责与行为保持

| 模块 | 前 | 后 |
| --- | --- | --- |
| runtime/alert.ts | 业务文案/Brief 判定/去重、配置、渠道转换、transport、邮件混合 | 保留全部业务、状态、配置、发送和原 API；渠道函数/类型兼容 re-export |
| runtime/alert-channels.ts | 无独立边界 | 原中性协议类型、渠道识别、请求序列化/签名、应用响应分类；唯一 runtime import 为 node:crypto |

逐字比较原两段类型/helper/函数与新叶模块完全一致；整个余下 facade 也完全一致，
仅 crypto import 换为 leaf import/re-export。旧调用方和测试不改，函数引用身份不变。
email 的 type-only facade import 保留，叶模块不反向导入，无新增 runtime 回环。
没有新增框架、容器、依赖或通用抽象。

真实调用方清单见spec，Job/agent/watchdog/admin/email均保留facade。
ops/probe-alert.mjs仍是既有独立协议镜像，不导入本实现；未运行/修改，不作为正确性证明。

收益是渠道协议成为不加载 DB/email/logger/业务策略的独立入口，协议测试无需邮件或
数据库运行时。没有声称性能提升；文件变小不是独立收益证据。原 logger 初始化和
LOG_LEVEL 读取保留；通知配置仍调用时读取。签名 secret truthy/now 缺省仍读 Date.now，
显式 now=0/负值/秒边界保持；未签名不读时钟。

JSON 字段顺序、undefined 丢弃、换行、tags 顺序/重复、ntfy origin/首路径段、错误分类/
同步传播、应用拒绝日志、HTTP/body-read/transport 失败兜底保持。没有 SQL/事务/连接/
写顺序/fencing/schema/migration 改动，引用白名单/语义一致性/证据可见性/报告发布/
模型/provider/thinking/prompt/预算阈值/评测口径零改动。既有 `null` 响应落“非 JSON”、
字符串 `"0"` 落拒绝等现状已记录，未修复。

## 冻结基线与保护测试

修改 alert.ts 前，从原 facade 冻结19 detection、17完整请求、18响应分类共54合成向量；
时间显式固定或无签名。预期静态入库，测试从不调用新实现生成预期。

- fixture：`tests/fixtures/d2-alert-channel-baseline.json`，SHA256
  `904010bd94b54f234785fef8f54d6c6c212637c02858506c9bde64256c86094a`。
- 原保护测试：`src/lib/runtime/alert.d2-baseline.test.ts`，SHA256
  `4c8c3a9fd802df8af421273a0a7135ccc2089b60153f9099de917b741fc905ec`；提取前/后字节相同。
- 提取前旧 alert 60 + D2 67 = 127/127；提取后同组127/127。首次试跑 fixture 相对路径
  错误导致套件未加载，在原实现仍未修改时修正；不把此失败当行为反例。
- 追加3项边界测试证明 facade 引用身份、无 email/logger/diagnostics 依赖、fresh native
  Node TS import 不读应用配置、不调 clock/random/transport。
- 原67项覆盖完整字节、非法/空输入、默认/历史结构、重复/顺序、输入不变、同步 getter/
  JSON/URL 异常、时钟、真实 notify→adapter→sendAlert 和同步/异步失败；只 mock
  transport、日志/邮件依赖，不 mock 被提取函数。
- facade 初始化测试明确 mock logger/email，只证明 alert 自身无通知配置/投递，不冒称
  真实 logger 零初始化。leaf 导入子进程只传合成 NODE_ENV/PATH，不继承密钥。

## 本地验证

| 验证 | 实际结果 |
| --- | --- |
| 定向 alert/两个 D2/email/jobs，5文件 | 156/156 |
| npm run test:coverage | 250文件、2645 Vitest、150 ops，全通过、零 skip |
| statements / branches / functions / lines | 79.27% / 71.81% / 79.38% / 83.10%，原阈值保留；C2b 收据对应79.25/71.79/79.34/83.08，不称受控性能对比 |
| npm run typecheck | TS7+TS6 app/tools 四项通过 |
| npm run lint | max-warnings=0，通过 |
| npm run build:e2e | 真实生产构建一次19357ms，成功 |
| npm run test:e2e:built | HTTP 6文件7/7，同构建additional_builds=0 |
| npm run test:browser:built | D4 Chromium 5/5，零重试，同构建additional_builds=0 |
| git diff --check / 专属文档链接 | 通过（提交前再次核对） |
| npm ci audit | 0漏洞；CI保留独立npm audit和Docker门 |

早期 typecheck 发现 facade 漏 import 本地仍使用的 PushHighlight、子进程 test env 缺
NODE_ENV 类型字段，两处已修正；只涉及 erased type import 和合成测试 env。之后双编译器、
两份 D2 测试70/70、lint通过，运行时搬移字节未改。coverage运行于相同运行时代码，
最终候选由PR full CI重新完整验证。没有放宽测试或覆盖率门。

本地build/E2E绑定 `2bb9151` 上的冻结工作树/输入/环境；之后仅fast-forward #413文档，
不以本地build冒充提交后的head。未运行本地Docker，候选full CI须补足。原全套继续执行
D1真实连接/迁移、C1删除/协调、C2a取消/fencing、C3 SDK/用量、C2b预算回归；全为
合成数据/隔离库/mock transport，真实通知、付费模型和生产访问均为0。

## 独立审查与 Eval

应用仓库 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md) 和
[eval-gate](../../.agents/skills/eval-gate/SKILL.md)。独立新上下文方案reviewer初报一个
Warning：真实facade有logger初始化，不能宣称零env；spec已修正，定向复核通过，
Blocking 0 / Warning 0。方案reviewer只读未运行测试，不冒称测试证据。

独立最终reviewer逐字核对两段提取/全部剩余facade与54向量hash；自身.cache probe取
git show原实现和字节相同保护测试，独立67/67通过。候选alert/email/jobs/cancellation/
llm-provider/task-budget共8文件201/201、双TS typecheck、4个TS文件eslint通过。
完整7文件（含spec/收据）评审 Blocking 0 / Warning 0 / Suggestion 0；远端diff另行复核。
reviewer读取本地coverage/build/HTTP/browser原始日志，计数/计时/来源与收据一致；两个
文档链接/格式、行为/交付src树身份、精确前置main CI均独立核对。leaf末尾仅去除一个
原分隔空行以通过diff格式检查，定义字节仍相同。
主agent的全coverage/build/HTTP/browser不冒称reviewer再次运行。

AI参数/模型/判断/引用/选择/评测路径零改动，逐字提取、固定字节/真facade接线和原全套
证明正常AI输出/评测语义不变。未运行A1：它不执行渠道转换，不能证明本次拆分。
采用 `Eval-Gate: skip (D2 verbatim alert channel extraction; frozen original facade and delivery regressions pass; AI output and eval semantics unchanged)`。

## 交付、回退和未完成范围

正常hooks提交/推送、Draft PR、独立远端完整diff复核、精确候选full CI；原始scope/
application/Docker JSON、head/base/tested SHA、run/attempt、checks、artifact ID/hash/到期
和计时追加PR摘要。首次提交时未运行候选CI，不预签成功；Actions原产物会过期，
摘要/hash不冒充完整长期归档。PR/CI后停止等待合并授权。

仅alert渠道内聚职责完成。alert业务文案/判定/Set/env/send/邮件、全部其他热点模块、
持久化适配和编排未拆分；D2/TD-12不关闭。下一切片先确认具体共享文件/测试交接，
再冻结纯边界基线；C2b即使已合入也不自动释放范围，C1/Brief同理。

回退只需正常代码revert，schema/ledger无变化。未授权且未执行合并、生产部署、迁移、
恢复、历史修复或branch/worktree清理；没有操作其他Session资源。
