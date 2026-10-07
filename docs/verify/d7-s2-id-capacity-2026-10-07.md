# D7 S2 本地证据及分片交接（未验收）

基线重新获取为 `473e2eeae119b600b63abd78ce886301bd882235`。方案与处置表见
[S2 spec](../plan/specs/d7-s2-id-capacity.md)，模型预算申请见[专项方案](d7-s2-model-evaluation-proposal-2026-10-07.md)。
S2a/S2b生成表达式和C4b测试窄窗口均已获得用户交接；未改其他Session文件。
专属worktree `/Users/dongqiu/Dev/code/insight-agent-d7-s2`；只复制0600的`.env.local`并隔离DB_PATH/DATA_DIR，未复制数据或开发env。

## 完整本地候选及反例

分支 `feat/d7-s2-id-capacity`，head `e59b304e64b5730646adf843ae42e38f7bb8a68e`；未推送，未创建S2b PR。
提交顺序为 `e17cbd8` 契约/反例，`312238c` S2a，`e59b304` S2b及补强测试。
旧实现首轮有效反例：4文件29测试，7个新生成契约失败，22个消费者/安全反例通过；排除先前测试fixture错误。
补充candidate独立契约时临时换回该表达式的base实现，确认旧UUID片段不匹配32hex；恢复候选后通过。
未变更数据库、模型、prompt、provider、thinking、数据集、阈值或baseline。

| 验证 | 绑定上述完整本地head的结果 |
| --- | --- |
| 独立最终review及专属测试 | 5文件34测试通过；确定性实现无Warning，真实模型证据1项Blocking |
| `npm run test:coverage` | 267文件2806测试及164个ops测试通过；statements79.96%、branches72.43%、functions79.87%、lines83.87% |
| `npm run typecheck` / `npm run lint` | TS7/TS6 app及tools均通过；lint通过 |
| `npm run build:e2e` | 21,239ms，1次build；收据绑定上述精确head |
| `npm run test:e2e:built -- tests/e2e/d7-s2-id.e2e.ts` | 1测试通过；真实登录/鉴权、自动及旧ID、更新、冲突、非法路径、配置页及Topic路由 |
| `npm run test:browser:built` | 7测试通过；复用同一构建，额外build=0；reader缺失归档拒绝、登录/退出、引用下钻及窄屏 |

以上不是S2a分片新head的构建/CI证据。分片最终SHA、复跑及CI以PR正文/Checks为准。
局部HTTP/browser使用临时合成数据库与无真实密钥env，无采集/生成请求；浏览器阻止外部网络。

## 固定AI请求证据与边界

真实analyze→callStructured→SDK/provider序列化→拦截fetch，两种transport均无网络。固定正文、schema、system、模型及参数，
仅换Source及历史event身份后请求精确多52 ASCII字节：Source出现一次+28，event出现一次+24。
Anthropic请求15,725→15,777字节；volcengine-responses请求15,715→15,767字节。
摘要和完整替换断言由 `src/lib/agents/d7-s2-payload-transport.test.ts` 可复现；coverage payload相同由完整候选S2b测试覆盖。
Topic完整对象进入chunk输入hash；Topic.id不出现在当前generation prompt。candidate/batch当前请求不含该新随机ID，
新batch派生event会进入未来历史请求。不能据此推断输出质量相同。
没有实际provider tokenizer/usage证据，token及成本影响未知；mock的usage不是实测。
真实模型调用0，prototype safety及身份对照未运行，无baseline对比和Eval-Gate通过章。

## 分片交付与恢复约束

- S2a Draft只包含Topic/Source生成器、专属测试、离线transport测试、HTTP及方案/证据；自动后缀16→128位，slug和原抽样分支/时机/次数保留。
  显式ID按既有trim规则、existingId及历史ID不重编，冲突/FK/事务仍按原行为拒绝。Source模型身份变化仍阻塞验收。
- S2b candidate44→128位、batch32→128位已在完整本地分支实施及审查；DB→validation→report→history、cache及checkpoint反例通过。
  C4b只双格式正则/专属反例，保持源码/config/recovery身份保护，不改性能样本/结论。全部S2b及C4b文件未进入S2a PR。
- 完整候选正常eval门检查拒绝Analyzer源码缺章；不设置ACK，不伪签skip/pass/scoped。S2a路径不触发现有机械push门，
  仍主动记真实模型质量Blocking，不能把hook或CI绿当作AI质量验收。
- 回退生成器会重引入容量风险；旧消费者合成验证支持长ID，但不能重编号/删除新对象，不能倒退引用白名单/reader/删除保护。
  A1源码、输入及checkpoint身份变化拒绝跨版本恢复；不得混用改动前后checkpoint或性能样本。
- 外部解析器、已下载产物、真实存量和生产回退未核；没有生产访问、迁移、恢复、历史修复、部署、合并或分支/worktree删除。

TD-20整体仍为部分完成；S2本地代码、PR/CI及镜像均不构成整体关闭或生产验证。
