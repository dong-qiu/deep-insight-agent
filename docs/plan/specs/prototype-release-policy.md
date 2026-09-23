# 内部原型发布政策

> 状态：Accepted · 2026-09-23
>
> 实现事实源：`src/lib/runtime/prototype-policy.ts`；决策背景见 ADR-0032。

## 目标

系统在当前快速迭代阶段只运行于 `development` 或内部 `prototype` 语境。它不再为每份报告维护
`quality_status`、`source_terms_status`、`release_tier` 的组合状态机，也不把 DCP、正式 baseline、
source-specific 条款判断或双人盲审作为原型发布前置条件。

这是一项产品范围收缩，不是第三方内容许可、法律意见、正式质量认证或生产准入结论。

## 固定政策

```ts
{
  stage: "prototype",
  audience: "authenticated_users",
  source_terms: "deferred_not_authorization",
  raw_content: "admin_only",
  commercial_use: false,
  public_api_export: false,
  model_training: false
}
```

应用必须在全局可见位置显示“内部原型”及其限制。该政策是静态代码常量，不能由环境变量或
数据库记录悄然扩大范围。

## 不可简化的保护

以下四项仍是发布的硬边界：

1. 仅含 validator `pass + support` 白名单引用的洞察可以进入读侧报告；`blocked`、未校验或
   不支持的引用不得发布。
2. 读侧引用必须来自已验证的 raw archive；归档不完整、hash 不匹配或不可读时 fail closed。
3. 原文正文只能由管理员在受控核验路径读取；不得公开展示、通过公共 API 导出或用于训练。
4. 管理员必须保有快速隐藏/撤回报告和禁用来源的操作路径。

现有 middleware 负责第一层认证，`role-paths` 负责管理面隔离；这份政策不另造一套认证系统。

## 快速评测与发布凭据

- 纯确定性/UI 改动：运行受影响测试、`typecheck`，必要时运行 `build`。
- 变更模型、provider、prompt、validator、coverage 或来源语义：运行小型真模型
  `npm run eval:a1:prototype-safety`。它强制进入 A1 smoke，按 case ID 从正式夹具选择样本，
  不复制、不重排完整 benchmark；必须覆盖 `support`、`uncertain`、三种 `not_support` 类型，以及
  display/quote 的正反例。
- prototype safety eval 的硬门仅为完整执行与 `unsafe_accept=0`；`false_reject` 首先作为趋势
  指标，连续三次观测后再考虑阈值。
- 完整 A1 留作按需或周期性诊断；无可比 baseline、DCP 或 v2 lock 不阻塞内部 prototype。
- 每次准备部署时生成一份无正文、无 URL、无密钥的 `prototype-release.json`，绑定代码版本、
  模型配置指纹、CI 与 safety eval 的聚合结果。它是可追踪收据，不是批准。

`eval:a1:prototype-safety` 的 `prototype-safety-receipt-v1` 只保存 commit、模型配置哈希、A1
artifact 哈希和聚合计数；它拒绝覆盖同一 run 的收据，也不写回 A1 已完成的不可变运行目录。

CI 在 lint、测试、typecheck、build 和 Docker 检查全部完成后上传同 commit 的
`prototype-ci-evidence-v1` artifact。准备部署时，从该 CI run 下载该 artifact 并运行：

```bash
npm run release:prototype:receipt -- \
  evals/out/prototype-safety-receipts/<run-id>.json \
  /path/to/prototype-ci-evidence.json \
  /path/to/prototype-release.json
```

命令拒绝 dirty worktree、commit 不一致、缺失 CI 检查或 `unsafe_accept > 0`。输出仅绑定
`sha-<commit>` 镜像标签；它是部署随附的过程记录，不是新的审批工作流。

## 重新进入正式治理的触发条件

出现以下任一条件前，必须先以新 ADR 替换本政策并重新设计相应门禁：匿名/公开访问、付费或
商业使用、原文向非管理员展示、公共 API/批量导出、将第三方内容用于训练，或对外声明来源许可/
合规/正式质量保证。

## 验收标准

1. `/reports`、`/api/reports` 与其他读侧路径不在公开路径白名单；未登录请求继续被 middleware
   拦截。
2. 管理员的报告撤回路径继续属于 admin-only；普通 viewer 不会获得管理权限。
3. 页脚明确显示 prototype 限制，且文案不声称得到来源授权或正式质量批准。
4. 不新增 SQLite migration、逐报告发布状态字段或原文副本。
5. 随后的 lightweight eval 与 release receipt 不持久化第三方正文、URL、prompt、模型输出或凭据。
