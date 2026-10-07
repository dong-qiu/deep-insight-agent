# A2 唯一不同版本隔离资格对：81dac77 → a5253da

## 范围、身份与归属

协调者2026-10-08已授权预算0唯一pair实验；先冻结本方案并由独立Reviewer复核，再实施。
工程base `81dac77cd27f82d7b554694bf0a12cd82cd0920b`，继承纯调查文档提交 `9ae14b9`；
独立branch `feat/a2-version-pair-20261008` / worktree `insight-agent-a2-version-pair-20261008`。
执行Agent B独占新增 `ops/a2-version-pair/*`、本spec和专属收据；只读复用#443 harness、#435 preflight及savedConfig。
不改既有policy/gate、A2/A3 helper、deploy/CI workflow、生产源码/schema/依赖/模型、共享台账或他人Session。

| 绑定 | release | research candidate |
| --- | --- | --- |
| revision | `81dac77cd27f82d7b554694bf0a12cd82cd0920b` | `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71` |
| index | `sha256:1f4cdaa37e32db7eb5efd45aa77fec2777c62dc994f0d3ab3212e7753c9f8498` | `sha256:5e180404edc7d7e0dbfddec11eb9d0251e2492acb6ca10e9160f767893630761` |
| amd64 manifest | `sha256:ea30cf753ba58ecabcd8462b2c6390f60aa2c124c6bf8a6aeef594b91927c255` | `sha256:73f49e69b6247a57d362554ab34d839817ce2c38158ee9414881c904274b9d48` |
| config | `sha256:3fd96d0701643b764e6d9beddd3d858718255902fc13079fd90ab7d01d0aacaa` | `sha256:aecad7580aa87133e1ef43307cfd60e0e41feaa48ff787d7056d9f15dec16642` |
| compose SHA256 | `984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd` | 同左 |

repository固定`ghcr.io/dong-qiu/deep-insight-agent`、linux/amd64。以上是实验身份绑定，不是批准policy。
#435实际policy仍冻结4477412，deployment blocked、safe_rollback=null；实验输出权限永远false。
真实CI/publish及本轮registry原字节来自[调查收据](../../verify/a2-different-version-candidates-2026-10-08.md)，
不得作为本pair未运行的native/业务证据。父子顺序以Git验证a525是81祖先；应用src及package/lock/Dockerfile/compose
在该pair间字节相同（不同测试/运维工程代码仍各自绑定）；不能据此声称解决共同应用payload自身启动故障。
两者都不含本轮A3新接线，未来维护镜像须另冻身份和验收；本pair不是该新镜像的回退批准。

## 原始消费路径与隔离

复用真实preflight校验index→manifest→config/revision、descriptor/hash、实际manifest pull/save及compose解析。
输入只用本模块冻结研究描述并保持blocked/null；不写共享policy、不传给任何真实部署入口、不增加CLI选项。
记录原image inspect/config、工具base/head/tested merge和run/attempt、harness/hash及每阶段实际bundle/hash。

所有业务容器禁网、非root、read-only rootfs、cap-drop ALL、no-new-privileges、无host port；
宿主Docker命令只继承PATH，无生产env配置。容器env从零生成合成AUTH/admin/viewer凭据及严格provenance身份，
固定STALENESS_ALERT_HOURS=1000000并每阶段断言stale=false/staleDailyTopicCount=0；无模型/AWS/抓取/通知key。
只挂随机带owner标签的空数据卷和只读harness，容器不挂Docker socket/应用源码/其他Session数据。
HTTP通过docker exec在容器localhost，路由复用#443实际allowlist；数字地址外网与metadata的TCP拒绝另核。
首次初始化空卷只用独占root容器chown，不运行应用；应用、CLI和probe以镜像原UID1001。

#443测试harness只读复用；生成本轮临时harness时只允许两处明确适配：fixture/http-probe/failure-probe的in-image import
转向pair adapter（共享snapshot/fixture constants不改，bundle绑定从447改为当前两个明确冻结身份）；
native六项测试的cwd从源码root改为/app。保护测试校验精确原harness SHA256和替换出现次数。
任何原harness字节漂移、替换/app bundle、未知身份、宽化路由/reader/status或继承secret即拒绝。
这种适配只改测试身份，不修改原镜像server、Next bundle、migration或record入口。

## 唯一有界矩阵与反例

1. 指定两revision导出不可变Git源码；只共享hash相同的安装依赖，分别跑真实source-map/magicast API安全测试，
   记为源码/builder API证据，不冒称执行已发布builder层；每个真实runtime跑source-map-js1.2.2及sharp原生六项。
2. fresh专属空卷由release真migration48项、strict record与server初始化。只在release调用#443fixture/完整HTTP矩阵：
   auth/revocation/权限、reader白名单17类、历史报告/长ID、HTTP topic/user/manual-review真writer、幂等及失败保全。
   SQL report/content/Insight/validation/audit/effect明确标fixture，不冒充模型业务生成。
3. 保存release写后与同镜像重启的持久snapshot/hash。停止本轮release容器并核Stopped后，
   candidate在同一合成卷执行原migration（ledger不变）、strict record（原deployment_record全部字段逐字保留，只追加1条候选identity）并启动原server。
   candidate独立核自身bundle/identity，不要求其bundle hash等于release；保留release snapshot/artifact原hash。
   跨版本核release业务新数据/关联/文件保留、admin/viewer真实新登录/401/403、报告/长ID与reader精确集合；
   blocked/unchecked/unknown effect仍隐藏；真实candidate新manual-review writer产生新trace/event/ref/released lease，重放不重复。
   candidate再次重启后新旧数据和关联/hash保留。一次pair，不跑全历史/生产/模型矩阵。
4. 候选错误身份不record，严格server拒绝业务；坏migration checksum拒绝且新数据完整，
   不用health成功掩盖业务失败。故障只用本轮另一个独占合成卷，不破坏成功路径数据，不反向迁移/删除/重编号。
5. harness的反例先行覆盖wrong revision/digest/config、tag/无资格旧版本、source替换、env继承/外网/publicport、
   SQL冒充writer、ledger/身份/状态错配、health掩盖失败、reader权限集合放宽、跨版本数据丢失及未经批准许可。
   CI Linux自动ops发现必须实际run，Docker缺失不得skip；本地无daemon明确未运行。

预期副作用只有本轮合成卷/短生命周期容器和临时harness/source；精确owner/id核验后回收本轮资源，
保留原证据/所有其他worktree/branch。失败先查原因，最多两轮修复独立review；不放宽门/换对象/无限实验。
所需本地定向ops、typecheck/lint/docs；真实CI包含native/HTTP/migration/record/Docker，与当前工程CI分层。
本切片不改生产路由或build输入，完整工程build/HTTP由正常full CI执行，不移植到两个research镜像。

## 结论与退出

通过只声明这一个pair在这些无模型合成数据/HTTP入口上的隔离资格建议；不是完整业务/真实模型质量或当前生产兼容。
S2a旧head真实质量缺口仍是独立专项预算待办，S2b/new main CI不补签；不妨碍本轮预算0工程实验。
生产访问/SSM真实终态、当前配置/数据/合格备份/容量、全writer维护和实名操作批准均未授予。
未知writer/终态/drain仍阻断；无rollback/deployment权限、没有解锁参数、没有实际生产执行或清理授权。
依据：[#443 spec](a2-same-image-business-matrix.md)、[A2契约](a2-safe-rollback.md)、
[#435](security-deploy-preconditions.md)、[恢复边界](recovery-time-coverage.md)。
