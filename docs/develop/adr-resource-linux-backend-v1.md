# ADR 提案：P31 Linux 后端按可证明能力分片

状态：PROPOSED。本决定文件不是已接受的新 kernel/特权控制面，也不是执行单。对应 [spec](../plan/specs/resource-linux-backend-v1.md)。基线 `99703624e962455465421245c9bfbcde3baac558`；不修改 P28/P29/P30 既有算法、SSM 或旧封存。

## 背景

已有预算与 lifecycle journal 组件不足以证明真实 Linux 上严格计费、所有别名的累计 I/O 和 authentic prebirth/final release。只看一次 green、memory.peak、kill/wait 或伪造 caller 身份会循环论证。需要把工程可演示的子集与原工作负载资格明确隔离。

唯一参考源为上游 v6.17 commit `e5f0a698b34ed76002dc5cff3804a61c80233a7a`，不是已绑定的 Azure kernel/config。官方 Ubuntu DSC 版本线索与旧 runner uname 不足以补齐 binary/source/config 身份。私有完整 capture 与 span 收据保留失败和来源差异。

## 拟采用的决定

1. 不再把 `memory.max=P` 单独当严格所有中间态证明。保留两条真实候选：受限调用集合的有限 reserve B；opt-in strict precharge/completion-reserve 的新 kernel TCB。当前 B=null、结论 UNKNOWN。B 必须是同 metric、不重叠且覆盖所有 per-run 成本的上界，并满足 B<P、真实正向容量；不是任选安全百分比。
2. 源码级最小未闭合边包括 add-before-check、force/no-fail 累计存活成本、分配后 charge、slab extension failure 跳过 charge、shared/receiver/RCU 留存。正常 stock 和 object overhead 已预充/已计费，不能双算；物理时序也不允许悄改 charged-memory metric。NOFAIL caller 进度不能靠简单返回 ENOMEM 解决。
3. 可以独立提出无特权 own-child classic seccomp USER_NOTIF/fixed-original-OFD 工程实验。仅 finite raw-syscall/filter 范围，一次复制、parent 原 OFD effect、真实返回 settle，无正向 CONTINUE。替代调用/alias/ABI 不在允许集则前置拒绝；不能推广任意 Node 或全系统别名覆盖。
4. positive I/O 和未资格 lifecycle adapter 分开 domain/场景。缺真实 prebirth/kernel-release 时在一切 journal mutation/sink/effect 前 HOLD/no-reuse，不用 flush、cookie、pidfd 或 wait 伪造成功。真实完整 lifecycle 尚 UNKNOWN。
5. 先由追加执行单冻结具体 C/CI/用例与唯一 owner，再审稳定设计+候选；两 fresh HIGH full1+必要 related1，不提前浪费设计轮次。无特权实验的普通安全步骤和新 kernel/host 特权决定不是同一种授权。

## 备选与拒绝项

- 只量 RSS/V8 heap/peak 再 kill：不能替代原 charged-tree/all-intermediate 契约。
- pointer-copy 后 CONTINUE：effect 会重读 child pointer；作为最多两字节 RED 反例可以验证，不能作为 byte-budget enforcement。
- 降低 L 加任意 reserve：没有完整成本图与 live-retention 上界不能签 B；但 UNKNOWN 也不意味着所有受限 B 路线已被反证。
- guest RAM/arena：可能是另一个可信边界方案，但需要 metric 等价、host/controller/shared 成本和 substantive decision，不是现契约的即插即用替换。
- 直接改 kernel force/tag failure：需要 reserve-before-publication、有限 completion pool、caller 进度和真实目标验证；当前只是待审设计，不宣称完整最小 patch 已找到。

## 后果与发布边界

允许在原资格仍关闭时交付有价值的独立 I/O 工程证据；不能因此豁免控制器/通知/capture 成本或签全树内存、16 tasks、120+2 终止、kernel release。实际特性不可用须 FAIL/NOTRUN 而非 skip-green。

本提案不移动其他 owner 文件，不重跑原 Node/loader/SQL/旧 VM，不清理 branches/worktrees/data，不启动付费模型或生产。`safe_rollback=null`、deployment BLOCKED、hold #435、qualification false、原 14/13 ready0 与 automation PAUSED 保持。文件完成也不代表此 ADR 已接受或 P31 整体完成。
