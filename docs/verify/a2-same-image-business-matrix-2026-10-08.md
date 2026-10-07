# A2 同镜像业务矩阵切片交付收据

## 状态、工程对象与交付

**同镜像业务矩阵切片已取得真实冻结镜像通过证据，独立证据评审通过。**
独立 [PR #443](https://github.com/dong-qiu/deep-insight-agent/pull/443)；不自动合并。
工程 base：重新 fetch 的 origin/main `2910a867a94d7d3a5ab657c2ad8d05cd8b4edc4a`。
branch：`feat/a2-same-image-business-matrix-20261008`；独立 linked worktree：`insight-agent-a2-business-matrix`。

| 证据对象 | 精确绑定 |
| --- | --- |
| 已通过业务工具 head | `5c12e8577e62e6c99997234617e412f8c3c28542` |
| 实际 tested merge | `e35b8605513cf04a457b6741c2f7fcd46e516afd`；父提交为上述 base/head |
| 完整 CI | [37661379512 / attempt 1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37661379512)，全部所需检查 success |
| 真镜像运行 job | [full application verification / 112929573569](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37661379512/job/112929573569) |
| 矩阵运行 UTC | `2026-10-07T17:46:46.494Z` → `2026-10-07T17:47:25.499Z` |
| harness SHA256 | `8e5e670a4b788993d6b1b0b1b8da3d470de39eba93d0c56f762ef168e7a73d6e` |
| 归档矩阵 JSON SHA256 | `b9160bb76cc5b0bdfc94f09ee48688272fcf8763c9d7a77f7463bafed2c19fc8` |

本次收据更新不改工具字节；最终交付 head 和该 head 的精确 CI 另在 PR 交接绑定。
不把收据提交的 CI、原 #435/#439 或其他 SHA 的结果移植成未执行的冻结镜像证据。
[专属 spec](../plan/specs/a2-same-image-business-matrix.md) 先经独立新上下文 reviewer 审查；
health 通知条件、历史 gap 提示边界两项方案 Warning 修正后准入。

## 实际镜像身份

| 对象 | 精确值 |
| --- | --- |
| revision | `4477412a3e2b1cb2764fb4357f2284e73952af67` |
| OCI index | `sha256:63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` |
| amd64 manifest | `sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c` |
| config | `sha256:d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749` |
| compose SHA256 | `984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd` |
| 原始 bundle（230文件）SHA256 | `bc9cf97ed0fba499331136743c05727e03f925f97518ec0d0acbb3ecd7d20beb` |

复用 [#435 policy/preflight](../../ops/aws/security-release-policy.json)，本轮实际核 registry index→amd64 manifest→config/revision、
pull/save 对象与冻结 compose；按 manifest 启动。Docker28.0.4/API1.48/Compose2.38.2。
六个专属 app 容器开始/结束 inspect 均为上述身份；原 entrypoint为docker-entrypoint.sh、Cmd为node server.js、User为app。
三个正常阶段重启前后容器id/config与原始bundle hash相同。inspect的Mounts顺序可能变化，归属/目标/读写集合保持精确一致。
只挂本轮合成数据卷与只读 `/matrix` harness，不挂 `/app` 源码或Docker socket；network none、read-only rootfs、cap-drop ALL、no-new-privileges、无发布端口。
HTTP client在容器内访问localhost；每个正常阶段ready/matrix/restart均对外部HTTPS和AWS metadata数字地址观察到ENETUNREACH。

原 [封存索引](c-evidence-archive-index-2026-10-07.md) seal `a791219e088523aa05e027edcca24af63836a7fa035b07c92b816f63b3019eeb`、
registry三对象原字节hash与versioned compose只读重核另存；不把这份历史身份资料代替本轮运行身份。
既有当前源码Docker工程job生成的镜像和prototype artifacts只归工程CI，不证明冻结业务行为。

## 矩阵、实际 writer 与未覆盖项

fresh/v46/v47各自独立卷，真实原镜像CLI迁移48项、deployment record、server启动、认证读写和重启。
v46源 `b199bc0381a1ebd2b50fde0e68819e0b884a4383`，v47源 `823b6d875ceecc66dc35ff4ef37a8699aadbec17`；
使用#439版本化fixture helper，迁移前核精确历史checksum集合，未倒删v48表。

| 覆盖项 | 实际结果 |
| --- | --- |
| 启动/业务可读 | 三组health200与admin业务读分别通过；48 ledger、strict record、历史Run/failed Report保全；重启身份与数据保持 |
| HTTP/auth | 真CSRF/credentials/cookie；env admin、HTTP创建viewer；匿名页面跳login/API401、无效cookie401、viewer管理API/写403、管理页307回首页；非法登录、改密/删除撤销、logout通过 |
| reader | 每组17类fixture：旧/长ID合格引用可读，其余blocked/unchecked/flagged/reachfail/旧gate/缺countercheck/statement或audit hash错配/unknown effect/绑定错配/body-envelope漂移/missing/corrupt/unreadable/plain拒绝；list/detail/graph精确关联通过 |
| 报告 | 列表/详情、旧长ID、prev链接、cite锚、历史正文快照例外通过；failed/未知ID404；下一请求重新检查原文读权限 |
| 实际HTTP writer | 每组创建并更新两个topic，HTTP创建/改密/删除/重建viewer，人工review更新lead；真实trace、2 events、3 entity refs、released lease；同key重放无追加、新key第二trace；重启值与关联精确保留 |
| 写入反例 | 匿名/越权、非法参数、缺key、重复topic、不存在lead/topic、关联topic删除拒绝；错误操作前后完整持久快照一致；独立SQL FK拒绝 |
| 启动失败 | 坏checksum CLI拒绝；坏record与未迁移v47 strict启动拒绝；三组HTTP listener存在、health500、登录不能建立有效会话、匿名reports401，合成旧数据hash保全 |
| 零外部业务调用 | 路由allowlist、network none与ENETUNREACH；无模型/云/通知凭据，model_usage_attempt与dispatch为空，run/effect/report无非预期变化；不运行cron/worker |

每个正常阶段记录86条matrix HTTP观测；SQL fixture origin明确为direct-SQL-and-synthetic-files-not-business-writer。
报告、原文、Insight/Citation/Check/v6 audit/initial lead/effect为SQL与合成文件输入，不能算业务writer创建。
只有实际HTTP的topic/user与lead manual review计为writer；Report/Insight/Analysis/Validation/新lead模型生成、来源抓取、通知、cron/dispatch/retry/followup明确排除。
本轮证明reader接线和白名单，不证明真实模型语义质量、真实来源许可或全业务实体创建。

unknown effect配reader_eligible=1是故意不一致的SQL反例；原startup不能finalize，当前reader及重启后继续隐藏。
合法pending(eligible=0)恢复未新增覆盖。历史gap只检测路径/文件类型/安全路径，不检测hash/读权限；历史正文可读不意味着当前来源可用。

共同schema SHA256：`b75613b77e83a11a37f754f0f85ce81959e44add58c212cde155f44d0b9bfc66`；
48 ledger SHA256：`2856c98a2ddca80108a65fb052a02316cb665ecb47ad37419ad754fded681d49`；
raw manifest SHA256：`8d37d291efb2dfb294f3a79a9db41dd78ef7ff488ff9583bd5bbe21b7b3a29ce`。
每组DB fixture、报告字节、HTTP结果hash及完整持久状态在原JSON逐项绑定。

| 阶段 | SQL fixture DB SHA256 | 写后=重启持久状态 SHA256 |
| --- | --- | --- |
| fresh | `5d435221e40f42fb603815c370d9f4a24419bad7176c63301d67dd8c2bb82302` | `394f2201e91477e232dc465f6b7bd9dc07557d1ec6ff4ba3d769caf0c794773f` |
| v46 | `9f2686849577b3f80995442e0b0d25e1482535d5031f1ebdb45275e59350b023` | `93f6c906dadcf44ff277bf04a655c83a60eea60175f713ddd19e3f986394c24b` |
| v47 | `265dd2b57775519ec2f879775d25d61d9765d21c37019144cc8161275db10a95` | `95fb3f5bd5e1a5ed041b1f5da2ea6f60d3b5a2a0573d3b9a9edfd76bc4cddf56` |

## 验证、修正与独立评审

Node24.19.0/npm11.17.0，专属worktree npm ci；未复制.env/.data/SQLite/WAL/真实原文报告或凭据。
本地最终ops367项：364pass、0fail、3明确Docker skip；本地无daemon。
最终TS7/TS6 typecheck、lint、spec/收据链接/锚点/格式通过。
精确447源码reader fixture smoke17类、record immutable/append/mismatch smoke通过，均明确source-only，不能替代image/HTTP/writer。

真实Linux CI ops367pass、0fail、0skip；coverage/typecheck/lint/build/API E2E/browser/audit/Docker与required aggregate通过。
当前源码reader微基准为Warning，P95增约0.023076ms，符合既有gate；该工程结果不用于冻结矩阵背书。

两次真实CI失败均保留：

- [37659874818 / attempt1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37659874818)，head `b752c56cbfa610d97dfb59fc73df72dc54df21db`：viewer/settings后客户端无base URL解析失败；修正相对Location解析，保留307/非空/同源/首页断言。
- [37660672038 / attempt1](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37660672038)，head `7b39ea7e76a6d2957d01abeb168a5233da3cbf58`：反例UPDATE immutable deployment_record失败；保留原行/触发器，先断言UPDATE拒绝，再追加最新合成错误digest记录。

完整读取并使用 [pre-pr-ai-review](../../.agents/skills/pre-pr-ai-review/SKILL.md)。方案、完整10文件、两次运行期修正及实际CI原ZIP/JSON/身份均由独立新上下文reviewer复核。
最终已测试候选Blocking0、Warning0；后续收据提交须另核精确最终head CI。
此前entrypoint、FK不存在ID、unknown重启预期、head/tested区分与schema hash修正均保留独立复核记录。
权限恢复过程中的EPERM失败日志保留；unrestricted复测无该错误，不将旧失败宣称通过。

最终diff仅专属ops工具/保护测试/fixture/spec/收据，不改prompt、模型、AI validator、来源、评测集或report-gen输出路径。
Eval不适用，未预签skip、未调用付费模型、未以不执行本路径的A1背书。

## 私有原产物、归属与后续接口

持久私有归档：`/Users/dongqiu/.local/share/insight-agent/evidence/a2-business-matrix-20261008-zwd5vh3o/`，目录0700、文件0600。
原始CI ZIP、矩阵JSON、GitHub run/attempt/jobs/artifacts与tested parents、工程artifact ZIP、失败日志、源码辅助工具/结果、本地检查、候选patch及逐文件hash清单分别保存。
GitHub CLI格式化日志遗漏长JSON块；完整原产物以 `ci-37661379512-attempt1-rawlogs.zip` 内的 `full application verification/8_Run npm run testcoverage.txt` 为准，只有其中的本轮JSON证明冻结矩阵。
`frozen-ci-seal.json` SHA256：`4c7baec73866465f96d1db1b51a01bb819a1440892766fbcc073ba368f9cf993`，51个原文件逐项hash；后续交付CI另封存，不覆盖原seal。
容器/卷与临时合成env均按本轮精确id/name/owner回收，JSON仅在完整断言与回收完成后输出。原证据及其他worktree未清理。

用户已转达A2/A3接口及归属无冲突：只读复用现有helper/preflight；仅新增专属目录/spec/收据，无共享workflow窗口需求。
原A2/A3 worktree、共享deploy workflow、身份policy/gate、生产代码/schema/模型/依赖未改。
A2接收③同镜像矩阵的fixture/schema/hash/入口证据；A3仅接收范围，不签ready、不释放锁。
①身份、②既有安全修复、③本轮同镜像业务切片分别记录；④当前生产兼容未核，⑤跨版本安全回退与⑥实际操作未批准。
**safe_rollback保持null、hold不变；不关闭A2/TD-09/TD-19整体，不批准部署/回退、不宣称修复上线。**
同镜像不能解决自身启动故障。后续生产身份/配置/数据/合格备份/容量、全writer准入/drain、未知执行终态、实名值守及操作/解除批准仍需专项核验授权。
