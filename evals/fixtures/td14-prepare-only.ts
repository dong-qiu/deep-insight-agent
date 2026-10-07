/** Read-only preparation sentinel. Never delegate any HTTP transport. */
if (process.env.A1_DIAGNOSTIC_PREPARE_ONLY !== "1") throw new Error("prepare_only_required");
globalThis.fetch = async () => { throw new Error("prepare_only_transport_forbidden"); };
