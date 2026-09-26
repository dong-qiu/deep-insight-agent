# Podcast shadow → 离线评测输入

状态：实施中；关联 INSI-203 / INSI-206；基于 ADR-0027 / ADR-0032。

## 范围

从完整、关闭的 shadow SQLite 快照及其 archive，生成一个固定 topic 的 transcript-only
A1 quality JSONL 和无正文 manifest。只做确定性输入准备，不请求网络、模型或生产数据库，
不生成正式 dataset lock，不把输入准备成功表述为模型质量、来源许可或 enabled 准入。
现有 `eval:build-local` / A1 评分与默认数据集保持原行为。第二来源不足仍使真实双源验收阻塞。

## 输入契约

CLI：`npm run eval:podcast-shadow-input -- request.json /absolute/private/root/output`。
`EVAL_ISOLATED_ROOT` 必须为显式绝对路径、已存在且不在仓库 `.data` 内；shadow_root 和新输出目录
均在该根内，输出在 shadow_root 外。拒绝路径穿越、符号链接及非普通输入文件；输入使用已有文件
的 readonly SQLite 连接，不 bootstrap/migrate。在打开连接前验证 SQLite header 的读写格式均为1（DELETE/rollback journal）；拒绝WAL header和WAL/SHM/journal附件。调用方须在独立副本制备阶段完成DELETE模式转换，导出器不执行pragma/migration。

request 文件也必须是无符号链接的普通文件（上限1 MiB；CLI允许相对文件路径）。
request 使用版本 `podcast-shadow-eval-request-v1`，包含绝对 shadow_root、topic（id/name/keywords/
language）、采样事实的 UTC time_window、per_source 正整数及非空 sources：source_id、policy_version、
strategy、adapter_version。首版只支持实际已实现的 `rss-podcast-transcript-shadow-v1+podcast-screen-v1`。
选择以 acquisition occurred_at 为窗口，不隐式使用当前日期。topic 必须属于每个 source 的 topic_ids。

## 验收标准

1. 单读事务、显式 source/policy/strategy/adapter 绑定；只接受 observe/shadow 事实。验证事件键、
   semantic hash，存在 conflict 的固定范围失败。清单按唯一 candidate 计 eligible/attempted/succeeded；
   attempted 表示实际 attempt 事实，succeeded 表示最新尝试成功且 evidence verified。
2. 成功项必须有 candidate/decision/对应 attempt/terminal 全链；只取同 candidate 最新尝试，
   后续失败或 pending 不得回退旧成功。相同 episode 存在多个 candidate 时失败，禁止跨来源重复 URL 凑数。
3. 检查 archive 文件名的 source + envelope 身份哈希，v2 envelope / adapter / canonical episode /
   program-page 绑定，以及 RSS、页面、转写归档载荷哈希。source_payload hash 仅保留原采集指纹，
   无法从脱敏归档重算，不宣称原始载荷已重验。
4. 首版接受 text/plain、text/vtt、text/srt、application/x-subrip 和现有专用 HTML 格式，使用来源层
   的纯清洗函数重建 transcript，逐字对比保存的 cleaned_body hash。脱敏改变清洗结果、未知 MIME/
   adapter/schema、缺归档、过大（单 envelope >64 MiB）或不完整证据均失败。无 JSON/Pragmatic 适配支持。
5. 用真实 rawToContentItem 规范化，拒绝空/截断/partial 内容；body_kind 固定 transcript，
   speaker_map_status=unknown，无凭空 speaker map。只在内存生成 ContentItem DTO，不插入任何 DB。
6. 按 source 配置顺序及 canonical URL 固定排序，每源取精确 per_source 条。任一源不足、来源重复、
   窗口/版本错误时不输出有效包；show_notes/article fallback 永不入集。
7. 输出独占私有目录0700、文件0600、不可覆盖。包包含 quality.jsonl、evidence 副本和最后写出的
   manifest.json；写入失败清理本次新建目录。manifest 无正文/URL/凭据，包含 request、输入DB、工具
   文件和输出文件hash、工具commit、固定版本、逐源计数及每个选中事件/证据hash。
   采样时的commit未被既有schema保存，明确记为unknown，不用工具commit冒充采样commit。
8. 失败只输出稳定错误码，不泄漏原文、URL、SQL或路径。导出前后DB字节hash与输入归档保持不变。
9. 回归通过真实 shadow sampler/store（仅传输用构造响应）建立 fixture，再走CLI；覆盖两源成功、
   hash/身份/版本破坏、缺归档、冲突、重试失败、样本不足、路径逃逸/符号链接、输出保护和确定性。
   测试产物仅证明协议，不作为真实cohort或人评证据。

## 验证与后续

本切片不改变抓取、模型、prompt、validator 或评分规则；eval-gate 采用真实存储→CLI的确定性回归、
受影响测试、typecheck、独立审查及CI。A1不执行输入生成器，不运行付费模型来代替转换测试。
未来在有效来源/采集边界明确后，另做真实cohort采集和安全评测。副本延续来源raw的保留期限，
转换不延长保留授权，不上传/提交这些私有文件。
