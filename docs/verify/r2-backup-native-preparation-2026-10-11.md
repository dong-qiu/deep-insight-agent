# R2 / Window N：实施准备与环境缺口收据

## 范围与身份

基线：`724bd7314272ceb60268d410a561b0223bac6324`。
worktree：`/Users/dongqiu/Dev/code/insight-agent-r2-native-plan-20261011`；
branch：`docs/r2-native-qualification-20261011`。
本轮承接用户“继续下一步”，交付[原语资格预冻结方案](../plan/specs/r2-backup-native-qualification.md)
及本文两份新文档；未创建四个native源码/测试候选文件。

K的[PR #470](https://github.com/dong-qiu/deep-insight-agent/pull/470)已合入，
精确主干CI38114484163/1为完整范围成功。该证据只验K，不能移植为N资格。
K历史收据/审查/失败与后续收口注记均保留。本轮不移动主worktree HEAD、修改共享ADR/架构或台账。

## 实际环境及归属盘点

- 定向检查82个Git worktree，仅四个N候选、两份专属新文档和ADR/architecture；
  六个新路径无已存在文件或未提交冲突，两个共享文档无所选未提交变化。
  这是时间点检查，不代表共享owner释放、所有会话停止或全部工作区干净。
- 创建独占worktree后复制gitignored `.env.local`，权限0600，DB_PATH/DATA_DIR机械
  重写为该worktree隔离路径；未输出/提交密钥。未复制`.data`、DB/WAL、原文或
  `.env.development.local`，未加载配置运行测试或模型。
- 实测本机Node24.19.0、darwin/arm64、N-API10/modules137；Docker client29.2.1
  无可连接daemon，`colima status`明确未运行。Linux身份/镜像digest/工具链未核。
- 发现两个本地24.19.0头文件目录，未将macOS缓存签为Linux已核来源。
  registry候选身份查询因本地buildx命令不可用未形成镜像结果；不改装插件绕过。
- 浏览官方Node24.19.0 Node-API及LinuxUAPI作为语义参考；手册网页访问失败保留。
  未下载编译输入、不使用master网页充当pinned工具链或实际Linux证据。

## 本地验证

首版两份文档通过仓库实际`checkDocuments`检查；`npm run typecheck`的TS7/TS6四路
于2026-10-11 06:36 UTC退出0。命令在去凭据环境运行，只读复用既有依赖，未安装或加载配置。
原始日志hash为`4576ccb2819cc20836f7a61bb82deb02ab9b14fa92983ef552b0098d4e9425a1`，
绑定首版两文档hash，不能移植为修订版检查。修订版v2于06:56 UTC再次通过两文档检查及
四路typecheck，checks-v2.json独立绑定下述第二轮对象；内容相同的日志仍分版保留。
最后术语澄清及本收据事实追加后的检查另执行，不用v2代签。
N01–N16均为待执行测试设计，本轮没有native用例、编译、Linux容器或syscall正例。
Doc CI无论成功与否都不是Linux原语/应用/Docker/生产验收。
Eval不适用：模型、prompt、来源、引用白名单及评测口径未改，真实模型预算0。

## 独立审查

按pre-pr-ai-review使用两位新上下文非作者核方案、范围和验收真实性，最多两轮。
首轮A为B0/W2/S1，B为B0/W0/S2。首轮审查身份为spec
`8b6119be4cc6b898af2daf7399e97d1d525b73d18940b44f5f66466c81280be6`、receipt
`2486df7efea047912ce22b877f373eef578864aaf26eb34d56070af38b00d291`。
已补FD私有副本生命周期、syscall后返回失败的unknown、本地FS范围、C转换边界及skip/not-run分列；
第二轮A为B0/W0/S0，B为B0/W0/S1，原首轮发现全部解决。第二轮对象为spec
`3bdbc82cefe021f8d116a49fedeb96b45da664e0f3708a39df09f8f91ed96b7a`、receipt
`5aa839fb2a30aa06e47db441a488febf2bae92cb1d076a66372693259eea853b`。
最后S1为术语澄清，已把“零syscall”改为“不执行renameat2”，明确syscall_attempted
仅指renameat2，不否认dup/fstat/close；不改变方案。未重开第三轮方案审查，不补签K算法轮次。
PR后按skill另核最终diff、摘要及事实追加一致性，不把该留痕算作新算法审查。
未取得原生选型ADR签收、固定Linux环境及明确实施窗口之前，保持
`implementation_ready=false`、`qualification_ready=false`。

## 证据、限制与交接

私有准备材料根目录：
`/Users/dongqiu/.local/share/insight-agent/evidence/r2-native-plan-20261011-I0w0eg/`。
目录0700、文件0600，包含定向路径清单、隔离配置copy状态（无原密钥/原值）、
实际环境探针失败/成功日志和身份。本轮最终新增日志/评审另封存，旧K和#471索引不覆盖。
本地保存不等于异地备份；不将环境探针失败包装成平台资格通过。

下一必要确认是Linux环境启动/固定镜像及头文件工具链范围，以及原生选型ADR的限定登记归属。
环境可用后重新核身份和占用，不能复用本次失败探针为通过或把方案接受当技术行为证明。
四文件实现、真实Linux正反例、生产镜像native闭包和后置S仍未交付。
保持positive_admission_ready=false、safe_rollback=null、deployment blocked、hold/#435；
TD-09/TD-19/R2整体不关闭。未操作生产、实际备份/恢复/迁移/模型或清理。

## 回退

本轮仅新增两份文档，没有运行时回退对象或业务数据变更。
若方案需调整，另feature PR追加修订，保留原方案身份、失败和审查，不强改历史快照。
不因文档收口清理既有分支、worktree、私有原件或解除部署hold。
