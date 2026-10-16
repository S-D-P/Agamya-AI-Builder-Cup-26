// Impact: what Agamya actually did in this space, measured from its own records. No estimates, no projections, no
// scores. Each number names where it comes from; anything without enough records says so instead of guessing.
import { requirePermission } from "../platform/authz.mjs";

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function createImpact({ db }) {
  async function report(ctx) {
    requirePermission(ctx, "workflow.read");
    return db.tenant(ctx, async (q) => {
      // Capture: live sessions (not terminated), minutes of expert time, Moti's questions and the answers given.
      const sess = await q(`SELECT s.id, s.language, s.started_at, s.ended_at, s.status FROM expert_sessions s WHERE s.mode = 'live' AND s.status <> 'terminated'`);
      const minutes = sess.filter((s) => s.ended_at).map((s) => Math.min(180, Math.max(0, (new Date(s.ended_at) - new Date(s.started_at)) / 60000)));
      const totalMin = minutes.reduce((a, b) => a + b, 0);
      const [dlg] = await q(`SELECT count(*) FILTER (WHERE d.intent = 'live')::int AS asked, count(*) FILTER (WHERE d.intent = 'live' AND d.answer IS NOT NULL)::int AS answered,
                                    count(*) FILTER (WHERE d.intent = 'debrief')::int AS debrief
                             FROM session_dialogue d JOIN expert_sessions s ON s.id = d.session_id WHERE s.mode = 'live' AND s.status <> 'terminated'`);

      // Work Maps: confirmed vs draft, what they contain, how much is in the expert's own words.
      const maps = await q(`SELECT w.status, w.version, w.map, w.confirmed_at, s.started_at FROM work_maps w JOIN expert_sessions s ON s.id = w.session_id WHERE w.status <> 'withdrawn'`);
      const confirmed = maps.filter((m) => m.status === "confirmed");
      let steps = 0, judgment = 0, guardrails = 0, quoted = 0, quotable = 0;
      for (const m of confirmed) for (const s of m.map.steps ?? []) {
        steps++; if (s.isJudgment) judgment++; guardrails += s.guardrails.length;
        for (const x of [s.reason, ...s.guardrails]) if (x) { quotable++; if (x.status === "EXPERT_STATED") quoted++; }
      }
      const toConfirm = confirmed.filter((m) => m.confirmed_at).map((m) => (new Date(m.confirmed_at) - new Date(m.started_at)) / 60000);

      // Practice: runs, stops before a wrong decision, and whether stops fall for the same learner on the same map.
      const runs = await q(`SELECT learner_person_id, work_map_id, language, status, jsonb_array_length(interventions) AS stops, started_at FROM tutor_runs ORDER BY started_at`);
      const byPair = new Map();
      for (const r of runs) { const k = `${r.learner_person_id}:${r.work_map_id}`; if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(r.stops); }
      const repeated = [...byPair.values()].filter((xs) => xs.length >= 2);
      const fewer = repeated.filter((xs) => xs.at(-1) < xs[0]).length;

      // Agents: checks against confirmed maps, and decisions handed back to a person.
      const [ag] = await q(`SELECT count(*)::int AS checks, count(*) FILTER (WHERE verdict IN ('STOP','ASK'))::int AS stopped, count(*) FILTER (WHERE verdict = 'NOT_COVERED')::int AS not_covered,
                                   count(*) FILTER (WHERE verdict = 'PROCEED')::int AS proceed, count(DISTINCT agent_key_id)::int AS agents, percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50
                            FROM agent_checks`);

      // Languages actually used (expert sessions and practice), and the AI cost recorded for this space.
      const langs = [...new Set([...sess.map((s) => s.language), ...runs.map((r) => r.language)].filter(Boolean))].sort();
      const [cost] = await q(`SELECT COALESCE(sum(cost_usd), 0)::float AS total, COALESCE(sum(cost_usd) FILTER (WHERE op LIKE 'live:%'), 0)::float AS live, count(*)::int AS calls FROM ai_inferences`);

      return {
        capture: { liveSessions: sess.length, expertMinutes: round(totalMin), questionsAsked: dlg.asked, questionsAnswered: dlg.answered, debriefQuestions: dlg.debrief,
          questionsPer10Min: totalMin >= 5 ? round((dlg.asked / totalMin) * 10) : null },
        workMaps: { confirmed: confirmed.length, drafts: maps.length - confirmed.length, debriefed: maps.filter((m) => m.version >= 2).length, steps, judgmentCalls: judgment, guardrails,
          inExpertsWordsPct: quotable ? Math.round((100 * quoted) / quotable) : null, medianMinutesToConfirmed: round(median(toConfirm)) },
        practice: { runs: runs.length, finished: runs.filter((r) => r.status === "done").length, learners: new Set(runs.map((r) => r.learner_person_id)).size,
          stops: runs.reduce((n, r) => n + r.stops, 0), stopsPerRun: runs.length ? round(runs.reduce((n, r) => n + r.stops, 0) / runs.length, 2) : null,
          repeatedPractice: repeated.length, fewerStopsOnRepeat: fewer },
        agents: { checks: ag.checks, handedToPerson: ag.stopped, notCovered: ag.not_covered, proceeded: ag.proceed, connectedAgents: ag.agents, medianCheckMs: ag.p50 },
        languages: langs,
        ai: { calls: cost.calls, costUsd: round(cost.total, 4), liveCostUsd: round(cost.live, 4), costPerConfirmedMapUsd: confirmed.length ? round(cost.total / confirmed.length, 4) : null },
        generatedAt: new Date().toISOString(),
      };
    });
  }
  return { report };
}
