# C：关键交付证据归档索引

## 保存位置与最小清单

归档标识：`c-20261007T042516Z`。原始文件保存在 operator 私有持久目录 `$HOME/.local/share/insight-agent/evidence/c-20261007T042516Z/`，仓库外；目录 0700、文件 0600，使用新目录与独占创建，不覆盖已有归档。未复制环境、数据库、SQLite/WAL、原文或报告。

封存清单 `sealed-files.json` SHA-256：`a791219e088523aa05e027edcca24af63836a7fa035b07c92b816f63b3019eeb`；封存时间 `2026-10-07T04:32:04.386128+00:00`。清单逐个记录私有文件路径、大小与 SHA-256；后续读者先核此 hash，再核清单所有成员。本页是可公开的定位索引，不代替原始文件。单机归档尚无独立异地副本承诺。

优先级 1–4：#422 最终候选 37561418156、精确 main 37562025600、#427 精确 main 37559263616、镜像发布 37559608396。
优先级 5：#427 最终候选 37512051645、两次包装失败 37504892238/37506441067、#422 两个旧 run 37460791666/37506167287 的各 attempt、#423 main sharp audit 失败 37501620737。只下载 scope/app/Docker/reader 身份与结果证据、发布 build record，并保留各选定 attempt 日志及元数据；不无差别下载全部历史产物。

共 10 个 run、12 个 attempt、31 个现存关键 artifact；不把 superseded candidate、历史 failure 与最终 success 相互替代。其他成功中间基线和 P1/性能扩展附件不是本任务冻结安全候选的最小验收材料，仅在 artifact 元数据和已选日志中可见，未归档其原包；不声称保存了每个 run 的所有产物。

## 身份与结果（GitHub API + 原 JSON）

| PR / run / attempt | workflow / event / result | 源码 head SHA | tested SHA | run 开始 / 更新 UTC |
| --- | --- | --- | --- | --- |
| #422 / [37561418156](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/attempts/1) / 1 | CI / pull_request / **success** | `eca211f0e24af6d84f5ddb3bdedfa7c03d4fe93c` | `82a01056a6aafc22f5e5247cf6fd9000c618959b` | 2026-10-07T02:19:19Z / 2026-10-07T02:24:11Z |
| #422 / [37562025600](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/attempts/1) / 1 | CI / push / **success** | `473e2eeae119b600b63abd78ce886301bd882235` | `473e2eeae119b600b63abd78ce886301bd882235` | 2026-10-07T02:26:57Z / 2026-10-07T02:31:40Z |
| #427 / [37559263616](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559263616/attempts/1) / 1 | CI / push / **success** | `4477412a3e2b1cb2764fb4357f2284e73952af67` | `4477412a3e2b1cb2764fb4357f2284e73952af67` | 2026-10-07T01:52:49Z / 2026-10-07T01:57:08Z |
| #427 / [37559608396](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559608396/attempts/1) / 1 | Publish Production Image / workflow_run / **success** | `4477412a3e2b1cb2764fb4357f2284e73952af67` | `发布 checkout=4477412a3e2b1cb2764fb4357f2284e73952af67` | 2026-10-07T01:57:09Z / 2026-10-07T01:59:38Z |
| #427 / [37512051645](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37512051645/attempts/1) / 1 | CI / pull_request / **success** | `33e3e0f64e7254c40faedc64792b21bde557f476` | `a12c5478b433ca7f373216e5553151d66b279966` | 2026-10-06T18:32:06Z / 2026-10-06T18:38:20Z |
| #427 / [37504892238](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37504892238/attempts/1) / 1 | CI / pull_request / **failure** | `5c506a79cc892a9600bf09dc125eb279c6c382dd` | `ce1ae08164b5414dc96016592d564398ef8cdc42` | 2026-10-06T17:36:44Z / 2026-10-06T17:39:41Z |
| #427 / [37506441067](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506441067/attempts/1) / 1 | CI / pull_request / **failure** | `edfc059cc32530df8aa6ed8cae0a351131bc8bfa` | `4acfda57fc3b9f3687130a791cce193029fb18af` | 2026-10-06T17:48:53Z / 2026-10-06T17:54:51Z |
| #422 / [37460791666](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37460791666/attempts/1) / 1 | CI / pull_request / **failure** | `fdbef987d113847100f0e1f01b90136edc294557` | `371778b1e8bdf93c840ed5f1ecc95d25eb23442d` | 2026-10-06T12:05:23Z / 2026-10-06T12:11:12Z |
| #422 / [37460791666](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37460791666/attempts/2) / 2 | CI / pull_request / **failure** | `fdbef987d113847100f0e1f01b90136edc294557` | `371778b1e8bdf93c840ed5f1ecc95d25eb23442d` | 2026-10-06T16:56:32Z / 2026-10-06T17:01:55Z |
| #422 / [37506167287](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506167287/attempts/1) / 1 | CI / pull_request / **failure** | `be4bd6969c408a3064addd4d6c2cbeb25ec4fe61` | `3b73ec657f8857992e580d911884348ca0fd845c` | 2026-10-06T17:46:43Z / 2026-10-06T17:49:58Z |
| #422 / [37506167287](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506167287/attempts/2) / 2 | CI / pull_request / **success** | `be4bd6969c408a3064addd4d6c2cbeb25ec4fe61` | `3b73ec657f8857992e580d911884348ca0fd845c` | 2026-10-06T17:51:23Z / 2026-10-06T17:55:28Z |
| #423 / [37501620737](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737/attempts/1) / 1 | CI / push / **failure** | `b407b9e61915c33f835966f8f760f3424f0e17f5` | `b407b9e61915c33f835966f8f760f3424f0e17f5` | 2026-10-06T17:11:31Z / 2026-10-06T17:16:35Z |

run 的 started/updated 时间不是各 job 测试执行时长；原 attempt `jobs.json` 保留所有 job/step 的结果、开始和结束。CI workflow 为 `.github/workflows/ci.yml`；发布 workflow 为 `.github/workflows/publish-image.yml`。发布 run 的 tested 栏是实际 checkout 源码，不冒充 CI merge-ref 测试 SHA。

全部现存 scope/app/Docker JSON 的 head/tested/run/attempt 与 API、同 attempt scope 一致；现存 app/Docker checks 全 pass，但它们所属 run 可能因后续 audit/browser 等失败，整体结果以上表为准。reader JSON 没有 run 身份，使用 current.commit 与 scope tested 对照，再用该 attempt 的上传日志/ID关联，不能虚构其自带 run/attempt。

19 个源码/base/tested Git commit 元数据保存在 `git-commits/<SHA>.json`；PR tested merge 与对应 head tree 均逐项一致。#427 head/tested/main 共用 tree `d0309b2e5d95edfb52ba31b0490185fd9de2a2f9`；#422 最终 head/tested/main 共用 tree `e661b28d505933b896f814dea1cd1b0b99074da0`。两个 tree 不同。

## Reader 实际 warning 结果

8 份现存 reader 原 JSON 均 `status=warning`、`passed=true`，按原政策双门通过；这不代表 warning 消失或生产/HTTP/browser P95 改善。下表记录原数值，不跨不同 runner 汇总为性能趋势。

| run / attempt / artifact ID | observed_regression_ratio | observed_delta_ms | 结果 |
| --- | --- | --- | --- |
| 37561418156 / 1 / 11456577965 | `1.3119794524596515` | `0.034408999999996` | warning / passed=true |
| 37562025600 / 1 / 11457431901 | `1.314239105732061` | `0.03357176000001344` | warning / passed=true |
| 37559263616 / 1 / 11456450291 | `1.3278427706447438` | `0.024183440000006162` | warning / passed=true |
| 37512051645 / 1 / 11434283683 | `1.2507553529005888` | `0.049208079999998516` | warning / passed=true |
| 37506441067 / 1 / 11432077396 | `1.2116976900889525` | `0.04439883999999436` | warning / passed=true |
| 37460791666 / 2 / 11429252744 | `1.3235172679942815` | `0.045100959999999746` | warning / passed=true |
| 37506167287 / 2 / 11432616111 | `1.312951746969186` | `0.022400360000001465` | warning / passed=true |
| 37501620737 / 1 / 11430600679 | `1.2818791405970005` | `0.021006840000009103` | warning / passed=true |

## 产物原包、期限与内部文件 hash

每行私有路径为 `<run ID>/<artifact ID>.zip`。API /zip 原响应不重打包；普通产物是 ZIP，发布 Docker build record 实际为 tar.gz，保留原字节（文件名后缀不代表格式）。API digest 与下载 SHA-256 只在同算法、同响应对象上比较，31/31 一致。内部文件 SHA-256 另列；不得与包 digest、Git tree ID 或镜像 digest直接比较。

| run / attempt / artifact ID | API 名称 | 创建 / 到期 UTC | API digest = 原包 SHA-256 | 下载 UTC |
| --- | --- | --- | --- | --- |
| 37561418156 / 1 / [11457445513](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/artifacts/11457445513) | `prototype-docker-evidence-eca211f0e24af6d84f5ddb3bdedfa7c03d4fe93c` | 2026-10-07T02:21:53Z / 2027-01-05T02:19:19Z | `sha256:645f39dfded53425846022d755082cac60dc476e5ca1db4221d38a67452151da` | 2026-10-07T04:26:15.011470+00:00 |
| 37561418156 / 1 / [11456632999](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/artifacts/11456632999) | `prototype-ci-evidence-eca211f0e24af6d84f5ddb3bdedfa7c03d4fe93c` | 2026-10-07T02:23:57Z / 2027-01-05T02:19:19Z | `sha256:4dadcea1bf563f70015f9b1375cb4f0e68a36533e4ce672c2ce61be08736d516` | 2026-10-07T04:26:17.811619+00:00 |
| 37561418156 / 1 / [11456577965](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/artifacts/11456577965) | `report-reader-p0c-evidence` | 2026-10-07T02:22:12Z / 2027-01-05T02:19:19Z | `sha256:915fbf8ed97c15b4c35ea9732af7b4dfda087cf7cc09e32032cc1f3eaed68bfa` | 2026-10-07T04:26:20.331458+00:00 |
| 37561418156 / 1 / [11456289780](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37561418156/artifacts/11456289780) | `ci-change-scope-82a01056a6aafc22f5e5247cf6fd9000c618959b-1` | 2026-10-07T02:19:28Z / 2027-01-05T02:19:19Z | `sha256:2bbaa4fd3ec15637e504e406e825c499eecb6a8228ade00219c5547438991d9a` | 2026-10-07T04:26:22.485311+00:00 |
| 37562025600 / 1 / [11457431901](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/artifacts/11457431901) | `report-reader-p0c-evidence` | 2026-10-07T02:29:54Z / 2027-01-05T02:26:57Z | `sha256:55c79b25da5d63a6a15e4a87b675f7128238eb100b2c13f42167ab652f16e0ee` | 2026-10-07T04:26:14.568845+00:00 |
| 37562025600 / 1 / [11457167568](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/artifacts/11457167568) | `ci-change-scope-473e2eeae119b600b63abd78ce886301bd882235-1` | 2026-10-07T02:27:06Z / 2027-01-05T02:26:57Z | `sha256:e3733afaf5850b67367c297898f420aa33e4950240e69fa458ed032d8ac396fb` | 2026-10-07T04:26:17.230819+00:00 |
| 37562025600 / 1 / [11456808678](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/artifacts/11456808678) | `prototype-ci-evidence-473e2eeae119b600b63abd78ce886301bd882235` | 2026-10-07T02:31:28Z / 2027-01-05T02:26:57Z | `sha256:acf1419245995a9762543eb1a08168656c16039d005b6deb2285f756e65b91f9` | 2026-10-07T04:26:19.609810+00:00 |
| 37562025600 / 1 / [11456688553](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37562025600/artifacts/11456688553) | `prototype-docker-evidence-473e2eeae119b600b63abd78ce886301bd882235` | 2026-10-07T02:29:29Z / 2027-01-05T02:26:57Z | `sha256:2d08cb29fda2d3504d8b5a58c241c1a300f1b86ca9660f9c6f6b2b83265fc59a` | 2026-10-07T04:26:21.832607+00:00 |
| 37559263616 / 1 / [11456450291](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559263616/artifacts/11456450291) | `report-reader-p0c-evidence` | 2026-10-07T01:55:22Z / 2027-01-05T01:52:49Z | `sha256:5be9c38be2263606d40d4cd8c8f0ded717008acf6de2c210fe11f9001e0c01b1` | 2026-10-07T04:26:15.346078+00:00 |
| 37559263616 / 1 / [11456037626](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559263616/artifacts/11456037626) | `prototype-docker-evidence-4477412a3e2b1cb2764fb4357f2284e73952af67` | 2026-10-07T01:54:55Z / 2027-01-05T01:52:49Z | `sha256:e6aa787f2f39059fc1f34ea116acf21385dea713818782ced30f3fb382a4f53f` | 2026-10-07T04:26:18.850327+00:00 |
| 37559263616 / 1 / [11455694127](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559263616/artifacts/11455694127) | `prototype-ci-evidence-4477412a3e2b1cb2764fb4357f2284e73952af67` | 2026-10-07T01:56:53Z / 2027-01-05T01:52:49Z | `sha256:ca157609d14ed79c6d33e0bf7ff70e040a98a6e2f1f65d05072dbe7d1c71c04d` | 2026-10-07T04:26:21.064780+00:00 |
| 37559263616 / 1 / [11455688480](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559263616/artifacts/11455688480) | `ci-change-scope-4477412a3e2b1cb2764fb4357f2284e73952af67-1` | 2026-10-07T01:52:56Z / 2027-01-05T01:52:49Z | `sha256:60ca3923965243ba42e09c6c9170cc3501bb731ecaf86aeb3f07d66202a6a54f` | 2026-10-07T04:26:23.305852+00:00 |
| 37559608396 / 1 / [11456370750](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37559608396/artifacts/11456370750) | `dong-qiu~deep-insight-agent~QPDK2E.dockerbuild` | 2026-10-07T01:59:28Z / 2027-01-05T01:57:10Z | `sha256:eb7f0e44cb574016bd60569ce68f26defe8d561e7eb6fb5d6529f44ec29afaf1` | 2026-10-07T04:26:14.321155+00:00 |
| 37512051645 / 1 / [11435548057](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37512051645/artifacts/11435548057) | `ci-change-scope-a12c5478b433ca7f373216e5553151d66b279966-1` | 2026-10-06T18:32:14Z / 2027-01-04T18:32:06Z | `sha256:5b1084b2b83ebe0981dff0573a29929f78efcd115ae7bc25b035d4bf188da90a` | 2026-10-07T04:26:24.121635+00:00 |
| 37512051645 / 1 / [11434593776](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37512051645/artifacts/11434593776) | `prototype-docker-evidence-33e3e0f64e7254c40faedc64792b21bde557f476` | 2026-10-06T18:35:23Z / 2027-01-04T18:32:06Z | `sha256:c5ee75dfdb25b9d04af5454ae192ce8a049b34db6821fb30e8a355c91186c8cd` | 2026-10-07T04:26:26.309454+00:00 |
| 37512051645 / 1 / [11434474902](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37512051645/artifacts/11434474902) | `prototype-ci-evidence-33e3e0f64e7254c40faedc64792b21bde557f476` | 2026-10-06T18:37:49Z / 2027-01-04T18:32:06Z | `sha256:3d4394ce83a02891d1afe87e6ff6f7c8b2e9c22cac2abe92448f10012897bb97` | 2026-10-07T04:26:28.725960+00:00 |
| 37512051645 / 1 / [11434283683](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37512051645/artifacts/11434283683) | `report-reader-p0c-evidence` | 2026-10-06T18:35:44Z / 2027-01-04T18:32:06Z | `sha256:dd58931de6a22192d5824476df5b416bd19c66dc8a89380918fc0131c55bb560` | 2026-10-07T04:26:31.146025+00:00 |
| 37504892238 / 1 / [11430384607](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37504892238/artifacts/11430384607) | `ci-change-scope-ce1ae08164b5414dc96016592d564398ef8cdc42-1` | 2026-10-06T17:36:54Z / 2027-01-04T17:36:45Z | `sha256:5958f99f1e3c454ba2306d27cd2f44896df2c23b0887f3656a8f33ebca60ec85` | 2026-10-07T04:26:30.791259+00:00 |
| 37506441067 / 1 / [11432406000](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506441067/artifacts/11432406000) | `ci-change-scope-4acfda57fc3b9f3687130a791cce193029fb18af-1` | 2026-10-06T17:49:02Z / 2027-01-04T17:48:53Z | `sha256:084239fdf616c4b8ee55ad242fa64a50b695023243e60ca5c03156a7bdcff21d` | 2026-10-07T04:26:31.902899+00:00 |
| 37506441067 / 1 / [11432077396](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506441067/artifacts/11432077396) | `report-reader-p0c-evidence` | 2026-10-06T17:52:35Z / 2027-01-04T17:48:53Z | `sha256:e5ccb6a8509ec973c11eabdf87b7807ca56637a8bb135fbf49245069d60f9473` | 2026-10-07T04:26:34.365986+00:00 |
| 37506441067 / 1 / [11431593791](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506441067/artifacts/11431593791) | `prototype-ci-evidence-edfc059cc32530df8aa6ed8cae0a351131bc8bfa` | 2026-10-06T17:54:38Z / 2027-01-04T17:48:53Z | `sha256:a4a70d6e47b02cf16d309d004b60fbb62c4cf86c94399368d3e4790dc1f3d756` | 2026-10-07T04:26:36.620633+00:00 |
| 37460791666 / 2 / [11429591269](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37460791666/artifacts/11429591269) | `prototype-docker-evidence-fdbef987d113847100f0e1f01b90136edc294557` | 2026-10-06T16:59:14Z / 2027-01-04T16:56:33Z | `sha256:5fe11b55b7cca79493c273e30dcec855866be0569e4403e42aea4f00b98c3f17` | 2026-10-07T04:26:37.191411+00:00 |
| 37460791666 / 2 / [11429252744](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37460791666/artifacts/11429252744) | `report-reader-p0c-evidence` | 2026-10-06T16:59:49Z / 2027-01-04T16:56:33Z | `sha256:d6e4abf04380499ffdd17b56a7728a168e09b69926267a46c9d5eb250031680f` | 2026-10-07T04:26:39.368263+00:00 |
| 37460791666 / 2 / [11429082968](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37460791666/artifacts/11429082968) | `ci-change-scope-371778b1e8bdf93c840ed5f1ecc95d25eb23442d-2` | 2026-10-06T16:56:42Z / 2027-01-04T16:56:33Z | `sha256:a9111c861fa9dd22700fbd74c33a59df8469c54896b4927e7c90d666fc8fb680` | 2026-10-07T04:26:41.551994+00:00 |
| 37506167287 / 2 / [11432616111](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506167287/artifacts/11432616111) | `report-reader-p0c-evidence` | 2026-10-06T17:53:53Z / 2027-01-04T17:51:24Z | `sha256:2046da44ccef7aeeff0828c0e33aa5d82b3037227ba8201a90a4fd6661d4afb7` | 2026-10-07T04:27:32.301294+00:00 |
| 37506167287 / 2 / [11432386367](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506167287/artifacts/11432386367) | `ci-change-scope-3b73ec657f8857992e580d911884348ca0fd845c-2` | 2026-10-06T17:51:32Z / 2027-01-04T17:51:24Z | `sha256:a32ba3a6dc87629ddd02e7da968e3f2c6e618bec8ebd0c52fae89a7bee33c70c` | 2026-10-07T04:27:34.550329+00:00 |
| 37506167287 / 2 / [11431877789](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506167287/artifacts/11431877789) | `prototype-ci-evidence-be4bd6969c408a3064addd4d6c2cbeb25ec4fe61` | 2026-10-06T17:55:17Z / 2027-01-04T17:51:24Z | `sha256:e9cf058c9c0e744dab2bb2f0185ce2ef35b1a81053d855c4bc7f1cbcf880bbb9` | 2026-10-07T04:27:36.792519+00:00 |
| 37506167287 / 2 / [11431224538](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37506167287/artifacts/11431224538) | `prototype-docker-evidence-be4bd6969c408a3064addd4d6c2cbeb25ec4fe61` | 2026-10-06T17:54:16Z / 2027-01-04T17:51:24Z | `sha256:58804abbc5841cea3064033636c60d1715830ccbbf0eeac159c9faa19649ff67` | 2026-10-07T04:27:39.102676+00:00 |
| 37501620737 / 1 / [11430600679](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737/artifacts/11430600679) | `report-reader-p0c-evidence` | 2026-10-06T17:14:20Z / 2027-01-04T17:11:32Z | `sha256:e77d77e181dd02060a17370e78090273ff9555ecd62a2f0974d4585ea643c980` | 2026-10-07T04:27:27.328703+00:00 |
| 37501620737 / 1 / [11430295739](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737/artifacts/11430295739) | `ci-change-scope-b407b9e61915c33f835966f8f760f3424f0e17f5-1` | 2026-10-06T17:11:44Z / 2027-01-04T17:11:32Z | `sha256:62e9ba05d493bdf3c7b817d9ce01d22188911de5ea973f7b544bfe52ae444c2f` | 2026-10-07T04:27:29.798061+00:00 |
| 37501620737 / 1 / [11429729015](https://github.com/dong-qiu/deep-insight-agent/actions/runs/37501620737/artifacts/11429729015) | `prototype-docker-evidence-b407b9e61915c33f835966f8f760f3424f0e17f5` | 2026-10-06T17:16:09Z / 2027-01-04T17:11:32Z | `sha256:f1a3c0a6a723724775bff1bcefe735ee1b422056077ae24a05fe15135a1fa937` | 2026-10-07T04:27:32.272209+00:00 |

| run / artifact ID | 内部关键文件 | 原文件 SHA-256 | 与 PR 快照核对 |
| --- | --- | --- | --- |
| 37561418156 / 11457445513 | `prototype-docker-evidence.json` | `fb7bb719008286536fcf542641dfceef185c6ac3f0258e01f9cb97dc1d6b1408` | 同 ID 与 hash 一致 |
| 37561418156 / 11456632999 | `prototype-ci-evidence.json` | `b4c2b73b2ad93ed2d8db49dc4a5085417dd00892107801ac9a48de3d38a059d9` | 同 ID 与 hash 一致 |
| 37561418156 / 11456577965 | `report-reader-p0c-evidence.json` | `760d42e79d83dd23b31c2518e34b0057f07eea4f7abf0b8ced201c3d3b7ec99a` | 同 ID 与 hash 一致 |
| 37561418156 / 11456289780 | `ci-change-scope.json` | `488764c6aaa0026dc759609aa86d81feb1e7225ee09004a33553a47a2476c22b` | 同 ID 与 hash 一致 |
| 37562025600 / 11457431901 | `report-reader-p0c-evidence.json` | `327ee78e3fc4de35bb29eca4f8d24ccd80da9bebc71ebacd10499d87dddbb485` | 同 ID 与 hash 一致 |
| 37562025600 / 11457167568 | `ci-change-scope.json` | `a7d0cd28c1e5b3559d539a349f053e396bd191f2a870400bfc462f5331a5b07c` | 同 ID 与 hash 一致 |
| 37562025600 / 11456808678 | `prototype-ci-evidence.json` | `559da0d5c724b7d9514391205030bb95eef2d048880559f8ab82a461c4ab4a00` | 同 ID 与 hash 一致 |
| 37562025600 / 11456688553 | `prototype-docker-evidence.json` | `f0e8535f3c551d81b3fbf64f167e93d912325e72264da11d70d37e9d756d39d3` | 同 ID 与 hash 一致 |
| 37559263616 / 11456450291 | `report-reader-p0c-evidence.json` | `1c2b2b30e85c945240039a8bc542836f167f7e56c6ebd5e22d1f384fecc332ba` | 摘要未逐文件声明 |
| 37559263616 / 11456037626 | `prototype-docker-evidence.json` | `c3795d58582fc69fbc3e3ef993c34c30af450106b0f2a51f785b082061f281e5` | 同 ID 与 hash 一致 |
| 37559263616 / 11455694127 | `prototype-ci-evidence.json` | `6d4e78624cb3e461223295092b8fda321dc38dd8f3eacb65ed44fc8b90a85a54` | 同 ID 与 hash 一致 |
| 37559263616 / 11455688480 | `ci-change-scope.json` | `76508c7f264345162d8aaa95d4ea3f7a931e3eb26c4be13fe720e3859ff53457` | 同 ID 与 hash 一致 |
| 37559608396 / 11456370750 | `blobs/sha256/63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` | `63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `blobs/sha256/7e6c251679697444bd802c09d2eaddecd84516bbc79a28c897258851c076267c` | `7e6c251679697444bd802c09d2eaddecd84516bbc79a28c897258851c076267c` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `blobs/sha256/8253d9a404126fbb61eebee226fa1f8a401892e15e8e28186d9ed235b7e10c9c` | `8253d9a404126fbb61eebee226fa1f8a401892e15e8e28186d9ed235b7e10c9c` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `blobs/sha256/9921ae0efc44fe69e9f86ca39945d18a2d4804b852ddb3308302b6bc1fb8f389` | `9921ae0efc44fe69e9f86ca39945d18a2d4804b852ddb3308302b6bc1fb8f389` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `blobs/sha256/db0886b8270a44a5eede14e2528a533bd81f984223053b0cb6733523b693e03d` | `db0886b8270a44a5eede14e2528a533bd81f984223053b0cb6733523b693e03d` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `blobs/sha256/ee08dc98515f81eea778f7a5b1c2e5106fd85e029ece1c0d9a33cd088bc9b061` | `ee08dc98515f81eea778f7a5b1c2e5106fd85e029ece1c0d9a33cd088bc9b061` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `index.json` | `5cc52d5856b15d6551b9adb6062057df8ed7bcd93c230093b303b934e8944e7b` | 摘要未逐文件声明 |
| 37559608396 / 11456370750 | `oci-layout` | `18f0797eab35a4597c1e9624aa4f15fd91f6254e5538c1e0d193b2a95dd4acc6` | 摘要未逐文件声明 |
| 37512051645 / 11435548057 | `ci-change-scope.json` | `bcc237d11be30195d41a64f39a366e245a90c32285f1dbd48310bc932cc3914e` | 同 ID 与 hash 一致 |
| 37512051645 / 11434593776 | `prototype-docker-evidence.json` | `27109f310d0cee2b3a4c06b444c16f736a08070e40945119bd21ab4d2ba3c876` | 同 ID 与 hash 一致 |
| 37512051645 / 11434474902 | `prototype-ci-evidence.json` | `dbaf723e70522695ee7fa129383a1ada03d68e14e38662c02a9e8d48613cc241` | 同 ID 与 hash 一致 |
| 37512051645 / 11434283683 | `report-reader-p0c-evidence.json` | `7640b44387801182de78a73f60955ee80beea5588fe5f76c9779d4c3a7a887b1` | 摘要未逐文件声明 |
| 37504892238 / 11430384607 | `ci-change-scope.json` | `60f799babd77ad4f4a6a5227b5364a37256a3796f57522e0273153031f6df548` | 摘要未逐文件声明 |
| 37506441067 / 11432406000 | `ci-change-scope.json` | `30855be362f783e9c9308efd1f83e017e7abee0a0424cfeb0f779ccd42da8284` | 摘要未逐文件声明 |
| 37506441067 / 11432077396 | `report-reader-p0c-evidence.json` | `06af221a298d77c7b27560887a542bf10c239341d720acb9af264676a884509f` | 摘要未逐文件声明 |
| 37506441067 / 11431593791 | `prototype-ci-evidence.json` | `064a819ad75925bede656ab12ce4a25cb7b9f43565da25e7310a22e9fa343ebe` | 摘要未逐文件声明 |
| 37460791666 / 11429591269 | `prototype-docker-evidence.json` | `4d70d41e5e19c7270f3c7b4f9636f9b4376f9feb5d48a06e9987ac2972835710` | 同 ID 与 hash 一致 |
| 37460791666 / 11429252744 | `report-reader-p0c-evidence.json` | `cee9c0d2220eb62000638ca65bbe0799f1f8cb3cb86f72f95a8fd5750d0fc3ce` | 同 ID 与 hash 一致 |
| 37460791666 / 11429082968 | `ci-change-scope.json` | `f5735f79013db910a9f8ae2b4ce48240c756bb46d8cec1066356890633f51d67` | 同 ID 与 hash 一致 |
| 37506167287 / 11432616111 | `report-reader-p0c-evidence.json` | `8e3a5c871667bf2a48b739975cd387d488f25b89e89277dad04fb4eb73910ef0` | 同 ID 与 hash 一致 |
| 37506167287 / 11432386367 | `ci-change-scope.json` | `125d4de4bfb57883b61684bc3aaed0867cd6cf725da44f49c3a2225312a1b3b0` | 同 ID 与 hash 一致 |
| 37506167287 / 11431877789 | `prototype-ci-evidence.json` | `1955c48f7a2d7bb98dd590cc25827281ec19a4f853896ec0d30f32bf61769fd3` | 同 ID 与 hash 一致 |
| 37506167287 / 11431224538 | `prototype-docker-evidence.json` | `075713dd867f16fa9fc95125d5cbb4586dc1a655287c36dcc1756454a765e797` | 同 ID 与 hash 一致 |
| 37501620737 / 11430600679 | `report-reader-p0c-evidence.json` | `d15f0a1f3bf9bde01e3e05e80c9caa266c2f624df1466699d37240316fb7975e` | 摘要未逐文件声明 |
| 37501620737 / 11430295739 | `ci-change-scope.json` | `60c7bb5d2435c78c030854cdf6e1acfe53cab4d7b222ba83a8e33755900f7de7` | 摘要未逐文件声明 |
| 37501620737 / 11429729015 | `prototype-docker-evidence.json` | `da6fe117ef23e309627835ca36a14aa3607d489750b9b36912f1410b0e261d02` | 摘要未逐文件声明 |

21 份内部文件 hash 可与 #422/#427 摘要中的既有声明核对一致；其余是本轮增补保存、摘要没有逐项声明的附件，不编造旧摘要已背书。各 artifact 的原元数据（含 expired/digest/workflow_run）在 `<run>/artifacts.json`；下载来源与时间、原包 hash、内部成员 hash、核验结果在 `archive-index-verified.json` 和 `verification.json`。

## 原始来源、日志及元数据定位

读取来源为 GitHub REST `repos/dong-qiu/deep-insight-agent/actions/runs/<run>`、`attempts/<n>`、`attempts/<n>/jobs`、`attempts/<n>/logs`、`actions/artifacts/<ID>/zip`；原 PR 快照来自 `/pulls/422`、`/pulls/427`，comments/reviews 各有独立 API 文件。PR/registry 快照的获取完成UTC及其时间依据另存 `supplemental/acquisition-times.json`，封存原文件未改动。稳定 API/网页链接可以公开，下载重定向临时签名 URL 不入本页。

| 私有相对路径 | SHA-256 |
| --- | --- |
| `37561418156/run.json` | `b68a71f8b9a9bcf46d5d97379c840eb94b8b91d9a677aa650265c0b0094f5d97` |
| `37561418156/artifacts.json` | `7122a67d0afba13c9a412a1a3be63423de5f1018da8624e9f4d6d4fa3c87ff94` |
| `37561418156/attempt-1/run.json` | `a5a2426b3855129424eeaf9bba20656c3b2c0d8ec5462741dace1a693708d65a` |
| `37561418156/attempt-1/jobs.json` | `4568ac27ee7332b9bf1ada5c8014190fb63ead98439bea07bf7b2ce97cbb9005` |
| `37561418156/attempt-1/logs.zip` | `9b6598f5c50cbaecd962902205d396d6c51b8562be428ec76f2436d74181a097` |
| `37562025600/run.json` | `d9e11f3ad13b6730251d3293b4c9d25f87b8bb97648bb3f4d8f99438bb4fd484` |
| `37562025600/artifacts.json` | `46bf458ea8f408ce9224a6cbe48bedf5c30fc49404814514b43ada4c8f745c54` |
| `37562025600/attempt-1/run.json` | `eebdbcef6b117e7e85a0e927dd59c259606f616c173181e28a443dabc7299c74` |
| `37562025600/attempt-1/jobs.json` | `21cca276707b11ccde324a47378dd54e94a71aac5d0807c15c7f44f96f247854` |
| `37562025600/attempt-1/logs.zip` | `afbb58fff3d01645f774860008f3dd97ef2041571196dd4603b0ec80eca91c3b` |
| `37559263616/run.json` | `8aec12e2ec18061ed0f99fd77cf5de64e3862cf04caff03fd71b95f2d4bdc2a6` |
| `37559263616/artifacts.json` | `df72cc14d76521488f950fe7a63af201e79e8b926072908bed31d4683c223795` |
| `37559263616/attempt-1/run.json` | `e590908667ede2bfd8c6f46e510fa993b62239c8331867c487cd596f5198f4f6` |
| `37559263616/attempt-1/jobs.json` | `cff017e0ac1ed8af0ea74a043e6ee4de5e178426a582b74dd3309f23b7f94f51` |
| `37559263616/attempt-1/logs.zip` | `6570e5f9354c84600f65600e6449e33bc54d7bc4b39f0564c7c672ccd54f5374` |
| `37559608396/run.json` | `8ffea746239526e9f8e7b52cfe0099242ec3d1ffbb3e27cdd06ad08594b0e9d0` |
| `37559608396/artifacts.json` | `b2ec65a9e6a3a65981254b721dbcf016163625bc4817f6ead2d0dac754fd889c` |
| `37559608396/attempt-1/run.json` | `48e86cf1468eb53cffbe2b907f64162432bd226829e3238df147e36ffecdc82a` |
| `37559608396/attempt-1/jobs.json` | `76b062aa0a053134c55924e647dae4a9e58ca2d6ee03722d43005793c46043c0` |
| `37559608396/attempt-1/logs.zip` | `4e2736a03e4aaa268438ecc951d559c7091d07c04f2c3e68f35f114e3fb98a93` |
| `37512051645/run.json` | `0eea3c977fad509ef7ec14e9c434267692e917232508d2278e8e84a3d1a65630` |
| `37512051645/artifacts.json` | `f3a6fa8c803851e5815d8409c007da49cbc4d6b6fb4f829dd637194ca11a6c1c` |
| `37512051645/attempt-1/run.json` | `f7a8f0840ca7f6853d01bf254d9605cae066020366df8c507bf720cf616cf575` |
| `37512051645/attempt-1/jobs.json` | `a27d9d1ef58f126dc2bbcaebe6ca85d5204ecc8e02a511c2c0f40045785a7122` |
| `37512051645/attempt-1/logs.zip` | `d0059e54e269233e23a056a6ac8489bab911434ed649cc21c8d51ae8afb38ee7` |
| `37504892238/run.json` | `1417996ef015ebb7c56d0f71fc84a4910d24d503f2f53f6254e51ce1b77cf55f` |
| `37504892238/artifacts.json` | `c8ae46b8c24b6a5c0f473669ea365aafc0b41b4441d2761aafb09aaa4ee32aa8` |
| `37504892238/attempt-1/run.json` | `c4163116cf55329225a1d5bb0457568c729fc6f17b7b394477faa18a902ab374` |
| `37504892238/attempt-1/jobs.json` | `e62f3874cfc47d323b5aacd271c1308b5a920d3251c5482f5baf32bde41759b6` |
| `37504892238/attempt-1/logs.zip` | `1ef25246efc5955ed58b4dc2d7f46322d2b234a6c403c80c7bf5ae89826e3fa8` |
| `37506441067/run.json` | `c196085ce57f1a6cd6775b5bedcad17d71e9171b899285e26c50b5cab2d443cf` |
| `37506441067/artifacts.json` | `c890e9a10512fda7e049586f70a6d52ad0189f3f01927282ce5a41d61e797dc7` |
| `37506441067/attempt-1/run.json` | `c23979e72f7225be0278f1db3ba84c115fa8373c257ac2d6c951bd675471d674` |
| `37506441067/attempt-1/jobs.json` | `5dc748e2dbafb76d021b3c3a654d43509546157f0e731571debf1d6b99c2d5af` |
| `37506441067/attempt-1/logs.zip` | `3c8d4e4a69a28b2bee162cb4127949211397ea408fd7640a99bfed61c773d649` |
| `37460791666/run.json` | `e59562a548649d106e006e573df5c518a0c4c1ef31d3c9b780ee910ff65e6356` |
| `37460791666/artifacts.json` | `1f8a3999e8f27391d4937c4370efb01a366b0dcdcfde26f7aafafd385aca9d51` |
| `37460791666/attempt-1/run.json` | `f3da2082e8d7cf54af213f37a5325c2f4ab3d4e818b134d8354c38a81f92a22d` |
| `37460791666/attempt-1/jobs.json` | `c32216c5ed552c08984aa86ac626593fa80a0834138c2bcad5cbae9f8319778c` |
| `37460791666/attempt-1/logs.zip` | `cef96b92add2f53b6a160e8454def079bf6ae3d47b49fedd99cf027bfe8e029d` |
| `37460791666/attempt-2/run.json` | `0e147e32c573513c1ffe1f2d6e13d4bf07fa0b33ef52489f44cd2ff8ca8aac04` |
| `37460791666/attempt-2/jobs.json` | `3d11fb74dc60d44d30c1fc0b0247d0af8319c11eff99fb2e61d869ad3d665243` |
| `37460791666/attempt-2/logs.zip` | `5ef87a9925a2eacd0c7d490809331ce54373bfff615ee76627b2be9d85975665` |
| `37506167287/run.json` | `d5fcf14783def121ab67cd8989aa71af46fe12184c2ece2806645d2180d2b351` |
| `37506167287/artifacts.json` | `95fd4e8db50b8b4074d98d86f02bf3b55843763bcdea510abdc8953ff7d9cacd` |
| `37506167287/attempt-1/run.json` | `44594b8de3d5feff5d409e3ac0e04cab1b5c2258bb4e2cfeace10d630d298be1` |
| `37506167287/attempt-1/jobs.json` | `c2e4e230bf5fc0568c2bd042f90164b3a52782469d86f1b344582ede4e9e8e6c` |
| `37506167287/attempt-1/logs.zip` | `ebe8ff5c6a5a721d4d46282118a29d194ea29361e7a731800f844adbaee173f8` |
| `37506167287/attempt-2/run.json` | `98c6a1241444da9abdf19fa46c4c9764fbaa25f4de4ef1f73cb6a4b1a099b80b` |
| `37506167287/attempt-2/jobs.json` | `fdaf90fd424dc96f518d1140eb64bbaaf37ce915ab70d7ceaa8607907c2c6c5f` |
| `37506167287/attempt-2/logs.zip` | `8eb1789e171be69b66ee724805971502959f7b4186f2e0893371a6f411e6bc0f` |
| `37501620737/run.json` | `6ef6e9b18d1a92e2c617f94e88bd3fe0c668a705c9b69b3b32150bd90b4ffaea` |
| `37501620737/artifacts.json` | `4764a0b8d7aeaea3b9527817472041aaecc0fb4116c25e0aebcfc79dff9a9c3b` |
| `37501620737/attempt-1/run.json` | `01ad052ebdeb1975357618e1a6f9f7ee96f11bbc33e70c92065459c8d3104267` |
| `37501620737/attempt-1/jobs.json` | `1953d063fd888d978ae298cb49feda5fdd839303bbdb6b7cba62441c38012bfe` |
| `37501620737/attempt-1/logs.zip` | `5d4a2ba54fbd94fcefc20b61a9c037b9f48ea2f214aaa673620dc8995b745833` |

日志 ZIP 内部每个文件 hash 同时在私有封存扩展清单 `log-members.json` 中定位；API 没有为日志包提供 artifact digest，日志下载包 SHA-256 只证明本轮保存的字节。原 artifact 的 digest/JSON hash 另按上表核，不以日志摘要替代原产物。

| 原交付 / registry 快照路径 | SHA-256 |
| --- | --- |
| `pr-422-comments.json` | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| `pr-422-reviews.json` | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| `pr-422.json` | `2759cf874162ab2214e6c308aa800e030e2279a1b2466fa2d1277b12bc61cac2` |
| `pr-427-comments.json` | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| `pr-427-reviews.json` | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| `pr-427.json` | `6b8cfad67b6f98c5a098011b4452b20bfe34c0802958aefea1037cb76c32ad70` |
| `registry/headers.json` | `8a9cccbedb6cd3dd4d6cd990327c9d4139448458a80e0e66a9e8f3f60e7b2883` |
| `registry/linux-amd64-config.json` | `d86150f47c0da31e3515e4848b2ed6aa346bfdc825ad718bef6a934370534749` |
| `registry/linux-amd64-manifest.json` | `e3eb029114229218cd6ed305d91a488c5b998577f37bd85402e1af09e302012c` |
| `registry/manifest.json` | `63b1735b7b8a89a6fd7d602bd6fceb1cc6eef3251543d20e4096fa8a0e1e4fbe` |

PR 原摘要中的独立 reviewer 结论已保存且与最终身份对应；本轮查询 comments/reviews 没有另外提供该 AI 会话完整 transcript，不能把交付摘要当作独立审查全文。当前 C 任务另做独立 review，见 [C 收据](c-evidence-readiness-receipt-2026-10-07.md)。

GHCR 原始 OCI index、amd64 manifest、config 与 digest/revision 关系见 [上线准备清单](c-security-release-readiness-2026-10-07.md#候选冻结与证据边界)。registry 只读获取不涉及生产；没有下载全部镜像层或在该发布 digest 上重跑原生测试。

## 缺口与历史失败保持

D6 原 attempt 1 上传日志指向的以下 7 个 ID，当前 API 逐项 HTTP 404；包括 5 个关键证据包和 2 个附属 Docker build record。现有 artifact 列表只有后续 attempt 的同名原包；后续原包不能替代这些历史文件。原因与重跑覆盖相符，但 API 404 本身不证明具体删除机制。原包本轮不可恢复，不能提供原内部字节/hash或 API expires_at/digest；日志中的 hash 只是当时上传声明。没有重跑 workflow。

| run / attempt | 缺失 artifact ID / 当时用途 | 当前替代证据及限制 |
| --- | --- | --- |
| 37460791666 / 1 | 11411253208 Docker；11411592700 scope；11413097148 reader；11411488210 dockerbuild | 原 attempt jobs/logs 已保存；browser 6/7（预期4节点收到2）；不能恢复缺失原 JSON |
| 37506167287 / 1 | 11432630140 scope；11432235893 Docker；11431911328 dockerbuild | 原 attempt jobs/logs 已保存；D3 801-ID coverage 超时，reader/build/browser/audit 后序未执行，未生成的 app/reader 不能标为丢失 |

逐项 404 原响应、稳定来源、查询 UTC 在 `historical-artifact-availability.json`。37460791666 attempt 2 的 browser 7/7 后 sharp audit 失败保持 failure；37506167287 attempt 2 success 不抹掉 attempt 1，也不证明首次根因修复。#427 两次失败分别是 Linux路径断言和 Docker rsvg 清单缺失，#423 main 是 sharp audit 阻塞；从来没有成功上传的结果证明不由后续成功补造。

D6 最终产物分别到期于 2027-01-05T02:19:19Z 与 02:26:57Z；#427 候选、main、发布及历史产物按上表各自 expires_at 为准，不统一套日期。公共链接可能提前失效，只有已保存原字节才算归档。

TD-19 原始20项审计全文来源仍缺失；D7 后续交付重核条件与 P1 dormant 保留。生产运行源码/镜像/实际库/不可信输入路径、安全回退、数据前置及值守负责人尚未核验，不宣称本次修复已上线。
