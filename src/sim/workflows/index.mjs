// Registry of sample workflows and simulated capture sources. User-created workflows live in the database, not here.
import payments from "./payments.mjs";
import weaving from "./weaving.mjs";
import analytics from "./analytics.mjs";
import kitchen from "./kitchen.mjs";

/** Agamya for Work samples: the three technical workflows (also used by the acceptance tests). */
export const DEMO_WORKFLOWS = [payments, weaving, analytics];
/** Agamya for Living Knowledge sample: the featured mother-and-daughter journey. */
export const LIVING_WORKFLOWS = [kitchen];
const ALL = [...DEMO_WORKFLOWS, ...LIVING_WORKFLOWS];

/** Simulated capture sources, selectable by any workflow (including user-created ones). */
export const SIM_SOURCES = Object.fromEntries(ALL.map((d) => [d.environment.id, d.environment]));

export const CURATED_SCENARIOS = ALL.flatMap((d) => d.scenarios.map((s) => ({ ...s, workflowId: d.workflow.id, source: "curated" })));

export function simSource(id) {
  return SIM_SOURCES[id] ?? null;
}
