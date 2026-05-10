# L0 — 基础层 (Foundation)

> Claude Code 在本项目的最底层行为约束。所有上层 skill 默认继承本层。

## 代码规范

<!-- TODO: 语言、风格、命名、Lint 配置 -->

## Git 约束

- 提交信息：<格式约定，例如 conventional commits>
- 分支模型：<trunk-based / git-flow>
- 不允许：force push 到主分支、跳过 hooks

## 安全边界

- 禁止提交：`.env`、密钥、token、个人数据
- 禁止访问：<列出禁区路径或资源>
- 外部调用：所有第三方 API 调用必须走 `src/lib/sources/` 适配层

## 文件操作约定

<!-- TODO: 什么文件可改、什么文件需复核 -->
