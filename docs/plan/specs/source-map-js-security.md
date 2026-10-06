# source-map-js 依赖安全补丁

调查起点为 `origin/main` @ `6eabc5f671073c377200f7551daf8a143d333989`；实施期间另一个会话合入
PR #420，最终基线对齐 `86d824fd5fbe12006679a02cebcc877f71493f73`。修复
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)，保留 D7 S1；
D7 S2 / TD-20 不在本次范围。不修改共享 roadmap / ADR。

## 验收标准

- 将锁文件内 source-map-js 1.2.1 定向更新到官方补丁 1.2.2；确认所有安装副本、父依赖范围、registry resolved 与 integrity，不升级其他 registry 包。
- 现场发现 magicast 0.5.5 发布产物还内联 source-map-js 1.2.1，公开 generateCode(inputSourceMap) 实测接受非法 offset；0.5.4 同样内联，最新发布仍是 0.5.5。因此锁文件单独更新不足以覆盖全部副本。允许新增 coverage-v8 → magicast 的正式 file vendor override 和 magicast 本地 dev 依赖锚点，保留 0.5.5 API/其他代码/类型/许可证，只把全部十个旧 source-map 模块外联到精确 1.2.2。官方 tgz integrity、可复现转换和逐文件 hash 必须可核验，不使用安装后 patch 或修改 node_modules。保护测试约束当前父版本及其 magicast 声明范围，未知父契约升级必须重新审查。
- 保留已有 PostCSS override、vendor 安全适配和全依赖 high+ audit 门；使用 Node 24.19.0 / npm 11.17.0，干净 `npm ci`、`npm ls source-map-js --all`、`npm audit --audit-level=high` 成功。
- 保护测试通过实际安装包、PostCSS previous-map 和 magicast 公开 generateCode(inputSourceMap) 消费路径验证非法 offset、嵌套累计上限、合法边界、SourceNode 超出代码范围和深层嵌套、generator 大跨度序列化。异常输入在独占子进程内执行，设超时和内存上限；旧版本反例不得挂死测试 runner。Docker deps/context 包含新 vendor，继续拒绝凭据与 node_modules。
- 核验上游 CSP 修复兼容性，运行 typecheck、lint、完整 coverage、生产 build、HTTP E2E、D4 browser smoke。HTTP/browser 沿用 C5 收据复用同一次构建；完整最终 CI 保留 Docker 与全部安全门。
- 按 eval-gate 从实际 diff、调用链和验证结果判断 AI 评测适用性；不默认调用付费模型。独立新上下文 reviewer 审查最终完整 diff，并在 PR 创建后复核远端一致性。
- 专属收据与 PR 摘要记录公告、前后依赖、实际测试、审查、精确候选与实际测试 SHA、完整 CI 及未核验边界。CI 后按现有交付流程更新 PR 摘要，不为补 CI URL 改候选 SHA。

## 安全与回退边界

开发/构建依赖同样执行代码，不因 dev 分类忽略。PostCSS 可消费 previous source map；
本项目生产接口接受攻击者 source map 的端到端路径若未证实，应标为未核验，不能由 audit 推断。
回退锁文件会恢复已知漏洞，不能作为安全完成方案。

本任务仅交付独立 Draft PR 与完整 CI；不合并、不部署、不迁移、不访问或改写生产数据，
不清理分支/worktree。本会话未修改或合并 PR #420，其他会话工作区保持原状。
