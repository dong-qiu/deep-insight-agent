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

## PR #391 CI 超时定位与修正

初始 CI 6 个反例超过默认 5 秒，非安全 verdict 失败；该 head 不可合入。独立 Node 24.19.0 目录只从 tracked archive 建立，没有本地 `.env`/`.data`，依赖按 lockfile 重新安装。

同一合成断言的本地覆盖率计时：1,261,568 字节，建库/迁移约 39.7 ms、序列化约 0.32 ms、Vitest `toEqual(Buffer)` 约 1,829.5 ms、`Buffer.equals` 约 0.14 ms。这是诊断样本，不是生产性能预算。

在 Node 24 覆盖率环境中，修正前 22 个用例共 20.55 秒，九个拒绝反例各约 1.74–1.82 秒；修改三处完整数据库快照断言为原生精确字节比较后，23 个用例共 1.48 秒，九个反例各约 37–39 ms。新增同长度单字节变化反例，确保比较仍检测字节改变。没有改全局/局部 5 秒超时、夹具初始化、签名逻辑或安全规则。

上述定向覆盖率诊断命令暂设全仓 coverage threshold 为 0，仅因未运行其他文件；没有修改仓库 coverage 配置，不能当作全仓覆盖率门通过。随后须运行未覆盖参数的完整 `npm run test:coverage` 与最终 head CI。Node 24 本地组件验证仍非同镜像 HTTP/认证/恢复验收。

修正后的独立 Node 24 环境完整 `npm run test:coverage` 已退出 0，仓库原覆盖率阈值不变，ops 68/68 通过。第一次全仓运行因 tracked archive 没有 `.git`，两个既有播客 CLI 测试无法读取提交身份而失败；在该隔离目录建立本地合成 Git 快照后重跑通过，未修改播客测试或生产数据。最终 PR head CI 仍需通过后合入。
