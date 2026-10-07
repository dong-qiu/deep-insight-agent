# A2 不同版本候选资格调查收据

## 结论与精确对象

已核三个不同revision的真实OCI metadata链与发布成功job，**没有完成安全回退资格验收的对象**。
这是缺证/质量预算限制，不是“没有不同镜像”；不批准候选，safe_rollback仍null、deployment blocked及#435硬阻断保持。
冻结发布仍 `4477412a3e2b1cb2764fb4357f2284e73952af67` / amd64
`sha256:e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c`。
其他版本比447新，不冒称已批准downgrade；未来工程镜像需重新固定release→candidate关系。

工程base `81dac77cd27f82d7b554694bf0a12cd82cd0920b`；branch `docs/a2-different-version-candidates-20261008`，
专属 worktree `insight-agent-a2-candidates-20261008`；只写两份新文档，旧Session文件/policy/gate/主台账未写。
本地配置0600且DB/DATA/端口3112隔离；未运行应用、复制数据或打印凭据。
[切片spec](../plan/specs/a2-different-version-candidates.md)规定分层、退出和下一片有界方案。

registry观察 `2026-10-07T18:53:55.555Z`：匿名只读请求，每对象≤1MiB、30s timeout；token不保存、不输出。
逐对象保存原index/manifest/config字节并核SHA256、响应digest、descriptor size/type、amd64唯一性及config revision；
compose来自精确Git对象，三者SHA256均 `984e62a4af23b980ec16f3ece7532eb3aa2c0dd0a073444640219344ef6953fd`。

| revision | index | amd64 manifest | config |
| --- | --- | --- | --- |
| `eb2bd4d6a096331d888f938391749a42aa16625b` | `sha256:3bd1ba71b1ce612f716bf00e983c6d156c91674c88a13f1b4fcf917e8506982e` | `sha256:d2b2e6a00d4edf3d364f4c46ca1ad4eea451ed655e0cb5781fe7859d195d4974` | `sha256:a02b54236af7c86dceffbe8f7e0ab701cd74cdbd58723baf27f7acea3ca1ada6` |
| `a5253da8a4e9c40f8098235d6976e5a7b7f6eb71` | `sha256:5e180404edc7d7e0dbfddec11eb9d0251e2492acb6ca10e9160f767893630761` | `sha256:73f49e69b6247a57d362554ab34d839817ce2c38158ee9414881c904274b9d48` | `sha256:aecad7580aa87133e1ef43307cfd60e0e41feaa48ff787d7056d9f15dec16642` |
| `81dac77cd27f82d7b554694bf0a12cd82cd0920b` | `sha256:1f4cdaa37e32db7eb5efd45aa77fec2777c62dc994f0d3ab3212e7753c9f8498` | `sha256:ea30cf753ba58ecabcd8462b2c6390f60aa2c124c6bf8a6aeef594b91927c255` | `sha256:3fd96d0701643b764e6d9beddd3d858718255902fc13079fd90ab7d01d0aacaa` |

| revision | 精确 main CI / attempt1 | publish / attempt1 | 实际build+push job |
| --- | --- | --- | --- |
| eb2bd4d | [37573978663](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37573978663) push/head=revision/success | [37574371338](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37574371338) success | 112639910148 success |
| a5253da | [37603495951](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37603495951) push/head=revision/success | [37604014130](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37604014130) success | 112735079701 success |
| 81dac77 | [37665469691](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37665469691) push/head=revision/success | [37666179870](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37666179870) success | 112945968810 success |

main run/job和publish run/job原JSON已保存，核head/event/conclusion及实际publish job；
本轮没有重执行publication admission、下载其application/Docker产物或独立重验builder日志。
上述是已有工程CI/publish元数据，不是指定GHCR镜像安全/兼容运行证明。
初次列publish run使用了分页输出，发现超出近期调查必要范围后中止；最终依据只取指定3个精确run/对象，未搜索个人目录或运行旧镜像。

## 资格和缺口

| 候选或层 | 本轮所核 | 保留缺口 / 处置 |
| --- | --- | --- |
| 447之前已知漏洞版本（含b199/823b） | 既有修复/收据边界；sharp0.35.4/source-map-js1.2.1不可作为安全回退 | 排除，不pull/run；不是全历史对象安全扫描 |
| eb2bd4d / S2a | #430最终head235045d及merge、main CI与真实OCI链；Topic/Source后缀128位 | #430明确保留旧head Source模型输入变化的真实质量Blocking；预算0，不能用#438/当前main补签；实际镜像闭包与跨版本新数据未验 |
| a5253da / S2b | #438 head eadccc5及main/publish/OCI；candidate/batch128位；S2b专项收据明确原源码桥接与有限安全口径 | #438明确保留S2a旧head待办，不能抹去；该digest完整闭包/HTTP/跨版本新数据未验；不是新维护代码候选 |
| 81dac77 / 工程main | #443后main CI及新publish/OCI；静态Analyzer/validate与a525一致 | #443真实矩阵执行的是447镜像，不能移植到81镜像；该digest闭包/业务/跨版本未验；仍继承S2a专项缺口 |
| 指定源码兼容 | 三者package/lock/Dockerfile/compose/vendor provenance、schema、provenance及迁移定义/runner/ledger、startup、deployment、integrity lifecycle、middleware、report-gen均与447字节相同；validate均不同，后两者Analyzer不同 | 静态相同不证明runtime/native重建相同，不证明reader/auth所有依赖路径或业务新数据可消费 |
| 真实pull/save/native/HTTP | 本地Docker CLI存在、daemon不可用；未pull/save/run；不为了凑验证运行未完成资格对象 | 缺实际拉取身份、builder/runtime修复闭包、真实业务及release→candidate数据矩阵；未启动CI候选实验 |
| 当前生产/操作批准 | 本轮无访问，不读取live库、配置、备份或AWS/SSM | 外部授权/实名人员/当前数据及备份容量等阻塞；无rollback或生产许可 |

初次static-source-bindings请求了不存在的`src/lib/db/initialize.ts`，原文件保留missing，
后续`static-source-bindings-supplement.json`改为真实startup/migration路径；不能将missing列当成功。
无模型、prompt、校验语义、数据源、schema/历史契约变更；无真实模型调用，不签Eval-Gate skip/pass。
纯文档调查以registry/指定源码/CI原材料复核及文档检查验收，不用A1或当前源码Docker构建代替。

## 私有保全与交接

私有归档 `/Users/dongqiu/.local/share/insight-agent/evidence/a2-candidates-20261008/`；目录0700、文件0600。
29文件首索引`archive-index.json` SHA256 `8585a23cb2d41f5e671ad03eb2f691c6fddb1d9f538ade5f0b0a1f381b015065`；
补充真实startup路径后31文件索引`archive-index-2.json` SHA256 `86907d49dfc5eb6ba7e4445e289b975dfe01b137d46d053654000778ad0b90d2`。
index2含原index1，原材料不覆盖、不删除；raw registry/config/CI原材料只在私有目录，Git只记digest和结论。

本阶段完成候选资格调查；未完成镜像安全/不同版本运行兼容、S2a真实质量、当前生产兼容或批准。
当前没有足够资格进入本轮运行验收的候选，按spec退出；后续先完成具体候选的身份/源码安全预筛并明确质量缺口处置，
取得必要预算/证据并独立冻结有界方案，再通过专属禁网矩阵补齐拉取/原生/业务资格。不会重做#443或解锁生产。
独立review及此文档PR最终head/tested merge/main CI由协调者在最终PR和台账绑定，不预签。
