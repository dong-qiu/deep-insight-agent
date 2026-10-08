# A3 隔离 SSM no-EOF 用例 CI 修复收据（候选）

本片基于 `46612863dde8508cd5f10b2c13184e90fc00e379`，独立分支
`fix/ssm-no-eof-ci-20261009`，只修改原 no-EOF 测试并新增本收据。
最终源 bytes、独立评审、正常提交、PR/tested merge 和新 main CI 由协调者分别绑定；
本收据不预签这些结果。原 A worktree/分支、失败日志和原封存全部保留。

## 原失败与限定修复

精确 main CI `37809289491 / attempt 1` 的 application 为 failure，Docker 为 success。
原 native ops 为 660 total / 659 pass / 1 fail / 0 skip；唯一红例为
`ssm-isolated-transport.node-test.mjs:273` 的 no-EOF 用例，最后 HTTP records 断言得到 `0 != 1`。
前面的 deadline 首因和 hold committed 断言已通过，但没有进入实际部分响应路径。
原始 `full-application.log` 为 567657B，SHA256
`0c2e18dacf9d53816071a70102feb5626b978c8e003948e843f20db9fcb61afd`，
封存在本轮私有根 `coord/main464-ci-37809289491-attempt1-failure/`，不改其失败身份。

旧例从入口给 1200ms，包含真实 CLI capability、ledger 接线和 API 进程准备，
却未先确认 HTTP/部分响应已发生。原日志不含该失败例逐阶段计时，不能从别例的 capability
耗时补造其计时，也不从 HTTP0 推断模型/远端发送或终态。本片修正测试的准备假定。

沿用已有 fixture 的单次原始 10s deadline，创建 run 后立即附上成功/拒绝处理。
五秒单调时钟屏障同时要求完整 `AmazonSSM.SendCommand` 请求、部分 JSON 的
`res.write` callback 成功和 `res.writableEnded === false`。屏障失败单独报准备失败，
仍等待同一个原 run 收敛；不重置期限、不结束响应、不重试、不追加请求。
屏障通过后继续检查原 deadline 首因、hold committed、权限 false/null/unknown 和 HTTP1，
并核持久 `submission_unknown`、`held` 与 deadline failure。服务端部分写出且无 EOF
只证明这个实际服务端事实，不证明 CLI 已解析字节或远端已停止。

运行时 SHA256 仍为
`06622d3baf57bed4fd124b72c116f0c835d99f736b53e09df3013be130c75083`；
CLI、类型声明、冻结 spec、旧 controller/ledger 与 hooks/policy/package/lock 均不改。
没有 AI 语义、模型、校验、来源、历史数据合同或生产许可变化。

## 实际验证

私有增量目录为
`/Users/dongqiu/.local/share/insight-agent/evidence/refactor-continuation-20261008-224349/executor-a/no-eof-ci-v1/`。
目录0700，日志、合成 SQLite/marker 副本、inventory 和最终索引0600；原材料非覆盖保全。
新 worktree 未复制本地配置，以 `env -i`、独立 DB_PATH/DATA_DIR 和 Node24.19.0 运行。
真实 AWS CLI2.35.3 只访问字面127.0.0.1，child 使用显式假凭据与空共享配置；
真实模型预算0，未加载业务/通知/云凭据。此 executable 不能代替 Linux CI 的版本验收。

- 实际 module 全部 33 / 33 pass，0 fail / skip，`actual-suite-v1.log`，exit0。
- no-EOF 实例约10022.6ms，实际 HTTP1、SendCommand、partialWritten=true、writeFailed=false、
  writableEnded=false、preparationFailed=false；返回 deadline 首因与 hold committed，
  stage committed / child started / response unavailable，权限 false、termination unknown、safe_rollback null。
- 持久状态断言为 submission_unknown / held，包含 task_deadline_exceeded；
  控制前后 marker/main 原字节与 sidecar absence 保存在 `actual-suite-v1/no-eof-*-inventory.json`
  及对应 `.bin`，完整新 run 收敛后 HTTP 总数仍1。
- whole lint 和四项目 TS（TS7/TS6 各 app/tools）实际 exit0；`git diff --check` 通过。

原失败 main CI 始终保留 failure；新受审源、tested merge 和新精确 main CI 尚需另核。
没有新增构建/路由/部署变更、真实模型质量或镜像验收。现有 hold、#435 生产硬阻断、
deployment blocked 与 safe_rollback=null 保持；C1 文件交接、实际消费者接线和可信远端终态等
原工程缺口不由此测试修复关闭。
