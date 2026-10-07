# A2 同镜像业务矩阵切片交付收据

## 状态与固定对象

**真镜像最终验收与独立 PR 交付待精确 CI。** 修正已应用到独立 worktree；以下本地/源码证据不代表镜像运行通过。
工程 base 为 fetch 后 `2910a867a94d7d3a5ab657c2ad8d05cd8b4edc4a`；
branch `feat/a2-same-image-business-matrix-20261008`；linked worktree `insight-agent-a2-business-matrix`。
独立 [Draft PR #443](https://github.com/dong-qiu/deep-insight-agent/pull/443) 已创建；PR、候选 head 与精确 CI 在 PR 交接中绑定。
[矩阵 spec](../plan/specs/a2-same-image-business-matrix.md) 已先经独立新上下文 reviewer 审查，
health 通知条件、历史 gap 提示边界两项 Warning 修正后方案准入通过。

研究镜像只接受 [#435 policy](../../ops/aws/security-release-policy.json) 的固定身份：

| 对象 | 精确值 |
| --- | --- |
| revision | `4477412a3e2b1cb2764fb4357f2284e73952af67` |
| OCI index | `sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` |
| amd64 manifest | `sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c` |
| config | `sha256:d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749` |
| compose SHA256 | `984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd` |

原 [封存索引](c-evidence-archive-index-2026-10-07.md) seal
`a791219e088523aa05e027edcca24af63836a7fa035b07c92b816f63b3019eeb` 与原 registry 三对象字节 hash、
index→manifest→config descriptor/revision、versioned compose 字节均在本轮只读重核。
config 的原 entrypoint 为 `["docker-entrypoint.sh"]`、Cmd 为 `["node","server.js"]`、User 为 app。
这只是原封存身份核验，**本轮实际拉取及容器开始/结束身份尚未执行**。
不把原 #435/#439 CI 或其他 SHA 的结果算成本轮 HTTP/writer 证据。

## 实现、矩阵与证据分层

只新增 `ops/a2-business-matrix/` 与专属 spec/收据，复用原 preflight 和版本化 v46/v47 helper。
用户已转达上述归属无冲突；原 A2/A3 worktree 未操作，共享 workflow/policy/gate/生产代码/schema/模型/依赖未改。
无需新增 CI 接线：现有 `test:ops` 递归发现新 `.node-test.mjs`，Linux Actions 不可 skip。
手工适用 Linux 环境可显式设置 `A2_BUSINESS_IMAGE_TEST=1` 运行新 image test。

| 路径 | 实现内容 | 当前执行状态 |
| --- | --- | --- |
| fresh/v46/v47 启动 | 真镜像 CLI migration/strict record、48 ledger、旧行保全、health 与业务分开 | Docker 未执行 |
| auth | 真实 credentials/cookie、env admin、HTTP创建viewer、角色/匿名/无效cookie、改密/删除撤销、logout | Docker 未执行 |
| reader | 报告列表/详情/旧长ID/prev/引用锚；lead/detail/graph17类独立合成门；历史快照保留 | 源码 fixture smoke17类通过；镜像HTTP未执行 |
| 业务 writer | HTTP topic创建/更新；lead人工review的trace/event/ref、同key重放/新key、重启持久性 | HTTP未执行；不以SQL或source smoke替代 |
| 失败边界 | 每次错误写前后快照、FK拒绝、独立checksum/record/unmigrated-v47故障库 | Docker 未执行 |
| 隔离/身份 | 真preflight、manifest运行、non-root/read-only/network none、loopback exec、开始/结束inspect和bundle hash、数字地址egress拒绝 | 保护反例通过；运行态证据未执行 |

报告、原文、Insight/Citation/Check/v6 audit/initial lead/effect 均为 direct SQL/合成文件 fixture。
只有经过实际 HTTP 的 topic/user 写入和 lead manual review 才计为业务 writer；当前尚未执行它们。
Report/Insight/Analysis/Validation 的模型驱动生成、来源抓取、通知、cron/dispatch/retry/followup明确排除。
不提供模型语义质量或真实来源许可证明。

unknown effect 配 reader_eligible=1 是隔离effect状态门的不一致合成反例；原 startup 不能 finalize，
当前reader及重启后继续隐藏。合法pending恢复未新增覆盖。历史gap只检测路径/文件类型/安全路径，
不检测hash/读权限；当前reader拒绝 corrupt/unreadable 不意味着历史页面一定提示该类缺口。

## 本地验证与恢复后的限制

Node24.19.0 / npm11.17.0，独立 worktree clean npm ci；未复制 .env/.data/DB/WAL/真实原文报告或任何云凭据。

| 验证 | 结果 |
| --- | --- |
| 限制切换前全ops | 366项：363pass、0fail、3明确本地Docker skip |
| 最初专属guards | 19/19；本地image项明确未执行 |
| /tmp修正候选guards | 20/20，含真实entrypoint替换反例；image项仍明确未执行 |
| typecheck/lint | 恢复权限后的最终独立worktree TS7/TS6 typecheck及lint通过；原/tmp候选结果保留 |
| 文档 | spec链接/锚点/格式通过；候选收据另核 |
| 精确447源码fixture smoke | 真源码CLI建48 schema，相同SQL fixture仅适配host路径；真实reader函数17类通过；bundleIdentity明确stub，不是镜像/HTTP/writer证据 |
| 恢复后全ops复跑 | 367项：362pass、2fail、3skip；既有source Vitest向依赖symlink的.vite-temp写入EPERM，既有worker localhost listen EPERM；原失败日志保留，不宣称通过 |
| unrestricted恢复后全ops | 367项：364pass、0fail、3明确本地Docker skip；两项EPERM不再出现 |
| 冻结镜像Docker矩阵 | 无daemon，未执行；未用main镜像/永久skip替代，最终验收仍缺适用环境真实证据 |

首轮 Linux [CI 37659874818 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37659874818)
对应 head `b752c56cbfa610d97dfb59fc73df72dc54df21db`，真实镜像矩阵未通过：fresh matrix 访问 viewer `/settings` 后，
客户端用无base的 `new URL(location)` 解析重定向目标，在 `/matrix/http-probe.mjs:102:120` 失败。
修正为以隔离localhost作base解析相对Location，继续要求307、同origin和首页pathname；不放宽角色边界。
原失败日志独立保存；需新候选完整CI，未产出通过JSON，不宣称本轮镜像已通过。

任务曾因恢复后的 managed sandbox 阻断：当时仅主workspace与/tmp可写，本任务linked worktree及.git只读，GitHub shell请求被拒绝。
当时用户再次授权恢复访问后，平台权限尚未同步更新，apply_patch仍明确拒绝写入。随后平台切回 unrestricted；GitHub请求已恢复。
专属 `/tmp/a2-business-candidate-27ectgxb/` 候选保留了当时的修正及证据；恢复访问后，pending patch已通过check并应用到本任务worktree，重新fetch确认origin/main仍为精确base。
不通过Connector提交绕过正常Git hooks，也不改原A2/A3或主workspace来规避权限。

## 修正、独立审查与评测

完整读取 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。
方案首轮Blocking0/Warning2，两项已修正并独立复核通过。
完整实现独立review发现unknown重启预期超出原finalize契约，已在原worktree修正为继续隐藏；
Markdown换行误报经字节/Node VM核验撤回。
后续原config重核捕获entrypoint断言错误；离线schema smoke捕获FK反例ID已存在。
/tmp候选已修正上述问题，并补PR head/tested身份区别及实际sqlite_master schema hash；恢复访问后全部写回独立worktree。
最终完整10文件独立worktree复核：工程审查通过，Blocking0、Warning1（真镜像CI未执行），允许创建Draft PR。8个工具文件与spec均与已审候选逐字节一致，全部修正已应用；收据仅更新已核事实。
独立guards20pass/0fail，image明确skip1；未发现新的确定性代码问题。结果另存专属review文件，整体验收仍待真实CI。

按当前完整候选diff：仅ops隔离工具/保护测试/fixture/spec/收据，不改prompt、模型、AI validator、来源、评测集，
也不改report-gen输出路径。Eval不适用；未预签skip，未调用付费模型或以不执行本路径的A1作为证据。

## 原产物与继续步骤

私有原产物已持久归档于 `/Users/dongqiu/.local/share/insight-agent/evidence/a2-business-matrix-20261008-zwd5vh3o/`（目录0700、文件0600）；原暂存位置 `/tmp/a2-business-resumed-evidence.ds1ZXn/` 保留：
保护/ops/lint/typecheck日志、封存身份核验JSON、source-fixture-smoke工具与原结果、
`pending-fixes.patch`（对当前未提交实现的修正）、`candidate-against-base.patch`（完整base候选）、
逐文件hash清单、独立review结果和封存清单。全部是本轮合成/工程产物，没有真实用户或生产数据。
原候选封存清单保留，后续CI证据另封存；最终清单记录每个原文件路径/size/SHA256。

继续步骤：正常hooks提交 →
独立review复核最终Git diff → 创建独立PR → 精确head/merge/run/attempt的Linux真镜像矩阵 →
归档日志/JSON及hash并独立核身份 → 更新收据与PR交接。重要修正后复查，不自动合并。

A2只接收③同镜像业务矩阵的fixture/schema/hash/入口证据；A3只接收范围，不签ready、不释放锁。
①身份、②既有安全修复与③本轮业务切片分别记录；④当前生产兼容未核、⑤跨版本回退及⑥操作批准未批准。
safe_rollback保持null，hold不变，不关闭A2/TD-09/TD-19整体，不宣称上线。
后续生产身份/配置/数据/合格备份/容量、全writer准入/drain、未知执行终态、实名值守及操作/解除批准仍需专项核验授权。
