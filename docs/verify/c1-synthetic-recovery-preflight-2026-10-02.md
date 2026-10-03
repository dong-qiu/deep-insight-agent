# C1 合成恢复演练前置核验（2026-10-02）

## 已完成

- PR #387 的最终 head `f3753d8` 全部 CI 与独立评审通过，合入主干 `735927d4282fb2e457b3d555f1948a1986ce0b6b`；合入不代表部署、生产恢复或 TD-09 完成。
- 在该主干提交创建独立 worktree 和 `feat/c1-synthetic-restore-rehearsal`；所需 gitignored 本地配置按仓库规则复制并设为 `0600`，未在测试/容器中加载，未复制 `.data/`。
- 默认 Colima profile 与其他已有 profile 均未启动。为演练建立专用 `insight-c1-rehearsal`（2 CPU、4 GiB RAM、20 GiB 配置磁盘上限），Docker daemon 28.4.0 可访问；确认该环境无应用容器。该环境检查不是服务验收。原 Docker context `colima` 已恢复；核验后停止专用 VM，保留 profile 供后续使用，不删除用户任何已有资源。
- 使用 Dockerfile 相同打包选项生成真实 recovery runner CJS bundle，在显式最小环境子进程中执行 R01–R05；5 个拒绝场景全部通过（Node test 报 6 项含父测试）。没有 DB/WAL/SHM 创建，合成报告字节未变，没有输出成功 replay 事件。临时 bundle/合成报告由测试清理。
- TS6/TS7、新增测试 ESLint、`git diff --check` 通过。无运行逻辑、schema、模型、prompt 或数据源变更，Eval-Gate 不适用。

## 尚未完成

本地测试使用 Node 25.9，不是标准 Node 24 镜像服务演练；不以 Docker daemon 可用或 runner 拒绝配置冒充同镜像恢复验收。主干 CI/镜像身份及本切片 CI 状态必须另按精确提交核对。

尚未执行：合成 transport 下成功的 S3/KMS/HMAC 回放、坏签名/缺版本失败、回放幂等性、AUTH_SECRET 轮换及旧 cookie 拒绝、恢复后 HTTP 健康/报告读取、编排失败保持服务停止。也没有访问生产登记册、确认真实 recovery identity 权限、触发生产发布或执行生产恢复。

下一步按[合成恢复演练验收](../plan/specs/synthetic-restore-rehearsal.md)实现并执行服务级用例；只在这些用例获得真实证据后勾选相应项。TD-09 继续 `incomplete`。
