# P31：真实 Linux 资源后端（提案）

状态：机制研究与限定工程验收提案，未授予原工作负载资格。基线为 `99703624e962455465421245c9bfbcde3baac558`。P28/P29/P30 组件与旧封存不因本提案重开。实现、CI 文件和执行场景须由追加执行单明确冻结；本文件本身不是执行授权。

## 1. 不变契约与证据层次

原资源限制保持：全树 charged memory 268435456 bytes、swap 0、tasks/threads 16；所有 scratch alias 共享一个 67108864-byte tmpfs；stdout 1048576、diagnostic/combined 2097152、descriptor 1048576 bytes；单任务 120 秒加 2 秒 grace、batch 1200 秒。不能用 V8 heap、RSS 合计、抽样未超限、kill 请求或 launcher exit 代替原契约。

必须区分：固定版本源码支持的条件推论、真实目标内核/配置身份、实际工程场景结果、原工作负载资格。前三者不能自动推导第四者。paid models 为 0；hold #435、`safe_rollback=null`、deployment BLOCKED、qualification false、原 14 requirements / 13 gates ready 0 保持。

## 2. 研究源与失效边界

本轮唯一上游参考为 Linux v6.17 commit `e5f0a698b34ed76002dc5cff3804a61c80233a7a`，annotated tag object `6063257da111c7639d020c5f15bfb37fb839d8b6`。来源为官方 torvalds/linux immutable raw/contents API；完整文件、原 capture、解码 bytes/Git blob 和选定行范围另存私有收据，不把网页摘录冒充完整源码。

旧 runner 观测 `6.17.0-1022-azure` 仅是 metadata。Ubuntu source DSC 指向 linux-azure-6.17 `6.17.0-1022.22`，但签名、实际运行 binary/config/source binding 尚未核实。上游参考不等于该 Azure 内核。源码版本、配置、CPU/hotplug 域或允许调用集合变化，都会使依赖它们的有界成本论证失效。403/429/502 等失败原件保留，后续同 pin 成功不覆盖失败。

## 3. 三能力与当前结论

| 能力/路线 | 当前结论 | 还必须满足 |
| --- | --- | --- |
| `memory.max=P` 单独保证所有中间态严格上限 | NO_GO，已知不足；不重复当新成果 | force、speculative charge、归属与生命周期闭合 |
| 降低准入 L，证明有限 reserve B | UNKNOWN，不是否定所有有限 B | 固定真实 target/callset；所有互斥成本项有用且有限，B<P |
| opt-in strict precharge + completion reserve | UNKNOWN，新 TCB 方案 | 明确 kernel/caller 改动、失败与进度证明、受控验收 |
| 固定原始 OFD 的无特权 I/O broker | 可提出独立有限实验；尚非原资格 | 冻结 C/filter/FD/通知/result 路径；真实 Linux 场景 |
| 通用 prebirth、最终 kernel release、durable lifetime ACK | UNKNOWN | 真实生产者与前置 reservation；缺事实必须 HOLD/no-reuse |

### 3.1 内存计费与 B 的证明义务

令 P 为原 charged-memory 上限，L 为内部降低的准入上限。候选证明须给出同一 metric 下 `C_required(t) <= L + F + T + K + S + H <= P`，其中 B 是这些不重叠尾部成本的上界，L<=P-B，且 B<P 并保留真实正向执行容量。这里不是已经成立的定理：数值 B 目前为 null。若改变实际 memory.max 或由 ledger 限制 L，须明确区分并对齐原检查，不得暗改验收含义。

已预充 stock 以及正常 object membership overhead 不得再次加到 B。物理分配发生在 charge 之前是独立时序/归属问题，不能把所有物理 RAM 悄悄改称原 charged memory，也不能因此排除控制器、receiver、kernel、共享 scratch 的 per-run 成本。

固定参考源中的关键未闭合边：

- `mm/page_counter.c:118–164` 先 atomic add、后 max check/失败回减；watermark 是有竞争的观测，不能证明不存在中间态。所有 in-flight 请求大小与路径须有界。
- `mm/memcontrol.c:2299–2435` 的 PF_MEMALLOC / 部分 NOFAIL/HIGH 分支可走 `page_counter_charge`；该函数不检查 max。须界定仍存活、重复强制分配的累计量，而不是只界定一次分配。NOFAIL 不能无 caller/progress 证明就改成 ENOMEM。
- 同参考中 `MEMCG_CHARGE_BATCH=64`、`NR_MEMCG_STOCK=7`；不是旧版本 batch32。stock 是预充 credit，不能直接用 slots×batch×CPU 编造额外 B；真实 CPU/配置尚未固定。
- `mm/page_alloc.c:5148–5167` 分配页后才做 ACCOUNT charge；anon/shmem/filemap 路径也要逐一映射归属，不能只证明普通用户页。
- `mm/memcontrol.c:3130–3198` 对已分配 slab object，在 extension 分配失败分支可能 continue、跳过该 object 的 charge 后返回 true。这是条件性未闭合边，不是已观测 Azure/Node 反例。正常 `obj_full_size` 已计 pointer overhead；`mm/slub.c` 的 CLEAR_MASK 是移除 ACCOUNT/NOFAIL，不是 NOFAIL 调用者证据。
- controller/通知/receiver、跨组共享页、RCU/refcount 延迟释放需要真正的归属与保留期上界。task16、pids0、tracer/parent ACK 不能单独界定全部残留成本。

最小实质取舍：继续证明固定受限 callset 的 B；或设计 opt-in strict hierarchical precharge、有限预充 completion pool、tag-failure publication 拒绝与 caller 进度处理的新 kernel TCB；或明确接受另一种隔离/metric 契约。现阶段不把任一路线说成完整最小 patch，也不以任意余量、RSS 或 guest RAM 直接替代原契约。

### 3.2 独立固定 OFD 实验

限定 owned raw-syscall child，parent 通过 `no_new_privs` 和 classic seccomp USER_NOTIF 获得请求，以实际 listener/ID、owned task、固定 FD role 校验后，一次复制有界输入，调用不变的 I/O reserve，使用自己持有的原始 OFD guard FD 完成实际 effect，再按真实返回 settle、SEND。正向路线不得 CONTINUE；child 指针/FD 不在 effect 时重读。ID_VALID 只是瞬时事实，SEND 成功也不代表 child 消费或 lifecycle ACK。

原 policy caps、全局 attempt 次序与同 domain shared counters 不缩小、不按 child 重置。已知 partial 只结算 actual k 一次；effect 后死亡、SEND 失效、未知错误保留 reservation，无重试/退款。预设 alias/fork inheritance 共享 role；运行时 dup/rebind/open/SCM/mmap/splice/io_uring、未知 ABI/调用等必须在有限 filter 中拒绝，未构造路径不能被签覆盖。

本实验最多 controller+2 workers 或 controller+child+mutator 共 3 tasks。parent 不是任意不可信 workload 的 sandbox；bootstrap/capture 成本不因此从原契约豁免。实验需要明确的追加 scope，不能用本设计代替源码/filter/实际 CI 证据。

### 3.3 生命周期必须独立 fail closed

参考 `fork.c` 中 task 分配在 cgroup_can_fork 之前，copy_process/wake_up_new_task 在 ptrace fork notification 之前；仅事件后 reservation 是 postbirth。`PTRACE_EVENT_EXIT` 在 cleanup 前；cgroup release、task reference/RCU 释放、tracer wait 与 real-parent reap 不是同一事实。非 leader exec 还改变身份。

缺 authentic prebirth 或 kernel-release producer 的 adapter 必须在 journal mutation、sink append、payload effect 之前 UNKNOWN/HOLD，禁止 reuse；没有 ticket 时描述为 adapter HOLD/core active0，不伪造 held reservation。不以 cookie/hash/JSON/pidfd/kill/wait 构造 KERNEL_RELEASE，不调用 flush 制造成功。独立 I/O positive 是 engineering-only，不能挂在虚假的 journal 成功链上。

## 4. 有限验收目录

内存 M01：普通页 cap-page/exact/+page 和 swap0 两 worker，明确真实 cgroup 前置；M02：真实 counter/force/stock branch-hit 与累计存活成本；M03：实际 slab extension failure/publication/charge/lifetime；M04：shared/receiver/RCU 留存。均须先冻结 source/executable/argv/target/权限；当前是计划，未激活。peak 未超限不能签普遍 B；缺 branch-hit 是 NOTRUN/UNKNOWN。

I/O I01：原 stdout/combined 边界与最后额度竞争；I02：固定 alias 共享与替代路径前置拒绝；I03：标准设备合法方向/零 cap/真实 count；I04：独立至多两字节 RED 控制展示 CONTINUE 指针重读，正向 copy-once/OFD 精确一字节；I05：known partial 与 effect 后 SEND 失效，未知不退不重试。不得把刻意 RED 当准入成功。

L01：缺 prebirth/release 的零 mutation/effect HOLD；L02 若另激活，仅观察 ptrace 与 real-parent 次序，仍不签物理释放；L03：实际构造 stale/foreign/unsupported 反例。X01：真实 notification→旧 counter→原 OFD effect→result/SEND→工程 receipt/fsync；receipt 不是 P30 lifecycle ACK 或 crash-recovery 证明。

所有测试须保存执行前 input/helper/compiler/kernel/filter 身份、真实 return/errno、exit/wait、两路 EOF、raw hash、超时/overflow/forced-close。特性不可用必须 FAIL/NOTRUN，不能 green skip。每 child 120+2 秒、两路 capture 限额、core0、64MiB 新域总额保持；不以 trusted fixture 有界宣称原工作负载已获资源资格。

## 5. 实施、审查与发布顺序

1. memory / I/O-lifetime 两线稳定机制、源收据、有限场景；Dev 唯一 repo 作者，R3 只在独占私有域形成候选。
2. 协调者追加冻结实际 C/case/runner/CI 文件、owner、前置与停止条件。未激活不编译/运行；新特权、kernel/boot/system 修改须实质决策。
3. 合并稳定设计与实际新增候选，再由两 fresh 非作者按 Standards/Spec 做 HIGH full1，必要 related1；不先耗设计审再开第三代码审。旧组件不重复算法审。
4. 正常 hooks、feature PR、精确自然 CI、受审/远端/actual merge 字节身份与 main CI；失败/unknown 保留，不 rerun 洗白、不降低 oracle。

本 spec 不是 Ready、上线或整体技术债关闭声明；原 Node/SQL/G1/G2/BNT 与生产执行门均保持关闭。

## 6. 本轮追加激活范围

2026-10-17 13:08:01 UTC 的追加执行单 `phase2-restricted-io-activation-v1.json`（SHA256 `821ba3d6ca354416a92c4e9d4c6edade8649f28ac642c199127bb3a44846255b`）仅激活无特权 own-process/child 的有限 pipe 工程：B01 原边界/alias、B02 两 child 最后额度、B03 实际构造的前置拒绝、B04 真实 partial、B05 effect 后 SEND 失败、B06 copy-once 指针竞争、B07 独立生命周期缺能力 HOLD，以及单独 negative-only build 的 R01 至多两字节 CONTINUE 反例。

唯一新增代码归属为 `experiments/resource-linux-backend-v1/{broker_discriminator_v1.c,broker_cases_v1.json,run_broker_cases_v1.py}`。R3 独占私有候选，冻结后 Dev 唯一写入 repo；旧 core/io/journal/supervisor/SSM 不改。标准设备 I03、ptrace、内存 M01–04、原 Node/probe/SQL/G1/G2/BNT 与任何新增特权均未激活。

先保存 report/capture FD>=200，parent guards 不触发自己的通知；child 关闭全部 broker/listener/report/directory FD，再安装固定 allowlist。所有 live context 在 fixture forks 后初始化。每 case 是新的串行 case process，未知后不在同原 domain 继续工作。已知 effect k 若已 settle，则 SEND 失败保留 used k 并 latch adapter HOLD，不能假称该 token 仍全额 outstanding；effect 本身未知才保留真正 outstanding reservation。

稳定联合 HIGH 审查前，允许普通 feature push 的独占临时 `.github/workflows/p31-broker-development.yml` 做真实 Linux debug：仅当前分支 push、已有 gcc/clang/Python、contents:read、无 install/sudo/secrets/dispatch/schedule。临时文件必须在 full R1 前正常 commit 移除，所有 commit/run/失败 raw 留档。最终最小 step 接入既有 `resource_c` 两 compiler lane 与其 artifact；缺 case/特性不可用必须使 aggregate 失败，不 green skip、不改变旧门禁。

这份激活不是实际执行或通过收据。编译 BPF bytes 只能在真实 compile 后观测；第一次开发 push 前检查源 allowlist/filter，CI 在安装前记录编译 BPF/headers/binary/kernel 身份，不能事后回填。source STOP 14:32:35、review STOP 15:02:35、collect STOP 15:32:35 UTC 均不延长。
