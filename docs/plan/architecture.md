# 技术架构设计

> IPD 计划阶段产物。系统骨架、数据流、关键技术选型。

## 架构总览

<!-- TODO: 一张高层架构图（mermaid 或 ASCII） -->

## 模块拆分

| 模块 | 职责 | 位置 |
|---|---|---|
| <collector> | 数据收集 | `src/lib/agents/collector.ts` |
| <analyzer>  | AI 分析   | `src/lib/agents/analyzer.ts`  |
| <validator> | 结果校验 | `src/lib/agents/validator.ts` |

## 数据流

<!-- TODO: 抓取 → 清洗 → 分析 → 校验 → 存储 → 呈现 -->

## 数据模型

<!-- TODO: 核心实体与字段 -->

## 技术选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 运行时 | | |
| 模型   | | |
| 存储   | | |
| 调度   | | |

## 部署与环境

<!-- TODO: 本地 / 预发 / 生产 -->
