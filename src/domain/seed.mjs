// Seeding. Platform policy templates always; the shared demo organization only when DEMO_SEED is on (never in
// production by default); per-visitor sample spaces on request when SAMPLE_SPACES is on.
// Sample people are REAL accounts with REAL roles inside an isolated space; they have no password and can only be
// entered through the sample flow. Curated tests are labelled SYNTHETIC (designer-authored), never human-validated.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";
import { DEMO_WORKFLOWS, LIVING_WORKFLOWS } from "../sim/workflows/index.mjs";
import { defaultOrgSettings, founderRoles } from "./identity.mjs";
import { newToken, hashPassword } from "../platform/security.mjs";

export const DEMO_PASSWORD = () => process.env.DEMO_PASSWORD || "agamya-demo-2026";
export const DEMO_ORG_SLUG = "northwind-demo";

const first = (name) => name.split(" ")[0].toLowerCase();
const personaEmail = (name) => `${first(name)}@demo.local`;

/** Shared demo organization used by scripts and tests (password sign-in, DEMO_SEED / DEMO_LOGIN). */
export async function seedDemo({ db, identity, cfg, log }) {
  const [existing] = await db.system((q) => q("SELECT id FROM organizations WHERE slug = $1", [DEMO_ORG_SLUG]));
  if (existing) return existing.id;
  const orgId = await createOrg(db, { name: "Northwind Operations (demo)", slug: DEMO_ORG_SLUG, settings: defaultOrgSettings(cfg), experience: "work" });
  const pw = DEMO_PASSWORD();
  const people = new Map();
  const add = async (name, title, roles) => {
    const email = personaEmail(name);
    if (!people.has(email)) people.set(email, await identity.createUserWithMembership({ email, displayName: name, password: pw, orgId, roles, title }));
    return people.get(email);
  };
  const owner = await add("Alex Morgan", "Head of Operations", ["ORG_OWNER", "ORG_ADMIN", "KT_COORDINATOR", "WORKFLOW_OWNER", "REVIEWER"]);
  await add("Rae Kim", "Quality reviewer", ["REVIEWER"]);
  for (const d of DEMO_WORKFLOWS) {
    for (const e of d.workflow.experts) await add(e.name, e.role, ["EXPERT"]);
    for (const l of d.workflow.learners) await add(l.name, l.role, ["LEARNER"]);
  }
  await loadWorkflows({ db, orgId, owner, personOf: (name) => people.get(personaEmail(name)), workflows: DEMO_WORKFLOWS });
  log?.info({ orgId }, "demo organization seeded");
  return orgId;
}

async function createOrg(db, { name, slug, settings, experience, sampleKind = null }) {
  return db.system(async (q) => {
    const [o] = await q("INSERT INTO organizations (name, slug, settings, is_demo, experience, sample_kind) VALUES ($1,$2,$3,true,$4,$5) RETURNING id", [name, slug, JSON.stringify(settings), experience, sampleKind]);
    await q("INSERT INTO workspaces (org_id, name) VALUES ($1, $2)", [o.id, experience === "living" ? "Our kitchen" : "Operations"]);
    return o.id;
  });
}

export const SAMPLE_BUDGET_USD = () => Number(process.env.SAMPLE_AI_BUDGET_USD || 2);

/**
 * A fresh, isolated sample space for one visitor: the featured Living Knowledge journey (Lakshmi teaches Meera) or the
 * Work sample (three workflows and one scheduled knowledge transfer). Returns the lead person to sign in as.
 */
export async function createSampleSpace({ db, identity, cfg, kind }) {
  const tag = newToken().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  const living = kind === "living";
  const settings = { ...defaultOrgSettings(cfg), aiMonthlyBudgetUsd: SAMPLE_BUDGET_USD() };
  const orgId = await createOrg(db, { name: living ? "Lakshmi's kitchen (sample)" : "Northwind Operations (sample)", slug: `sample-${kind}-${tag}`, settings, experience: living ? "living" : "work", sampleKind: kind });
  const people = new Map();
  const add = async (name, title, roles) => {
    if (!people.has(name)) people.set(name, await identity.createUserWithMembership({ email: `${first(name)}.${tag}@sample.agamya.invalid`, displayName: name, password: null, orgId, roles, title }));
    return people.get(name);
  };
  let lead;
  if (living) {
    const k = LIVING_WORKFLOWS[0].workflow;
    lead = await add(k.experts[0].name, k.experts[0].role, ["ORG_OWNER", "ORG_ADMIN", "WORKFLOW_OWNER", "EXPERT"]);
    await add(k.learners[0].name, k.learners[0].role, ["LEARNER"]);
    await loadWorkflows({ db, orgId, owner: lead, personOf: (n) => people.get(n), workflows: LIVING_WORKFLOWS, ownerLearns: false });
  } else {
    lead = await add("Alex Morgan", "Head of Operations", ["ORG_OWNER", "ORG_ADMIN", "KT_COORDINATOR", "WORKFLOW_OWNER", "REVIEWER"]);
    for (const d of DEMO_WORKFLOWS) {
      for (const e of d.workflow.experts) await add(e.name, e.role, ["EXPERT"]);
      for (const l of d.workflow.learners) await add(l.name, l.role, ["LEARNER"]);
    }
    const ids = await loadWorkflows({ db, orgId, owner: lead, personOf: (n) => people.get(n), workflows: DEMO_WORKFLOWS });
    // One scheduled knowledge transfer, as a manager would arrange it.
    const tomorrow = new Date(Date.now() + 86400000); tomorrow.setUTCHours(10, 0, 0, 0);
    await db.tenant({ orgId, userId: lead.userId }, (q) => q(`INSERT INTO transfers (org_id, workflow_id, expert_person_id, learner_person_id, scheduled_for, purpose, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, ids.payments, people.get("Dana Reyes").personId, people.get("Jordan Park").personId, tomorrow,
        "Dana retires next quarter. Capture how she handles month-end payment exceptions the runbook gets wrong, so Jordan can handle them alone.", lead.userId]));
    // A receiver group, as a coordinator would set one up (application-level group; no directory sync).
    await db.tenant({ orgId, userId: lead.userId }, async (q) => {
      const [g] = await q("INSERT INTO groups (org_id, name, description, created_by_person_id) VALUES ($1,'Operations-New-Joiners','People joining operations this quarter',$2) RETURNING id", [orgId, lead.personId]);
      for (const n of ["Jordan Park", "Lee Chen", "Max Romero"]) if (people.get(n)) await q("INSERT INTO group_members (group_id, org_id, person_id, added_by) VALUES ($1,$2,$3,$4)", [g.id, orgId, people.get(n).personId, lead.userId]);
    });
  }
  return { orgId, leadUserId: lead.userId };
}

async function loadWorkflows({ db, orgId, owner, personOf, workflows, ownerLearns = true }) {
  const ids = {};
  await db.tenant({ orgId }, async (q) => {
    const [ws] = await q("SELECT id FROM workspaces WHERE org_id = $1 LIMIT 1", [orgId]);
    for (const d of workflows) {
      const w = d.workflow;
      const key = w.id.replace(/^wf-/, "");
      const [row] = await q(`INSERT INTO workflows (org_id, workspace_id, key, name, description, kind, modalities, capture_sources, owner_user_id, source, status, profile)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'demo','active',$10) RETURNING id`,
        [orgId, ws.id, key, w.name, w.description, w.kind, JSON.stringify(w.modalities), w.captureSources, owner.userId,
          JSON.stringify({ domainSummary: w.description, source: "curated", decisionPoints: [], likelyTacitAreas: [], riskAreas: [], vocabulary: [] })]);
      ids[key] = row.id;
      const docIds = {};
      for (const doc of w.documents) {
        const [dd] = await q(`INSERT INTO workflow_documents (org_id, workflow_id, title, mime_type, text_content, sha256) VALUES ($1,$2,$3,'text/plain',$4,md5($4)) RETURNING id`, [orgId, row.id, doc.title, doc.text]);
        docIds[doc.id] = dd.id;
      }
      for (const p of w.procedures) {
        await q(`INSERT INTO workflow_procedures (org_id, workflow_id, document_id, key, title, applies_when, steps, default_decision, resolution_actions, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'curated')`, [orgId, row.id, docIds[p.docId] ?? null, p.id, p.title, p.appliesWhen, JSON.stringify(p.steps), p.defaultDecision, p.resolutionActions ?? []]);
      }
      for (const e of w.experts) await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,'EXPERT') ON CONFLICT DO NOTHING", [orgId, row.id, personOf(e.name).personId]);
      for (const l of w.learners) await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,'LEARNER') ON CONFLICT DO NOTHING", [orgId, row.id, personOf(l.name).personId]);
      // The owner can also try lessons in a workplace demo (not an expert).
      if (ownerLearns) await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,'LEARNER') ON CONFLICT DO NOTHING", [orgId, row.id, owner.personId]);
      // Curated tests: written by the test designer independently of the model → ground truth SYNTHETIC (not human-validated on real work).
      for (const s of d.scenarios) {
        await q(`INSERT INTO scenarios (org_id, workflow_id, case_ref, curated_key, kind, title, facts, narrative, options, answer_key, rule_action, visual, source, ground_truth_source, criteria)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'curated','SYNTHETIC',$13)`,
          [orgId, row.id, s.sourceCase, s.id, s.kind, s.title, JSON.stringify(s.facts), s.narrative, JSON.stringify(s.options), s.answerKey, s.ruleAction ?? null,
            JSON.stringify(s.render === "loom" || s.render === "stove" ? { render: s.render, state: s.state } : s.render === "sheet" ? { render: "sheet", view: s.view } : { render: s.render }), JSON.stringify(s.criteria ?? [])]);
      }
    }
  });
  return ids;
}

/** Import the latest benchmark file (if newer than what is stored) as a platform-level record with its ground-truth source. */
export async function seedBenchmark(db) {
  const f = path.join(ROOT, "data", "benchmark.json");
  if (!fs.existsSync(f)) return;
  const b = JSON.parse(fs.readFileSync(f, "utf8"));
  const [has] = await db.system((q) => q("SELECT 1 FROM benchmark_runs WHERE created_at = $1", [b.at]));
  if (has) return;
  const notes = b.engine === "v3"
    ? `${b.summary[0]?.sessions ?? 7} scripted expert sessions × ${b.summary.length} context policies on the v3 engine. "Should the AI ask?" ground truth = designer labels on scripted cases (SYNTHETIC). Question quality = Gemini-as-judge (MODEL_DERIVED). Single run; expect run-to-run variation.`
    : "v2 engine. 7 scripted expert sessions across 3 demo workflows. Ground truth SYNTHETIC; question quality MODEL_DERIVED. Single run; run-to-run variation observed (71–77% reduction).";
  await db.system((q) => q(`INSERT INTO benchmark_runs (org_id, model, ground_truth_source, summary, rows, notes, created_at) VALUES (NULL,$1,'SYNTHETIC',$2,$3,$4,$5)`,
    [b.model, JSON.stringify(b.summary), JSON.stringify(b.rows), notes, b.at]));
}

/**
 * Judge accounts (JUDGE_ACCOUNTS=1): idempotent on every start. The password is reset to the configured public one,
 * so a judge can never lock others out by changing it. Each account owns one real, empty space of its kind and can
 * capture, confirm and practise (expert + learner roles).
 */
export async function ensureJudgeAccounts({ db, identity, cfg, log }) {
  if (!cfg.judges?.enabled) return;
  const hash = await hashPassword(cfg.judges.password);
  for (const a of cfg.judges.accounts) {
    const slug = `judges-${a.key}`;
    let [org] = await db.system((q) => q("SELECT id FROM organizations WHERE slug = $1", [slug]));
    if (!org) org = await db.system(async (q) => {
      const [o] = await q("INSERT INTO organizations (name, slug, settings, experience) VALUES ($1,$2,$3,$4) RETURNING id", [a.orgName, slug, JSON.stringify(defaultOrgSettings(cfg)), a.experience]);
      await q("INSERT INTO workspaces (org_id, name) VALUES ($1,'Default')", [o.id]);
      return o;
    });
    const roles = [...new Set([...founderRoles(a.experience), "EXPERT", "LEARNER", "KT_COORDINATOR", "REVIEWER"])];
    await identity.createUserWithMembership({ email: a.email, displayName: a.displayName, password: cfg.judges.password, orgId: org.id, roles });
    await db.system((q) => q("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, status = 'active' WHERE lower(email) = lower($1)", [a.email, hash]));
  }
  log?.info({ accounts: cfg.judges.accounts.map((a) => a.email) }, "judge accounts ready");
}
