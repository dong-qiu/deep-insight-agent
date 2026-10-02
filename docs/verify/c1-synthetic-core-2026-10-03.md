# C1 合成恢复核心：首切实现证据

## 范围

契约 PR #390 已合入 `59ba8ccb5e453fffd0e78cd6855d715eb02ff76c`。本分支开始实现，不再仅维护设计。

代码位于 `experiments/c1-recovery/core.ts`；只允许 `:memory:` 数据库，无 CLI、环境配置加载、AWS transport 或生产服务接线。DDL 事实源仍为 `src/lib/db/schema.ts`，新增常量不进入 `SCHEMA_SQL`/生产 migration。实验 resolver 不替换生产 resolver。

已实现独立 Ed25519 发行/恢复身份、新合成 epoch、连续对象摘要索引、提交维护闸门、冻结检查点、签名采样与备份绑定、全量对象校验、真实 AES-GCM/HMAC、报告 scope 限制、永久实验删除约束、真实报告/索引撤下、单事务及结果绑定签名收据。

“空起点”仅为新建合成环境前提，不是旧生产历史的完整性证明。authority 是进程内模型，不是持久云发行者或跨进程锁。

## 验证

- `npx vitest run tests/c1-synthetic-recovery.test.ts src/lib/db/redaction.test.ts`：24/24（22 个新测试、2 个原有回归）。
- `node --test ops/replay-redaction-boundary.node-test.mjs ops/replay-redaction-preflight.node-test.mjs`：12/12，仍是旧 CLI 的现状刻画/前置拒绝证据，不是旧 CLI 安全修复。
- TS7 与 TS6（app/tools）类型检查通过；新测试通过 tools include 引入实验模块，避免实验文件漏检。
- 三个受影响代码文件 ESLint 与 diff 空白检查通过。
- 本地 Node 25，不能称为目标 Node 24 同镜像服务验收；本轮未运行生产构建/部署，最终 head CI 仍须核验。

独立审查复现“既有一致 tombstone + 残留报告投影”会假成功；已在实验核心同一事务无条件撤下报告与全部相关派生表，反例加入 22 个新测试。不修改生产清理原语。

## 后续未完成

1. 可信发行者/连续索引的持久化、独立 transport、所有写入口跨进程维护闸门。
2. 生产永久删除约束、immutable migration、全部 resolver/读模型集成与旧镜像拒绝。
3. 生产 runner 参数与调用方迁移、原 KNOWN GAP 转为真实 CLI 安全回归。
4. Node 24 同镜像合成备份、HTTP 删除不可见、认证轮换及服务启动收据验证。
5. 真实 IAM/Object Lock/历史覆盖与生产恢复授权。

未知覆盖继续拒绝，不改变现有备份保留政策。TD-09 incomplete；没有生产恢复、安全门通过或历史原文恢复的声明。
