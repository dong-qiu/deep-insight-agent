# R2 / Window N：no-replace 原语资格预冻结方案

## 状态、范围与来源

基线为 `724bd7314272ceb60268d410a561b0223bac6324`，包含已合入 K 的 PR #470。
本轮承接“继续下一步”，仅完成 N 的实施准备、环境盘点和独立方案审查。
状态为 `preparation_only`；不是 native implementation、Linux qualification 或生产准入。
历史[实施窗口](r2-backup-implementation-windows.md)、[共享条件合同](r2-backup-shared-interface-v1.md)
保留原样；K 的后续接受以 #470 最终追加收口为准，不改写历史待验收快照。

目标是资格验证同进程 Linux `renameat2(RENAME_NOREPLACE)`：目的名称竞争出现时不覆盖。
它不是 backup capability、expected-source-inode 的原子证明、持锁发布或耐久性证明。
只使用稳定 C Node-API，不使用 V8/libuv/任意 FFI、通用命令执行、普通 rename/copy fallback。
公开原语测试入口只是受控底层测试面，不能进入现有 backup CLI 或赋予业务许可。

Linux flag 来源为[内核 UAPI 定义](https://github.com/torvalds/linux/blob/master/include/uapi/linux/fs.h)，
运行时 API 参考[精确 Node24.19.0 Node-API 文档](https://nodejs.org/download/release/v24.19.0/docs/api/n-api.html)。
这些网页是语义参考，不是已冻结的构建头文件或实际资格证据；实现时还须记录精确源码 commit/hash。

## 文件窗口与归属

本轮只新建本文及[准备收据](../../verify/r2-backup-native-preparation-2026-10-11.md)。
后续源码候选仍限定为四个 NEW 文件，不因本次盘点自动取得实现或共享构建权限：

| 候选文件 | 最小职责 |
| --- | --- |
| `ops/maintenance/backup-native/rename-noreplace.c` | C Node-API：固定同步调用、FD/basename 参数边界、实际 errno 与 namespace 结果 |
| `ops/maintenance/backup-native/build.mjs` | 显式隔离编译及非覆盖产物，固定工具链/头文件/编译参数的身份记录 |
| `ops/maintenance/backup-native/loader.mjs` | 固定资格产物加载；缺失、漂移、平台/ABI/身份错误拒绝，不自动构建或下载 |
| `ops/maintenance/backup-native/rename-noreplace.node-test.mjs` | 合成目录及真实进程的 Linux 正反例；平台拒绝与资格结果分列 |

本轮定向盘点没有上述四文件或两份新文档的现有冲突；只是时间点观察，不代表原 owner 释放。
`docs/develop/decisions.md`、`docs/plan/architecture.md`、Dockerfile、package/lock、CI、
ledger/writers、C1 CLI/cron、主台账、K 源码均未移交给 N，也不修改。
原生选型在采用源码之前须由 ADR/架构 owner 登记；本文是交接提案，不能代替 Accepted ADR。

## 环境身份与停止门

2026-10-11 实际盘点：本机 Node24.19.0、darwin/arm64，runtime N-API10、modules137；
本地 Docker client29.2.1，但 Colima 未运行，当前 daemon/socket 不可用。
本机有24.19.0头文件目录，只是 macOS 本地材料；不作为 Linux 头文件/工具链资格。
本轮未启动 VM/container、未拉镜像、未下载编译器/头文件、未编译 addon。

建议第一种限定目标为 Linux/amd64、Node24.19.0、Debian bookworm/glibc，与当前 Docker
build/runtime patch 系列一致；只对实际测试得到的内核、libc 与文件系统组合签资格。
本机arm64或模拟amd64必须在环境中明确标记；模拟测试不证明物理amd64或生产主机行为。
容器的内核来自宿主，image identity 不单独确定 syscall/FS 行为。
Dockerfile 的 patch tag 不是不可变 digest；候选镜像目前没有已核 index/amd64 manifest/config。

实施前必须非空且逐项实核下列字段；缺失即 `qualification_ready=false`：

| 字段组 | 要保存及核对的身份 |
| --- | --- |
| 源码 | 基线、候选、实际测试 tree、四文件 byte hash；历史 K 证据不移植 |
| Linux环境 | VM/profile、实际kernel、host及container arch、是否emulation、mount/fs类型和设备 |
| 镜像 | 官方来源、index/amd64 manifest/config digest、实际容器 image ID，开始/结束一致 |
| Node | 精确可执行文件hash、version、modules、runtime N-API；运行实测，不引用本机值代签 |
| 头文件/工具链 | 官方来源及精确version/manifest或包hash；实际header清单hash、compiler/linker/libc身份及命令参数 |
| 产物 | ELF机器类型/动态依赖、addon hash、源码/工具链绑定、目录及文件安全属性 |
| 结果 | 实际命令、stdout/stderr、exit/signal、原始文件dev/ino/hash；pass/fail/unsupported/skip/not-run独立计数及原因 |

建议 addon 显式固定稳定 `NAPI_VERSION=8` 的必要 C API；runtime 的支持上限与编译请求版本分列。
该版本选择仍待方案接受和真实编译验证，不根据 Node-API 稳定性承诺跨Linux/libc通用二进制。
不用 node-gyp/node-addon-api 新依赖，不运行自动postinstall；若固定 C 编译不能满足闭包，
停下明确新的文件、工具链来源及构建许可，不悄悄扩大窗口。

只使用新合成隔离目录；不挂载 `.env.local`、业务 `.data`、生产卷或 Docker socket进入测试容器。
运行阶段无网络、无提供商/云/通知凭据、不以root执行测试；编译使用固定显式命令而非用户shell。
新VM启动、镜像/头文件下载、原生依赖或共享构建改动必须先明确对象和权限。
当前 Linux 身份、原生选型 ADR 签收与运行环境仍未齐备，不能开始实现后补签。

## 原语合同与分层责任

### 调用及输入

候选原语为同步、同进程、固定一次的 no-replace rename，固定八个 primitive 参数：
`srcDirFd, srcName, srcParentDev, srcParentIno, dstDirFd, dstName, dstParentDev, dstParentIno`。
不接回调、driver、配置对象、任意绝对路径、flag 或命令，不做隐式类型转换。
FD必须是number类型的有限整数，范围为0..2147483647；先核范围和整数性，再转换为C int，
不能只依赖`napi_get_value_int32`成功，以免超范围数值回绕。parent dev/ino是无符号64位
BigInt，C提取须lossless；它们只用于物理绑定比较，不是授权或expected-source证明。
名称只接受ASCII `[A-Za-z0-9._-]+`，拒绝`.`/`..`，1..255字节且不超过实际父目录NAME_MAX。
拒绝空值、路径分隔、NUL、非ASCII、多字节边界、编码截断或超长值；提取长度须精确一致。
C层的长度、整数溢出、lossless标记和每个napi_status均检查，不调用用户getter/coercion。

借入FD不由C关闭。C首先逐一用`F_DUPFD_CLOEXEC`取得自己拥有的副本，在副本上fstat为
目录并比较对应expected dev/ino；此后rename只使用副本，所有正常/拒绝/异常出口关闭副本。
dup之前原FD被并发关闭/复用时，副本校验失败就拒绝且不执行renameat2；dup后复用原FD不改变副本。
不得先检查原FD再复制，以免把检查身份移植到新描述符。实际同一目录的dev/ino绑定仍依赖
本轮受信本地文件系统；不是跨任意文件系统的能力令牌。副本泄漏及worker并发复用须实测。

FD不是许可令牌，调用方能提供FD不证明有backup执行权。未来仅 S 的固定私有适配器在
同一真实锁域校验 root/parent/dev/ino、owner/fence/attempt/signal/window 后消费原语。
S尚未交付；N禁止向现有CLI暴露通用发布/覆盖接口，也不包装可序列化的授许可JSON。

### 物理与名称边界

测试必须持有来源/目标父目录 FD，在C私有副本上校验精确dev/ino/type，且source是已封存目录。
验证父路径当前绑定由future S承担；dir FD指向旧目录不自动证明路径没被替换。
真正namespace动作只用固定 `RENAME_NOREPLACE`，不采用 check-then-普通rename。
目的已存在的空目录、文件或symlink均不能被覆盖/删除/收编。跨设备、不支持平台/FS或
安全预检失败拒绝；不为了成功把结果复制到另一设备，不执行清理已发布目录。

no-replace不原子核验expected源inode/hash；受信命名空间仍为假设。
不宣称防恶意同UID/特权路径替换或整账本回滚。调用中禁止JS回调/await/threadpool
和shell子进程；返回并记录真实namespace事实后才能处理后续停止条件。

### 结果与取消

立即保存实际syscall返回值及errno，不能被后续Node-API/close覆盖。只有已知syscall成功
才记录 `namespace=committed`；未执行renameat2的拒绝及冻结环境下语义明确的失败才记
`namespace=not_committed` 与准确code/errno。预检失败保持 `syscall_attempted=false`。
这里`syscall_attempted`专指renameat2，不否认dup/fstat/close等预检与清理系统调用。
未确认语义的errno、进程被杀或syscall后Node-API结果构造/转换/交付失败时，控制器若没有
完整可信返回只能登记 `namespace=unknown`，不能把JS异常等同未提交；已确认成功不得倒写。
结果以自有data property构造，检查napi_status且不触发继承setter/用户JS回调；尽可能在
syscall前准备结果容器，但不假定这样能消除全部返回失败。实际实现须提供后置失败注入反例。
事后目录检查只是诊断，不能恢复重发权或猜定未执行；N不创建attempt/持久结果账本。

首轮资格仅限冻结的受信本地FS，不签NFS/其他网络文件系统。Linux手册明确提示NFS可能在
返回失败时已完成rename，因此不能把所有非零返回归成未提交；新增FS须独立语义核验。
参考[Linux rename合同](https://raw.githubusercontent.com/mkerrisk/man-pages/master/man2/rename.2)
及[Node-API异常合同](https://nodejs.org/download/release/v24.19.0/docs/api/n-api.html#exceptions)。

不能把“同步调用”承诺为硬实时可取消；syscall已开始后不能回溯取消。
异步边界让出、原signal/原窗口与控制持久事实由 S负责；控制器退出测试只验证N的
进程事实，不代签全writer、drain/lease或远端终止。

rename namespace、父目录fsync耐久性、控制COMMIT/ACK是独立层。
N不签 `durability=confirmed` 或控制收据确认；fsync/outcome后失败的组合矩阵留给 S。

## 待执行测试矩阵

以下均为验收用例设计，当前全部未实现/未执行；文档CI不补签任一N用例。
Linux要求项不能以skip/unsupported补签；不支持环境作为拒绝行为的证据，资格仍未通过。

| AC | 测试与注入位置 | 必须可观察的判据 |
| --- | --- | --- |
| N01 | 精确Linux身份下stage目录→同设备空名称 | 实际addon调用成功；源消失，目标dev/ino及嵌套文件hash等于原stage；保存syscall返回 |
| N02 | 目的名称已有空目录 | 拒绝；原stage和空目标dev/ino/hash保持，无目标删除或普通rename |
| N03 | 目的名称已有文件或symlink | 各自拒绝；目标字节/链接与source保持，不跟随或替换目标 |
| N04 | 独立进程在外部absence检查之后、实际调用之前创建空目标 | 用完整IPC/原子ready协调确定性交错；实际addon拒绝，source和外部目标保留 |
| N05 | 两个进程将不同stage竞争同一目标 | 恰好一次成功；失败者stage原样，目标属于成功者；不能只统计exit code |
| N06 | 同时存在两个不同mount/dev的src/dst | Linux真实跨设备拒绝，无复制/删除；缺第二设备则not-run，不能用mock EXDEV签资格 |
| N07 | 非Linux、缺产物、错误平台/ABI/ELF/工具链绑定 | loader fail closed且无native加载/编译/下载/业务FS变更；Mac拒绝与Linuxpass分列 |
| N08 | 真环境缺syscall/FS支持，及明确unsupported错误分支 | 不fallback/重试；真实unsupported环境若未提供则not-run；注入只证明错误分支 |
| N09 | FD为负/非int/NaN/Infinity/2^31/2^32回绕值/已关闭/普通文件；参数少/多；parent BigInt越界或非lossless | 转换前准确拒绝，无非法syscall或隐式转换；source/target不变 |
| N10 | 空/dot/dotdot/slash/NUL/256字节/多字节UTF-8边界/错误类型名称 | C与JS边界均拒绝；合法ASCII上限需受真实NAME_MAX约束，无截断、越界或任意路径访问，进程不崩溃 |
| N11 | 错父FD、worker并发关闭/复用借入FD、原父路径被置换、source inode被换 | 使用校验后的C私有副本或不执行renameat2而拒绝；不得写错父目录或泄漏副本；futureS guard尚缺，不声称原子比较expected源inode |
| N12 | 调用前取消/耗尽、调用后控制器死亡、成功syscall后结果构造/交付失败或继承setter | 不虚构取消权；无可信返回保留unknown且不重发；原型setter不得执行，已知committed不倒写；注入测试不冒充真实OOM |
| N13 | 调用前/实际rename附近/成功返回后SIGKILL | 前后屏障分别绑定；无法控制syscall内时点则保留不确定，不把kill-after-return称原子中断 |
| N14 | 修改/替换addon或identity manifest，注入编译flags/加载路径 | 固定loader在加载前拒绝漂移；manifest单独正确不授许可；不受任意路径/flags控制 |
| N15 | addon重复调用、Linux长序列实际竞争及进程终止 | 已存在目的保持no-overwrite，无FD/内存泄漏或隐式重发；记录真正执行次数及限定范围 |
| N16 | 资格套件原件与环境hash漂移/缺字段 | 不生成qualified或ready收据；base/head/tested/产物/环境须一致，null不能当wildcard |

N04/N05/N13的IPC协议不得“exists即ready”：写完整记录后原子发布或完整消息传递，
父方校验记录字段/身份并确认子进程exit/error；每个等待有上限和诊断，结束不留无主子进程。
这保护测试真实性，不修改已合入SSM/drainfixture或其历史失败。

## 实施次序、可并行范围与出口

1. 本轮：只固化N方案、环境缺口及测试设计，双非作者最多两轮评审；不写四个候选源码。
2. 实施前：原生选型 ADR/架构归属签收、四文件owner确认、Linux环境/镜像/工具链/头文件
   身份及启动下载范围明确。未齐备保持 `implementation_ready=false`，先核不后补。
3. N独立源码批次：固定原语/显式build/拒绝loader/专属测试；所有产物只放独占worktree
   gitignored `.cache/backup-native/`，不改Docker/npm/CI或借用K的SQLite/输出。
4. 原件验收与正常PR/CI；现有runner是否真正执行嵌套Linux资格须实核。
   默认CI没执行不能算通过；需要共享runner改动时另交接，不偷换方便替身。
5. N收口最多证明冻结组合的资格；S另批串行。A3/R6真实producer/全入口覆盖未交付，
   K/N不代签A02/A14、实际C1消费、部署、恢复或安全回退资格。

N实现可与不触碰其四文件/产物/环境的其他任务并行；共享组合S不能与ledger/writers
其他owner并发写。资料/归属盘点只读；ADR或环境需要新增权限时暂停对应动作请求确认。

本轮源码回退不适用：只新增两份专属文档，后续变更仍走feature PR，不改历史事实。
始终保持 `positive_admission_ready=false`、`safe_rollback=null`、deployment blocked、hold/#435。
真实模型预算0；无生产访问、实际备份/恢复/迁移/部署、保留分支/worktree/证据清理。
