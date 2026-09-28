# B3 运维写入口：历史报告预览与生产发布

状态：实施验收。承接 [技术债治理计划](technical-debt-remediation.md) 的 TD-06/07。

## 边界与决策

- `ops/regenerate-reports-cites.mjs` 只做历史报告格式差异**预览**。必须显式设置专用 `REPORT_SNAPSHOT_DB_PATH` 指向独立静止 SQLite 快照；仅有 `DB_PATH` 不得触发预览，快照与活动 `DB_PATH` 同文件（包括符号链接/硬链接）或指向容器活动 `/data/insight.db` 时拒绝。带 WAL/SHM 旁文件的库也拒绝读取。用不可变只读 URI 打开，不创建旁文件。默认扫描快照全部报告；可用 `--report-id rep_...` 限定单份。未知参数、无效报告 ID、`--apply` 均须在接触数据库前拒绝；不存在的合法 ID 经只读查询后拒绝。
- 同类旧入口 `backfill-report-chain.mjs`、`backfill-highlights.mjs`、`cleanup-reports.mjs` 的 `--apply` 全部停用，预览使用只读且已有的库；`backfill-highlights` 缺列时不得以“预览”名义自动补列。非报告内容的成本回填不属于本切片。
- 已发布报告正文不能原地改写：当前发布契约要求正文 artifact、`report_index`、FTS、`generation_effect` 和可选完整性锚在同一发布协议中保持一致；引用仍须经 validator 的 `pass/support` 白名单。旧脚本只更新 Markdown 会破坏这个契约。需要更正内容时，使用正常的报告重生成流程建立新的 Report/Trace 和发布记录；未来若需要“同一报告的版本化修复”，另立 spec 与完整性迁移验收，不以 B3 脚本绕行。
- `ops/aws/deploy.sh` 旧源码+配置投递入口一律 fail-closed：不得再向生产机传输、覆盖 `.env.local`、执行 `rsync --delete` 或启动容器。**已初始化实例**的生产发布唯一入口是 `Deploy Production Image` GitHub Actions：只消费 main CI 发布的不可变 GHCR 镜像并走健康切换。当前 CD 依赖已有 app、compose 与备份；全新空主机首发不在 B3 范围内，须另立安全 bootstrap 流程，不能暗示“仅放置 env 即可首发”。
- 不读取 live 生产 SQLite 或运行历史修复；验收只使用临时隔离库与模拟的部署入口。保留历史事故文档，不重写既有证据。

## 验收反例

1. 含可修复旧格式的报告：无参数及指定 `--report-id` 运行仅输出预览计数，正文和 SQLite 字节不变；指定 ID 只扫描该报告。
2. `--apply`、未知参数、非法或不存在 ID：退出非零，且不创建数据库或写文件。
   同样核对三个旧元数据/清理入口：预览前后 DB 字节不变、报告文件仍在，`--apply` 在打开库前拒绝。
3. 对已有生产配置的旧部署入口，即使传入旧参数或环境，也在任何网络/文件写动作前拒绝，并指向唯一 CD 流程。
4. 生产指引、AWS 入门与环境模板不再建议运行旧部署路径；不得误称现有 CD 支持空主机首次发布。
5. 容器已注入活动 `DB_PATH` 但未设置专用快照变量、或快照变量指向活动库时，四个预览入口均须拒绝；建机脚本不得把未加空卷保护的迁移脚本列为默认下一步。
