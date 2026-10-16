// Database access. PostgreSQL everywhere: Cloud SQL via `pg` in production, PGlite (PostgreSQL compiled to WASM)
// locally and in tests. Same SQL, same migrations.
//
// Two entry points, and nothing else touches the database:
//   db.system(fn)        - platform code that must see across tenants (identity, job claiming, migrations).
//                           Runs as the schema owner. Callers are few and reviewed.
//   db.tenant(ctx, fn)   - everything request- or job-scoped. Runs `SET LOCAL ROLE app_rw` (no BYPASSRLS, not the
//                           owner) and sets app.org_id / app.user_id for the transaction, so PostgreSQL Row-Level
//                           Security enforces tenant isolation even if application code forgets a WHERE clause.
// Rule: never call Gemini (or any slow I/O) inside a transaction.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";

const MIGRATIONS_DIR = path.join(ROOT, "src", "platform", "migrations");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createDb(cfg) {
  const impl = cfg.driver === "pg" ? await pgImpl(cfg) : await pgliteImpl(cfg);

  async function tenant(ctx, fn) {
    if (!ctx?.orgId || !UUID.test(ctx.orgId)) throw Object.assign(new Error("tenant context required"), { status: 500 });
    return impl.tx(async (q) => {
      await q("SET LOCAL ROLE app_rw");
      await q("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ctx.orgId, ctx.userId ?? ""]);
      return fn(q);
    });
  }

  return {
    kind: cfg.driver,
    system: (fn) => impl.tx(fn),
    tenant,
    async migrate(log = () => {}) {
      await impl.tx(async (q) => { await q("SELECT pg_advisory_xact_lock(72190331)"); await q(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); });
      const done = new Set((await impl.tx((q) => q("SELECT version FROM schema_migrations"))).map((r) => r.version));
      for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
        if (done.has(f)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
        // api and worker instances boot concurrently: serialize on an advisory lock and re-check inside it.
        const applied = await impl.tx(async (q) => {
          await q("SELECT pg_advisory_xact_lock(72190331)");
          if ((await q("SELECT 1 FROM schema_migrations WHERE version = $1", [f])).length) return false;
          await impl.exec(q, sql); await q("INSERT INTO schema_migrations(version) VALUES ($1)", [f]);
          return true;
        });
        if (applied) log(`migration applied: ${f}`);
      }
    },
    async ping() { await impl.tx((q) => q("SELECT 1")); return true; },
    close: () => impl.close(),
  };
}

async function pgliteImpl(cfg) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  if (cfg.dir) fs.mkdirSync(cfg.dir, { recursive: true });
  const db = new PGlite({ ...(cfg.dir ? { dataDir: cfg.dir } : {}), extensions: { vector } });
  await db.waitReady;
  return {
    async tx(fn) {
      return db.transaction(async (t) => {
        const q = async (sql, params) => (await t.query(sql, params)).rows;
        q.exec = (sql) => t.exec(sql);
        return fn(q);
      });
    },
    async exec(q, sql) { await q.exec(sql); },
    close: () => db.close(),
  };
}

async function pgImpl(cfg) {
  const pg = (await import("pg")).default;
  // Match PGlite's JavaScript types: counters (bigint) and costs (numeric) as numbers, not strings. Values here are
  // byte counts, token counts and dollar amounts, all far inside Number's exact range.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
  const pool = new pg.Pool({ connectionString: cfg.url, max: cfg.poolMax, ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  return {
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(q, sql) { await q(sql); },
    close: () => pool.end(),
  };
}

/** Optimistic concurrency: throws 409 if the row's version moved. */
export function assertUpdated(rows, what = "resource") {
  if (!rows.length) throw Object.assign(new Error(`${what} was modified by someone else (or does not exist); reload and retry`), { status: 409 });
  return rows[0];
}
