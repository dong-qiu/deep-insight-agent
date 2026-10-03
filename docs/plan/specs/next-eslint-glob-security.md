# Next ESLint glob 依赖安全替换

本任务解除 C1 PR #392 的现有依赖审计阻塞，不修改恢复语义或生产应用。

## 验收约束

- 保持 Next / eslint-config-next 16.3.8、现有 lint 配置和全依赖 high+ audit 阻断门不变；不降级、不添加 audit 忽略。
- 仅当前 `@next/eslint-plugin-next@16.3.8` 的 fast-glob 调用经受控适配层执行；真正移除 braces/micromatch 实现和锁文件依赖，而非换名称掩盖漏洞。
- 使用已有依赖图内的精确 tinyglobby 0.2.17；适配唯一 globSync(string, {onlyDirectories:true}) 调用，未知 API/options 失败，不宣称完整 fast-glob 兼容。
- 真实 Next getRootDirs 路径测试默认 cwd、单根、尾随斜杠、相对/绝对、Windows 分隔符归一化、wildcard/brace、array、literal symlink、文件/隐藏/不存在目录。不得递归扩大 literal 根目录。tinyglobby 对 glob 发现的 symlink 目录不等价，必须显式失败，要求配置 literal roots，不能静默漏掉 lint 范围。
- 深层 brace 与过长 pattern 在解析前明确拒绝；普通 brace 能正常运行。
- 真实 ESLint + 项目 flat config 仍检测 no-html-link-for-pages/no-img-element，正确 Link 无错误/告警；`npm run lint` 门槛不变。
- Node 24 隔离 clean npm ci、全依赖 audit、typecheck、完整 tests/coverage、build 及 CI/Docker build 通过；Docker deps 阶段必须包含本地 adapter。

## 维护/退出

这是工具链的临时窄范围依赖替换，不是生产运行时 glob 实现。至少每 30 天检查上游；官方兼容版本移除漏洞链后，在独立 PR 删除 override、直接本地 dev 依赖和 vendor，并重跑同一矩阵。升级 Next 插件后不能静默扩张适配范围。
