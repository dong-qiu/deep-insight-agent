# D4 / TD-16：最小关键交互浏览器 smoke

## 范围与前置核对

初始基线为 `065dd0cf7a8f06d4becd093da2f133fc552ce201`；首先整合 `b2a12e762bff6913dc4c0e1e8583e4a7491d1307`（#405/#407/#408 的 CI 优化），冻结前再整合最新 `origin/main` @ `8a96b862894cbb65fdfd64f301469ad1ba37cdb4`（#406 C2a 已合入）。主干 C5、D5 已完成，尚无 D4；旧计划状态不作为实施事实。只新增真实浏览器测试、固定测试依赖与必要 CI 接线，不改 UI、读取性能、schema、运行任务、agent 或证据/AI 判断。

Dependabot #373/#400/#401/#402 在排队，均与 package/lockfile 重叠；本切片不合并或重算它们的分支。用户指定 C2a 只占 runtime/job、pipeline、scheduler、取消传递；现场 C2a 无 package/CI 改动。本切片负责 package.json、package-lock.json 的 Playwright 新增项和 ci.yml 的浏览器安装/执行步骤，不引入其他升级。后续依赖 PR 必须以集成后的主干串行更新。共享 roadmap/ADR 不修改。

## 最小工具与接线

采用固定版本 `@playwright/test`、单 Chromium、单 worker、零自动重试。使用其页面隔离、稳定 locator、自动等待和清理能力，不建第二套平台。维护成本为新增测试包及其匹配的 Chromium 下载；Linux CI 用 `npx playwright install --with-deps chromium` 安装系统库与浏览器，不依赖个人浏览器或生产会话。

`test:browser` 默认先 `build:e2e`；`test:browser:built` 先执行原 C5 verify，再跑浏览器。CI 在原一次 `build:e2e` 与 HTTP E2E 后使用 built 入口，不额外 build。当前完整 PR 仍分类 full：application 内保留 coverage、audit、P1、一次构建/两条 E2E；container 从同一事件 SHA 独立构建，与 application 并行。原 verify/docker 必需检查仅汇总各自成功结果，全部完成才可收口，文档轻量结果不能替代 D4 的 full 证明。浏览器运行实际 `.next` 构建，使用无 env 文件的临时服务目录和合成运行配置；不复制开发配置到运行目录。

## 验收标准

1. 登录：匿名访问 `/opportunities` 跳转登录；填写真实登录表单的合成 viewer 账户后页面允许访问，管理页面仍受保护；点击退出后再次访问受保护页重新跳登录。每例全新浏览器上下文，不注入 cookie。
2. 证据：机会页展开 details，核对读者面待验证假设、引用摘录、来源链接、观测日期；同一页面/同一摘录的两条引用计为 `1 个来源页面 · 1 段原文 · 2 条引用记录`。不声称两条引用是两个来源。fixture 有同 batch pass/support/pass、v6 kept/hash 精确绑定、source_quote_v1、可读 v1 envelope 与 committed effect。另一个隔离空 fixture 含不合格候选，验证被过滤后的合法空态；不绕过门制造内容。
3. 图谱：合成已知实体在不同主题/时间窗下有不同节点/边集合；通过表单点击应用切换，键盘操作最小共现 slider，断言精确节点/边及阈值无边提示。点击按实体名称定位的 SVG 节点，核对侧栏；点击经 hit-test 确认的空白恢复选择。合法无图主题显示提示，不判为错误。不依赖节点坐标随机性或截图像素。
4. 窄屏：固定 `390 × 844` viewport，真实登录、导航到证据页、展开证据、访问图谱、退出。关键控件通过 actionability 与中心点 hit-test 确认可操作；证据正文和来源可访问，页面 `scrollWidth <= clientWidth + 1`。不以截图文件存在代替断言。如发现 UI 缺陷，不顺带修 UI；记录独立修复范围，并保留真实失败，禁止 skip/xfail。

## 隔离、失败与清理

每个 fixture 独立 mkdtemp DB/归档目录、动态 loopback 端口、合成账户与 AUTH_SECRET；服务只监听 127.0.0.1。复用现有 openDb/migrations、raw archive 写入与 analysis/validation 保存接口，不调用模型或抓取来源。浏览器请求限于本测试服务，外部导航 fail-closed。无 storageState、trace、video 或配置/服务原文日志产物；失败输出仅测试断言和合成页面材料。

通过有超时的 HTTP health 成功和服务进程存活条件等待就绪，不用长固定 sleep。成功、失败、启动异常均关闭自有服务和浏览器，删除自有临时目录；只对自己的 ChildProcess 发信号，不扫描/终止其他会话进程。浏览器 runner 自带上下文/浏览器 teardown，服务 fixture 使用 finally。

## 验证与交付

四类 browser smoke、现有 HTTP E2E、TS6/TS7 app/tools、lint、应用构建与 CI coverage/audit/Docker。新增测试和配置另做定向 ESLint。最终 diff 使用 pre-pr-ai-review 新上下文独立审查并修正复查。仅测试/工具接线不触发 AI eval；未运行不相关完整 A1。

冻结候选后按 [交付证据流程](pr-delivery-evidence-workflow.md) 将候选 SHA、实际测试 SHA、run/attempt、各项结果与 artifact 身份记录在 PR 摘要；不只为补 CI 链接更新 head。交付可重复命令、脱敏收据及 Draft PR；不合并、不部署、不访问生产库或清理其他分支/worktree。覆盖不包括 Firefox/WebKit、完整移动设备矩阵、全业务流程或浏览器性能；浏览器 P95 未测，不宣称通过。

## 退出后保护恢复缺陷：历史发现与独立修复

优化 CI 首候选在退出后再次访问受保护机会页失败。加强测试为先观察真实退出 POST 响应、合成 session cookie 从存在变为零，再保留登录 DOM/退出按钮消失与再次访问保护断言；不清理 cookie、不重试导航、不增加测试 retry。加强版本本地单次 5/5，但登录重复 20 次仅 16/20，四次均在 cookie 为零和登录页呈现后再次访问成功，DOM 包含合成账户及受保护机会内容。因此不能以单次 CI 成功宣称该交互可靠或 D4 已关闭。

独立修复范围：认证 middleware 的会话 cookie 刷新、退出 server action 与在途 RSC/预取响应的竞争；验证退出响应与迟到响应的身份/时序及保护页面实际响应，增加确定性回归。历史发现时确切根因尚待确认。该修复另立 spec/PR，不在本 D4 修改页面、认证或 runtime，不改 reader/AI/schema/C2a。修复并整合后，重新运行同一零重试 smoke 与最终候选 full CI 才可解除交付阻塞。

用户随后授权独立修复。认证修复见 [#409](https://github.com/dong-qiu/deep-insight-agent/pull/409) 与 [专属 spec](auth-logout-protection.md)，基于 main 8a96，只让 middleware 校验会话时停止写 session cookie；真实 Auth.js 四种迟到响应反例修前失败、修后通过。D4 以该独立修复分支为测试差异基线，完整测试增量仍是上述十个测试/工具/文档文件。现有 CI 只监听以 main 为目标的 PR，#404 保留 main 目标并明确依赖 #409；因此相对 main 暂时包含独立认证六文件，认证先合入后的 D4 差异才恢复十文件。本 Session 不合并。原严格登录、证据、图谱、窄屏断言保持不变；复验及最终 CI 证明见收据/PR。普通页面不再滚动延长 JWT 的行为取舍由认证 PR 单独交付。不将两个未合入 Draft 写成主干 TD-16 已关闭。
