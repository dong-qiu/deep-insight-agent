# P0c 生产容量验收（2026-08-17）

## 结论

生产规模匿名 fixture、受限视图索引计划与性能门均已验收通过。匿名生产规模测量已固化为
[`evals/provenance-p0c-fixture.v2.json`](../../evals/provenance-p0c-fixture.v2.json)，
`npm run benchmark:provenance-p0c -- --enforce` 默认使用该 fixture。

## 测量边界

- 方式：经获批的 AWS SSM 只读命令，在生产 app 容器以 SQLite readonly 连接执行聚合和 `EXPLAIN QUERY PLAN`。
- 未读取或输出 trace ID、实体键、报告正文、引用文本、prompt、密钥或个人数据。
- 时间：2026-08-17T15:47:12.206Z；数据库 65,961,984 bytes，906 条 trace。
- 运行环境：SQLite 3.53.2、WAL、`busy_timeout=5000`；x86_64、Intel Xeon Platinum 8175M、2 vCPU；`/opt/app` 文件系统 30,083,776,512 bytes（测量时可用 4,785,856,512 bytes）。
- 写入上下文：app、cron 与 generation-dispatch-worker 三个服务可发起写入；SQLite 在单库层面串行化 writer。

## 匿名聚合结果

| 指标 | P50 | P95 | 最大值 |
| --- | ---: | ---: | ---: |
| 每 trace event | 4 | 4 | 13 |
| 每 trace entity ref | 4 | 32 | 177 |
| 每 trace generation edge | 0 | 0 | 0 |
| 每 event entity ref | 1 | 15 | 34 |

生产尚无持久化 `generation_edge`；P0c 图在生产中由已落地的 event/entity refs 投影。v2 fixture 因而使用 0 edge fanout，并以 906 条 trace 的四段匿名 profile 精确复现上述 event/ref/edge 的 P50、P95 和最大值；同时填充临时 SQLite 至不小于记录的 65,961,984 bytes。该 padding 不包含生产数据，只代表与受测 provenance 表无关的数据库页规模。

## 索引与性能门

生产的 `EXPLAIN QUERY PLAN` 结果为：

- timeline：`idx_generation_event_trace_sequence`，并以 generation entity-ref 主键索引完成相关计数；
- event refs：`idx_generation_entity_ref_trace_event`；
- graph edge：`idx_generation_edge_trace_from` 和 generation-event 主键索引；
- graph ref projection：entity-ref 入口命中 `idx_generation_entity_ref_trace_entity_event`；event-ref 入口命中 `idx_generation_entity_ref_trace_event`，随后以 generation-event 主键索引关联。

timeline、event refs、graph edge 与两种 entity-ref projection 均未出现 `USE TEMP B-TREE`。event-ref projection 的临时排序已由索引驱动查询修复并加入回归测试；生产在 `ff8c4785a7dfa67a9d4f1b66f3ee25cf2e16a2dd` 部署后复验，执行计划为 `idx_generation_entity_ref_trace_event` 加 generation-event 主键索引，无临时排序。基准强制 `page_size ≤ 100`、图深度 `≤4`、图元素 `≤500`，并拒绝临时排序或任一 P95 超出 timeline/ref 1 秒、graph 2 秒的结果。

v2 gate 在记录的本地基准机（Darwin arm64、Apple M4、10 CPU、Node 25.9.0、SQLite 3.53.2）执行：timeline 0.037 ms、event refs 0.029 ms、graph 0.178 ms（各自 P95）。该性能数值仅适用于此已记录基准机；生产测量用于确定匿名容量分布和验证真实索引计划。生产已完成同一受限查询计划复验，P0c 容量门正式通过。
