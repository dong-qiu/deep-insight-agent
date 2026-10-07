# A2 同镜像业务矩阵切片

## 固定对象与归属

工程 base：fetch 后 origin/main `2910a86`（完整 SHA 见收据），专属 linked worktree
`insight-agent-a2-business-matrix` / branch `feat/a2-same-image-business-matrix-20261008`。
研究对象只接受 [#435 policy](../../../ops/aws/security-release-policy.json) 的 revision
`4477412a3e2b1cb2764fb4357f2284e73952af67`，linux/amd64 manifest
`sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c`。
复用真实 preflight 的 index→manifest→config/revision、save 原字节及冻结 compose 核验；
不得换成 main/latest/tag 重建。原始 server.js、Next bundle、migration/record bundle 不替换。

本轮新增 `ops/a2-business-matrix/`、本 spec 与专属 verify 收据。
只读复用 `ops/aws/a2-compatibility-source.mjs` 的 `makeLegacyFixture(directory, revision)`、
`historicalRevision` (v46)、`oldRevision` (v47) 与 `security-release-gate.mjs` 的 preflight。
不改 A2/A3 helper、policy/gate、deploy/CI workflow、生产代码、schema、模型或依赖。
已请求原 A2/A3 Session 确认接口及上述文件窗口；确认记录见收据，不能自行宣称已获接收。
Node test 自动发现已有 CI 接线可运行专属测试；如必须增加 CI 接线，先另获窗口。

## 隔离与证据协议

registry preflight 在业务运行前完成。业务容器全部 `--network none`（独立网络命名空间），
无 host 发布端口；HTTP client 用 docker exec 在容器内访问 127.0.0.1。
只挂本轮随机命名、带归属标签的数据卷、只读 `/matrix` harness 与历史合成 fixture。
read-only rootfs、非 root UID1001、cap-drop ALL、no-new-privileges；不挂 socket/本地应用代码。
Docker socket 仅供宿主编排，绝不传入容器。只运行 Web server 和有限 one-shot fixture/CLI/client；
不运行 cron/dispatch worker。凭据在临时 mode0600 合成 env-file 生成，既不版本化也不输出。
所有子进程用最小 env，不继承 AWS/模型 key、HOME cookie 或真实配置。不得复制任何 .env/.data。
health 会调用陈旧通知：使用冻结版本真实支持的 `STALENESS_ALERT_HOURS=1000000`，
历史合成 topic 停用、其他时间新鲜；每阶段断言 stale=false、staleDailyTopicCount=0，
内置 Docker healthcheck 使用相同配置。不注入模型/通知 key，不假设关闭开关。

每次记录工具 base/head/tested SHA、preflight 身份、fixture 来源/schema/hash、ledger 集合 hash、
容器开始/结束 inspect 身份及 mounts/network/rootfs、bundle hash、HTTP 操作摘要、持久 SQL 快照，
明确 writer=HTTP 与 fixture=direct-SQL。TCP 数字地址 egress 反例证明网络拒绝，不依赖 DNS 故障。
每次操作有限路由 allowlist；任何模型、抓取、通知、cron、dispatch 路由即使 admin 也不能被 harness 调用。
网络阻断加无凭据避免外部调用；核 model_usage_attempt、run、dispatch 和 effect 变化，不能只信 HTTP200。
不记录密码/cookie/完整 auth 响应。原始私有产物位置/hash 与 CI run/attempt/job 精确绑定。
Web 固定 `PROVENANCE_SCHEMA_REQUIRED=1`、`PROVENANCE_DEPLOYMENT_REQUIRED=1`，不设置 writer 豁免。
reader 独立反例包括 flagged/uncertain、reachability fail、非v6、缺countercheck、statement/hash错配、
unknown effect、effect binding错配、body/envelope漂移、missing/corrupt/unreadable/plain。
unknown effect 配 reader_eligible=1 隔离其状态门；这是故意不一致的 SQL fixture，启动不能将其
修复为可见证据。合法pending(eligible=0)的恢复流程在本轮未新增覆盖，不混写两者结论。

## 矩阵（入口均来自冻结源码）

所有行共同证据：入口/状态码或退出码、精确镜像/fixture 绑定、数据断言；任一断言失败即失败，
health 成功不得替代业务读写。fresh/v46/v47 各自独立卷；重启使用同一卷/身份/配置。

| 项 | 真实镜像入口 | 输入、操作及预期 | 允许副作用 | 未覆盖条件 |
| --- | --- | --- | --- | --- |
| A1 | /app/ops/run-provenance-migrations.mjs；record-deployment.mjs；server.js | 空 DB 真实 CLI 初始化48项，再 strict record；health 与认证业务读分别200 | 合成 schema/ledger/record；startup 内置协调 | 生产配置/启动故障的修复 |
| A2 | 同上 | #439 历史源码生成 v46/v47，先核版本/checksum/hash，再真镜像升级48；历史 Run/failed Report/FK 保持 | 正向迁移，不倒删48表 | 跨版本 downgrade |
| A3 | server.js；GET /api/health；GET /api/reports | 业务写后重启，身份/bundle/ledger不变，数据精确保留 | startup 正常协调；默认方向播种单列 | 生产持久卷 |
| B1 | GET /reports、/api/reports；POST /api/admin/topics | 匿名页面跳/login，API401；非法cookie401；无持久业务写 | 进程内限流 | 匿名公开产品 |
| B2 | /api/auth/csrf、callback/credentials；GET /api/admin/users | 合成 env-admin 登录；HTTP创建 viewer，再真实登录；viewer 普通读200、admin/API写403、管理页跳首页 | app_user及凭据版本 | 个人账号/cookie |
| B3 | POST /api/admin/users；DELETE 同路由；GET /api/reports | 改密/删除撤销旧cookie；无效登录不获得有效session | 合成用户改密/删除 | AUTH_SECRET跨版本轮换 |
| C1 | GET /api/reports、/reports/:id、/topics/:id | 合成历史 done 报告列表、正文、旧/长ID、prev链接及引用锚精确读取；failed/未知ID不可读 | 无；报告为 SQL/文件fixture | report-gen writer或真实语义质量 |
| C2 | GET /api/leads、/api/leads/:id、/api/graph/drill | 合成 v6 audit+pass/support+committed raw envelope 才可读；blocked/无check/不匹配绑定不得泄漏 | 无；原文/check/audit/effect均 SQL fixture | 真实模型校验/真实来源许可 |
| C3 | 同上及 /reports/:id | missing/unreadable/hash-mismatch原文在当前reader隐藏；历史已发布正文保留；missing/不安全路径提示缺失归档；下一请求重新检查 | 专属反例fixture原文变更；不删新业务数据 | 历史gap只核路径/文件类型，不检测hash/读权限，不将其作为现时来源证明 |
| D1 | POST /api/admin/topics；PUT /api/admin/topics/:id；GET /topics/:id | HTTP创建旧/长ID主题，重复创建409、更新200，查询与重启持久值相同 | 真实topic writer | 全部业务实体创建 |
| D2 | POST /api/leads/:id | HTTP状态更新产生真实 provenance trace/event/ref；同key重放不重复；新key可再更新；重启关联保留 | 真实人工review writer；initial lead/evidence为SQL fixture | AI分析/新lead生成 |
| D3 | DELETE /api/admin/topics/:id | 关联合成Report/Insight的主题删除409/FK，关联数据与新writer数据保留 | 无 | 生产删除 |
| E1 | 上述真实HTTP入口 | anonymous401/viewer403；非法主题422/lead status或key400；不存在关联404；保存前后快照不变 | 无 | 任意未选路由 |
| E2 | 真镜像migration CLI、strict server business GET | 独立坏ledger/未迁移/record错配，CLI或业务失败；公共health单独记录，即使200也不能收口通过；数据不丢 | 独立故障fixture，startup可能创建空DB文件 | 修复坏migration/生产恢复 |

冻结镜像无无需模型的 Report/Insight/Analysis/Validation 新生成入口：明确排除 brief/deep-dive/followup、
sources collect、runs retry、generation retry/dispatch、cron、通知；不以 SQL fixture 冒充业务 writer。
原生/CLI既有修复证据复用 #435/#439 并单列，不能算本轮新增业务覆盖。

## 反例先行与验收

先实现专属保护测试：拒绝错revision/config/digest、mutable tag、替换/app bundle的mount、
SQL-only writer声明、允许外网、秘密继承、权限401/403放宽、reader白名单集合放宽及业务失败被health掩盖。
矩阵方案先独立新上下文 reviewer 审查，再实现；完整diff、真实入口及精确CI后复核重要修正。
至少受影响ops测试、typecheck、lint、文档检查。Linux Actions必须真实运行冻结manifest矩阵，不能skip；
本地无Docker仅明确未执行，不能成为最终验收。无需新CI接线时用已有test:ops自动发现。
正常hooks创建独立PR，不自动合并、不清理其他worktree；临时资源只按本轮精确name/id/label回收。

## 分层与后续接口

①镜像身份、②已有安全修复、③本轮同镜像业务兼容、④当前生产兼容、⑤跨版本回退资格、⑥操作批准
分别记录。本轮只补③及其身份绑定；④未核，⑤/⑥未批准，safe_rollback仍null，hold不变。
同镜像不能解决自身启动故障。本切片不关闭 A2/TD-09/TD-19，不宣称上线。
A2接收矩阵/fixture/schema/hash/入口证据；A3只接收范围说明，不签ready、不释放维护锁。
后续生产核验仍需独立目标/命令/窗口/副作用授权以及配置、数据、合格备份/容量、全writer/drain、
未知执行终态、实名值守与解除批准。本轮不申请、不执行这些操作。

依据：[A2契约](a2-safe-rollback.md)、[A2收据](../../verify/a2-safe-rollback-2026-10-07.md)、
[认证](auth-hardening.md)、[reader](evidence-reader-visibility.md)、
[历史快照](legacy-archive-reader-integrity.md)、[恢复](recovery-time-coverage.md)。
