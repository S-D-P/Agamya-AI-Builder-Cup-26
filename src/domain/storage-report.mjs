// Storage and AI-cost report for one space, by knowledge layer. Everything is measured from records; the only computed
// figure is the token baseline "if every captured observation were sent at default resolution", which the capture
// pipeline records per session at the moment it decides (rawEquivalentTokens), and it is labelled as computed.
//   A  original evidence  — media objects (Cloud Storage / disk; never in PostgreSQL)
//   B  evidence index     — observation text, transcript segments, judgment ↔ evidence links
//   C  approved knowledge — judgment versions of approved knowledge, compiled knowledge versions
//   D  learner-ready      — practice cases and cached derived answers
import { requirePermission } from "../platform/authz.mjs";

export function createStorageReport({ db }) {
  async function report(ctx) {
    requirePermission(ctx, "ai.cost.read");
    return db.tenant(ctx, async (q) => {
      const [a] = await q(`SELECT
          count(*)::int AS rows,
          COALESCE(sum(bytes) FILTER (WHERE status NOT IN ('purged','deleted')), 0)::bigint AS live_bytes,
          COALESCE(sum(bytes) FILTER (WHERE status NOT IN ('purged','deleted') AND dedup_of IS NULL), 0)::bigint AS stored_bytes,
          COALESCE(sum(bytes) FILTER (WHERE dedup_of IS NOT NULL AND status NOT IN ('purged','deleted')), 0)::bigint AS reused_bytes,
          count(*) FILTER (WHERE dedup_of IS NOT NULL)::int AS reused_rows,
          COALESCE(sum(bytes) FILTER (WHERE status IN ('purged','deleted')), 0)::bigint AS released_bytes,
          COALESCE(sum(bytes) FILTER (WHERE retention_class = 'knowledge' AND status NOT IN ('purged','deleted')), 0)::bigint AS evidence_kept_bytes
        FROM media_assets`);
      const byKind = await q(`SELECT kind, count(*)::int AS n, COALESCE(sum(bytes),0)::bigint AS bytes FROM media_assets WHERE status NOT IN ('purged','deleted') GROUP BY kind ORDER BY kind`);
      const [b] = await q(`SELECT
          (SELECT COALESCE(sum(octet_length(text)),0) FROM observations WHERE deleted_at IS NULL)::bigint AS observation_bytes,
          (SELECT count(*) FROM observations WHERE deleted_at IS NULL)::int AS observations,
          (SELECT count(*) FROM observations WHERE dropped)::int AS observations_not_sent,
          (SELECT COALESCE(sum(octet_length(text)),0) FROM transcript_segments WHERE deleted_at IS NULL)::bigint AS transcript_bytes,
          (SELECT count(*) FROM judgment_evidence)::int AS evidence_links`);
      const [c] = await q(`SELECT
          (SELECT COALESCE(sum(octet_length(v.content::text)),0) FROM judgment_versions v JOIN judgments j ON j.id = v.judgment_id AND v.version = j.current_version WHERE j.status = 'approved')::bigint AS approved_bytes,
          (SELECT count(*) FROM judgments WHERE status = 'approved')::int AS approved,
          (SELECT COALESCE(sum(octet_length(v.content::text)),0) FROM judgment_versions v)::bigint AS all_versions_bytes,
          (SELECT count(*) FROM judgment_versions)::int AS versions,
          (SELECT COALESCE(sum(octet_length(COALESCE(kv.rule,'')) + octet_length(COALESCE(kv.compact::text,''))),0) FROM knowledge_versions kv)::bigint AS compiled_bytes`);
      const [d] = await q(`SELECT
          (SELECT COALESCE(sum(octet_length(narrative) + octet_length(facts::text) + octet_length(options::text)),0) FROM scenarios WHERE judgment_id IS NOT NULL OR source = 'curated')::bigint AS case_bytes,
          (SELECT count(*) FROM scenarios)::int AS cases,
          (SELECT COALESCE(sum(bytes),0) FROM derived_cache)::bigint AS cache_bytes,
          (SELECT count(*) FROM derived_cache)::int AS cache_entries,
          (SELECT COALESCE(sum(hits),0) FROM derived_cache)::int AS cache_hits`);
      const [ai] = await q(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'ok')::int AS ok, count(*) FILTER (WHERE status = 'error')::int AS errors,
          count(*) FILTER (WHERE status = 'skipped_budget')::int AS skipped_budget, count(*) FILTER (WHERE result_summary LIKE 'attempt 2%')::int AS retries,
          count(*) FILTER (WHERE error_category = 'rate_limited')::int AS rate_limited, count(*) FILTER (WHERE error_category = 'timeout')::int AS timeouts,
          COALESCE(sum(prompt_tokens),0)::bigint AS prompt_tokens, COALESCE(sum(output_tokens),0)::bigint AS output_tokens, COALESCE(sum(thought_tokens),0)::bigint AS thought_tokens,
          COALESCE(sum(cost_usd),0)::float AS cost_usd, COALESCE(avg(latency_ms) FILTER (WHERE status = 'ok'),0)::int AS avg_latency_ms,
          COALESCE(sum((tokens_by_modality->>'IMAGE')::int),0)::bigint AS image_tokens
        FROM ai_inferences`);
      const byOp = await q(`SELECT op, count(*)::int AS calls, count(*) FILTER (WHERE status <> 'ok')::int AS failed, COALESCE(sum(prompt_tokens + output_tokens + thought_tokens),0)::bigint AS tokens,
                                   COALESCE(sum(cost_usd),0)::float AS cost_usd, COALESCE(avg(latency_ms) FILTER (WHERE status = 'ok'),0)::int AS avg_latency_ms
                            FROM ai_inferences GROUP BY op ORDER BY cost_usd DESC`);
      const [base] = await q(`SELECT COALESCE(sum((budget->>'rawEquivalentTokens')::bigint),0)::bigint AS raw_equivalent, COALESCE(sum((budget->>'rawBytesCaptured')::bigint),0)::bigint AS raw_captured,
                                     COALESCE(sum((budget->>'rawBytesPurged')::bigint),0)::bigint AS raw_purged, count(*)::int AS sessions FROM expert_sessions`);
      const n = (x) => Number(x ?? 0);
      return {
        measuredAt: new Date().toISOString(),
        layers: {
          A: { label: "Original evidence (object storage)", liveBytes: n(a.live_bytes), storedObjectBytes: n(a.stored_bytes), reusedBytes: n(a.reused_bytes), reusedUploads: a.reused_rows,
            releasedBytes: n(a.released_bytes), evidenceKeptBytes: n(a.evidence_kept_bytes), byKind: byKind.map((k) => ({ kind: k.kind, items: k.n, bytes: n(k.bytes) })) },
          B: { label: "Structured evidence index", observationBytes: n(b.observation_bytes), observations: b.observations, observationsNotSentToModel: b.observations_not_sent, transcriptBytes: n(b.transcript_bytes), evidenceLinks: b.evidence_links },
          C: { label: "Approved knowledge", approvedBytes: n(c.approved_bytes), approved: c.approved, allVersionsBytes: n(c.all_versions_bytes), versions: c.versions, compiledBytes: n(c.compiled_bytes) },
          D: { label: "Learner-ready and cached derivatives", caseBytes: n(d.case_bytes), cases: d.cases, cacheBytes: n(d.cache_bytes), cacheEntries: d.cache_entries, cacheHits: d.cache_hits },
        },
        ai: { ...ai, prompt_tokens: n(ai.prompt_tokens), output_tokens: n(ai.output_tokens), thought_tokens: n(ai.thought_tokens), image_tokens: n(ai.image_tokens), byOp: byOp.map((o) => ({ ...o, tokens: n(o.tokens) })) },
        baseline: {
          sessions: base.sessions, rawEquivalentTokens: n(base.raw_equivalent), rawBytesCaptured: n(base.raw_captured), rawBytesPurged: n(base.raw_purged),
          note: "rawEquivalentTokens is computed during capture: what sending every captured observation to the model at default resolution would have cost. It is a computed baseline, not a second measured run.",
        },
        savings: {
          storageReuseBytes: n(a.reused_bytes),
          cacheHitsAvoidedCalls: d.cache_hits,
          note: "Only what is listed here is measured. Percentages are not shown unless both sides of the comparison were measured on the same sessions (see scripts/storage-benchmark.mjs).",
        },
      };
    });
  }
  return { report };
}
