# Owned-drain IPC callback fault oracle：test-only 候选

## 冻结范围与来源

主控前瞻授予本切片唯一测试写窗，基线 `e5239dfbdcdb822bac58bb11cae21444300f03c2`，原测试 blob `1a6ecd71fc7d6549bac79206acd5cbbee648f2a2`。只更新 `ops/maintenance/owned-drain.node-test.mjs` 与本收据，不修改 runtime、native helper、CAS、计时或其他非 IPC 字节。

精确测试 SHA256：`10fe1458adacb8ed9cacc4e1a5a0371fd7068715343f251b1d9ce4444e0e655f`。私有候选完整 diff SHA256：`d64ecc43e405a4e9697e84f566e05c0c008397e30b9c52ae6d7e2cb62ceaaf79`。来源封存索引：`144f3efc30caaec6995a997178a4b5ddc55e6c1c8f476e5e080d7c24202f0dc9`。索引及原件为私有本地材料，不随代码上传。

六个 ready/entry/facts × late-error/no-callback 用例将 IPC 故障目标与初始双进程 CAS 竞争解耦。单 child 必须自然完成初始提交，实际 entry 消息后才释放第二阶段；真实 send callback 成功后固定 receipt 证明目标故障已注入或抑制。严格核对 exit、close、stderr、原 watchdog、held token 六字段、持久 hold、准入与所有许可。初始 unknown 不能计为 IPC 验收通过。已有独立并发 CAS、BEGIN busy、COMMIT unknown 反例保持；未引入 AnyError、sleep 或 busy timeout。

## Pre-PR AI Review

- 基线：上述精确 main。
- 风险：高；测试 oracle 与 native/并发失败路径。
- 两位独立非作者各两轮静态审查已完成。R1 missing-token P2 原件保留；R2 使用真实 held op 完整六字段绑定与 missing/wrong-token 负例，最终 Standards/Spec 无剩余确定阻塞。
- 本轮仅补来源、Git 上下文、文档与字节身份附记，不开启第三轮算法审查。
- Blocking：无未解决静态项；实际候选 CI 尚待验收，不宣称最终验证通过。
- Warning：生成 child 模板、native 行为与真实六用例尚未执行；静态审查不能签执行资格。
- Eval：不适用。没有 AI 输出、prompt、模型、来源或评测集变更。

## 验证与证据边界

2026-10-11 23:35:34 UTC 对本次精确 R2 测试文件执行一次 Node v24.19.0 `--check`，实际 exit 0、close 0，双路输出为空。这仅证明外层文件解析，不证明动态生成 child 模板或 native 执行。

受影响测试、类型检查、构建及现有 required 门交由新精确候选的自然 GitHub CI。候选 SHA、actual tested merge/parents、run/attempt、各门结果与原包身份须在 PR 追加核验，不把提交前待验记录修改成旧候选证据。失败保存原件并停止，不静默修改测试或重跑旧失败 attempt。

PR #479 的精确 main CI `38178530375/1` 失败继续保留：旧 entry IPC 用例在初始两 child 均 unknown 时未触达故障目标；具体锁 owner 与原 parent Error 未直接记录，不归因为 flaky 或文档。其他 feature CI 不能替代该失败。已有 reader 性能 Warning/PASS 不等于 A1 性能证明。

## 交付与保留

本轮仅 feature PR，不批准合并、部署或清理。旧文档分支保留；原 native worktree 九项未提交文件、HEAD/index、其他 owner、配置、数据与旧封存保持。新发布证据根为私有目录，原始日志不进入 Git。

`safe_rollback=null`、deployment blocked、hold/#435、controller/qualification=false 保持。没有本机 case/import/native/DB/VM/container/install 或模型执行；真实恢复、P1、prepare、matrix 与模型预算消费均为 0。真实环境、全 writer 静默或恢复资格不由本次测试 oracle 交付证明。
