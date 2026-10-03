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

首次诊断暴露测试定位问题：details 的 has 必须相对于目标 details；select 的包裹 label 名含选项文本；换行链接 bbox 中点可能在空白。均修正测试，没有改 UI 或削弱内容断言。退出只等待 URL 时可能在服务动作/导航结束前启动下一导航，现改为同时等登录 heading 和退出按钮消失。最终未确认应用缺陷，不将测试等待问题记录成产品漏洞。

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
| 本地 Docker | daemon socket 不存在；没有启动/修改其他会话 Docker 环境。候选 CI 独立 Docker 补证据，尚待执行 |

浏览器 smoke 最终本地单次约 6 秒，仅功能执行时间；没有浏览器性能样本，P95 未测。未覆盖 Firefox/WebKit、多设备、完整业务流程、模型生成、报告 hover/导出、图谱边下钻/缩放性能、生产或恢复矩阵。

## Eval 与独立审查

按 eval-gate 风险判断，本次仅测试/依赖/CI，没有 AI 输出、prompt、模型、来源、validator 或评测语义改动。不运行无关完整 A1；不拿它证明浏览器交互。提交使用 `Eval-Gate: skip (D4 browser tests and CI wiring only; AI output and eval semantics unchanged)`。

Pre-PR AI Review 使用新上下文独立审查最终 diff，初审 Blocking 0 / Warning 1：图谱只有节点名和边数量断言，不能识别错误连边。已补按现有 SVG line title 精确核对 Atlas–Beacon / Cedar–Delta / Echo–Foxtrot 端点集合；不依赖布局坐标、不改页面。修后独立定向复查通过，Blocking 0 / Warning 0 未解决；初审 1 项已处理。

reviewer 已独立复跑原候选 Chromium 5/5、lint、TS7/TS6 app/tools、diff check 与 lockfile entry 比较，全部通过，临时根目录为 0。修后 reviewer 另复跑图谱 1/1，C5 verify 保持 additional_builds=0，临时目录为 0。Draft PR 的候选 CI/Docker 状态及 SHA 绑定另见其验证摘要与 Checks；本地结果不冒充容器或生产证据。
