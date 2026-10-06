# 诊断收口 CI：图谱交互等待真实组件挂载

> 2026-10-06 UTC · 必要 CI 故障修复，仅测试同步，不改生产 UI、图谱选择或 Brief 行为，不降低完成门。

## 失败与因果证据

最终候选 `afceab31646f0df3d957394bd7f7e44ae08e15a4` 的 [CI37459884296](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37459884296) 失败于图谱 smoke：首次期望4节点，实际2。类型、单元/coverage、生产构建及Docker已通过；browser失败后audit未执行，不能签整套通过。同生产代码的main CI与#420曾通过，不用这些绿色抹去该失败。

在同生产构建、合成DB/无开发配置的临时运行环境中，临时将graph page JS延迟1200ms；原测试3/3失败，每次观测原生range.value=1、相邻React可见strong=2、document.readyState=interactive，SVG仍2。原helper只看原生值，事件在客户端接管之前触发，不能证明React状态更新。

修复同步后，相同受控延迟3/3通过；有一轮受主机长暂停影响，墙钟耗时不能作性能证据。延迟/console探针已移除，原件与探针版本保存在owner-only gitignored目录，不提交。

## 最小测试修复与保留门

- fixture以被动观察器原样转交每次原生addEventListener的this、参数与options，只记录当前角色SVG的wheel监听注册；该注册来自ForceGraph真实useEffect，证明该实例已经挂载，不读取React私有fiber/tracker。
- 每次阈值操作前等待**当前SVG实例**的effect注册，不能用旧页面或旧组件证明ready；GET导航另等待准确URL和load。
- Home/End后同时核原生值和React可见strong；原节点4/2、边、端点、主题/时间窗/空态、侧栏及窄屏断言全部保留，retries=0、期望超时5000ms和test超时30000ms未改。
- 没有重复点击/滑块重试、mock图谱或修改应用控制逻辑；将来wheel effect被移除时，这个同步信号也须随组件契约重新评审，不能默默跳过。

## 正式验证与独立审阅

移除临时探针后重新build:e2e（builds=1，build_ms=14271），built入口复用同次有效C5收据、additional_builds=0；完整D3/D4 smoke **7/7**通过。TS7/TS6 app/tools、定向ESLint及diff空白检查通过。合成数据/运行密钥/临时服务与生产隔离；不是H08生产人工验收。

独立新上下文对最终5文件的pre-pr-ai-review通过：Blocking0/Warning0，确认原断言、参数转发、当前实例绑定及探针移除；推送后的实际head/CI与远端终核仍须闭合。新CI不能复用afceab3失败或旧head通过。仅测试与文档变更，eval-gate判为不执行AI路径，未调用无关A1或加假pass章。

## 安全检查的另一层边界

#420已修复声明依赖锁与main的高危audit阻断，audit0不认证所有内联副本。另一会话的独立 [#423](https://github.com/dong-qiu/deep-insight-agent/pull/423) 指出magicast发布产物内联source-map-js 1.2.1，另行交付正式vendor修复；其当前draft/审批及上线不属于本诊断收口，不修改该分支或冒认已部署。本轮不把“audit绿”写为整项漏洞全部路径清除，保留该风险链接；生产仍为只读核验的b199。

后续状态补充：#423于2026-10-06T17:11:28Z由另一会话合入b407b9e，上段draft仅记录当时状态。ec72454的CI37500338318已验证本测试修复7/7；整套仍失败于新sharp高危audit。必要安全/测试修复改由独立#426承接，待其正常CI与合入后，#360从main继承测试文件，不把任何失败记录删除或冒认生产更新。
