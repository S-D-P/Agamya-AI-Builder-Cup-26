// Durable job queue on PostgreSQL (FOR UPDATE SKIP LOCKED). Same transactional store as the data the jobs change,
// so enqueueing is atomic with the write that caused it. Idempotency key per (org, kind): retries and duplicate
// uploads never trigger duplicate expensive processing. Exponential backoff, dead-lettering, stale-lock recovery.
//
// Production topology: the same image runs as a Cloud Run `worker` service (PROCESS_ROLE=worker, CPU always
// allocated, min instances 1). Locally and in tests the API process also runs a worker loop.
import os from "node:os";

export class RetryLater extends Error {
  constructor(message, delayMs = 2000) { super(message); this.delayMs = delayMs; }
}

/** Enqueue inside an existing tenant transaction. Returns the job row (existing one if the key was seen before). */
export async function enqueue(q, { orgId, kind, payload, key, runAfterMs = 0, maxAttempts = 4 }) {
  const rows = await q(
    `INSERT INTO jobs (org_id, kind, payload, idempotency_key, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, $6)
     ON CONFLICT (org_id, kind, idempotency_key) DO NOTHING RETURNING *`,
    [orgId, kind, JSON.stringify(payload), key, String(runAfterMs), maxAttempts],
  );
  if (rows.length) return { ...rows[0], created: true };
  const [existing] = await q("SELECT * FROM jobs WHERE org_id = $1 AND kind = $2 AND idempotency_key = $3", [orgId, kind, key]);
  return { ...existing, created: false };
}

export function createWorker({ db, log, handlers, cfg }) {
  const id = `${os.hostname()}:${process.pid}`;
  let running = false;
  let active = 0;
  const wake = new Set();

  async function claim(jobId = null) {
    return db.system(async (q) => {
      await q(`UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
               WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval`, [String(cfg.staleLockMinutes)]);
      const rows = await q(
        `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
         WHERE id = (SELECT j.id FROM jobs j WHERE j.status = 'queued' AND j.run_after <= now() ${jobId ? "AND j.id = $2" : ""}
                       -- jobs of the same capture session run one at a time, in order (temporal context matters)
                       AND (j.payload->>'sessionId' IS NULL OR NOT EXISTS (
                         SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.payload->>'sessionId' = j.payload->>'sessionId'))
                     ORDER BY j.run_after, j.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`, jobId ? [id, jobId] : [id]);
      return rows[0] ?? null;
    });
  }

  async function execute(job) {
    const handler = handlers[job.kind];
    const started = Date.now();
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const result = await handler(job.payload, { orgId: job.org_id, jobId: job.id, attempt: job.attempts });
      await db.system((q) => q("UPDATE jobs SET status = 'succeeded', result = $2, last_error = NULL, updated_at = now() WHERE id = $1", [job.id, JSON.stringify(result ?? null)]));
      log.info({ jobId: job.id, kind: job.kind, tenantId: job.org_id, latency: Date.now() - started, status: "succeeded" }, "job");
    } catch (err) {
      const retryLater = err instanceof RetryLater;
      const dead = !retryLater && job.attempts >= job.max_attempts;
      const delay = retryLater ? err.delayMs : Math.min(60000, 1000 * 2 ** job.attempts);
      await db.system((q) => q(
        `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' milliseconds')::interval,
                attempts = CASE WHEN $5 THEN attempts - 1 ELSE attempts END, locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE id = $1`, [job.id, dead ? "dead" : "queued", String(err.message).slice(0, 500), String(delay), retryLater]));
      if (!retryLater) log[dead ? "error" : "warn"]({ jobId: job.id, kind: job.kind, tenantId: job.org_id, status: dead ? "dead" : "retry", errorCategory: "job_failed", err: String(err.message).slice(0, 200) }, "job");
    } finally {
      for (const fn of wake) fn(job.id);
    }
  }

  async function loop() {
    while (running) {
      if (active >= cfg.concurrency) { await sleep(cfg.pollMs); continue; }
      const job = await claim().catch((e) => { log.error({ err: e.message }, "job claim failed"); return null; });
      if (!job) { await sleep(cfg.pollMs); continue; }
      active++;
      execute(job).finally(() => { active--; });
    }
  }

  return {
    start() { if (!running) { running = true; loop(); log.info({ worker: id }, "job worker started"); } },
    async stop() { running = false; while (active) await sleep(50); },
    /** Run one specific job now in this process (used for interactive steps such as simulated capture). */
    async runInline(jobId) {
      const job = await claim(jobId);
      if (job) await execute(job);
    },
    /** Wait until a job leaves queued/running (bounded). */
    async waitFor(jobId, timeoutMs = 120000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const [j] = await db.system((q) => q("SELECT status, result, last_error FROM jobs WHERE id = $1", [jobId]));
        if (!j || ["succeeded", "dead", "failed"].includes(j.status)) return j;
        await new Promise((r) => { const t = setTimeout(r, 400); wake.add(function f(id) { if (id === jobId) { clearTimeout(t); wake.delete(f); r(); } }); });
      }
      return { status: "timeout" };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
