# TD-14 / A1：获授权的单次真实诊断

本收据续接[零付费准备](td14-a1-attempt-diagnostics-2026-10-07.md)及[测量 spec](../plan/specs/td14-a1-attempt-diagnostics.md)。用户在专项申请后明确回复“授权”；只执行一次固定 1/12/14/8、最多 80 transport attempts、45 分钟的 cold/no-resume 诊断。没有扩大样本、自动重跑、恢复、合并、部署或清理。

## 冻结身份

被测源码 `d18009f221a51662ca3802d0fc06a2839e0ee929`，dirty=null、identity_complete=true；启动 origin/main 仍为 D6 `473e2eeae119b600b63abd78ce886301bd882235`。选择 D7 前输入，不混用 D7 S2 身份。
Node v24.19.0 / npm 11.17.0 / macOS。lockfile SHA-256 `63427dc25bd41f83b2db7c4842966df364b73d110d7c95c8f693b77eaebbcad2`。
重新执行拒绝网络的 prepare，并逐字段核对 config、effective_config（除采样时间）、输入、限制和 cache/resume 与此前申请一致；执行终态再次匹配配置、源码和 checkpoint recovery identity，源输入/产物 hash 核验通过。

- prepare plan 文件 SHA-256：`2d03bf114b71467bddbcd045229396878385687d9bad43268074af221081ad71`。
- recovery identity：`d5a3dca8eb36f4825f93ee31bcb22ce6fd188935a6270eb3da623cb1ae1434a7`。
- EvalConfig canonical SHA-256：沿用 `22d79dcecb79b1dae6dbe830dac3a6ca30f1814aa37ebedb01b29793d75fa288`。
- 原文件字节、selected canonical 输入、prompt/协议 hash 与[准备收据身份表](td14-a1-attempt-diagnostics-2026-10-07.md#冻结身份及实际准备结果)一致；实际选择 1 quality / 12 consistency / 14 display / 8 quote，dataset 顺序、一个 quality chunk。

现用 Responses；analyzer deepseek-v4-flash / validator deepseek-v4-pro / coverage glm-5.2，thinking false/false/true；coverage/primary maxTokens 2048，每 primary call 一条 claim。
独立 mapper 并发 1；analyzer 内部仍有候选审计并行，未改并发。LLM timeout 120000ms、topic 1800000ms、judge/coverage 300000ms。
Responses EOF 额外 retry 1 / backoff 750ms，SDK/validator 外层 retry 不适用（null）。prompt cache=false，无 runner validator cache、无 resume、P0 不调用 backfill。provider 可以自行报告缓存命中，不能把该开关当 provider 无缓存的保证。
无本会话 build、coverage、全量测试等重负载并行；不主动 flush OS cache。cold 表示新进程，不表示 OS 页缓存冷。

## 终态与阶段墙钟

run `a1-20261007045514-233e4d10`，一次执行；退出 0、无 signal、window_exceeded=false、stop_reason=null，measurement_complete=true / diagnostic_execution_complete=true。
status=completed、auto_gate=smoke、baseline_comparison=incomparable、manual_review=pending、DCP ineligible。
只建立该冻结子集的诊断样本，没有可比 before，不能报告整体 A1 提速、吞吐、质量提升或 attempt P95。

| 边界 | 墙钟 ms | 占外层进程墙钟 |
| --- | ---: | ---: |
| spawn→close | 169376.976 | 100% |
| main（C4a） | 169131.449 | 99.855% |
| setup | 47.058 | 0.028% |
| quality | 52658.780 | 31.090% |
| consistency | 36651.596 | 21.639% |
| display/quote benchmark | 79423.561 | 46.892% |
| finalizing | 350.447 | 0.207% |
| 最终 progress/hash/manifest/rename/pointer 发布 | 1.943 | 单独 IPC 边界 |
| outer−main | 245.527 | 0.145% |

并行阶段以起止墙钟记录，未累加子请求作为整体耗时。outer−main 包含 module loading、发布、退出和 observer 残差，不单独归因。setup+finalizing+残差约 643ms，只是本样本可见本地工作与混合残差，不等于纯 CPU/I/O 成本。
运行中 progress 会在同阶段刷新，早先 17/30 次快照不能作为阶段交界累计；下表按终态 call.phase 归属。

## 调用放大与用量

34 logical calls / 34 actual attempts，34 call succeeded / 34 attempt EOF，raw samples 全部保留；每个 call 只有一次 attempt，无实际 SDK/runtime EOF retry。

| 阶段 | logical / attempts | operation 分布 |
| --- | ---: | --- |
| quality | 10 / 10 | generation 1、primary 4、countercheck 4、consistency 1 |
| consistency | 12 / 12 | consistency 12 |
| benchmark | 12 / 12 | primary 2、countercheck 10（display 2、quote 8） |

14 display fixture 并不意味着 14 个模型请求：保留生产路径的确定性拒绝/短路；quote benchmark 独立执行 countercheck，不通过 primary AND 门掩盖错误。没有跳过 coverage 或减少必要校验。
quality 生成 7 个候选、最终 reader-visible 1 个；候选被保守筛掉前的审计仍消耗调用。没有语言 repair、拆批或 backfill operation，relay recovery/probe/backoff 计数均为 0；这些缺席仅描述本样本。

| role / operation | calls / attempts | 累计 logical latency ms（非整体墙钟） | 单 call min–max ms |
| --- | ---: | ---: | ---: |
| analyzer / generation | 1 / 1 | 15830.810 | 15830.810–15830.810 |
| validator / primary | 6 / 6 | 14499.465 | 1817.437–2935.752 |
| validator / consistency | 13 / 13 | 39757.831 | 2597.686–4060.373 |
| coverage / countercheck | 14 / 14 | 106089.752 | 2717.334–31648.909 |

coverage 的累计 attempt wall 为 106079.867ms、累计到 headers 为 19152.833ms；剩余仍包括网络/流消费和 provider 工作，不能称纯模型服务时间或单独归因 thinking。quality 的请求存在重叠，累计延迟不能与阶段墙钟相加。本样本 coverage countercheck 是累计请求延迟最大来源，benchmark 是墙钟最大阶段。

usage reported 34 / partial 0 / unknown 0，指每次最终 input/output 原始数字齐全；不意味着所有缓存字段或账单已知。
input 56614 tokens / output 10405 tokens；analyzer 5093/2031、validator 33852/2514、coverage 17669/5860。
cache-read 数字已知 15 次、未知 19 次；已知数字累计 3648。cache-creation 34 次均未知，不能记为零。金额 estimate 全部 null/unknown；Coding Plan余量与费用未测，80 请求cap不是金额cap，本地结束不能证明撤销在途 provider 费用。
单运行及各角色数量不足以推断稳健尾延迟；legacy telemetry 自带的 p95 字段仅保存在私有原产物，不用作本收据尾延迟结论。

## 质量与争议边界

执行完整：quality 1/1、judge 12/12，无基础设施失败或截断；12 个 judge 与冻结标签一致（support 3 / not_support 7 / uncertain 2）。
display 14 个负例无 unsafe_accept/projection_violation；其正例为 0，不能由此声称 false-reject 已获验证。quote 4 正/4 负无误接或误拒；只支持这几个固定样本。
review queue 为 1，人工审查仍 pending、未进行裁决；没有因性能结果关闭争议样本。dataset lock=verified_legacy，smoke 和无可比 baseline 继续限制质量结论，不更新 baseline/评分或引用白名单。

## 优化决策与下一步候选

本轮选择不实施优化。当前实测主要成本是必要的模型审计，不是 setup/发布或 retry；凭单样本删审计、改模型/thinking/prompt、提高并发都不符合本轮边界。TD-14继续部分完成。

| 候选 | 预期收益与证据 | 效果风险 / 验证 | 回退 / 授权 |
| --- | --- | --- | --- |
| 减少确定性 setup/产物工作 | 本样本全部本地边界/残差合计约0.64s，优化其中一部分的收益更小；暂不推进 | identity/hash/checkpoint/发布原子性可能受影响；需CPU/I/O细分及等价回归 | 独立代码切片可回退；真实before/after需另授权 |
| 同run严格相同countercheck输入复用 | 尚未证明重复请求身份，无可量化收益；先零付费盘点quote/input hash | 缓存必须覆盖模型/协议/prompt/参数/quote/locator且不混合判定；不得缓存不完整执行 | 默认关闭、独立方案；若实施或付费效果测量另行申请 |
| 补尾延迟/重复诊断样本 | 可核对这次31.65s长样本是否稳定，不直接提速 | 样本与顺序要冻结，不混D7；质量与计费不确定仍保留 | 需要新样本/attempt/窗口专项授权；当前授权已使用，不重跑 |

原产物和 raw samples 保存在隔离 worktree `.private/td14/authorized-20261007/`，不入仓；checkpoint未修改、未自动恢复。
manifest SHA-256 `80e806267aeaeedc2ecd4562d54413575b7f1c94772811a92344dba9c7e51094`；a1-run `99e72644b1ae5110806bd4705418f316cf34cffd21246e84dd7c4cb6c5d36f0c`；quality-checkpoint `1b47604e2aba9ed4314e971ce7c477371b63b6c03b36117d413c5bd989ad302e`；process-observation `86eab4b98f445e878eb81e30fb311a66de9efcc4f08528a424501b9af546d1da`。
后续文档提交改变分支源码身份，不改写这次被测d18009f身份或恢复其checkpoint。独立证据审查及最终候选CI追加PR交付记录；本收据不预先宣称未来CI通过。
