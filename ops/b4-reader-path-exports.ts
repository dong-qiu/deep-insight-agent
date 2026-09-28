/** B4 static-snapshot preflight entry: bundle these exact production reader functions for
 * same-snapshot baseline/new comparison without starting Next.js or opening a live DB. */
export { buildTopicGraphData, insightsMentioningEntity, insightsCooccurring, reportLinksByInsight, groupDrillInsights } from "../src/lib/db/graph.js";
export { listTechLeads, getTechLead, listTechLeadEvidence } from "../src/lib/db/tech-leads.js";
export { listTechnologyOpportunities, getTechnologyOpportunity, listOpportunityLeads, listTopicDirections } from "../src/lib/db/planning.js";
export { listTopics } from "../src/lib/db/repos.js";
