# sharp / librsvg 定向安全修复

## 范围与验收

从 `origin/main` @ `b407b9e61915c33f835966f8f760f3424f0e17f5` 建立独立 worktree，调查
GHSA-wq5f-xc86-pv6w / CVE-2026-96889 并定向修复。工作期间并行会话合并了 #426，包含相同依赖补丁；
当前验收基线顺序更新至 `5539ec136ca8a087f190670332bae87db5bfdbbe`。最终独立 PR 仅补充原生
保护测试、Docker 检查与专属证据，不重复依赖升级或改写 #426 的 graph smoke。
保留 #423 的 source-map-js / magicast 补丁及全部现有依赖策略。

1. 核实官方公告、sharp 0.35.5 与对应平台原生包 / libvips 1.3.4 来源及发布时间。
2. 核验已合入的 sharp override 0.35.5 及必需原生闭包与本次独立定向更新一致；当前候选不再修改
   package 文件，不新增直接依赖，不批量升级 Next、测试工具或其他依赖，不绕过 audit。
3. 干净 Node 24.19.0 / npm 11.17.0 安装；确认全部 sharp 副本与锁定的平台包一致，完整 audit high 门通过。
4. 独占子进程（硬超时）验证实际加载官方预编译 sharp / libvips 与其 librsvg 清单至少 2.63.2，验证 SVG 的
   RGBA 像素、PNG 往返、异常 SVG 拒绝及像素上限。正常与异常输入是兼容性边界测试，不声称复现 CVE。
5. 自动发现的 ops 测试进入 coverage；在完整 Docker CI 的真实 standalone 运行镜像中复用同一测试，
   证明 glibc Linux 加载的原生库和解码行为。保留全部既有 Docker、功能及安全门。
6. typecheck、lint、coverage、生产构建、HTTP E2E、D4 browser smoke 均通过；HTTP/browser 共用一次 C5 构建。
7. 由 eval-gate 根据最终 diff 和真实调用路径决定评测适用性；默认不调用付费模型。
8. 专属收据在首次提交前记录调查、本地结果、限制和独立完整 diff 审查；新 Draft PR 后复核远端 diff，
   在 PR 摘要补齐最终候选精确 SHA / 实际测试 SHA / 同一 CI run 与 attempt / 完整产物身份。

## 攻击路径、交付与回退边界

公告描述特定运行条件下 glibc Linux 的潜在 RCE，不能仅凭 audit 推断本项目接口可利用。
检查项目直接调用、Next 图像优化入口及默认 SVG 策略；实际生产不可信 SVG 的可达链、PIE 和运行库仍须另行核验。
不修改生产配置或数据。完成 PR / CI 后等待本 PR 的合并授权；不部署或清理分支/worktree。
回退至 sharp 0.35.4 会重新引入已知漏洞，不能作为安全完成方案。
