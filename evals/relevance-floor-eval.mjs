/** (1c) 相关性硬下限离线 eval —— ADR-0010「沾边离题阈值」的数据验证。
 *
 *  目的：在真实样本上量化「当前评分(floor=1) vs 双语关键词 / 提高 floor」对
 *  「区分 on-topic(AI 产业动态) vs off-topic(OpenAI 垂直应用/客户故事/研究)」的 precision/recall，
 *  把 ADR 写的 lexical 阈值假设从「拍脑袋」变成「测量」。
 *
 *  数据来源：2026-06-23 从生产 t_ai_industry 近 30 天候选拉取 45 条（openai_news 源），
 *  分数 sc(当前中文+实体词表) / sb(加 26 个英文产业事件词) / tc(标题命中数) 均由生产**全文**计算
 *  （见 originSession 的 SSM export.js）。label 为人工标注。
 *
 *  标注口径（对应用户「openai_news 离题、0 被引」的真实痛点）：
 *   - on  = AI 产业/市场结构事件：并购/IPO/融资、政策/监管/治理、基建/数据中心、模型或产品发布、平台可用性、战略合作。
 *   - off = 垂直领域应用故事(health/chem/biodefense/astro/lifesci/edu) + 单个客户案例 + 纯研究/benchmark/安全方法 + CSR。
 *  （客户/采用类故事归 off：它们正是低价值重复 PR，0 被引的来源。换宽口径见文末敏感性说明。）
 *
 *  跑：node evals/relevance-floor-eval.mjs
 */

// id, t=标题(截断), sc=当前分, sb=双语分, tc=标题命中, label
const DATA = [
  ["ci_4a975b","Samsung brings ChatGPT and Codex to employees",3,3,2,"on"],
  ["ci_450d5c","New usage analytics and spend controls for enterprises",3,3,0,"on"],
  ["ci_9f4dbd","Improving health intelligence in ChatGPT",2,3,2,"on"],
  ["ci_edcd24","Using AI to help physicians diagnose rare genetic diseases",1,1,0,"off"],
  ["ci_5ff2f7","A near-autonomous AI chemist improves medicinal chemistry",2,2,0,"off"],
  ["ci_381e7f","Introducing LifeSciBench",0,0,0,"off"],
  ["ci_c00001","Predicting model behavior before release (deployment sim)",1,2,0,"off"],
  ["ci_4a1a2e","Introducing the OpenAI Partner Network",1,1,1,"on"],
  ["ci_dd7313","New OpenAI Academy courses",1,1,1,"off"],
  ["ci_ddc7b2","How Preply combines AI and human tutors",1,1,0,"off"],
  ["ci_009f70","OpenAI to acquire Ona",1,3,1,"on"],
  ["ci_043e5a","BBVA puts AI at the core of banking with OpenAI",3,3,1,"off"],
  ["ci_d38f7a","Supporting Europe's trustworthy AI ecosystem",1,1,0,"on"],
  ["ci_0fda1a","How an astrophysicist uses Codex to simulate black holes",0,0,0,"off"],
  ["ci_c17e71","Access OpenAI models and Codex through Oracle cloud",1,3,1,"on"],
  ["ci_278708","PRC-linked influence operations targeting AI debates",3,3,0,"off"],
  ["ci_c7866b","From data to decisions: how LSEG is scaling trusted AI",1,1,0,"off"],
  ["ci_5b802c","How engineers at Nextdoor use Codex",1,1,0,"off"],
  ["ci_98916a","Confidential submission of draft S-1 to the SEC",1,2,0,"on"],
  ["ci_da51b3","Built to benefit everyone: our plan",1,1,0,"on"],
  ["ci_1ce2aa","OpenAI Economic Research Exchange",1,1,1,"off"],
  ["ci_2e1f29","How Endava is redesigning software delivery",2,2,0,"off"],
  ["ci_c3ab33","Dreaming: Better memory for a more helpful ChatGPT",2,2,2,"on"],
  ["ci_32a436","Biodefense in the Intelligence Age",0,0,0,"off"],
  ["ci_ba5622","Introducing new capabilities to GPT-Rosalind",1,1,1,"off"],
  ["ci_032a72","How Wasmer used Codex to build a Node.js runtime",1,1,0,"off"],
  ["ci_df48d0","A blueprint for democratic governance of frontier AI",1,3,0,"on"],
  ["ci_b90e07","OpenAI public policy agenda",1,1,1,"on"],
  ["ci_079b6e","Travelers deploys AI-powered claims with OpenAI",1,2,1,"off"],
  ["ci_b040c6","Codex for every role, tool, and workflow",0,0,0,"on"],
  ["ci_f4e042","Advancing youth safety and opportunity",1,1,0,"off"],
  ["ci_473ece","Codex is becoming a productivity tool for everyone",0,0,0,"on"],
  ["ci_4ef2b0","Our views on AI policy and political advocacy",0,1,0,"on"],
  ["ci_04c1d2","Building the infrastructure for the Intelligence Age in Michigan",1,1,0,"on"],
  ["ci_4df8e5","OpenAI frontier models and Codex now available on AWS",1,2,1,"on"],
  ["ci_e62972","Boston Children's uses AI to unlock new diagnoses",1,1,0,"off"],
  ["ci_880638","How Braintrust turns customer requests into code",1,1,0,"off"],
  ["ci_1c9b44","Strengthening societal resilience with Rosalind Biodefense",2,2,0,"off"],
  ["ci_2aa7e7","How Endava builds an agentic organization with Codex",0,0,0,"off"],
  ["ci_ac3d09","OpenAI's Frontier Governance Framework",1,4,1,"on"],
  ["ci_b7195b","MUFG aims to become AI-native with OpenAI",3,3,1,"off"],
  ["ci_c7affa","Building self-improving tax agents with Codex",1,2,0,"off"],
  ["ci_ddd246","Warp's big bet on building open source with GPT-5.5",2,2,1,"off"],
  ["ci_635db8","Election information and safeguards in 2026",0,0,0,"off"],
  ["ci_e60fa7","OpenAI, Grupo Folha and Grupo UOL strategic content partnership",3,3,1,"on"],
];

const ON = DATA.filter((d) => d[5] === "on").length;
const OFF = DATA.length - ON;

/** keepFn(item)->bool；按 label=on 为「应保留」算 precision/recall/F1。 */
function evalVariant(name, keep) {
  let keptOn = 0, keptOff = 0, droppedOn = 0;
  for (const d of DATA) {
    const isOn = d[5] === "on";
    if (keep(d)) { isOn ? keptOn++ : keptOff++; } else if (isOn) droppedOn++;
  }
  const kept = keptOn + keptOff;
  const precision = kept ? keptOn / kept : 0;
  const recall = ON ? keptOn / ON : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { name, kept, keptOn, keptOff, droppedOn, precision, recall, f1 };
}

const variants = [
  evalVariant("当前  floor=1 (sc>=1)", (d) => d[2] >= 1),
  evalVariant("当前  floor=2 (sc>=2)", (d) => d[2] >= 2),
  evalVariant("双语  floor=1 (sb>=1)", (d) => d[3] >= 1),
  evalVariant("双语  floor=2 (sb>=2)", (d) => d[3] >= 2),
  evalVariant("双语  floor=3 (sb>=3)", (d) => d[3] >= 3),
  evalVariant("titleHit>=1 OR sc>=2", (d) => d[4] >= 1 || d[2] >= 2),
];

const pct = (x) => (x * 100).toFixed(1).padStart(5);
console.log(`样本 N=${DATA.length}  on=${ON}  off=${OFF}  (源=openai_news, t_ai_industry, 30d, 2026-06-23)\n`);
console.log("变体                       kept  keptOn keptOff dropOn   P%     R%    F1%");
console.log("─".repeat(78));
for (const v of variants) {
  console.log(
    `${v.name.padEnd(26)} ${String(v.kept).padStart(4)} ${String(v.keptOn).padStart(6)} ${String(v.keptOff).padStart(6)} ${String(v.droppedOn).padStart(6)}  ${pct(v.precision)} ${pct(v.recall)} ${pct(v.f1)}`,
  );
}
console.log("─".repeat(78));
console.log("注：keptOff=放进分析的离题数(噪声)；dropOn=被误杀的真产业新闻。");
