# S2a Docker builder 精确依赖接线收据

本片由主控独立指定 Dev-Agent-R3–R6接口准备为唯一 owner；六小时必要授权适用，固定截止 2026-10-12T01:26:40Z。协调决定 `independent-build-window.json` SHA256 `b065a436ee4adeaa607ee4c94499334aa412cd84a0f1cf0e9ee2cd6a5a3370f1`，基线 HEAD `0ca8aef39e2a8d8b05caed1f006f58a753abd6d1`，沿用 PR480、bcba 与现分支。只写 `.dockerignore`、`ops/check-docker-context.mjs` 和本新收据；具体竞争、dirty、额外闭包或必要 Dockerfile/source 改动交回主控。本片不接管历史 source owner。

## 真实问题与最小闭包

旧 PR480 CI38177614234/1 是 full failure：full Docker job114583273062 的 `npm run build` 报 TS2307，runtime 三处 import/export 无法解析 `../../../ops/maintenance/writers-v2.mjs`。本地类型检查和其余应用/运维 CI 通过不消除此失败。builder 的 `COPY . .` 接收默认拒绝 `.dockerignore` 的上下文；当时未放行 maintenance 目录。旧 head、测试原件、两轮源码审查与失败 CI 不改写为通过。

实际静态闭包：runtime `writer-admission-v2.ts` → `writers-v2.mjs` → `contract.mjs`、`ledger.mjs`，ledger → contract；`writers-v2.d.mts` 引入 better-sqlite3 类型。五个输入逐 import/export-from 检查并搜索 dynamic import/require 语法，无新增相对闭包。zod、better-sqlite3 已在 package/lock 中，builder 的正常 `npm ci` 提供依赖。这里只说明静态闭包，不冒充执行 runtime trace。

`.dockerignore` 增加必要父目录遍历后立即继续拒绝 maintenance 后代，仅精确放行四文件：

| Builder 输入 | 用途 |
| --- | --- |
| `ops/maintenance/writers-v2.mjs` | runtime 固定 factory 的目标模块 |
| `ops/maintenance/writers-v2.d.mts` | 对应类型声明 |
| `ops/maintenance/contract.mjs` | 原有同步协议函数 |
| `ops/maintenance/ledger.mjs` | 原有 S0 只读 inspection 依赖 |

没有全 ops/maintenance 通配放行；既有 source/vendor 允许及最后敏感路径 deny 保留。九个原受审源码/测试/收据及 Dockerfile、ledger、contract 原字节均核对，未修改。Dockerfile 只读 SHA256 `846faca2b35d62a26c4633e692f7d20ed4ade193277138c5f6b2127fc3d93a2e`。

## 真实 context 验证路径

现检查器是 `.github/workflows/ci.yml` container job 的真实 `node ops/check-docker-context.mjs` 前置。保留原 fixture、`FROM scratch`/`COPY . /context/`、Docker buildx `--network=none`、真实输出逐文件断言和仅清理自建 mkdtemp 的既有行为。新输入仍只有 synthetic sentinel，不复制 live 工作区、env 或数据库。

required 加四个精确 placeholder。excluded 增加同目录未列模块、writer-control-v2/CLI、node-test、fixtures/nested 同名模块、env/credentials/key、DB/WAL/SHM、日志/cache/node_modules。实际 Docker ignore/COPY 语义由新 head 的自然 CI 执行，不能用静态数组/正则检查代替真实测试。

本机只执行 `node --check`、fixture 数组唯一/互斥及闭包/原字节检查、`npm run typecheck`；不调用 Docker/helper/buildx，不启动 VM/daemon/container，不安装依赖，不运行模型、资格矩阵或生产。真实 context 和完整 builder、新 head 的 typecheck/test/build/ops/fullDocker 必须另取得实际 CI。旧 37 Node/3 runtime 及源码两轮 B0/W0/S0 只用于解释未变九字节范围，不替新构建门签名。

## 镜像运行与审查边界

production source 搜索仅发现新 runtime 模块自身的三个 import/export 及未接线 control → core，没有实际 app/domain 调用方。next config 对 better-sqlite3 显式 external；当前 Docker runner 原来复制 native module，但本片不执行或确认新的 writer runtime trace、zod 裁剪闭包或 maintenance CLI 可执行性。没有新 runtime COPY，不自动发布 control/CLI，不初始化业务 schema、不接 startup/source/usage/raw/report。TypeScript 构建可解析不等于 runtime 接线完成；未来真实消费者若要求运行镜像增量，须另冻结窗口和验证。不签 production、drain 或全 writer 覆盖。

新两位非作者只审本构建差异、白名单安全负例和 CI 适用，最多两轮；不重开旧 writer 算法第三轮，也不补签旧失败。代码合入仍需正式 ADR 主干及其实际 main CI、主控对新 exact head 指定唯一 merge owner；当前仅正常更新 PR480 和候选 CI 授权。PR479 的三文档增量独立核版本，不当作 source 变更或使用旧 CI批准新候选。

私有加性证据根：`/Users/dongqiu/.local/share/insight-agent/evidence/r3-r6-s2a-docker-context-20261012/`。只对明确的新 regular 证据成员收紧权限，不遍历/chmod旧 synthetic；旧源索引 `094d78b3751707c43c5494ee987cdc20fb18f99b5e3714f39415c9bbb8f185ee` 的 122 成员和五 synthetic 库存保留。旧 reviews-a/synthetic-r2 原 mode unknown 的已披露归一化事件限制继续适用，不把当前 mode 冒充原件。新审查、候选、Git/CI原日志与失败记录保全，最终结果以新候选 CI和加性索引为准。
