# B2 信息边界：诊断输出与镜像上下文

日期：2026-09-28；承接技术债 TD-08。基线 `a8865ec`。

## 范围与契约

- 统一应用 logger 的最终输出边界：递归处理对象/数组、Error、子 logger bindings 与格式化消息。
  凭据字段不区分大小写/下划线；请求/响应正文、prompt、原文、cookie、凭据均不应作为诊断输出。
  自由文本移除 URL 凭据/路径参数、认证头、显式密钥赋值、常见密钥与邮箱；深度/体积超限整段省略。
  不扫描环境变量收集真实密钥，不声称能识别任意无标记秘密或任意个人数据。
- 错误对象只输出受控类型和原因码（HTTP 状态、网络、SQLite、固定业务原因）。未知错误为
  `operation_failed`；不持久化原始 message/stack/cause/SDK body。这会减少自由文本诊断信息，
  以 Run/trace/stage 标识和原因码定位。禁止以正则清洗未知正文冒充完整脱敏。
- 在 Run insert/finish 写边界保护 error；runJob 的失败通知使用同一摘要，原始异常原样重抛。
  保持成功结果、成本、fencing、重试/拆批/拒答分类、通知开关和发布白名单不变。
- 接线现有应用 catch 日志和错误响应/失败审计；不清洗业务原文、报告正文或成功报告推送，
  不改模型/prompt/来源获取行为，不迁移或删除历史日志、Run、业务数据。
- Docker 上下文改为构建输入允许列表，并对允许目录内的凭据/本地 DB/缓存另作排除。
  只对人造文件运行真实 Docker COPY/export 测试；不把真实工作区秘密送入测试构建器。

## 验收

1. 人造密码、混合大小写 header、深层数组凭据、URL 用户信息/query/webhook path、PEM、JWT、
   email 不出现在最终日志；普通 stage/run_id/count 保留；子 logger、格式化字符串、toJSON 不绕过。
2. Error 的 message/stack/cause/body 含无标记人造私密串时，日志、Run 原始 SQL 行和失败 webhook
   payload 均不包含它；网络/HTTP/SQLite 原因仍可识别；循环/深层对象和非 Error throw 安全退化。
3. 真实隔离 DB 的 insertRun、finishRun、runJob 覆盖；原始 throw 对象和 retry/fencing 行为不变。
4. 失败通知的字段截断发生在脱敏之后；webhook 拒绝只记录状态/原因，不打印响应正文。
5. Docker 真实构建验证顶层与嵌套 .env、AWS/SSH 凭据、pem/key、CSV 凭据导出、本地 DB、
   agent 配置/产物均不进入 COPY；构建配置、源码、vendor 补丁、migration/worker 运维脚本仍在。
6. 定向回归、全量测试/coverage、typecheck、lint、build、HTTP E2E 和 CI Docker 通过。
   AI 文件若仅改诊断，以确定性回归与 diff 核对盖 skip 章，不用无关真实模型 A1 作为证明。

## 发布与回退

无 schema/数据迁移。独立 review → PR → CI；合入、生产发布分别确认。
回退仅恢复旧诊断行为，不恢复已省略的错误正文；历史数据未被改写，不宣称历史泄露已清除。
第三方框架自身的 stdout、一次性运维工具与任意新增日志调用不由本切片自动代理；不得全局劫持 console。
