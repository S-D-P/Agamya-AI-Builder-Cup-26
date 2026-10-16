// Structured JSON logging (pino). Cloud Logging reads `severity` and `logging.googleapis.com/trace` directly.
// Redaction is deny-by-default for anything that can carry secrets or enterprise content.
import pino from "pino";

export const REDACT = [
  "req.headers.cookie", "req.headers.authorization", "req.headers[\"x-csrf-token\"]", "res.headers[\"set-cookie\"]",
  "password", "*.password", "token", "*.token", "csrfToken", "*.csrfToken", "apiKey", "*.apiKey",
  "body", "*.body", "text", "answer", "*.answer", "reasoning", "*.reasoning", "mediaBase64", "audioBase64", "*.dataBase64",
];

export function createLogger(cfg) {
  return pino({
    level: cfg.logLevel,
    base: { service: "apprentice", role: cfg.processRole },
    redact: { paths: REDACT, censor: "[redacted]" },
    messageKey: "message",
    formatters: {
      level(label) {
        const severity = { trace: "DEBUG", debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR", fatal: "CRITICAL" }[label] ?? "DEFAULT";
        return { severity, level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Coarse error category for metrics/alerting, never the raw message. */
export function errorCategory(err) {
  if (!err) return null;
  if (err.status === 401) return "unauthenticated";
  if (err.status === 403) return "forbidden";
  if (err.status === 404) return "not_found";
  if (err.status === 409) return "conflict";
  if (err.status === 413) return "payload_too_large";
  if (err.status === 415 || err.status === 400 || err.status === 422) return "invalid_input";
  if (err.status === 429) return "rate_limited";
  if (/timeout/i.test(err.message)) return "timeout";
  if (/schema/i.test(err.message)) return "ai_schema";
  return "internal";
}
