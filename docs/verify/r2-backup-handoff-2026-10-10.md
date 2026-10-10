# R2 三文件恢复移交与可行性核查

2026-10-10 增量入口：[共享设计收据](r2-backup-shared-design-2026-10-10.md)。
新增设计授权未扩大源码归属；两轮评审后的草案修正不补签方案通过或实施就绪。
以下保存原移交阶段及其证据，旧私有归档未覆盖。

## 收口结论

**限定移交及合同准备已完成；完整 R2 为 needs_interface_handoff，未实施。**
用户本轮授权仅恢复移交 C1 的三个文件，不包含既有共享维护/runtime 源码。
两个独立 Reviewer 一致确认缺少合法备份许可生产者与固定 FS 提交/轮转接口。
现有源、旧工作区和未提交内容未覆盖，不宣称全部重构完成或只差生产授权。

## 接收工作区与身份

- 接收 worktree：`/Users/dongqiu/Dev/code/insight-agent-r2-backup-20261010`。
- 分支：`refactor/r2-backup-contract-20261010`。
- 冻结基线：`22fc151ec5d452efc06527987b2a48af93d21524`。
- 主工作区本地 main 仍为 `65c5a6b4fe3e0089f6be5b66937fedf0d3f8c640`，未移动。
- 必要 `.env.local` 复制后设为 0600，仅 DB_PATH/DATA_DIR 改为新 worktree
  隔离路径；未输出密钥，未复制业务 `.data/`、DB/WAL 或报告原文。

原 owner 为 C1；接收 owner 为本 R2 协调者，仅接收以下文件的后续工作权限。
本轮授权是恢复移交，不冒称已经取得原 Session 的独立签收。

| 文件 | 最新接收源 SHA-256 |
| --- | --- |
| `ops/backup-db.mjs` | `40b853a093e44bdee5d1bd130b2a48939f904f0d72c896230e2a87adb59c9d7c` |
| `ops/backup-integrity.mjs` | `1c06ec55837f2717bd099d8e6e96e32ed93fa7bf7d81bd67add8963d76a2b7b9` |
| `ops/crontab` | `308865d78847a17c66ff9581255b032d5892f2e8cf552455a67c2a192464458d` |

定向核查的原工作区三文件均无未提交修改，其他路径不在移交范围：

| 原工作区 | HEAD | 三文件处理 |
| --- | --- | --- |
| `insight-agent-c1-backup` | `d14c589600de42c2e70defca758e17d8d994de7c` | 较旧源保留，未覆盖最新 main |
| `insight-agent-c1-restore-rehearsal` | `8177ff71e177d6e71cc2bcc111153616c1f0f134` | 三文件 hash 与接收基线相同，原目录保留 |

较旧 backup worktree 中 backup-db/backup-integrity 的 hash 分别为
`d7fcf74bcad750619f1427adc36be5c9bc82022117a1047b95c2f112cde39340`、
`c630200b327f0c0a3edea7878c9db7a0931d4ce37ee1ba7ce95cad8c46233e31`。
crontab hash 与上表相同。移交使用最新 main，不回写旧分支或重放旧补丁。

## 已实际执行的限定验证

环境为 Node 24.19.0；依赖安装成功，安装器 audit 为 0。
prebuild-install 弃用及 allow-scripts pending 提示保留；安装成功不替代原生验证。

1. **既有 C1 功能基线：26 pass、0 fail、0 skip。**
   实际运行 `ops/backup-integrity.node-test.mjs`，总时长 1035.933334 ms。
   新的空 cwd 仅链接新 worktree 的 ops 源码，进程环境白名单不含凭据，
   测试只使用新合成 fixture。日志 SHA-256 为
   `cdf23b287a3aa2c53bb72a6e8dc0bb821187e58040cf0a97da961aebf002295e`。
   这证明旧 C1 功能基线，不证明 R2 准入、取消或合法正例。
2. **Reviewer B 的真实 R2 红例：已 held，旧 CLI 仍发布。**
   真实 S0 backup operation 已 held、production permission 为 false，
   原 CLI 仍 exit 0 并生成 manifest-complete 的空合成备份；账本前后相同。
   说明旧备份入口没有消费维护准入；不是 R2 成功正例。
   原脚本、输入/输出与 hash 溯源均已保存，没有重跑冒充原证据。
   原 run 输出的是前后 hash 相等；相同 hex 是随后只读读取，前值据等值证明推得。
3. **两个独立非作者可行性评审：needs_interface_handoff。**
   没有 R2 实现接受结论，没有伪造 ready、scope 全覆盖或原生异步终止证明。

本轮未运行 R2 新测试、完整应用 CI、构建、镜像或模型评测。
模型/prompt/validator/来源/评测口径均未改；不以 A1 替代备份合同验收。
两个专属 Markdown 为本地未提交草案，无 PR、tested merge 或 main 验收身份。

## 证据与下一步

本轮新证据先保存于接收 worktree 的 `.cache/r2-evidence/`，
随后仅定向复制本轮新日志、Reviewer 材料及草案到私有持久归档；
不复制旧工作区数据或 `.env.local`，不覆盖历史封存。
持久归档索引独立记录精确路径、size/hash 和目录 0700/文件 0600；
本地保存不等于异地备份。

下一步见 [共享合同准备](../plan/specs/r2-backup-entry-contract.md)：
先确认仅 backup 的共享设计窗口、合法许可来源、固定文件发布/轮转协议
和精确文件交接，双独立方案评审通过后再确定实施窗口。
其他共享源码、三主台账和其他 Session 的私有内容不因此移交。

继续保持 `safe_rollback=null`、deployment blocked、既有 hold 和 #435。
未访问或操作生产、未调用模型、未清理分支/worktree 或任何原证据。
