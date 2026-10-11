# SSM fixture ready：完整记录的独占发布

基线 `22fc151ec5d452efc06527987b2a48af93d21524`。用户于 2026-10-11 明确授权恢复接收
`ops/maintenance/ssm-isolated-transport.node-test.mjs` 单文件，本片仅改该测试及专属 spec/收据。
历史 worktree、原件及其他源码归属保留，不接管 transport、controller、ledger、CI 或三主台账。

## 问题与冻结范围

#470 的默认并发本地回归保留 397 pass / 1 fail / 0 skip；失败发生在 ready 文件的 JSON.parse。
原 writer 直接 writeFileSync(final, ..., wx)，目录项存在不代表内容已经写完。
受控诊断在创建 final 后、写完前暂停，复现同一解析失败；这是故障窗口暴露，不冒充自然重现
或原历史调度的完整归因。串行通过、单文件通过与 CI 通过均不能抹去原失败。

## 验收标准

1. 先在同一自有 fixture 目录独占创建 0600 staging，完整写入并关闭，然后 hard link 到 final；
   final 发布必须不覆盖，重复发布抛 EEXIST 且原 inode/字节不变。只清理自身创建的 staging。
2. 强制实际子进程在 staging 部分写入期间暂停：原 ready reader 仍不能观察 final，放行后
   一次读到完整 JSON。测试用同一 publisher 函数序列化至 preload，不另写替代算法。
3. 写入失败不能发布 final；已存在的损坏 JSON 仍直接失败，不重试解析、不忽略错误。
   缺失 ready 的原准备期限、5ms 轮询、10s 屏障及 CLI 固定 30s 窗口均不放宽。
4. 原 35 项测试及真实 SQLite/CAS/BUSY、exactly-one 正例、zero-send/unknown/重启拒绝负例
   所有断言保持。只改 fixture 记录发布，不改业务或 production 测试钩子。
5. 自有子进程在有界 finally 内终止并观察 close 后才删除自有 fixture；无法确认 close 则
   测试失败并保留目录。测试中的 hard link 不证明 Window N、崩溃持久化或生产文件系统资格。
6. 运行 Node 24.19.0、credential-free 单文件及默认并发相关/完整 ops，四路 typecheck、scoped
   lint、文档检查。Linux image 本地 skip 分列，不能声称通过。双独立非作者评审，最多两轮；
   精确 PR/main CI 与最终 diff 复核后才合入。#470 必须重新绑定包含修复的基线与验收。

未改 AI 语义/模型/评测口径，Eval 不适用，A1 不执行此测试路径；真实模型预算 0。
`positive_admission_ready=false`、`safe_rollback=null`、deployment blocked、hold/#435 保持。
不部署、访问生产、迁移恢复或清理历史环境。必要回退通过独立 feature PR revert，不删历史失败。
