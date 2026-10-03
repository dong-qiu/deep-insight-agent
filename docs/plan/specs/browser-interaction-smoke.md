# D4 / TD-16：最小关键交互浏览器 smoke

## 范围与前置核对

基线为 `origin/main` @ `065dd0cf7a8f06d4becd093da2f133fc552ce201`。主干 C5、D5 已完成，尚无 D4；旧计划状态不作为实施事实。只新增真实浏览器测试、固定测试依赖与必要 CI 接线，不改 UI、读取性能、schema、运行任务、agent 或证据/AI 判断。

Dependabot #373/#400/#401/#402 在排队，均与 package/lockfile 重叠；本切片不合并或重算它们的分支。用户指定 C2a 只占 runtime/job、pipeline、scheduler、取消传递；现场 C2a 无 package/CI 改动。本切片负责 package.json、package-lock.json 的 Playwright 新增项和 ci.yml 的浏览器安装/执行步骤，不引入其他升级。后续依赖 PR 必须以集成后的主干串行更新。共享 roadmap/ADR 不修改。

## 最小工具与接线

采用固定版本 `@playwright/test`、单 Chromium、单 worker、零自动重试。使用其页面隔离、稳定 locator、自动等待和清理能力，不建第二套平台。维护成本为新增测试包及其匹配的 Chromium 下载；Linux CI 用 `npx playwright install --with-deps chromium` 安装系统库与浏览器，不依赖个人浏览器或生产会话。

`test:browser` 默认先 `build:e2e`；`test:browser:built` 先执行原 C5 verify，再跑浏览器。CI 在原一次 `build:e2e` 与 HTTP E2E 后使用 built 入口，不额外 build。保留 coverage、audit、P1 和独立 Docker 门。浏览器运行实际 `.next` 构建，使用无 env 文件的临时服务目录和合成运行配置；不复制开发配置到运行目录。

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

交付可重复命令、脱敏收据及 Draft PR；不合并、不部署、不访问生产库或清理其他分支/worktree。覆盖不包括 Firefox/WebKit、完整移动设备矩阵、全业务流程或浏览器性能；浏览器 P95 未测，不宣称通过。
