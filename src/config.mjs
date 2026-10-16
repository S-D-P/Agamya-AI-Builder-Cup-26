// Central configuration. Everything environment-specific comes from env vars; nothing environment-specific is hard-coded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const bool = (v, d) => (v === undefined || v === "" ? d : ["1", "true", "yes"].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export function getConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const prod = nodeEnv === "production";
  const port = num(env.PORT, 3200);
  const publicOrigin = (env.PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/$/, "");
  const cfg = {
    nodeEnv, prod, port, publicOrigin,
    processRole: env.PROCESS_ROLE || "all", // all | api | worker
    logLevel: env.LOG_LEVEL || (prod ? "info" : "info"),
    db: env.DATABASE_URL
      ? { driver: "pg", url: env.DATABASE_URL, poolMax: num(env.DB_POOL_MAX, 10), ssl: bool(env.DB_SSL, false) }
      : { driver: "pglite", dir: env.PGLITE_DIR === "memory" ? null : env.PGLITE_DIR || path.join(ROOT, "data", "pg") },
    storage: env.STORAGE_DRIVER === "gcs"
      ? { driver: "gcs", bucket: env.GCS_BUCKET, signedUrlTtlSec: num(env.SIGNED_URL_TTL_SEC, 300) }
      : { driver: "local", dir: env.STORAGE_DIR === "memory" ? null : env.STORAGE_DIR || path.join(ROOT, "data", "objects") },
    auth: {
      sessionTtlHours: num(env.SESSION_TTL_HOURS, 12),
      idleTimeoutMinutes: num(env.SESSION_IDLE_MINUTES, 120),
      cookieName: prod ? "__Host-kd_session" : "kd_session",
      cookieSecure: publicOrigin.startsWith("https://"),
      allowSignup: bool(env.ALLOW_SIGNUP, !prod),
      maxFailedLogins: num(env.MAX_FAILED_LOGINS, 5),
      lockoutMinutes: num(env.LOCKOUT_MINUTES, 15),
      signupRateMax: num(env.SIGNUP_RATE_MAX, 5), // per IP per 15 minutes
      oidc: env.OIDC_ISSUER ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, label: env.OIDC_LABEL || "Google" } : null,
    },
    // seed: shared demo org for scripts/tests. passwordLogin: its one-click sign-in. samples: per-visitor sample spaces from the landing page.
    // Product walkthrough video (landing page). Unset → an honest "coming soon" placeholder; nothing is invented.
    // DEMO_VIDEO_URL: an https URL or a /path served by this app (MP4/WebM). Captions (WebVTT) and a transcript are expected with it.
    demoVideo: env.DEMO_VIDEO_URL ? { url: env.DEMO_VIDEO_URL, captionsUrl: env.DEMO_VIDEO_CAPTIONS_URL || null, transcriptUrl: env.DEMO_VIDEO_TRANSCRIPT_URL || null, poster: env.DEMO_VIDEO_POSTER || null, title: env.DEMO_VIDEO_TITLE || "How Agamya works" } : null,
    // Shared judge accounts (hackathon judging): one Work space and one Culture space, a public password shown on the
    // sign-in page. Real, empty spaces: nothing is pre-filled. Off unless JUDGE_ACCOUNTS=1.
    judges: { enabled: bool(env.JUDGE_ACCOUNTS, false), password: env.JUDGE_PASSWORD || "agamya-judges-2026",
      accounts: [
        { key: "work", email: "judge.work@agamya.example", displayName: "Judge (Work)", orgName: "Agamya for Work · judges", experience: "work" },
        { key: "culture", email: "judge.culture@agamya.example", displayName: "Judge (Culture)", orgName: "Agamya for Culture · judges", experience: "living" },
      ] },
    demo: { seed: bool(env.DEMO_SEED, false), passwordLogin: bool(env.DEMO_LOGIN, !prod), samples: bool(env.SAMPLE_SPACES, false), sampleDailyCap: num(env.SAMPLE_DAILY_CAP, 300) },
    voice: { provider: env.VOICE_PROVIDER || "google" },
    jobs: { pollMs: num(env.JOB_POLL_MS, 500), concurrency: num(env.JOB_CONCURRENCY, 4), staleLockMinutes: num(env.JOB_STALE_MINUTES, 10) },
    media: { maxFrameBytes: num(env.MAX_FRAME_BYTES, 3_000_000), maxAudioBytes: num(env.MAX_AUDIO_BYTES, 6_000_000), maxVideoBytes: num(env.MAX_VIDEO_BYTES, 25_000_000), maxDocBytes: num(env.MAX_DOC_BYTES, 10_000_000) },
    ai: { offline: bool(env.AGAMYA_OFFLINE ?? env.KINDRED_OFFLINE, false), defaultMonthlyBudgetUsd: num(env.AI_MONTHLY_BUDGET_USD, 50) },
    testHooks: bool(env.TEST_HOOKS, false) && !prod,
  };
  if (prod) {
    const missing = [];
    if (cfg.db.driver !== "pg") missing.push("DATABASE_URL");
    if (cfg.storage.driver !== "gcs" || !cfg.storage.bucket) missing.push("STORAGE_DRIVER=gcs + GCS_BUCKET (container disk is ephemeral)");
    if (String(env.IP_HASH_SALT ?? "").length < 16) missing.push("IP_HASH_SALT (>=16 chars; a known salt makes IPv4 hashes reversible)");
    if (!cfg.publicOrigin.startsWith("https://")) missing.push("PUBLIC_ORIGIN (https)");
    if (missing.length) throw new Error(`production configuration incomplete: ${missing.join(", ")}`);
  }
  return cfg;
}
