# C1 与已合入交付工作的有界验收

> 2026-10-05 只读核验。按 [收口计划](../plan/pre-rich-brief-closeout.md) 第 5 项及 AGENTS/L2/L3、ADR-0038/0039/0041/0042、[历史缺口处置](../plan/specs/historical-recovery-disposition.md)执行。没有部署、服务恢复、原文回填或生产业务写入。

## 主干与实际生产版本

核验期间有其他会话继续推进 main：开始 `92d684b`，后为 `5e90ff4`，当次已核验 **`057f265b8df67f22a312ecebafabbb6ee8f2cba1`**。其 [CI 37339733574](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37339733574) success；[镜像 workflow 37339802475](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37339802475) success，但该文档提交的 build/publish job 实为 skipped，只有 trusted evidence 验证成功，因此不能声称已发布一个 057 镜像。此前 `5e90ff4` 的 [镜像发布 37338292847](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37338292847) success；也不能证明生产切换。

随后主干到 `1d8925f7559bc648a2be288f2e9977336a4e0d17`（其他会话 #417 文档收尾），其 [CI 37340831376](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37340831376) success。S0 同步 merge `883b78d` 的实际第二 parent 为该 SHA；未修改排除分支，不能把含其已合入内容的主干同步写作本轮实现。

最近 GitHub 生产部署收据 `6827351877` 对应 **`b199bc0381a1ebd2b50fde0e68819e0b884a4383`**。SSM `14e96718-4869-4629-9b0e-4b488389d94f` 于 `2026-10-05T16:05:54Z` 现场核对：app、cron、generation-dispatch-worker 都 running、restart 0，运行镜像 digest **`sha256:b947ee53b22ba26494ac30da7730bd76612a67bc3410a1aafafb57cd8fdd4406`**，OCI revision 为 b199，image created `2026-10-03T10:43:04.769033419Z`。只读身份检查不输出容器环境。该命令首个撤回计数查询误用了不存在的表名，stderr 已保留，不把 SSM 总体 Success 当所有子命令通过；纠正后的单独查询 `e78fa42f-863b-4087-9821-f82a61522795` 成功，`16:07:22.996Z` redactions=0、requests=0。

SSM `8113c4cb-baab-418d-813a-d48dc602fc6f` 于 `16:18:10.410Z` 验实际镜像内容：恢复 runner SHA `f4f92988ac16eeb340d164e2439e5cb5bc059e393f78cbf2a16bfebdda60bd35`、包含 `--restore-time`；历史归档不可用提示的已打包 page.js SHA `38e6f243f1d7043ffd79489d2a01032ab22254e3d949ad471cf72e53b03913d6`，app healthy。代码字面量存在不是 H08 页面验收，也不是恢复协议安全证明。

生产未包含 b199 之后的 #394 报告永久删除边界、#395 合成登记新鲜度锚及后续运行时/CI/交付改动；这些“已合入”不得写为生产已验收。三个排除的重构分支及其自行产生的进展不在本次实现/验收范围，现场查到 main 更新也不赋予修改它们的权限。

## 三层能力与 H01–H08

| 层级 | 本轮证据与状态 | 未证明的能力 |
|---|---|---|
| ① 备份/清单与异地复制机制 | H01–H07 相关真实脚本/函数回归通过。10 月 4 日实际 S3 DB/清单及 15 所选原文字节与清单一致；在线备份区间及 DB SHA 认证，quick_check=ok。host DR 脚本 SHA 与既有部署收据相同 `80ec7755618732ad88a75c8500a1398276ce347e59261a280af2bdc5fc33451d` | 仅证明指定备份/传输，不证明全部历史原件、真实 Object Lock/IAM 恢复权限或一次成功服务恢复 |
| ② 合成数据能力 | in-memory core、durable registry、freshness anchor、报告删除/读侧边界与真实 bundle 拒绝路径回归通过 | **同镜像隔离服务恢复演练未通过/尚未执行**；不能把组件绿色或只读备份观察升格为 HTTP/认证/服务恢复 |
| ③ 真实生产历史完整恢复 | **未通过，TD-09 incomplete**。10 月 4 日实际清单仍 incomplete：19,090 引用，16,867 present、415 missing、1,808 unmapped | 387 个规范路径缺文件、6 个空引用、10 份未找到报告的既有处置保留；4 个新增候选未恢复，不能减去缺口。当前 backup 原始引用计数与历史按实体缺口口径不同，不能混加或推断恢复 |

本轮 Node 24.19.0：`node --test ops/backup-integrity.node-test.mjs ops/replay-redaction-boundary.node-test.mjs ops/replay-redaction-preflight.node-test.mjs` **38/38**；`npx vitest run ops/c1-candidate-audit.test.ts src/lib/db/reader-evidence.test.ts src/lib/db/report-archive-gap.test.ts tests/c1-synthetic-recovery.test.ts tests/c1-durable-registry.test.ts tests/c1-freshness-anchor.test.ts src/lib/db/report-redaction-boundary.test.ts` **105/105**。`npm run typecheck` TS7/TS6（app/tools）通过。没有修改 prompt/模型/来源/校验/评测集，Eval 不适用。

其中 `KNOWN GAP: earlier snapshot time reports success but skips later deletion` **仍按现状缺陷预期通过**：它证明旧 runner 会漏掉快照之后删除，不是 bug 已修复。恢复时间/覆盖协议尚不能据此获生产启动许可。

H08 人工页面复核安排：浏览器 skill 已尝试连接并按 troubleshooting 枚举，当前无可用浏览器。只读选出的两个可审目标是 [rep_a79e2e11](https://insight.dolphinqd.dpdns.org/reports/rep_a79e2e11) 与 [rep_726ed43c](https://insight.dolphinqd.dpdns.org/reports/rep_726ed43c)。SSM `0e9b8697-598f-4111-9daa-3202bebb17d8` 于 `16:26:17.744Z` 确认其已刊 Markdown 仍存在，当前不可用引用的文件存在性下界为 2/56；不是完整 reader gap 计数。Markdown SHA 分别 `047212f891477d76d9e32521a946c2ac829d44845291cdc8ed52cbe70082f6b6` / `3ac0c0ea6dd7a9c0601c53369ba388a1eabf8a537a87cb49144f2865a861af11`。连接浏览器后的人工检查须确认正文可读、归档不可用提示可见、来源链接不被解释为生成时原文认证；核对正文 hash/历史 check 不被写回或重校验。**H08 pending，本页不签 UI 验收。**

历史搜索沿用已确认的边界（同账户标准/人工备份、对象版本、本地候选；无其他已知外部存储），本轮不重开原件搜索。将来出现新备份只重开命中的受影响项目，并先鉴别原字节/身份；不重抓网页冒充原件，不删除真实历史引用来换 complete。

## 已合入交付工作的阶段核对

| 工作 | PR / merge SHA | 有界状态 |
|---|---|---|
| docs-only CI 与 trusted publish | [#405](https://github.com/dong-qiu/deep-insight-agent/pull/405) / `f390343df6ce604f5e8cbc2b79879b151c11410d` | merged；后续 057 main CI 成功，文档 scope 与 full verification evidence 可区分 |
| 冻结候选与交付收据 | [#407](https://github.com/dong-qiu/deep-insight-agent/pull/407) / `0f5d687311e37674f525588108bbf106e65abf8d` | merged；阶段完成，未据此声称部署或业务收益 |
| 应用与 Docker 并行 CI | [#408](https://github.com/dong-qiu/deep-insight-agent/pull/408) / `b2a12e762bff6913dc4c0e1e8583e4a7491d1307` | merged；057 CI 中两类验证成功 |

C1 #387 merge `735927d`、#394 merge `0a965a8`、#395 merge `bbd8276` 均核为 merged；其声明仍限各自 spec/test 范围。没有单独遗漏的本次交付功能 PR，不清理排除分支。

## 可审查的下一步目标与回退

生产部署仅形成决定材料，**本授权不含执行**：候选代码需包含 #394 的永久报告删除读取/发布边界，目标应从完整验证并实际发布的镜像取得 OCI revision + immutable digest；文档-only 057 不凭 workflow success 编造目标 digest。执行前检查运维 §8 的 migration 演练、备份、dispatch/凭据配置存在性、停写和 worker 稳定性，避开 16:50–17:30 UTC。现有可核验旧镜像 b199 的 digest 已记录，但回退前必须检查新 schema/删除边界兼容；若不兼容，不直接恢复对外服务，按手册验证认证轮换及删除约束。部署后再核实际三个服务镜像、健康、最低兼容 reader/guard，不以镜像发布代替部署。

下一切片合成服务演练单独按 [synthetic-restore-rehearsal](../plan/specs/synthetic-restore-rehearsal.md)：专用 Colima context、固定 Node24 镜像、全新合成数据/随机密钥、loopback/内网、合成 transport，不加载本地或生产配置/DB/AWS。执行身份独立；成功验签/解密/回放后才启动 app，验健康/登录/报告读取/删除不可见，轮换后旧 cookie 拒绝；坏签名/缺版本/传输失败保持服务停止，验幂等。只清理本次创建资源并恢复 context。真实 IAM/Object Lock/生产历史恢复仍另过门。

本项有界证据可作为阶段收尾；不能关闭 H08、服务演练或 TD-09。独立审阅/最终提交与 PR 收据另记；本页不宣布这些后续门通过。

独立新上下文 pre-pr-ai-review：Blocking 0 / Warning 0，独立复跑 exporter15、C1 Node38、Vitest105与TS7/TS6 app/tools均通过，亲自复现 KNOWN GAP 仍预期绿色。只读核对 main CI/PR merged SHA/文档 workflow 跳过发布，无私有 DB/原文访问；因此只签有界证据整理，不签 H08/服务恢复/生产完整恢复。
