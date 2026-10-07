# D7 S2b 专项评测守卫

本切片只新增专属 eval 工具、合成测试及本文档，不改共享 runner/runtime/LLM/usage，不扩大 S2b 的三个 ID 文件窗口。S2b 候选与本守卫分别冻结 clean commit/tree/lockfile，证据必须同时绑定两者。最新 main 基线为 e6045adf3233fdded3b7567a0debd6962970c165，包含 #434 的 41d40ed2f3fcb4140d0fb706e912b6b7f4a76ed1；后续变更重新冻结。

## 验收与反例

- 一个任务最多 100 次实际 HTTP fetch admission、20 次保守 retry/amplification、一个从任务创建起 45 分钟的绝对 deadline，包含加载、四个身份 case、原 prototype safety 清单和最终发布。第 101/21 次发送前拒绝；模型请求上限不是金额或额度上限，已发送请求可能继续计费。无自动重跑或恢复。
- 每个子进程通过专属 preload 加载候选的同一个 `A1AttemptDiagnostics`/observer 模块；原 runner 的内层 observer 仍可观察实际 SDK/runtime fetch。未知 logical call、operation、请求形状或 model 关联拒绝发送。实际 Anthropic SDK retry、Responses EOF retry 和跨 logical validator retry 必须用假 transport 证明；不以 logical calls 代替 HTTP attempts。
- Retry 取这些条件的并集，每次最多计一次：同 segment/logical 的后续 fetch，同 segment/model 的相同完整 body，SDK retry header，segment 内额外 analysis generation，以及 repair/backfill。身份 segment 由专属 case 明确设置；A1 使用 phase，不能使用 settled 后才更新的 case index。重复的合法输入也可能保守消耗 retry；超限保持未完成，不删样本凑预算。原 P0 不调用 backfill；意外未知 operation 直接拒绝。
- 子进程顺序运行，通过 `wx` actor lease 排他；存活期间唯一 budget writer 为该 child。父进程只在 close 后更新 owner/state；取消通过独立 `wx` STOP marker，不能覆盖 reservation。deadline/STOP 在 reserve、写请求后紧邻 native fetch、body read、finish、child exit 和父进程发布检查。父进程整个任务生命周期保留 signal/deadline handler，parent-only certification 也不能留下假完成。
- 任何 cap/cancel/timeout/late/schema/coverage/validator 基础设施错误、身份/config/source 漂移或安全失败均 sticky incomplete。父进程在 child close 后只封存自己的全新 task root：撤 own latest pointer/pass receipts，checkpoint recovery identity 置 null，删除 case.completed，manifest/progress/diagnostics 标失败、撤 completed counts，重算 artifact hashes，保留原 hash 审计。损坏 budget 或个别损坏 artifact 不能阻止其他有效产物封存。实际 checkpoint loader 必须拒绝恢复。
- 身份输入文件固定 SHA-256 `056a6748ad961d4785ae36f1a5706ca1efda3af692613a681d4137f0f6d14c37`。四 case 仅替换 Source 与历史 event；实际生成请求的完整序列化字节只能有规定替换。当前随机 candidate/batch 不得进入本次生成请求；未来 history 的 event 根改变输入。生产 analyze → coverage → validateBatch 检查历史白名单、followup、citation/quote 原文绑定。合法无输出与未知 event 只记真实观察，合成 transport 才能强制分支；四 case 不能证明统计质量等价。

## 授权与执行

用户已授权按“守卫 → 专项真实评测 → 正常 PR/精确 CI”的顺序继续，第 2 项专项授权沿用先前提出的一次 100 attempts/20 retries/45 分钟任务；不使用 #431 剩余额度。先完成无网络测试和独立审查，再运行 `--prepare`（0 admission）冻结当前输入/config/source，之后 `--execute --prepared <preparation.json>`。CLI 默认不执行，不能复用 output root。原 prototype safety 固定 1 quality/12 consistency/14 display/8 quote，config canonical hash `22d79dcecb79b1dae6dbe830dac3a6ca30f1814aa37ebedb01b29793d75fa288`；不换 provider/model/thinking/prompt/dataset/阈值/baseline。

专属子进程直接加载候选 `run-a1.ts`，避免原 prototype wrapper 派生未带 preload 的孙进程；父进程使用原 `applyA1PrototypeSafetyConfig` 和 `certifyPrototypeSafetyRun`。全部必要样本执行完整，规定的 support/uncertain/三类 not_support 完整，display/quote unsafe_accept=0，四身份 case 完整且引用绑定正确，两个 diagnostics attempt 数之和等于共同预算 admission 数，方可生成 scoped prototype safety 与任务收据。不得将 prepare exit 0、mock、旧候选的测试或 CI 当作当前真实质量通过。

所有输入、请求 body、模型结果、checkpoint 和详细日志均为私有产物：root 0700、文件 0600；不保存请求 headers/key/endpoint，不提交原文或结果。无生产访问、数据库复制、迁移、恢复、合并、部署或清理授权。S2a 的旧 head 质量验收独立，TD-20 整体仍部分完成；正式 baseline/DCP/人评不由本专项签章。
