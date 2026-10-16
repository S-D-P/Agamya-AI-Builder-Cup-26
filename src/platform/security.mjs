// Security primitives. Standard algorithms from node:crypto only (no home-grown cryptography).
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

// ---------------------------------------------------------------- passwords (scrypt, per-password salt, constant-time compare)
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  if (!stored?.startsWith("scrypt$")) { await hashPassword("timing-equaliser"); return false; }
  const [, N, r, p, saltB64, keyB64] = stored.split("$");
  const expected = Buffer.from(keyB64, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected);
}

const COMMON = new Set(["password", "password123", "123456789012", "qwertyuiop12", "letmein12345", "welcome12345", "changeme1234", "administrator"]);
export function passwordProblems(password, email = "") {
  const p = [];
  if (typeof password !== "string" || password.length < 12) p.push("use at least 12 characters");
  if (password && password.length > 256) p.push("use at most 256 characters");
  if (COMMON.has(String(password).toLowerCase())) p.push("this password is too common");
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length > 3 && String(password).toLowerCase().includes(local)) p.push("do not include your email name");
  return p;
}

// ---------------------------------------------------------------- opaque tokens
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const hashIp = (ip, salt = process.env.IP_HASH_SALT || "local-dev") => (ip ? sha256(`${salt}:${ip}`).slice(0, 32) : null);
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- upload validation (magic bytes, never trust Content-Type)
const SIGNATURES = [
  { mime: "image/png", test: (b) => b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG" },
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { mime: "audio/wav", test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" },
  { mime: "video/webm", test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: "video/mp4", test: (b) => b.length > 12 && b.toString("ascii", 4, 8) === "ftyp" },
  { mime: "application/pdf", test: (b) => b.length > 5 && b.toString("ascii", 0, 5) === "%PDF-" },
];

export function sniffMime(buf) {
  return SIGNATURES.find((s) => s.test(buf))?.mime ?? null;
}

const PDF_ACTIVE = [/\/JavaScript/, /\/JS\s*[(<]/, /\/Launch/, /\/EmbeddedFile/, /\/RichMedia/, /\/XFA/, /\/OpenAction\s*<<[^>]*\/S\s*\/JavaScript/];
/** PDFs are only ever passed to Gemini (never rendered or executed server-side); active content is still rejected. */
export function inspectPdf(buf) {
  const head = buf.toString("latin1");
  const found = PDF_ACTIVE.filter((re) => re.test(head)).map((re) => re.source);
  return { ok: found.length === 0, activeContent: found };
}

export function validateUpload(buf, { allow, maxBytes }) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, "empty upload");
  if (buf.length > maxBytes) throw httpError(413, `upload exceeds ${maxBytes} bytes`);
  const mime = sniffMime(buf);
  if (!mime || !allow.includes(mime)) throw httpError(415, `unsupported or mismatched file type${mime ? ` (${mime})` : ""}`);
  if (mime === "application/pdf") {
    const pdf = inspectPdf(buf);
    if (!pdf.ok) throw httpError(422, `PDF contains active content (${pdf.activeContent.join(", ")}) and was rejected`);
  }
  return mime;
}

/** Plain-text documents: decode strictly, strip control characters, bound the size. */
export function sanitizeText(input, maxChars = 60000) {
  return String(input ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, maxChars);
}

// ---------------------------------------------------------------- prompt-injection signals in OBSERVED / EXTERNAL content
// Detection is advisory: flagged content is still treated purely as data (see ai/prompt.mjs). Flags are recorded,
// surfaced in the UI and audited, so a reviewer can see that a document or screen tried to instruct the AI.
const INJECTION = [
  [/ignore (all |any )?(previous|prior|above) (instructions|prompts?|rules)/i, "override-instructions"],
  [/disregard (the |all )?(system|previous|above)/i, "override-instructions"],
  [/\b(system prompt|developer message|you are now|act as (an? )?(admin|system))/i, "role-hijack"],
  [/(reveal|print|send|upload|exfiltrate|leak).{0,40}(api[ _-]?key|secret|password|token|credentials)/i, "exfiltration"],
  [/<\/?(system|assistant|instructions?)>/i, "fake-delimiters"],
  [/\b(approve|confirm|mark).{0,30}(all|every).{0,30}(knowledge|judgments?|rules?)/i, "action-request"],
];
export function scanForInjection(text) {
  const s = String(text ?? "");
  return INJECTION.filter(([re]) => re.test(s)).map(([, tag]) => tag);
}

export function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, expose: true, ...extra });
}
