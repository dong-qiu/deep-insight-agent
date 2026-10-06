# source-map-js 安全修复验证收据

## 范围与现场基线

调查起点：`6eabc5f671073c377200f7551daf8a143d333989`，D7 S1 PR
[#419](https://github.com/dong-qiu/deep-insight-agent/pull/419) 已合入，未修改 package/lock。
精确主干 CI [37437928802](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37437928802)
的应用其他验证和 Docker 成功，根因是全依赖 audit 的 source-map-js high；必需汇总随之失败。

本任务期间另一个会话合入 [#420](https://github.com/dong-qiu/deep-insight-agent/pull/420)，
最新基线对齐 `86d824fd5fbe12006679a02cebcc877f71493f73`；其精确 main CI
[37458872550](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37458872550) 已全绿。
本会话未修改、关闭或合并 #420。新的独立 PR 修复该主干上 **audit 看不到的 magicast 内联副本**。
不回退 D7，不实施 D7 S2 / TD-20，不改共享 roadmap / ADR。

隔离分支 `fix/source-map-js-security-complete-20261006`；linked worktree
`insight-agent-source-map-security`。已只读检查工作树、近期未归档 Session cwd/branch 和进程；
主工作区已有 docs 改动及其他 worktree 保留。只复制 `.env.local`，权限 `0600`，
DATA_DIR/DB_PATH 指向新 worktree 的独立 `.data`；未复制数据、SQLite/WAL、报告、原文、备份或
`.env.development.local`，不输出凭据。

## 公告、来源与依赖路径

- [GHSA-68fv-2mgg-jv7q / CVE-2026-93749](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)：high，受影响 `>=1.0.0 <1.2.2`，修复版本 1.2.2。GitHub 发布日 2026-09-18，更新/审核日 2026-10-05。
- [官方 v1.2.2 release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)：2026-09-30T13:34:23Z；[npm registry](https://registry.npmjs.org/source-map-js) 记录包发布时间 2026-09-30T14:08:09.382Z，repository 为 `7rulnik/source-map-js`。
- [官方修复 cf765805](https://github.com/7rulnik/source-map-js/commit/cf7658058ceeaa8619d5ae0ec90be6905209d016)：offset 非负安全整数和累计 line 上限 1e7、嵌套 sources getter 线性读取、generator 大跨度 repeat、SourceNode 在代码耗尽后跳过空行；release 另包含禁用 unsafe-eval 时 quick-sort fallback。
- 原始 `npm ls` / `npm explain`：Next 16.3.8 → PostCSS 8.5.26（已有 override）→ source-map-js；Vite 8.3.0 → 同一 PostCSS；coverage-v8 5.0.1 → magicast 0.5.5 → source-map-js。父声明均为 `^1.2.1`。只有一个可枚举安装包目录，原为 1.2.1，#420 后为 1.2.2。
- [magicast 0.5.5 官方 metadata](https://github.com/unjs/magicast/blob/v0.5.5/package.json) / 实际 tgz：额外 `inlinedDependencies.source-map-js=1.2.1`，完整 consumer/generator/SourceNode/quick-sort 被内联，未被 npm audit 枚举。0.5.4 同样内联；现场 npm 最新仍为 0.5.5（2026-09-11T03:31:09.196Z）。实际公开 generateCode(inputSourceMap) 接受负 offset 并返回 map，证明该代码可执行。

PostCSS `PreviousMap.consumer → SourceMapConsumer` 和 `MapGenerator → SourceMapGenerator` 可消费
previous map。magicast recast `composeSourceMaps → SourceMapConsumer` 消费 inputSourceMap；
coverage provider 导入 magicast，parseConfigModule 解析本地配置。src 没有直接 source-map API
或攻击者 map 接入。本次没有证明生产接口能输入攻击者 source map，生产端到端攻击路径仍为
**未核验**。开发/构建依赖会执行代码，不因 dev 分类视为无风险；audit 也不证明生产可直接利用。

## 最小实施与正式依赖策略

原先定向 `npm update source-map-js --package-lock-only --ignore-scripts` 只改 version/resolved/integrity，
但发现内联副本后不足以关闭任务。#420 合入后本 PR 的所有 registry 包版本、resolved、integrity
均与最新 main 相同；锁图只变 root dev 锚点、magicast file link 和新 vendor metadata。

正式 vendor magicast 0.5.5，版本 `0.5.5-insight.1`，删除全部十个旧 source-map 模块，
改用精确 source-map-js 1.2.2 外部依赖；其余七个 dist 文件和 LICENSE 保持字节一致，
其他 builders 代码保持原样。根 package 新增 magicast 本地 dev 锚点和仅 coverage-v8 → magicast
的 file override。保护测试约束当前父版本/范围，父契约升级需重新审查。
这是 npm 能稳定 hoist 的正式包路径，不是修改 node_modules 或安装后补丁。

生成器 `ops/vendor-magicast-source-map.mjs` 校验固定官方 tgz SHA512、builders SHA256、十个模块
边界，生成逐文件 `PROVENANCE.json`。从 registry 独立重现的全部 11 个生成文件与提交文件逐字一致。
来源、许可证、复现和至少每 30 天检查上游/退出条件见
[SECURITY_PATCH](../../vendor/magicast-source-map/SECURITY_PATCH.md)。文本 vendor diff 较大来自保留上游 API，
实际行为改动只有外联 source-map；不升级 Next/Vite/Vitest/Babel/recast，不调整 prompt/模型/引用规则。

Docker deps 增加单一 vendor COPY，default-deny context 增加该目录；合成 context 检查同时增加
必需文件及凭据/node_modules 排除反例。原 PostCSS override、image-size / Next glob vendor、
其他 override、audit、hooks、coverage 和全部 CI 门均保留。

实际变更文件：package.json / package-lock.json、Dockerfile / .dockerignore、
ops/check-docker-context.mjs、两份专属 ops 脚本、vendor/magicast-source-map 下 12 文件、
[任务 spec](../plan/specs/source-map-js-security.md) 和本收据。src、模型、DB/schema、共享计划不变。

## 本地验证（Node 24.19.0 / npm 11.17.0）

| 验证 | 实际结果 |
| --- | --- |
| 干净 `npm ci` | 成功；新 override 首次尝试的无效 file link 已通过 root dev 锚点和重新计算锁图解决，最终 clean install 成功 |
| `npm ls source-map-js magicast --all` / 安装包目录 inventory | 成功；source-map-js 唯一 1.2.2，magicast 0.5.5-insight.1，coverage 使用该同一 file 包，无旧内联模块 |
| `npm audit --audit-level=high`（全部依赖） | 0 漏洞；原基线为 1 high，不使用 omit=dev 或忽略公告 |
| `node --test ops/source-map-security.node-test.mjs` | 7/7：非法 offsets、累计嵌套上限、合法最大边界、深嵌套、SourceNode、generator、PostCSS/magicast 实际 API、禁用 VM string codegen 的 quick-sort、实际 vendor hash |
| 旧版反例 | 前四项在原 1.2.1 全失败，其中 SourceNode/generator 的独占 128MB 子进程内存耗尽；父 runner 正常退出。magicast 原发布另实测接受非法 offset |
| 复现正式 vendor | 官方 tgz 校验后 11 个生成文件字节一致；其余 dist/LICENSE upstream/patched hashes 相同 |
| `npm run lint` | 成功，无 warning |
| `npm run typecheck` | TS7 / TS6，app 与 tools 均成功 |
| `npm run test:coverage` | 262 文件 / 2,759 Vitest 用例，运维 Node 158 用例通过；全局 coverage 79.58% statements、72.02% branches、79.61% functions、83.46% lines，门槛未改变 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build:e2e` | 生产 webpack build 成功，C5 收据 `build_ms=21814, builds=1` |
| 同 env `npm run test:e2e:built` | 7 文件 / 8 HTTP 用例成功，收据复用 `additional_builds=0` |
| 同 env `npm run test:browser:built` | D4/D3 Chromium 7/7，包括登录、引用证据、图谱、合法空态和 390px 窄屏；同一构建，`additional_builds=0` |
| `git diff --check` / 锁图完整对比 | 成功，无其他 registry 包漂移或本地绝对路径泄漏 |
| 本地 Docker | daemon 未运行，未声称本地容器通过；最终完整 Actions 必须补齐 image/context/runtime/HTTP/dispatch 证据 |

每个危险 map probe 用独占子进程、10 秒 OS timeout、SIGKILL、128MB heap 和有限输出；
不靠单进程 timer 保护同步阻塞，也不使用仅断言版本的测试。VM codegen 验证对应上游 CSP fallback，
不冒充本项目生产浏览器 CSP header 端到端证明。

本地验证的实施文件集合 SHA256：
`37f6f9e369864e54199fc6c82a657b81f2fc9982b387090653c413f85d949833`。
C5 本地 pre-commit 收据 HEAD 为基线，但 inputs 指纹包含完整待提交实施改动；HTTP/browser
确实复用该同次产物。最终候选精确 SHA 的权威证明来自下述完整 PR CI。

## Eval 与独立评审

已使用 eval-gate 按实际完整 diff 与依赖路径判断：source-map 修复改变异常 map 处理、构建/coverage
工具链行为；不改 analyzer/validator/followup、LLM/provider、数据源、评测集或 report selection。
src 无该库直接调用；A1 不执行本次 source-map API 路径，因此不适用，未运行真实/付费模型。
实际覆盖由安全 API 回归、完整 coverage、生产构建和 HTTP/browser 提供，不预签“依赖升级永不影响输出”。

Pre-PR AI Review 按仓库 skill 进行。前置独立方案审查指出锁文件遗漏内联副本及 magicast API
保护缺口，均已修复。最终完整 21 文件（含全部 8 个 vendor dist）经另一新上下文独立 reviewer
审查：**通过，风险中，Blocking 0 / Warning 0**。reviewer 独立下载官方 metadata/tgz、重现
11 个生成文件并比较全部上游字节，确认仅 builders 删除十个旧模块和导出 wrapper / 新增 import；
独立复现原 magicast API 接受负 offset，复跑实际安装安全测试 7/7、audit 0，并核验锁图仅三节点。
还验证 CommonJS/ESM root/core/helpers API 和禁用字符串 codegen 时正常映射；无质量门弱化。
全套应用验证使用本收据的执行证据，reviewer 未重复全套；实际 Docker 仍待最终 PR CI。

## PR、CI 与发布边界

首次提交前 CI 尚未运行，不写已通过。按
[交付流程](../plan/specs/pr-delivery-evidence-workflow.md)，冻结候选后将最终精确 head SHA、
实际测试 merge SHA、run/attempt、每个完整 application/Docker/必需入口结果、两份 prototype
证据与 artifact hash/有效期记录在同一 Draft PR 摘要和 Actions。CI 后不为追加 URL 再改候选。

本任务不合并、不部署、不执行生产迁移/恢复/历史改写、不访问生产数据、不清理任何分支/worktree。
代码修复经 PR 验证后仍等待合并授权；生产是否运行修复版本未核验，不能宣称上线。
回退 source-map-js 锁文件或 magicast vendor 会重新引入已知漏洞，不能作为安全完成方案；
必须选择另一个已验证安全版本/正式补丁并重跑完整门。
