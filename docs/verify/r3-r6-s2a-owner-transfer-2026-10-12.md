# S2a 精确写窗与移交准备收据

## 身份与本轮授权

唯一作者 Dev-Agent-R3–R6接口准备；复用 bcba worktree，不建新worktree，不复制env或DB。基线为 PR476 merge `b9cd8a208436b6a50dede73dd1b78f8416ef44aa`；前候选6101107d只含两文档，因此下列源码在两者间无设计变更，33源码在实际merge逐项blob/SHA已核一致（coord/owner-inputs-v2.json）。本轮仅新增 [格式/API spec](../plan/specs/r3-r6-s2a-v2-format-2026-10-12.md)、本收据与 [ADR delta提案](../plan/specs/r3-r6-d2-adr-delta-2026-10-12.md)。当前branch最终身份在私有candidate/交付索引记录，不借旧D2head签新方案。

用户六小时协作授权与主控明确委派覆盖文档准备、正常commit/push/PR/CI。主控指定本线唯一merge owner的PR476 exacthead已正常squash；新PR尚无mergeowner/head委派，停在可评审。固定截止2026-10-12T01:26:40Z。D2 root方向已冻结；精确APP_ID/DDL/API及8新源码/测试接管尚未冻结，正文均提案，不创建这些文件。

## 已确认、历史与待确认

已确认：三新文档及本私有证据由本线独占；S1/U旧八文件的限定接管仍保留但不能扩大S2；PR476已合入且main docs CI成功。历史：10-08/10-09协调收据all_owners_retained、D1/A3/C1/C2f及Git lastcommit只作来源。待确认：下面每个新文件同名其他owner占用、S2b域driver、W1十一文件释放、A/P接口与原owner的未提交保全。clean/合入/聊天结束不等于释放。

本片不进入r2-native、Worktree清理的17目录，不做全机扫描或向旧owner聊天。ADR/architecture的原Dev-Agent重构owner及N08 hold继续有效；该owner未授权本线落实际ADR。占用不明继续独立只读与新方案，交主控精确协调，绝不写成free。

## 八个候选新文件

| 精确路径 | 本线HEAD/blob/本worktree | 历史owner、hold、当前占用与移交 | 后续唯一owner/依赖 |
| --- | --- | --- | --- |
| `ops/maintenance/writers-v2.mjs` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `ops/maintenance/writers-v2.d.mts` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `src/lib/runtime/writer-admission-v2.ts` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `ops/maintenance/writer-control-v2.mjs` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `ops/maintenance/writer-control-v2.d.mts` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `ops/maintenance/writers-v2.node-test.mjs` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `ops/maintenance/writer-control-v2.node-test.mjs` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |
| `src/lib/runtime/writer-admission-v2.test.ts` | HEAD不存在/blob无；本worktree未存在 | 同名外部占用未知，未扫描；新增写窗未释放，未提交内容入口待主控确认 | 唯一S待指名；S2a exact格式/runtime/control/tests |


## 既有文件逐项身份和归属矩阵

下列blob/SHA256均为只读冻结真实Git对象，不认lastcommit作者为当前owner。完整40位base/head/lastcommit、字节数、worktree同字节及不可变snapshot见私有 `coord/owner-inputs-v1.json`（本地merge核对后加性v2）；表中缩写只便于阅读。每个文件的未提交保全/活跃占用需原owner或主控定向证据，本worktreesame不证明其他worktreeclean。

| 文件 | blob / SHA256 | 历史与当前释放 | 处理/未来owner |
| --- | --- | --- | --- |
| `ops/maintenance/contract.mjs` | `33573a20f2c990855406659279a81000b9ec446a` / `13d5b885a5e5f5aed70a585f004219237825ee3cbc016b1eb6f7aa4e48fe09e8` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/ledger.mjs` | `799f23a5694e5bdacd74869986d08b6b5361ed21` / `6429ce42260884ea0bcc7d698e2b68daff947fae011717a5cb205add92f18b79` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/controller.mjs` | `73fda3efb16b698f5ae5ed7696af7a506a42e2e0` / `852023a56842ad82f616bd095ad3027e5a90c2265c62a639a736e79511d0b8a0` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/drain.mjs` | `e68d5cfc3d31a4e0105ac144d4a1d0fbd46380d1` / `bbfcc191624252f94507660927cce601c5b53d3c2577dc782edc9a61a2bb398a` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/drain.d.mts` | `b5af5e221ac57ef0eed35ef621fa54b19e9e95f1` / `f9d74ae543086e531d42d26844c06607df002aa70fc815514372d7520bde47b5` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/staged-terminal.mjs` | `de3cac40442fec29b260798508a76602b0c2b125` / `a7d9fe9c5d8cb772e673ff18ed7a6ae131c865621ef3b97ae09ee89ed351e0f8` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/staged-terminal.d.mts` | `c18e2bd6333fe6ce21d30b2d8e7bfbf01475578f` / `cf2afb82c7e51374595ec2c91bbcee2756f9d65c0684c1eca65bd92a4fc03d22` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/writers.mjs` | `4cde95cafc0b47d356a78b7c430b0ec506558e05` / `ed1e34c0d82ae6c3b4142e392c40bfedcca47cd453a96a3fbd196ab367df3849` | A3/S1/U历史，本线限定使用hold仍在 | 保持字节；S2不扩旧窗，usage旧path不adapt |
| `ops/maintenance/writers.d.mts` | `c0f54c0297aa46e012c377197bf8c5943a1342cd` / `0e7a38fae6c10b33b12ff92ce5676f959bdbb62a741fa8311c39f0198678538f` | A3/S1/U历史，本线限定使用hold仍在 | 保持字节；S2不扩旧窗，usage旧path不adapt |
| `ops/maintenance/a2-consumer.mjs` | `3f44cf46466e94dde8663ac71812f097be97c69f` / `0de8016743bc5604d843e07383b9fb7f0538a206828204fd46e21306d6249007` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/owned-drain.mjs` | `72aebfe5c01cfa05146a8127ef813cc6bd184195` / `3b11be4d0cc10169509970942e3f89cd2f0eb415f34fc63147302695e71b21f0` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/cli.mjs` | `2a1fad8465a4d97eb2e7df1b3fcf2e37371c4674` / `3affb2eda50b89ec9d6c9161a02cd081b4af1617c1484e4a520e488c8ab5d6f8` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `ops/maintenance/controller-cli.mjs` | `93e39b70b22c2788ccac2e5f1b107c819f0931e9` / `93a927c78d664ed8adfdf8f7ebc4c2dea3dbf630d1628dfb202b482acad20877` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `src/lib/runtime/writer-admission.ts` | `0aade7e6d12acd819ba345a2d532012627ea5e83` / `b31bde04077c21544765fe715b598bb66969fcc52e1377f8579135ec2e67eb63` | A3/S1/U历史，本线限定使用hold仍在 | 保持字节；S2不扩旧窗，usage旧path不adapt |
| `src/lib/runtime/usage-dispatch-driver.ts` | `71536989dea481a69db21979164f8dcd14ce200c` / `08b8079c5da6f05483c7b1f89d08c5972d82c73011db08ae5630a6ed90615517` | A3/S1/U历史，本线限定使用hold仍在 | 保持字节；S2不扩旧窗，usage旧path不adapt |
| `src/lib/runtime/terminal-dispatch-driver.ts` | `4e99bff3a97671fa06641572e3e6a26e85cf5389` / `20ba69d4a59c406a1604a00f7e93cb1eb2726f4be7860d98ac4a9805a2fa1e99` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `src/lib/db/schema.ts` | `f9402c6fd88670c224a295ec40fbc2b8ba7ec01e` / `8b83a8fc65c38c0267a0e0d45c9f2648b057205ea225dc3fa505fdd6b977e840` | S0/A3/terminal等历史；现owner/释放待确认 | 只读字节保持；消费者真实能力见spec，不取接管 |
| `src/lib/db/connection.ts` | `1aaad9bf8847d2333d69d018f28b50274d1361de` / `2a745a12a4cc198ce3560ef78ccb810c669ac724109a8f0c7fea89b5ae8bd751` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/startup.ts` | `39ed2dd385919958b4d1ee0a4f482414dd21da05` / `eddcb65e1be02b75bc1c1e1d75050882142d1d2208832c57e49ca87252efe78f` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/local-bootstrap.ts` | `f171f0db700e9fa140db9493a6541ebe14476a41` / `da716a4588ea5b524e892962bf6449786a48de6c1bad35b258438a23c88caf52` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/config/index.ts` | `1d5705a73d387864ca5d6da55138af3a0d66c35d` / `8cbadd236f302b21c00ec17d8ef46b5471015ee38266314ff519305b4a7440c4` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/planning.ts` | `c2457ad5e055b426579d52e029f92e1860040834` / `0536dedd9cc99cfa6af9ad5ff2dbffd311326c6221ef4840c0581992ae7ddb62` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `evals/seed.ts` | `569ce3381c322d0500b44d30acf9369892a0065b` / `e0c6c6b510a1dc787b64a5a08ac796dacbc76007b8a645cc097ee2e2f758eff7` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/d1-connection.test.ts` | `f5ba7ca628f3407e19f80e1d125387bd6b9defaf` / `7448e4017dae5e92a652e668175c5338aa4a0b605298c06164489c0f153f8dd8` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/local-bootstrap.test.ts` | `b5cd08408f013a42bf71643623787674b32d173f` / `95ce30d49db0a0401492d866125ba7e62a3ede0d3c7e2e5bd4f9a727095703e4` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/config/index.test.ts` | `28b2ab9d9e21ff8f94b387390e686314eacdac2c` / `61f6f2c065e21bcc5d0db11cce35fce4a368ee80f3e5878aaed2216e483902c3` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/planning.test.ts` | `1062ee2208a10209a3285874e4358286aeb52714` / `5884c25fbeb8d36a5becc251e4e1715148ea6c6fa24cf8363a854fd90614e8bd` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `evals/seed.test.ts` | `025124fa5af9b558f280f248b9ee3b6c45550f20` / `f44c9863f89a4624722af369dd550bc0fee3047e191cf6768501e60a79320c8a` | D2已列W1候选，D1/seed等历史；未释放/活跃占用待确认 | 同一W，十一文件逐项接管后串行W1 |
| `src/lib/db/legacy-bootstrap.ts` | `5cbec3d5dcb134e4dc4c836d2b6de4633423f6d2` / `8cfc080429a8eddad439294594008ce4366f1e4bea22eccf48529614cd5de0ec` | D1/C1/C2f等历史；原owner保留，当前释放未知 | 只读邻域；collector/provenance/legacy不扩，raw=A、reports=P待指名 |
| `src/lib/db/provenance.ts` | `050090125b7283c77a557d48f8995d5521193783` / `745ce0f20ac873cef9ac874e20c8a3586f9fdcea925f2ccec59af1f5a3bd3e92` | D1/C1/C2f等历史；原owner保留，当前释放未知 | 只读邻域；collector/provenance/legacy不扩，raw=A、reports=P待指名 |
| `src/lib/agents/collector.ts` | `a10c08c1d04ea4a84b949fe181f56fbc298fb7b0` / `5fb6758694f36479eb00f6a25029f8689313447dd381e323a0dbd34e09c2c6a8` | D1/C1/C2f等历史；原owner保留，当前释放未知 | 只读邻域；collector/provenance/legacy不扩，raw=A、reports=P待指名 |
| `src/lib/db/raw-archive.ts` | `a24139fa62908e2c75f5aba4d206b50fbf77aa59` / `79e384a7057975c9ba03b5eb8f843b48aa549048cbbafd882fb31656cc575eed` | D1/C1/C2f等历史；原owner保留，当前释放未知 | 只读邻域；collector/provenance/legacy不扩，raw=A、reports=P待指名 |
| `src/lib/db/reports.ts` | `a4833bda23db100a9927f06f569954c57880c285` / `81f8581785ae24c95a77623656e5faf1c7321c7b612373601ca430dd27bc421b` | D1/C1/C2f等历史；原owner保留，当前释放未知 | 只读邻域；collector/provenance/legacy不扩，raw=A、reports=P待指名 |


## 移交证据要求与依赖顺序

每个实际实施窗口必须有：具体交出owner→唯一接收owner；base/head/blob/hash；原worktree的dirty/untracked内容保全位置与仍保留窗口；当前活跃写占用；明确停止旧窗口写入/原路径使用的证据；消费接口版本与DDL/API冻结；review/CI适用范围。不存在文件须由主控定向查同名计划/占用，不以本线不存在补全。概括授权只能解决同意，不能生成这些技术事实。

S2a新registry/runtime/control与其tests由同S串行；新真实control消费者读取六entry/未ACKsteps并永久close同registry，不能拿旧drain拒绝当positive覆盖。S2b同S继续新domain固定消费；A/P可在各自独占repo并行准备，实际恢复结果之后W1才能组合raw→report→seed→发布_db。W1六source五tests尚缺精确释放，owner须同W直至后续caller串行；auth-reader D1 readonly例外不纳入W1。app-path旧targets共同ownership与D3 async另案。

## 验证、审查与证据

本片只做格式/links/import事实/来源身份核对；不运行native/app/模型/资格/生产。按pre-pr-ai-review高风险，三新文件的新两位非作者，最多两轮，原件保留，结论绑定candidate SHA；旧D2两轮已收口不重审。正式PR独立远端identity/full-diff/summary核对仅留痕，不第三轮算法审。docs路线CI不签runtime。

私有根 `/Users/dongqiu/.local/share/insight-agent/evidence/r3-r6-s2a-prep-20261012/`，目录0700，原件0600；inputs冻结33源码，coord为candidate/owner身份/PR476真实merge及mainCI/网络失败，reviews-a/b各独占。旧D2 final-index-v1与58成员及S1/U全部保全、不修改、不清理。初次与两次重试fetch连接超时记录保留；API签名原件重建Git对象并验证exactSHA=b9cd8a2，tree与D2受审head一致后导入本地对象并开codex/r3-r6-s2a-prep-20261012，未改写origin/main；main-ref-api确认当时main同SHA。branch/对象身份见verified-api-import-v1.json，不把网络失败写成CI失败。

最小下一行动：主控冻结本格式/8新窗口与S2b精确driver范围，正式ADR由原owner落账；拿W1十一文件与A/P恢复接口收据。缺口期间只推进本片专属交付；不生成源实现、不重开延期reports拆分。
