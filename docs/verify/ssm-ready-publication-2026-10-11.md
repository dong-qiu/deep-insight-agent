# SSM fixture ready 完整发布：测试修复收据

## 范围与身份

基线 `22fc151ec5d452efc06527987b2a48af93d21524`，分支 `fix/ssm-ready-publication-20261011`。
用户明确授权恢复接收一个共享测试文件；只改该测试及本片新 spec/收据，未接管历史工作区。
验收见 [spec](../plan/specs/ssm-ready-publication-test.md)。最终 head、tested merge、精确 CI 和
合入身份按正常流程在 PR 追加，本提交前收据不预签远端验证。

## 修复与反例

原 #470 默认并发回归 397 pass / 1 fail / 0 skip 和 parse 失败原件保留。
本片仅修正 fixture 记录发布：完整写入/关闭同目录的 0600 独占 staging，再 hard link 独占
发布 final，finally 删除自身 staging。ready reader、准备期限、SQL、网络和原 35 项断言不变。
preload 使用同一 publisher 的源码，不另写替代算法，不提供 production hook。

- 实际 CLI 在部分 staging 写入期间暂停，final 不存在、原 reader 未完成；放行后完整 JSON、
  权限、staging 清理及真实发送/提交均通过。
- 重复发布 EEXIST，原 inode/字节不变；部分写入异常关闭 fd、无 final/staging；已发布损坏
  JSON 仍直接 SyntaxError，不重试解析。
- 专属隔离反事实将 publisher 改为 open(final, wx) 后写入，实际 partial-write case 失败
  `true !== false`。这是对旧可见顺序的受控故障窗口检验，不冒充原历史运行或自然重现。

## 本地验证

Node 24.19.0，清空环境、不加载本地运行配置，真实固定 AWS CLI v2/loopback/SQLite。

| 检查 | 结果 |
| --- | --- |
| SSM 单文件 | 39 pass / 0 fail / 0 skip，含原 35 项 |
| 默认并发完整 ops | 666 total / 662 pass / 0 fail / 4 Linux image skip |
| 四路 typecheck | ts7/ts6 × app/tools 均通过 |
| scoped lint、diff 格式 | 通过 |
| spec 文档检查 | 通过；最终 spec/收据组合检查在 PR 追加 |
| 私有反事实 | 1 项预期失败，原日志保留，不算正常回归绿灯 |

首次错误调用 docs-check 缺少 scope 参数且使用默认 Node 25，命令失败；随后用规定 Node 24 和
实际 checkDocuments 文档 scope 检查通过。未把错误调用记为验收或更改 checker。

transport/controller/ledger/CLI hash 与基线分别一致：

- `06622d3baf57bed4fd124b72c116f0c835d99f736b53e09df3013be130c75083`
- `852023a56842ad82f616bd095ad3027e5a90c2265c62a639a736e79511d0b8a0`
- `6429ce42260884ea0bcc7d698e2b68daff947fae011717a5cb205add92f18b79`
- `fca26196c0a62df4b423db7ce6b4352df7fc8a17e470245ed9b7fd78d0ee53c5`

## 独立审查与证据

两位 fresh-context 非作者第 1 轮分别 B0/W0 与 B0/W1。Reviewer B 实测完整 final 可见但
unlink 尚未执行的合法交错，发现新增用例过早要求无 staging；该断言已移至实际 child close 后。
独立第 2 轮只复核该修正、最终收据及其验证，结果和最终文件身份在 PR 追加。
最多两轮，未解决问题不宣称通过。#470 既有评审及限定专项验收保持原身份，
本次不增签 K 算法或替代其重新绑定主干后的验收。

新私有证据目录 `ssm-ready-20261011-klAQv2` 位于本机持久 evidence 根；单文件、完整 ops、
typecheck、反事实、review 与远端证据分别保留并封存索引。原两个 K 封存目录不覆盖。
最终本地 hash/索引及远端有效期追加至 PR；本地归档不等于异地备份。

## 边界与回退

这是 fixture 可见性修复，不是生产 transport 或 Window N 文件发布能力认证，不证明崩溃
持久化、全 writer 静默或安全回退。Linux skip、历史失败及 reader 性能 warning 分列保留。
未改 AI 语义、模型或评测口径，Eval 不适用，未运行 A1/真实模型。`positive_admission_ready=false`、
`safe_rollback=null`、deployment blocked、hold/#435 保持，原技术债整体状态不扩大关闭。
必要回退仅通过独立 feature PR revert；不访问生产、部署、迁移恢复或清理历史环境及原件。
