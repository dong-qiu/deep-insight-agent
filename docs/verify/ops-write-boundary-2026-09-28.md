# B3 运维写入口验证与发布记录

日期：2026-09-28。基线 `origin/main@0467a433b33bce5bc4763de0a946e7d4198afb97`；分支 `fix/ops-write-boundary`。

## 范围与安全边界

- 四个旧报告维护脚本现在只做只读预览：`regenerate-reports-cites`、`backfill-report-chain`、`backfill-highlights`、`cleanup-reports`。须显式指定静止的独立 SQLite 快照；WAL/SHM 库拒绝；旧 `--apply` 显式失败。Markdown、索引和报告元数据不再从旧入口绕过发布/删除协议。
- `ops/aws/deploy.sh` 变为旧命令拒绝入口；**已有 app/compose/备份的现存实例**唯一生产代码发布路径仍为 GitHub Actions `Deploy Production Image`。全新主机首发尚无安全入口，另立任务，不能用旧脚本替代。AWS 入门、运维手册、工作流说明与环境模板已对齐。
- 实施和隔离测试阶段未触碰生产 SQLite、报告或生产配置；未执行生产修复或迁移。测试只创建临时隔离库/伪配置并在结束后清理。实施 worktree 仅复制本地 gitignored `.env.local`，权限 600，未复制 `.data` 或其他运行数据。后续生产部署与最小只读核验单独记录如下。

## 验证

| 验证 | 结果 |
|---|---|
| 定向 Node 反例（预览文件/DB 字节与目录不变、拒绝带 WAL/SHM 的库、仅单报告扫描、`--apply`/非法参数前置拒绝、缺列不补 DDL、仅有活动 `DB_PATH` 或快照同文件〔含符号/硬链接〕时拒绝、部署旧入口不触发配置/网络） | 9/9 通过 |
| `npm test`（Vitest + ops Node 测试） | 完整重跑通过；ops 33/33 |
| `npm run lint` | 通过 |
| `npm run typecheck`（TS6 + TS7） | 通过 |
| `npm run build` | 通过 |
| `node ops/check-docker-context.mjs`（合成 Docker build context） | 本机 Docker CLI 无 `buildx` 插件；[PR Docker CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36369116467) 与[主干 Docker CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36370925992) 均通过 |

Eval-Gate：不适用。本切片未修改 prompt、模型、validator、来源、eval 数据集或现行 report-gen 选择/渲染/发布语义；A1 不执行上述旧运维入口，不能作为 B3 的安全证据。

## 审查与交接

PR 前独立审查初轮发现空主机首发指引不实、SQLite WAL 旁文件可能被只读连接创建；已按现有 CD 实际前置条件修正文档，并用不可变快照打开方式和 WAL 反例收紧预览。PR 后独立复核进一步发现建机脚本仍提示迁移、容器活动 `DB_PATH` 可能被误当快照，以及硬链接可绕过字面路径比较；已移除迁移提示，改用专用快照变量，并以设备号/inode 拒绝活动库同文件别名，相关反例均已通过。旧 `migrate-db.sh` 仍缺空卷强制检查，是独立迁移风险；已从默认步骤移除并标明不得直接用于已有卷，需在后续数据恢复/迁移切片处理，B3 未运行该脚本。

## 合入与生产发布

- PR [#364](https://github.com/dong-qiu/deep-insight-agent/pull/364) squash 合入为 `a582ed32c8a4ef0db91b82c1012f93c95ea0a40e`；[主干 CI](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36370925992) 和[不可变镜像发布](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36371451338) 成功。
- 经用户确认，在日报窗口外通过 [Deploy Production Image](https://github.com/dong-qiu/deep-insight-agent/actions/runs/36371982822) 显式部署 `sha-a582ed32c8a4ef0db91b82c1012f93c95ea0a40e`。发布前旧 revision 为 `0467a433`，app/worker 健康、worker 零重启、可用备份 17 份。首次只读预检因 SSM 默认 `/bin/sh` 不支持 `pipefail` 而在首行退出，未改生产状态；兼容写法重发后通过。
- 发布后只读核验：生产容器 OCI revision 为目标 SHA，运行镜像 digest 与最新 `deployment_record` 一致；B3 的 `REPORT_SNAPSHOT_DB_PATH` 保护代码存在于运行镜像。app/worker 健康、worker 零重启、cron 运行；容器内和公网 `/api/health` 均为 `ok`、报告数 289。短间隔复查仍稳定。完整发布回执见 [PR 评论](https://github.com/dong-qiu/deep-insight-agent/pull/364#issuecomment-5862556222)。
- 生产未运行旧 `deploy.sh`、旧 `ops/aws/migrate-db.sh` 或历史报告修复，也未修改 `.env.local`。标准 CD 按工作流执行了隔离 migration 演练与受控 provenance migration；旧 `migrate-db.sh` 空卷保护与全新空主机 bootstrap 仍属独立后续任务。

已发布报告如需纠正，仍须新建 Report/Trace 并走现有 validator 白名单、artifact/index/FTS/effect 协议，不能原地改文件。
