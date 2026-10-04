# D4 / TD-16：最小关键交互浏览器 smoke 收据

验收见 [专属 spec](../plan/specs/browser-interaction-smoke.md)。本切片仅测试与必要工具/CI 接线；不合并、不部署、不读取生产，不关闭其他技术债。

## 基线、文件归属与隔离

- 启动读取 AGENTS.md、独立计划工作区的并行实施计划/preflight、最新主干技术债清单及 C5/D5/B4 收据和 E2E 配置。fetch 后 main 为 `065dd0cf7a8f06d4becd093da2f133fc552ce201`；[main CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37137081561) 和镜像发布成功，不推断生产版本。
- 主干没有 D4 实现；C5、D5 已完成，不按旧计划重复实施。从该 main 创建 `feat/d4-browser-smoke` / `insight-agent-d4`。仅复制 gitignored .env.local，0600，DATA_DIR/DB_PATH 指向该 worktree；没有复制 .data、SQLite/WAL、报告或 .env.development.local。
- Dependabot #373/#400/#401/#402 的 package/lockfile 排队状态已核对；不合并、重算或升级它们。C2a 现场改动位于运行/agent/DB 等路径，没有 package/CI；本切片独占新增浏览器依赖、scripts 和 CI 浏览器两步，不触及其运行逻辑。共享 roadmap/ADR 与原工作区六项未提交文档均保留。
- 固定 `@playwright/test@1.63.0`，锁文件仅根 devDependency 与 @playwright/test、playwright、playwright-core 三个新 entry。逐 entry 核对其余版本和内容不变。无其他依赖升级，Node/types、vendor、overrides、Dockerfile、C5 校验脚本不变。
- 每例新建临时 DB/归档目录与本地端口，seed 合成 viewer；服务仅 127.0.0.1、环境白名单。临时运行目录只链接已验证的真实 .next、public 和 node_modules，无 env 文件，不继承真实 provider/通知凭据。运行 next start，浏览器限于该服务 origin；无模型、外部抓取、生产 cookie。
- Playwright 管理浏览器/上下文 teardown；服务 fixture finally 关闭自有 ChildProcess（SIGTERM，限时后 SIGKILL），再删除自有临时目录。首次失败与后续成功运行后临时根目录数均为 0。没有扫描终止其他进程或清理其他工作区。trace/video/screenshot/storageState 均不生成；仅有忽略目录下的合成失败 DOM/断言材料，没有生产内容或 cookie 产物。

## 实际覆盖

| 类别 | 浏览器断言 |
| --- | --- |
| 登录 / 权限 | 匿名机会页跳登录；真实表单填写合成 viewer；登录后机会页允许、admin 重定向且管理导航隐藏；退出完成后再次访问机会页受保护 |
| 引用 / 证据 | 展开/收起 details；待验证假设与引用事实分开；准确摘录、来源 href、观测日期；同一来源/摘录的 2 条引用显示 1 页面 / 1 段 / 2 记录，展开只 1 li |
| 证据空态 | durable 候选仍存在且引用旧 pass，但没有 committed v1 归档；真实 reader 门隐藏机会与摘录，显示合法空态 |
| 图谱 | 全历史 4 节点/2 边（准确 Atlas–Beacon / Cedar–Delta）、阈值 2 为 2 节点/1 边（Atlas–Beacon）；近 30 天排除 60 天旧 pair；单次共现主题阈值 1 有图、2 无边；空主题合法提示；按实体名称点击 Atlas、侧栏同表述 2 条及两条未入报告记录、hit-test 空白点击清除 |
| 固定窄屏 | 390×844；导航、证据展开及来源、图谱应用/slider、退出可操作；中心点命中验证遮挡，兼容 inline 链接换行的 clientRects；首页/机会/图页页面级横向溢出不超过 1px |

fixture 沿用 v6 kept/hash 绑定、source_quote_v1、同 batch pass/support/pass 与真实 raw-archive committed v1 envelope；没有放宽 validator 或原文门。图谱日期使用真实 batch.created_at 口径，实体和阈值断言不依赖随机布局坐标。来源 href 定位经过 DOM 核对，不导航 example.test。

首次诊断暴露测试定位问题：details 的 has 必须相对于目标 details；select 的包裹 label 名含选项文本；换行链接 bbox 中点可能在空白。均修正测试，没有改 UI 或削弱内容断言。退出只等待 URL 时可能在服务动作/导航结束前启动下一导航，现改为同时等登录 heading 和退出按钮消失。初切阶段当时未确认应用缺陷；后续优化 CI 与重复验证发现真实退出后保护问题，见末节，不能沿用初切结论。

## 可重复运行与本地验证

环境 macOS arm64，Node 24.19.0 / npm 11.17.0（机器默认 Node 25 未用于安装/验证）。

```sh
npm ci
npx playwright install chromium
npm run test:browser
# 同一 worktree/源码/配置/环境、C5 收据一小时内复用：
npm run build:e2e
npm run test:e2e:built
npm run test:browser:built
```

Linux CI 安装用 `npx playwright install --with-deps chromium`。两个 built 入口都先调用原 C5 verify；缺失、过期或身份不匹配直接失败，不悄悄构建。不直接把 playwright CLI 的诊断运行当作最终 C5 验收。

| 验证 | 本地结果 |
| --- | --- |
| 干净 npm ci、npm audit --audit-level=high | 成功；502 包安装 / 505 包 audit，0 漏洞；lockfile 无漂移 |
| npm run lint | 通过，脚本新增 tests/browser，使 CI 同样检查浏览器测试 |
| npm run typecheck | TS7/TS6 app/tools 四项通过；最初并行 build 的 .next/types 竞争已通过顺序复跑解决 |
| npm run test:coverage | 234 文件 / 2,366 用例通过；ops 109/109；statements 77.44%、branches 70.20%、functions 77.70%、lines 81.32%，既有门保留 |
| npm run test:browser | 默认实际 build 一次（13,260ms 单次观察）+ C5 verify + Chromium 5/5，通过，additional_builds=0 |
| npm run test:e2e:built | 同一 build 收据通过，HTTP E2E 6/6；additional_builds=0 |
| git diff --check | 通过 |
| 本地 Docker | daemon socket 不存在；没有启动/修改其他会话 Docker 环境。由候选 CI 的独立 Docker 门补证据（状态见下方 PR Checks），不把本地工具路径当容器通过 |

浏览器 smoke 最终本地单次约 6 秒，仅功能执行时间；没有浏览器性能样本，P95 未测。未覆盖 Firefox/WebKit、多设备、完整业务流程、模型生成、报告 hover/导出、图谱边下钻/缩放性能、生产或恢复矩阵。

## Eval 与独立审查

按 eval-gate 风险判断，本次仅测试/依赖/CI，没有 AI 输出、prompt、模型、来源、validator 或评测语义改动。不运行无关完整 A1；不拿它证明浏览器交互。提交使用 `Eval-Gate: skip (D4 browser tests and CI wiring only; AI output and eval semantics unchanged)`。

Pre-PR AI Review 使用新上下文独立审查最终 diff，初审 Blocking 0 / Warning 1：图谱只有节点名和边数量断言，不能识别错误连边。已补按现有 SVG line title 精确核对 Atlas–Beacon / Cedar–Delta / Echo–Foxtrot 端点集合；不依赖布局坐标、不改页面。修后独立定向复查通过，Blocking 0 / Warning 0 未解决；初审 1 项已处理。

reviewer 已独立复跑原候选 Chromium 5/5、lint、TS7/TS6 app/tools、diff check 与 lockfile entry 比较，全部通过，临时根目录为 0。修后 reviewer 另复跑图谱 1/1，C5 verify 保持 additional_builds=0，临时目录为 0。Draft PR 的候选 CI/Docker 状态及 SHA 绑定另见其验证摘要与 Checks；本地结果不冒充容器或生产证据。


## Draft PR 与候选 CI

Draft PR [#404](https://github.com/dong-qiu/deep-insight-agent/pull/404) 承载本切片。最终候选的 CI/Docker run 链接、tested head SHA 和状态记录在 PR 的验证摘要与 [Checks](https://github.com/dong-qiu/deep-insight-agent/pull/404/checks)，与本地验证表分开；必须以最终候选完整通过为准，不以 superseded/取消的运行放行。此处归档只补专属收据，不改测试源码。

初始候选使用优化前的 CI：verify 一次 build:e2e，之后 HTTP E2E 和 browser smoke 校验同一 C5 收据；Docker 当时为独立 needs:verify 作业。该段描述初始候选历史，当前接线见下节。PR 保持 Draft；没有合并、部署、SSM、生产 DB 操作或分支/worktree 清理。


## 更新至优化后的 CI

2026-10-04 按用户要求将当前 D4 分支无冲突合入最新 `origin/main` @ `b2a12e762bff6913dc4c0e1e8583e4a7491d1307`。对应 [main CI 37145080605](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37145080605) success；#405/#407/#408 的分类、证据归档和并行 Docker 已完成，不重复实现。只更新本分支与 D4 专属文档，其他会话工作区与 Dependabot 保留。

整合主干时浏览器测试、fixture、package/lockfile 与上一候选字节一致；随后仅加强登录用例的退出响应与合成 cookie 等待（见下节）。应用/AI/证据规则不变。自动合并后的浏览器安装与 smoke 步骤位于 application：先 build:e2e，再 HTTP 与 browser built，各自调用原 C5 verify，随后 audit 和 prototype CI evidence。container 独立 needs:scope，与 application 在同一事件 SHA 并行；原 verify/docker 必需门仍分别严格汇总应用和容器实际结果。完整 D4 PR 含测试/依赖/CI，必须 full，不能因最后提交文档就走 docs 路径。

本轮集成顺序复跑 lint、TS7/TS6 app/tools、actionlint、文档链接/结构与 diff check 均通过；CI 分类/必需门/发布 admission 与 C5 相关 node tests 72/72（无跳过）。build:e2e 实际构建一次 12,521ms，随后 HTTP E2E 6/6、Chromium 5/5 复用同一 C5 收据，additional_builds=0。该构建时间是单次观察，不是浏览器 P95。

本轮再次使用 pre-pr-ai-review 新上下文独立审查最新基线到当前工作树的完整十文件：风险中（测试依赖/CI），Blocking 0 / Warning 0，结论通过。reviewer 独立核对完整 diff、lock entry、前候选字节一致性、四类交互/隔离/reader 门及新 CI 失败路径，未复跑需配置或构建产物的运行命令；上述运行结果来自主 agent。冻结后再独立复核远端 diff/body，候选完整 CI/Docker 仍以实际运行结果为准。

最终候选 Actions 的 run/attempt、head/base/tested SHA、scope、checks、两份完整证明与 artifact SHA256/到期时间按 [新流程](../plan/specs/pr-delivery-evidence-workflow.md) 保存到 [#404 验证摘要](https://github.com/dong-qiu/deep-insight-agent/pull/404)。不为 Actions 链接再提交收据，也不将原候选 `5aefe8f` 的 CI 当作更新后候选证明。

回退本切片通过正常 revert PR 移除 D4 测试及浏览器接线，保留最新主干 CI 优化；无 schema/数据迁移。不部署、不访问生产，不清理其他分支/worktree。先前“不合并”的用户边界未因本地验证自动解除，是否 Ready/合并仍按用户明确授权。

## 历史 CI 失败与已复现缺陷（修复前证据）

首个优化 CI 候选 `715155d5c5608f4564855b1ba1c65177c05eb3a3` 在 [37167149073 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37167149073) 为 failure。full scope；application 的 browser smoke 4/5，登录用例在退出后再次访问 `/opportunities` 没有跳回登录页；application 汇总必需门正确失败。独立 Docker 与其汇总门 success，不能替代应用证明。构建实际 52,517ms 一次，两个 built 入口 additional_builds=0；未执行的 audit / prototype CI evidence 不算通过。

原用例本地 20/20 未复现，不能推断 CI 根因。加强测试在点击退出前等待当前页面 POST 响应，断言状态 <400、真实合成 session cookie 前 >0 / 后 ==0；保留 `/login` DOM、退出按钮消失和随后受保护导航断言。没有手动 clear cookie、修改 cookie、重试导航、skip 或调宽 timeout。尝试 response.finished() 在本例 Next 流式响应不结束，导致 30 秒失败；该无效就绪条件已移除，使用响应与 cookie/DOM 状态。

加强版 build:e2e 实际 12,684ms 一次；Chromium 单次完整 5/5。但 `NEXT_TELEMETRY_DISABLED=1 npx playwright test --config tests/browser/playwright.config.ts --grep '登录、viewer' --repeat-each 20` 仅 **16/20**，重复项 1、3、4、10 失败。四次已通过退出 POST、cookie 为零、登录 DOM 和退出按钮消失，随后仍打开受保护机会页；合成 DOM 摘要包含 smoke@example.test · 只读、退出按钮、技术规划机会与待验证机会内容。该失败不含生产 cookie/凭据/数据，测试自己的临时目录均由 finally 清理。

已确认可复现的退出后保护恢复缺陷，确切网络/cookie 竞争机制仍待确认。middleware 会话刷新与在途 RSC/预取响应是候选原因，尚非定论。独立修复范围见 [D4 spec](../plan/specs/browser-interaction-smoke.md#退出后保护恢复缺陷历史发现与独立修复)。本分支仅提交更强的 smoke 与失败收据，保留严格门；即使最终 CI 单次偶然成功，该已知缺陷仍阻塞 D4 交付，不能宣布主干 TD-16 已关闭。

最终候选的实际检查和独立定向复核按上述冻结流程写入 PR 摘要；不修改本 Session 约定外的认证或页面代码。

冻结前主干前进至 `8a96b862894cbb65fdfd64f301469ad1ba37cdb4`（#406 C2a），已无冲突整合；完整最新基线到本工作树仍只有 D4 十文件，没有本 Session 对 C2a、认证或其他 src 的修改。认证/layout/middleware 与先前基线字节一致，因此不能用 C2a 合入推断上述问题已解决。整合后的 lint、TS7/TS6 app/tools 均通过；build:e2e 实际 15,302ms 一次，HTTP 6/6 与 Chromium 单次 5/5 复用该收据，additional_builds=0。单次通过不解除前述重复失败的阻塞；最终审查与候选 CI 结果见 PR 冻结候选摘要。

最新基线下独立定向复查结论为**需修复**：Blocking 1（上述既有认证缺陷，未处理），Warning 0；原“未确认缺陷”的时点歧义已修正。测试增强与 CI 接线无绕过、最新基线到本分支无 src 差异。reviewer 仅只读核验，未重跑 runtime。保留 Draft；最终候选 CI 的单次结果不能解除已知阻塞。

## 用户授权独立修复后复验

独立认证 Draft PR [#409](https://github.com/dong-qiu/deep-insight-agent/pull/409) 以 origin/main 8a96 为基线，冻结 head 19c5b96；D4 合入该 feature 分支，并将 #404 base 设为 fix/auth-logout-protection，保持认证六文件与 D4 十文件分别可审查。没有合入 main、部署、触及生产或其他会话工作区。认证根因、真实 Auth.js 反例、普通页面不再滚动续期 JWT 的取舍及独立审查见 [认证收据](auth-logout-protection-2026-10-04.md)。此前单次/重复/CI 失败均保留为历史，不能用早期成功覆盖它们。

D4 的浏览器源码、fixture、package/lockfile 与失败候选 0a49e57 字节一致；严格退出 POST、session 从存在变零、登录 DOM 及重新访问受保护页的断言不变，零自动重试，无清 cookie/skip/xfail。仅用独立修复候选重新验证。集成后顺序执行 lint、TS7/TS6 app/tools 全部通过；build:e2e 实际一次 20,094ms，HTTP 6 文件/7 项、四类 Chromium 5/5 与同一登录重复 20/20 全部通过，两个 built 入口 additional_builds=0。所有用例仍为零自动重试，临时资源由 finally 清理；不把这一单次 build 时间写成浏览器 P95。文档结构/链接、diff 检查通过；浏览器/依赖/CI 与 0a49e57 的比较无差异。最终 full CI 与独立 Docker 按候选 SHA/run/attempt 绑定到 PR 摘要，CI 后不为链接修改 head。

认证修复本地 coverage 239 文件/2,407 项及 ops 150/150 通过；整合后对应代码/测试/config 相同，最终候选 CI 再检查完整 coverage、供应链与原门。本地 Docker daemon 不可用，由两个候选 CI 独立 Docker 门补证据。新上下文独立 reviewer 对认证基线到完整 D4 十文件复查通过：风险中，Blocking 0、Warning 0。独立核对真实 Auth.js positive control/四种迟到响应反例、原授权与撤销边界，确认修复依据不限于单次 browser 成功；D4 范围、严格断言与历史证据准确。reviewer 独立检查 diff/锚点和字节一致性，未重跑 runtime，运行结果来自主 agent。冻结后还需核对远端十文件 diff/body 与最终 CI，不沿用修复前审查作为修后证明。浏览器 P95 仍未测；主干 TD-16 状态待 PR 合入后的流程，不在本 Session 宣称已关闭。
