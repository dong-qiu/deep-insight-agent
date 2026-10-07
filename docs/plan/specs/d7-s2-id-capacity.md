# D7 S2 / TD-20：自动配置与分析身份容量

2026-10-07。启动重新 fetch `origin/main`，base `473e2eeae119b600b63abd78ce886301bd882235`。
承接 [D7](d7-id-capacity.md)、[审计](../../verify/d7-id-capacity-audit-2026-10-06.md)、[D6](../../verify/d6-technical-debt-ledger-2026-10-06.md)。
用户已交接 S2a/S2b，仅修改生成表达式与必要 import/注释；其余消费者只读，新增专属测试与证据。

## 处置及交接表

| 切片/文件/身份 | 当前格式、有效随机位 | 生成时机 | 消费者及模型边界 | 新格式 | 风险及验收 |
| --- | --- | --- | --- | --- | --- |
| S2a `db/validate.ts` Topic | `t_<slug≤30>_<4hex>`，同slug16位 | name合法后、其他字段校验前；existingId优先、显式非空id次之，否则抽一次 | repos/config/default seed；topic路由、source.topic_ids、content.topic_ids、batch/report/lead/direction FK、provenance scope、analysis-cache key；Topic.id不在当前generation prompt，但完整Topic进入chunk输入hash | `t_<同slug>_<32hex>`，128位，最大65字符 | 保留lowercase/replace/slice规则（非ASCII折叠为下划线）；显式ID的既有trim及existingId原值不变；旧/新共存、seed/update不抽样、配置/精确查询/路由/归档关联不变 |
| S2a `db/validate.ts` Source | `src_<slug≤30>_<4hex>`，同slug16位 | 同Topic；其他字段失败仍保留已抽样行为 | config、源采集/熔断/统计、content.source_id FK、raw及provenance；renderItems的来源行直接进入模型 | `src_<同slug>_<32hex>`，128位，最大67字符 | source ID每出现一次请求增加28 ASCII字符/字节；固定输入实测payload，不推断质量等价；显式/历史/更新保留、unique/FK/事务失败保持 |
| S2b `agents/analyzer.ts` candidate | `ins_<UUID前12>`，44位（含连字符） | 模型返回后、coverage审计前，每candidate一次，包含之后被丢弃者 | coverage candidate/audit映射、chunk checkpoint；当前generation/coverage语义请求不渲染candidate ID | `ins_<32hex>`，128位，36字符 | 受控随机调用次序及真实Node格式；candidate→正式insight→audit精确绑定；被拒候选仍无正式insight；fallback摘要不改 |
| S2b `agents/analyzer.ts` batch | `batch_<UUID前8>`，32位 | coverage配置预检后、分块/checkpoint校验/模型调用前，一次；空输入也生成 | DB/validation/provenance/cache实例化；派生 `ins_${batchId}_${i}`、`evt_${batchId}_${i}`；event由renderHistory进入未来模型 | `batch_<32hex>`，128位，38字符；派生ins/event保持公式，单数index为44字符 | 每历史新event在generation请求增加24字符；旧历史event白名单精确复用、伪造拒绝；batch冲突仍SQL拒绝，不重跑模型；cache首写不覆写、引用保留 |

16个随机字节为128位；完整UUIDv4仅122位。前缀、slug、index不额外增加随机熵。
使用现有Node crypto，不扩展S1 helper，不建设解析/注册/重试平台。四处调用原位置、分支和次数不变。
不迁移schema、不改历史ID/URL/FK/raw_ref/文件/缓存；不改ContentItem/citation_ref/fingerprint/canonical_key/UUIDv5/幂等/Controller算法。

## 先反例后实施

- 专属S2a契约：同slug及非ASCII/最大slug格式；受控16bytes全编码及未mock Node；显式/空白/更新/后续校验失败抽样顺序；非法字符/traversal/NUL仍拒绝。
- S2a真实内存SQLite+迁移、repos/config和真实POST/PUT handler：旧/长Topic/Source混存、精确查询、seed重复、source→topic→content关联、unique409、FK及事务回滚。HTTP鉴权沿用实际middleware测试，不将handler测试冒称认证证明。
- S2b真实analyze，mock仅模型边界：完整generation+双coverage→candidate/batch/insight/event/citation_ref/audit→真实DB→validation→report/history；混旧历史精确复用、虚构event降级；空输入/配置错误/取消/拒绝保持；碰撞落库失败不再次调用模型。
- cache真实写/读/实例化：旧event保留、insight按新batch重建、首写不覆写、topic隔离、窗外citation拒用。checkpoint完整chunk原候选保留；topic/source/history变动hash不同且拒绝；A1恢复源码commit/dirty身份不同拒绝。不修改C4b归一化规则以伪造可比性。
- 先在base上验证旧/长合成消费者，再运行新生成契约，记录仅格式/bytes断言失败；独立review通过后逐切片替换生成器并重跑。

## AI证据与停止点

固定合成输入捕获实际callStructured请求，比较system/user/schema/maxTokens及coverage payload；只替换指定source/event身份得到长度、字节差与digest。
无provider tokenizer时token影响未知，只记录ASCII增量及粗略估计范围，不称实际token测量；真实usage必须由专项模型验证补足。
Topic/cache/chunk输入hash变化不等于prompt变化；batch/candidate当前请求相同不证明未来历史请求相同。
mock只能证明接线/契约。模型/provider/thinking/prompt/dataset/阈值/baseline保持。
按eval-gate：触及analyze，A1是有效门；L3与eval-criteria定义当前prototype的既有最小真实安全证据，不由本任务另缩样。
当前真实模型预算0，不盖skip/pass/scoped假章；专项范围见[验证申请](../../verify/d7-s2-model-evaluation-proposal-2026-10-07.md)。
必要真模型验证先给最小范围、硬请求/重试上限、时间窗口和额度风险，等待专项授权；未有证据时Draft/未验收。
若正常push hook因此拒绝，不设置ACK或伪造trailer；可先交付无敏感源码的审计/专属测试PR，源码留本地待证据。

受影响测试、typecheck、lint、coverage，最终构建使用C5单build收据，HTTP/browser复用同一身份；最终diff独立review并复核修正。
本地隔离实施/测试/review/PR已授权；合并/部署/生产访问/迁移/恢复/历史修复/模型调用/分支删除均不执行。
回退仅生成器重引入容量风险；base消费者先验证新格式，不能删除或重编号新对象；不得倒退C1删除与发布保护。
TD-20整体仍须按原验收及剩余审计范围决定，不因S2源码或CI完成就关闭，不以镜像发布作生产验证。

## 追加交接及方案复核

用户追加交接 `evals/c4b-recovery-measurement.test.ts`，仅适配完整新/旧batch/candidate双格式正则及专属反例。
32hex优先、尾部hex负向边界，既有有序双射/原始产物hash校验/派生digest重算保留；源码、配置与恢复身份不归一化。
不修改C4b样本、runner、checkpoint源码或性能结论。原源码旧格式消费者反例先通过，随后逐切片改变生成器。
独立方案review已补强candidate kept/kept与kept/dropped重复、cache真实hits+miss pipeline、report support阳性/blocked/缺记录、
schema/显式空白及抽样次序、复制已落盘chunk及源码身份漂移拒绝。最终实现review仍保留真实模型质量Blocking。
