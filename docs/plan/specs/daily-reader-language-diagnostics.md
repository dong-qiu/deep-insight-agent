# 日报失败诊断与中文结论守卫

## 范围

内部原型的小范围修复；不更换模型、不调整 Coverage thinking/token 预算、不放宽引用门槛。
历史失败不伪回填：2026-09-25 产业日报留下了 14 候选全拒绝的异常，但无对应批次审计；
旧容器已替换，现存 json-file 日志不覆盖该时段，不能确定逐条拒绝根因。

## 验收标准

1. 生产 `runAnalysis` 的缓存 miss 与全量路径均收集候选诊断；成功和失败均落独立的
   `analysis_coverage_diagnostics` revision，与同 trace 的既有 `analyze/completed` 或 `analyze/failed`
   事件在同一事务写入并通过 output_refs 关联；不新增事件类型或数据库迁移。
   只保存受控终态/原因码、翻译阶段枚举、候选 ID 的哈希、前后审计及 prompt 哈希和计数；不保存 claim/quote/body、
   evidence excerpt、未受控错误文本或完整 audit JSON。没有诊断时不伪造记录。
2. 写入仍受 dispatch fencing 保护；失败不得生成成功 batch/report，不得覆盖原失败信号。
   诊断记录不参与 publication whitelist，也不把缺失历史记录宣称为 complete。
3. 中文主题的纯非中文结论不能直接发布。先按原门审计原 claim，仅对已通过的非中文
   claim 使用 analyzer 模型做一次有界中文改写（最多 1024 输出 token，无上层递归重试）。
   正常中文、英文及 mixed 主题不增加此调用。
4. 改写不得修改绑定 quote、locator、来源、数值或范围；改写后必须重新通过原有稳定 token、
   原子绑定、primary + independent Coverage 及重要性锚点检查。译文 primary 还接收转义后的原始 claim，
   同时判定事实等价；原始 claim 不是支持证据，不能补足 quote。独立 quote-only Coverage 输入不变。
   事实改换、删除限定或扩写均拒绝，失败不回退英文。
   原始未通过的 claim 不得借翻译被修好后发布。保留改写前后哈希和复核证据。
5. 首版语言检查只可靠检测“完全没有汉字”的结论，不声称解决所有混合语言/翻译质量问题；
   不能用该机械检查代替事实审计。专名与数字可保留英文。
6. 输出/缓存版本升级，使旧英文结论缓存不能继续复用。既有历史报告不原地重写。
7. 回归覆盖：全拒绝仍可诊断、部分记录后异常、租约失效、敏感文本不落诊断、正常路径无额外调用、
   改写成功、仍为英文、语义扩张、原始主张不支持、超时与取消、引用不变、读者审计哈希一致。
8. 运行受影响测试、typecheck，以及生产同 provider/model/thinking/token 配置的 prototype-safety；
   补真实模型的中文改写定向检查。小样本不声明完整 baseline/DCP，人评与上线验收独立。

## 相关契约

这是 `report-quality-review-trace.md` 的失败路径补充：诊断只用于管理员复盘，非完整 LLM 重放。
中文结论是经审计的 reader_statement；statement 继续保留绑定原文，原文不是翻译结果。
