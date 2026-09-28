# B3 运维写入口验证记录

日期：2026-09-28。基线 `origin/main@0467a433b33bce5bc4763de0a946e7d4198afb97`；分支 `fix/ops-write-boundary`。

## 范围与安全边界

- 四个旧报告维护脚本现在只做只读预览：`regenerate-reports-cites`、`backfill-report-chain`、`backfill-highlights`、`cleanup-reports`。须显式指定静止的独立 SQLite 快照；WAL/SHM 库拒绝；旧 `--apply` 显式失败。Markdown、索引和报告元数据不再从旧入口绕过发布/删除协议。
- `ops/aws/deploy.sh` 变为旧命令拒绝入口；**已有 app/compose/备份的现存实例**唯一生产代码发布路径仍为 GitHub Actions `Deploy Production Image`。全新主机首发尚无安全入口，另立任务，不能用旧脚本替代。AWS 入门、运维手册、工作流说明与环境模板已对齐。
- 未读/写生产 SQLite、报告或生产配置；未执行生产修复、部署、迁移。测试只创建临时隔离库/伪配置并在结束后清理。新 worktree 仅复制本地 gitignored `.env.local`，权限 600，未复制 `.data` 或其他运行数据。

## 验证

| 验证 | 结果 |
|---|---|
| 定向 Node 反例（预览文件/DB 字节与目录不变、拒绝带 WAL/SHM 的库、仅单报告扫描、`--apply`/非法参数前置拒绝、缺列不补 DDL、部署旧入口不触发配置/网络） | 8/8 通过 |
| `npm test`（Vitest + ops Node 测试） | 追加 WAL/快照反例后的完整重跑通过；ops 32/32 |
| `npm run lint` | 通过 |
| `npm run typecheck`（TS6 + TS7） | 通过 |
| `npm run build` | 通过 |
| `node ops/check-docker-context.mjs`（合成 Docker build context） | 本机 Docker CLI 无 `buildx` 插件，无法运行；已核对 Dockerfile COPY 与 `.dockerignore` 白名单，待 CI 的 Docker 环境验证 |

Eval-Gate：不适用。本切片未修改 prompt、模型、validator、来源、eval 数据集或现行 report-gen 选择/渲染/发布语义；A1 不执行上述旧运维入口，不能作为 B3 的安全证据。

## 审查与交接

PR 前独立审查初轮发现空主机首发指引不实、SQLite WAL 旁文件可能被只读连接创建；已按现有 CD 实际前置条件修正文档，并用不可变快照打开方式和 WAL 反例收紧预览。复查确认代码侧无 Blocking，随后修正运维手册中最后两处自相矛盾的首发前置说明；最终 CI 结论待记录。旧 `migrate-db.sh` 仍缺空卷强制检查，是独立迁移风险；已从默认步骤移除并标明不得直接用于已有卷，需在后续数据恢复/迁移切片处理，B3 未运行该脚本。

当前仅是本地实现和隔离验证；未经 PR 合入与实际运行镜像核验，不宣称生产入口已更新。已发布报告如需纠正，仍须新建 Report/Trace 并走现有 validator 白名单、artifact/index/FTS/effect 协议，不能原地改文件。
