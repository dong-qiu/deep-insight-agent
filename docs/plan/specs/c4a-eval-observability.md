# C4a：A1 有效配置、阶段墙钟与状态呈现

范围：TD-14 / TD-04 的观测切片。只复用 A1 manifest、progress、EvalConfig 与 role/by-operation telemetry；不实施 C4b、C2/C3，不调整模型、prompt、timeout、retry、并发、cache、恢复或任何准入规则。

## 兼容契约

- manifest/progress 加性新增可选 `effective_config` 和 `timing`。不加入 EvalConfig/EVAL_CONFIG_KEYS，不改变 checkpoint 配置 digest、cache identity 或 baseline 比较。
- 配置摘要显式投影已解析 EvalConfig，并调用运行路径已有 getter；模块加载常量与调用时 getter 保持原读取时机。摘要记录采样时刻的有效配置，不声称未来动态环境变化仍一致。无配置可取得时为 null，不回显非法原值。
- provider 的 SDK、transient、validator 外层重试适用性分别标明；Responses 的 pre-terminal EOF recovery（仍取已有 transient getter，默认一次、上限两次） 单独记录。不将未适用的 retry 设置说成实际执行预算。
- timing 从 main 入口（不包含模块加载）使用单调时钟，overall 与各阶段独立取起止差；请求 latency 保留在既有 role telemetry。阶段包括 setup、quality、consistency、coverage_benchmark、finalizing；重复 progress 更新不重新开始阶段。
- 未运行阶段 wall_ms=null；运行中为已取得 elapsed；终态保留完成/失败阶段时长。SIGINT/SIGTERM 走既有 failed 路径。SIGKILL/断电不能取得终态：最后 progress 仍为 running，不推断完成或补零。
- finalizing 从汇总/产物处理开始，终态采样截至最后 progress/manifest 发布前；原子发布本身 I/O 不包含于该采样。stage sum 不代替 overall；并行请求 latency 不相加为墙钟。
- 状态展示直接消费现有 status/auto_gate/baseline_comparison。无产物为未运行；旧字段缺失显示未知/缺失，不推导质量、可比性或计时。completed 表示编排完成，不表示自动门通过；自动门 pass 不表示 baseline 可比/DCP/人评通过。基础设施不完整继续使用 not_evaluated。
- 新观测对象不含 endpoint、key、环境全集、路径、原文或个人数据。错误路径只输出固定错误类别，避免异常内容进入日志和产物。

## 验收与反例

1. 默认和显式有效配置等于既有解析结果（含零重试与限幅）；正常调用参数、顺序不变，模块常量不重新读 env。
2. 注入人造 key、endpoint、正文和未知 config 字段：摘要、呈现日志及观测产物不含敏感值；失败异常也不回显正文。
3. 确定性时钟覆盖成功、失败、取消、setup 失败、尚未运行阶段以及中断后的 running 快照。失败保留先前计时，旧产物缺 timing 不造值。
4. 同一并行阶段多次 settled/progress 更新不重复累加；两条 latency 之和不能变成阶段 wall_ms。
5. completed+fail、completed+pass+incomparable、failed+not_evaluated 独立展示；不改变正式门退出码。
6. 现有 quality checkpoint、baseline/DCP、独立并发、coverage 执行失败、source identity 测试全部继续通过；新增观测不进入 checkpoint digest。
7. 通过隔离测试上下文夹具执行真实 run-a1 编排（mock 模型边界，无网络），核验 terminal manifest/progress、失败/取消及调用参数保持原样。

## 交付证据

定向确定性测试、双版本 typecheck、lint、必要构建、eval-gate 行为核对与独立 pre-pr-ai-review；D5 合入后基于最新主干重跑最终集成。完整 A1 和真实模型未授权，不执行。C4b 需要固定输入、配置、缓存/恢复条件、provider、环境的完整 wall/phase/role/by-operation 计时样本；本切片不承诺速度收益。

## 本地读取入口

`node --import tsx evals/a1-status.ts <manifest.json 或 progress.json>` 输出三个独立状态和阶段计时；不加载 `.env.local`、模型客户端或数据库。不传路径表示未运行；显式文件不可读表示读取失败，不能当作未运行。现有 role/by-operation P95 是包含重试的逻辑调用延迟，不是逐 SDK attempt 延迟。后者当前缺失，C4b 测量应明确此限制。
