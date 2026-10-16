// Policy framework: versioned policy documents (platform templates or org-provided), acceptance records, and the
// per-session recording consent that gates capture. Text shipped here is TEMPLATE text, flagged as such.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.mjs";
import { sha256, httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";

export const POLICY_TYPES = ["TERMS_OF_SERVICE", "PRIVACY_POLICY", "AI_USAGE_POLICY", "RECORDING_CONSENT_POLICY", "ACCEPTABLE_USE_POLICY"];
const TITLES = { TERMS_OF_SERVICE: "Terms of Service", PRIVACY_POLICY: "Privacy Policy", AI_USAGE_POLICY: "AI Usage Policy", RECORDING_CONSENT_POLICY: "Recording & Consent Policy", ACCEPTABLE_USE_POLICY: "Acceptable Use Policy" };
// Accepted once per user per org at sign-in. Recording consent is additionally captured per capture session.
const REQUIRED_AT_SIGNIN = ["TERMS_OF_SERVICE", "PRIVACY_POLICY", "AI_USAGE_POLICY", "ACCEPTABLE_USE_POLICY"];
export const TEMPLATE_VERSION = "2026.10"; // the platform's own policies; a space can publish its own version

export function createPolicy({ db }) {
  /** Latest effective document per type: org-specific version wins over the platform template. */
  async function current(q) {
    const rows = await q(`SELECT DISTINCT ON (policy_type) * FROM policy_documents
                          WHERE effective_at <= now() ORDER BY policy_type, (org_id IS NOT NULL) DESC, effective_at DESC`);
    return Object.fromEntries(rows.map((r) => [r.policy_type, r]));
  }

  return {
    async seedTemplates() {
      await db.system(async (q) => {
        for (const type of POLICY_TYPES) {
          const content = fs.readFileSync(path.join(ROOT, "src", "policies", `${type}.md`), "utf8");
          await q(`INSERT INTO policy_documents (org_id, policy_type, version, title, content_md, content_sha256, is_template)
                   VALUES (NULL,$1,$2,$3,$4,$5,true)
                   ON CONFLICT DO NOTHING`, [type, TEMPLATE_VERSION, TITLES[type], content, sha256(content)]);
        }
      });
    },

    async status(ctx) {
      return db.tenant(ctx, async (q) => {
        const docs = await current(q);
        const accepted = new Set((await q("SELECT policy_document_id FROM policy_acceptances WHERE user_id = $1", [ctx.userId])).map((r) => r.policy_document_id));
        const list = POLICY_TYPES.filter((t) => docs[t]).map((t) => {
          const d = docs[t];
          return { id: d.id, type: t, version: d.version, title: d.title, isTemplate: d.is_template, requiredAtSignIn: REQUIRED_AT_SIGNIN.includes(t), accepted: accepted.has(d.id), contentSha256: d.content_sha256 };
        });
        return { policies: list, pending: list.filter((p) => p.requiredAtSignIn && !p.accepted).map((p) => p.id) };
      });
    },

    async document(ctx, id) {
      const [d] = await db.tenant(ctx, (q) => q("SELECT id, policy_type, version, title, content_md, is_template, effective_at FROM policy_documents WHERE id = $1", [id]));
      if (!d) throw httpError(404, "policy not found");
      return d;
    },

    async accept(ctx, ids, { ip, ua, requestId }) {
      return db.tenant(ctx, async (q) => {
        const docs = Object.values(await current(q));
        for (const id of ids) {
          const d = docs.find((x) => x.id === id);
          if (!d) throw httpError(400, "only the current version of a policy can be accepted");
          await q(`INSERT INTO policy_acceptances (org_id, user_id, policy_document_id, policy_type, policy_version, content_sha256, ip_hash, user_agent)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [ctx.orgId, ctx.userId, d.id, d.policy_type, d.version, d.content_sha256, ip, String(ua ?? "").slice(0, 200)]);
          await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "policy.accept", targetType: "policy", targetId: d.id, requestId, metadata: { type: d.policy_type, version: d.version } });
        }
      });
    },

    /** An org admin publishes the organization's own (legal-reviewed) version. Users must accept it again. */
    async publish(ctx, { type, version, content }, requestId) {
      if (!POLICY_TYPES.includes(type)) throw httpError(400, "unknown policy type");
      if (!/^[\w.-]{1,40}$/.test(String(version ?? ""))) throw httpError(400, "invalid version");
      const text = String(content ?? "").slice(0, 100000);
      if (text.length < 50) throw httpError(400, "policy text is too short");
      return db.system(async (q) => {
        const [d] = await q(`INSERT INTO policy_documents (org_id, policy_type, version, title, content_md, content_sha256, is_template)
                             VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING id`, [ctx.orgId, type, version, TITLES[type], text, sha256(text)]);
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "policy.publish", targetType: "policy", targetId: d.id, requestId, metadata: { type, version } });
        return d;
      });
    },

    async currentConsentPolicy(q) {
      return (await current(q)).RECORDING_CONSENT_POLICY ?? null;
    },
  };
}
