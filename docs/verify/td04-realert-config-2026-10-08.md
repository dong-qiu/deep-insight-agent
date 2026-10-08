# TD04 re-alert：本地工程收据

对应 [spec](../plan/specs/td04-realert-config.md)。仅五路径窄片；TD04整体仍部分完成。主干基线 `0ca435d63dbf1fdb69e8abcc3846c687fb137a8b`；文档main CI不是新应用证明。最终head/PR/testedmerge/main CI由协调者另登记，本页不签合入或上线。

## 真实行为与保护

两个模块只增加局部私有最终毫秒校验；保留 `Number || fallback` 与 `Math.max` 的默认、NaN/非法字符串安全回退、负Infinity/低值clamp、合法小数/hex/exponent及调用时动态读取。拒绝仅最终非有限窗口，固定脱敏诊断；无新公共API、global框架或依赖。

global fresh不重置窗口；daily恢复清理先于配置拒绝；dispatch初次incident不在无效窗口下推进。合法logger/send失败仍保原先更新状态顺序。真实三facade与两个health GET均执行；依赖mock只隔离通知/DB/auth/纯health数据，未mock掉被改facade。没有模型或真实通知供应商调用。

## 实际运行

原两模块上新增永久80例：**13 fail / 67 pass**。global三失败为原固定配置诊断缺失（原本send0）；daily/dispatch原+Infinity/转换overflow/乘法overflow仍首发，以及logger失败后窗口/恢复组合与真实public handler发送是行为红。不把其余通过当修复、不以import/setup失败制造red。

修复后新专属80 + 原五文件25，共 **6文件105/105、0skip**。包含旧worker route真实SQLite/readiness集成。原两unit route替换facade的限制仍保留，NEW handler用例执行真实facade/Response。

- `npm run typecheck`：TS7/TS6 app/tools四套全部通过。
- `npm run lint`：全库通过，未修改门禁/忽略规则。
- 文档检查与 `git diff --check`：通过；初次 docs checker 调用缺 `scope.mode=docs`，原失败保留，修正调用后实际两文件通过，不改 checker。

实际命令Node24.19.0/npm11.17.0、env-i、PORT3163、umask077；独立worktree/DB/DATA，必要.env.local0600隔离后保存，未加载其凭据运行测试。无新路由/core/构建依赖源变更，未本地启动HTTP服务或跑build；完整最终CI app/build/Docker仍是必需后续门，不能用本页105/类型/lint补签。没有A1或真实模型，未盖Eval skip。

## 原材料与退出

私有目录 `/Users/dongqiu/.local/share/insight-agent/evidence/td04-realert-20261008/`，原red输入、raw日志与最终五源原字节/hash、闭包、命令/退出码在非覆盖索引。原runner沿installed Vite8仅导出VITE_前缀，复制配置无VITE_键、env-i不含通知target；loader字节保存，不把静态追踪当运行期环境快照。补充私有merged config的 `envFile:false` / `envDir:false`（installed Vite实际支持）与每文件setup确认凭据/通知target absent 后，相同6文件105/105、0skip再通过。仅继承原test/coverage/server配置，不改Git测试配置或校验口径；无实际通知/模型调用证据声明。原red/green v1和私有隔离v2日志分开保留。

原proposal v1–v4及原R1 B0/W1历史保留；最终PLAN B0/W0只证明方案，不代替源码审查。

仅本片非有限re-alert消费阻断，不宣称全部危险配置或全应用预检完成。剩余来源/选择/AI上下文字段仍逐项工程/语义划界；不自行修改模型、来源、校验口径。safe_rollback=null、deployment blocked/hold不变，不访问生产或更改批准policy。所有旧worktree/作者归属/证据保留，协调者仅获本片正常Git/meta权限，源码内容仍由Agent A冻结。
