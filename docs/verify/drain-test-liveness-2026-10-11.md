# Drain 测试握手修复收据

## 范围与身份

本切片只恢复移交两份测试文件；[冻结方案](../plan/specs/drain-test-liveness.md)。
工作区 `insight-agent-drain-test-liveness-20261011`，基线 #471
`d3a04dba7395482a8456db752fa24da5d6a44934`；main `22fc151ec5d452efc06527987b2a48af93d21524`。
原 #471 三文件、运行时、SQL/CAS、业务期限、原安全断言保持；本阶段尚未提交或合入。

## 已知失败与诊断

旧 CI `38074669162/1` 已按用户专项授权取消。Vitest 3399 项通过不替代 ops；
原 drain 竞争失败具体断言及唯一 CI 挂起根因未知，取消/失败原包完整保留。

新实现首轮保留：同启两 owned 子进程引入 setup `BEGIN IMMEDIATE` SQLITE_BUSY，
consumer 返回 `isolated_observation_failed`，未到原 barrier；设施正确报失败。
改回原串行准备，不将未到 barrier 当合法 CAS loser，不改实际消费/SQL、不重试。
另一次本地重复检查第9次遇外层 watchdog 超时，期间主机有 Idle Sleep 记录；
不能由此独断唯一原因。命令级抑制睡眠的新10次检查通过，业务/CI阈值未改。

owned 005 的完整39项曾通过，但早于最终 loser 分类，不作最终源码验收。
006 表明真实 CAS loser 还可能保守返回 `owned_drain_initial_commit_unknown`，
已按精确业务合同分类；不容忍任意设施错误。最终分类的007重复检查在第9轮
仍失败：唯一初始 winner 后续 metadata/close 与 loser 的原生事务竞争，
`SQLITE_BUSY` 导致 `owned_drain_close_failed`；原精确 failures 断言仍不满足。
原日志及红源码快照保留，不能宣称最终稳定通过。私有第二阶段调度方案已取得
两位非作者独立复核 Blocking 0，按新增严格限定开始实施；不会修改运行时、CAS、
业务期限或原安全断言。方案通过不作为最终实现、反例或 CI 通过证明。

## 本地验证（阶段记录）

- 未修改代码的原 drain 竞争定向：1 pass；不是远端失败原因结论。
- drain 首轮：23 pass / 0 fail / 0 skip；原 closed、held、业务事实及 false/unknown 断言保留。
- drain 设施v2定向：23 pass / 0 fail / 0 skip，日志 `drain-final-v2.tap`。
- 独立源码复核指出：实际竞争仅解析最后一行可能跳过 malformed 中间输出，且等待
  失败时 finally 未记录 cleanup 后的完整输出。已统一完整协议解析并保存 close 诊断；
  新重复ready／额外malformed／多结果／尾部垃圾及完整stderr反例通过，v4为25 pass。
  后续小幅补齐反例自身的 finally 清理，最终冻结版本仍需全量回归与完整独立结论。
- 四路 typecheck 与 drain scoped lint 通过。
- 第二阶段 owned 阶段源码 SHA256 为
  `12285ba2a10983ae50fcc2e16a485b17f9aed57e626690c0ddb18f1316a869df`，
  012 完整57项通过，013两项真实正控各10次、20/20通过；007/009红记录保留。
- 默认并发全 ops v1：698项、694 pass、4个本地Linux专属skip、0 fail，
  2026-10-11 03:08:06–03:09:07 UTC；绑定上述 owned 阶段 hash 及 drain
  `7a55a5032f89c6a18df2eafae0b2e85f34d2a3ea0e69b5780f68f501d6cd93ad`。
  本地skip不签远端零skip，该阶段通过不替代后续修正的源码验收。
- 第一轮完整实现审查：Blocking 0，Warning 2。unknown 分类漏验四项许可字段；
  IPC callback 晚错可在父进程冻结 facts 后漏记，已由独立短反例证实。
  先修正这两项并补实际分类器/原生 IPC 反例，再复测与最后一轮独立审查；
  当前全 ops 的阶段绿灯不能抵消 Warning，也不作为合并依据。
- 014 专项9项通过；015完整轮62/63，保留新红记录：“winner 提前退出”
  设施反例尚未到退出注入，真实双进程竞争中一个 initial BEGIN busy，另一个
  initial INSERT 成功但 COMMIT busy，均无 entry-ready，父端4秒阶段如实失败。
  这不是已经修复运行时并发的证据；不得把 COMMIT unknown 当合法 loser。
  该生命周期反例收敛为单 native child 真实 COMMIT 后、父已接收 entry-ready
  才触发退出；正常双 CAS 正控、唯一 winner/token 和精确 failures 不变。
  修正后只做一次完整轮及10次正控复测；真正双 CAS 再红则停止，不无限重跑。
- 修正后的 owned 最终源码 SHA256 为
  `2190d6b0cd28f731fbc88ae8252491a428102bbd736375f9da6de59172048adf`。
  016完整63/63通过（78.76秒）；017原两项正控各10次、20/20通过。
  四permit的8个true/缺失变体共用真实BEGIN busy结果与实际分类器；六项真实IPC
  晚错/缺回调拒绝反例及单child退出切点均通过。015原件及红源码不覆盖。
- 最终默认并发全 ops v2：704项、700 pass、4个本地Linux专属skip、0 fail，
  2026-10-11 03:23:41–03:25:06 UTC，84.29秒；绑定上述 owned 最终 hash 和
  drain `7a55a5032f89c6a18df2eafae0b2e85f34d2a3ea0e69b5780f68f501d6cd93ad`。
  `all-ops-v2.json` 记录前后四文件 hash 无漂移；未设置串行/concurrency覆盖。
- 最终同源四路typecheck、scoped lint、专属文档/diff检查通过，记录
  `checks-v2.json`；收据增补全 ops 结果后另做文档检查，不移植旧文档 hash。
- 最后第二轮独立实现审查仍在进行；远端完整 CI 与合入身份仍待核，不预签通过。
- Eval 不适用：只改测试进程设施，A1 不执行此路径；未调用真实模型。

## 独立审查与证据

双独立方案审查 Blocking 0；所提 close、留存、其他 CLI 和同步 watchdog 要求已纳入。
最终实现需两位新非作者审查，最多两轮；旧 SSM 算法两轮审查不重开。

新私有证据保存于
`/Users/dongqiu/.local/share/insight-agent/evidence/drain-test-liveness-20261011-3rXjRC/`。
目录0700、文件0600；新失败、输出与 fixture 路径保留，不覆盖旧封存。
当前属于未完成验收的阶段记录，尚无新的远端通过或合入身份。

## 回退与限制

测试修复回退需普通 feature PR，仅还原对应新测试提交，不回写历史证据。
保持 #470 Draft、#471 未合入，最终完整 CI 通过前不推进依赖。
`safe_rollback=null`、deployment blocked、hold/#435 原样；未操作生产或清理旧环境。
本修复不是全 writer 静默、TD-09/TD-19 整体关闭或安全上线证明。
