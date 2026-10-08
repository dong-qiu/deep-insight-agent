# TD04：re-alert 有效窗口消费前校验

基线为 `0ca435d63dbf1fdb69e8abcc3846c687fb137a8b`；原实码与 `284efebd8a8b21356f66e73680940879ee73126c` 相同。协调者已冻结五路径归属，独立方案 v4 B0/W0；原 v2 B0/W1 的 global 恢复文字误差保留历史。

## 范围与真实消费者

只修改 `src/lib/runtime/staleness.ts` 的 global/daily 两个 re-alert 消费点、`generation-dispatch-health.ts` 的一个消费点；新增专属测试、本 spec 和收据。旧 route/tests、notification-config、env、provenance、共享维护、模型/prompt/validator、schema、master/policy/workflow 不修改；无新公共 helper/framework 或依赖。

- public `/api/health` 实际调用 `maybeAlertStale` 和 `maybeAlertDailyTopicStaleness`，仍为 app/DB liveness。
- worker-only `/api/internal/generation-dispatch/health` 调用 `maybeAlertGenerationDispatchHealth`，仍按真实 queue status 返回 readiness；鉴权与未配置拒绝不变。

本切片不改变首次26小时陈旧阈值、dispatch 5分钟告警/15分钟 readiness 门、reader 可见性、通知payload/渠道、任务预算/deadline，也不关闭 TD04 整体。

## 固定转换与拒绝

三个消费者完整保留 `Math.max(1, Number(env) || fallback) * 3600000`：staleness 默认24h，dispatch 默认1h。局部私有函数只检查最终毫秒 `Number.isFinite`；这是比较窗口，不创建 timer，不追加整数、safe-integer、Node timer 或业务时间上限。

| 原输入 | 原有效结果及本片行为 |
| --- | --- |
| 缺失、空白、各种数值0/-0、NaN、非法字符串 | 原24h/1h默认 |
| 合法有限数、两端空白、指数、hex、小数 | 原转换及乘积有限时保留 |
| 有限负数、0<值<1、-Infinity | 原1h clamp |
| +Infinity或正转换overflow | 最终非有限毫秒拒绝 |
| 有限小时乘3600000后overflow | 最终非有限毫秒拒绝 |

调用时动态读取，import 不读取两个字段。巨大但乘积有限值仍合法，包括 global 原零时间戳在该窗口内不首发的行为。原合法负值/默认/小数不能误判为漏洞。

拒绝不通知、不推进新的 alert/incident 时间；仅诊断固定 `field` 和 `reason_code=realert_interval_nonfinite`，不回显 raw。诊断 logger 自己抛错也 best-effort 吞错，不得进入 health handler 的异常分支。

## 去重与恢复不变量

global fresh/no_data 只早退，不清 `lastAlertAt`；fresh→stale 在原窗口内仍抑制，到期才再发。daily 先删除不再 stale 的 topic incident，即使另一个 stale topic 的配置无效仍清恢复状态；拒绝不能推进剩余 stale topic 时间。dispatch healthy 按原规则重置并早退、不读该字段；首次 `unhealthySince` 只在有效窗口校验后初始化，已有 incident 不因拒绝重写。

合法配置仍先推进去重时间再调用 logger/send；通知或日志失败不回滚原状态。原首次发送、窗口内抑制、等号再次提醒、daily 多主题独立及 daily/dispatch 恢复后重新首发保持。未调用真实通知或模型。

## 验收、退出与回退

先在原三实际 facade 上跑永久保护红。global +Infinity 原已经 send0，新红只证明固定配置诊断缺失，不能说原曾发送或本片自动恢复；daily/dispatch 首次 +Infinity/overflow 原实际发送并推进 incident，是拒绝前真实行为红。import/setup 不作为行为 red。

保护所有默认/合法格式/clamp/小数/有限大乘积、正非有限/乘积overflow、动态env、import零读取、首发/窗口/等号、global不reset、daily先恢复再拒绝、dispatch首次状态不推进、已有invalid→legal不抢原窗口，以及合法通知/logger失败原状态顺序。

专属测试还执行两真实 GET handler、三真实 alert facade，只隔离 DB/纯健康数据/auth/logger/notify 边界；原 route.unit mock 掉 facade，不能单独证明本片。非法配置及诊断logger抛错不得改变 public 200/data 或 worker 200/503/403/未配503，响应不泄配置原值。

定向新专属与原五测试、TS7/TS6 app/tools、wholelint、文档与 diff 检查；最终 CI 的 full app/build/Docker、独立 review、head/tested merge/main关系由协调者另验，不借 docs CI或 A1补签。零真实模型/生产，safe_rollback=null与#435阻断不动。

独立 worktree 端口3163、DB/DATA自有隔离；仅复制必要.env.local并0600及rewrite路径，运行Node24/env-i/umask077。原证据保留0700/0600。新明确 owner claim、合法行为/健康分类回归、Blocking未解决时退出交协调者。回退只正常feature PR，不改线上配置、不清incident、不部署、不删除旧WT/证据。
