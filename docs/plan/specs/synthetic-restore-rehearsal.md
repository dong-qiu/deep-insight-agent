# C1：合成数据隔离恢复演练

承接 [历史缺口处置](historical-recovery-disposition.md)。当前切片先固定环境与恢复 runner 的拒绝边界，不改生产恢复协议、历史引用或完整性门。

## 隔离要求

- 专用 Colima profile `insight-c1-rehearsal`；Docker 操作必须显式指定其 context。不得启动默认 profile、生产 compose 工程或已有 app/cron/worker。
- 只用新建合成目录、账号、原文、报告和随机测试密钥；不加载 `.env.local`，不挂主工作区 `.data/`、生产备份、AWS 配置或其他个人目录。
- 后续服务演练绑定 loopback、内部网络；provider 和登记册 transport 使用合成 fixture，不访问真实 LLM、S3、KMS、Secrets Manager。transport fixture 不算真实 IAM/Object Lock 证明。
- 用固定提交/镜像身份及 Node 24；若先在本地 Node 25 跑组件边界，必须单列，不称为同镜像服务验收。

## 本切片自动用例

使用 Dockerfile 相同 esbuild 参数生成真实 `replay-redaction-registry.ts` CJS bundle（AWS SDK 打包、better-sqlite3 external），在新子进程中用显式最小环境运行，不 mock runner 的参数/配置判定。

| 编号 | 输入 | 预期 |
| --- | --- | --- |
| R01 | 缺少 restore-time | 非零退出，usage；无 DB 或 SQLite 旁文件 |
| R02 | 非 UTC 合法格式恢复时间 | 非零退出，usage；无 DB |
| R03 | 有恢复时间、无登记册配置 | 非零退出，missing_redaction_registry_bucket；无 DB |
| R04 | 有合成 bucket、无独立 recovery identity 配置 | 非零退出，missing_redaction_recovery_role_arn；无 DB |
| R05 | 合成 bucket/role，HMAC 映射不可用 | 非零退出，missing_redaction_hmac_secret_mapping；无 DB |

各用例都在 AWS 客户端创建前失败，不设置有效云凭据，也不从父进程继承配置。断言预置合成报告字节不变、没有 DB/WAL/SHM，且成功 replay 事件没有被输出。测试从未启动服务，不能把它写成“证明服务编排失败后保持停止”。

## 后续服务级验收（本切片不勾选）

1. 合成新格式备份完整性通过后，复制到全新恢复目录；旧历史混合/损坏/超期快照仍拒绝。
2. 恢复点早于合成删除：真实 runner 通过合成 transport 读取、解密、验签并幂等回放；坏签名/缺版本/传输失败时禁止启动服务。
3. 仅 replay 成功后启动固定镜像 app；健康、登录、报告读取与删除对象不可见均验收；cron/worker 不执行生成管线。
4. AUTH_SECRET 轮换后旧 cookie 拒绝、新登录正常；不从快照恢复旧 AUTH_SECRET，不轮换丢失历史登记册 HMAC 版本。
5. 清理本次容器与合成临时文件，恢复原 Docker context、停止专用 VM；保留脱敏收据。不得删除用户已有容器、卷、worktree 或数据。

R01–R05 通过不是上述 1–5 通过，也不代表真实 recovery role 可假设或生产登记册访问可用。TD-09 继续 incomplete，不创建 ignore-legacy 或生产回填入口。
