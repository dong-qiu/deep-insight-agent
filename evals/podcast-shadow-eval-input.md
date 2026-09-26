# 从 podcast shadow 快照准备离线评测输入

此命令只生成私有输入，不采集、调用模型或写 SQLite。它不解除 INSI-206 的第二来源阻塞，
也不表示 transcript 可以进入生产报告。验收契约见
[spec](../docs/plan/specs/podcast-shadow-eval-input.md)。

## 准备

使用 Node 24。把**完整、关闭**的 shadow 快照（`shadow.db` 与 `archive/`）放入私有隔离根，
例如 `/private/tmp/podcast-eval-private/snapshot/`。不要直接复制正在写入的 DB 主文件；应先由
已有快照流程完成一致备份；仅在新建的私有副本上将 journal_mode 转成 DELETE，再关闭连接。
即使WAL数据库已经干净关闭且没有旁文件，也会被拒绝：readonly连接本身可能新建WAL/SHM。
转换器在打开前检查header，不会替调用方改数据库模式。命令拒绝 WAL/SHM/journal 附件和符号链接，路径须使用
真实绝对路径（macOS 的 `/tmp`、`/var` 可能是别名，先用 `realpath` 确认）。

在这个私有根创建 `request.json`。以下是**格式示例**；第二来源 ID 是占位符，不是来源批准：

```json
{
  "version": "podcast-shadow-eval-request-v1",
  "shadow_root": "/private/tmp/podcast-eval-private/snapshot",
  "topic": {
    "id": "t_code_agents",
    "name": "AI 软件工程",
    "keywords": ["agent", "software"],
    "language": "zh"
  },
  "time_window": {
    "start": "2026-09-26T00:00:00.000Z",
    "end": "2026-09-27T00:00:00.000Z"
  },
  "per_source": 2,
  "sources": [
    {
      "source_id": "src_chain_of_thought",
      "policy_version": "replace_with_recorded_policy_version",
      "strategy": "all",
      "adapter_version": "rss-podcast-transcript-shadow-v1+podcast-screen-v1"
    },
    {
      "source_id": "replace_with_approved_second_source",
      "policy_version": "replace_with_recorded_policy_version",
      "strategy": "all",
      "adapter_version": "rss-podcast-transcript-shadow-v1+podcast-screen-v1"
    }
  ]
}
```

`time_window` 是 acquisition candidate 的记录时间范围；tool 要求最新尝试也已在窗口结束前完成。
它不是按运行当天重新筛选。topic 必须存在于每源快照的 topic_ids；topic 名称和关键词由请求方
显式冻结。每源数量由 per_source 决定，所有指定来源都必须满足；单源调试不代表双源验收。

## 执行与结果

```sh
EVAL_ISOLATED_ROOT=/private/tmp/podcast-eval-private \
  npm run eval:podcast-shadow-input -- \
  /private/tmp/podcast-eval-private/request.json \
  /private/tmp/podcast-eval-private/output
```

输出目录必须不存在。成功输出：

- `quality.jsonl`：现有 A1 QualityCase 形状，`stratum=transcript`，仅包含完整 transcript DTO；
  `raw_ref` 指向本输出目录的 evidence 副本，复制/移动后不能直接复用旧绝对路径。
- `evidence/*.json`：逐项已验证的脱敏 v2 envelope 副本，不是新的采集证据。
- `manifest.json`：逐源 eligible/attempted/succeeded/selected、选中事件与版本、DB/request/输出哈希、
  转换工具 commit 和实现文件哈希；不含正文或 URL。

采样 commit 未存在于旧 shadow schema，因此 manifest 的 sampler_commit 为 null；工具 commit
只代表本次转换器。RSS/页面/转写的 archived hash 可重算；已脱敏载荷不能重建采集前 source hash。
转换器严格核对 cleaned hash；若脱敏改变了原清洗结果，该记录失败，不能重写历史hash让它过门。

选中 DTO 使用来源层真实 normalizer，speaker_map_status=unknown。相同请求/快照有稳定选集；
输出路径参与 raw_ref，因此换输出目录会改变 quality 文件hash，但不会改变选集/内容hash。
清单中 succeeded 是最新成功事实数，不是模型认可或发布数量。失败没有有效输出包，stderr仅错误码。

所有产物只供本地私有诊断，必须沿用原样本的保留期限，不能通过转换延长权限。不要提交或上传
quality/evidence；将来真实双源材料齐备后，另行按 eval-gate / ADR-0032 执行对应模型评测。
