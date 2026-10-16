// ASK AGAMYA: a learner asks a question in their own language; the answer comes only from approved knowledge they may see,
// with verified citations to the expert's words. If the knowledge does not cover it, the answer says so (in that language).
import { requirePermission } from "../platform/authz.mjs";
import { httpError, scanForInjection, sha256 } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { withAiContext, MODEL } from "../ai/gemini.mjs";
import { answerFromKnowledge } from "../ai/ops/detective.mjs";
import { CHAIN_FIELDS } from "../ai/validators.mjs";
import { normalizeLanguage, devanagariShare } from "../ai/language.mjs";
import { visibleSql, viewerOf } from "./knowledge.mjs";

const MESSAGES = {
  en: { insufficient: "There isn't enough approved knowledge here to answer that. Please ask {expert}, who taught this, rather than guessing.", unavailable: "Agamya can't answer right now (the AI service is unavailable). Your question was not lost; please try again shortly or ask {expert}.", nothing: "Nothing has been confirmed and shared with you yet. A Work Map or knowledge item can be used once its expert confirms it and shares it with you; you can ask for access from the Learning page." },
  mr: { insufficient: "याचे उत्तर देण्यासाठी इथे पुरेसे मान्य ज्ञान नाही. अंदाज करण्याऐवजी कृपया {expert} यांना विचारा, ज्यांनी हे शिकवले आहे.", unavailable: "Agamya सध्या उत्तर देऊ शकत नाही (AI सेवा उपलब्ध नाही). तुमचा प्रश्न हरवलेला नाही; थोड्या वेळाने पुन्हा प्रयत्न करा किंवा {expert} यांना विचारा.", nothing: "अजून तुमच्याशी कोणतेही मान्य ज्ञान शेअर केलेले नाही, त्यामुळे उत्तर देण्यासाठी आधार नाही." },
};
const msg = (lang, key, vars = {}) => (MESSAGES[lang] ?? MESSAGES.en)[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

/** Preferred language, else the script of the question (Devanagari defaults to Marathi here; the model confirms). */
export function questionLanguage(question, preferred) {
  if (preferred) return normalizeLanguage(preferred);
  return devanagariShare(question) >= 0.3 ? "mr" : "en";
}

export function createAsk({ db, maps = () => null }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function ask(ctx, { question, workflowId = null, language = null }) {
    requirePermission(ctx, "workflow.read");
    const text = String(question ?? "").trim().slice(0, 1000);
    if (text.length < 3) throw httpError(400, "ask a question");
    const lang = questionLanguage(text, language ?? ctx.language);
    const rows = await T(ctx, async (q) => {
      // Learners' view of knowledge: approved, active, and shared with them (never a reviewer's view of drafts).
      const viewer = { ...(await viewerOf(q, ctx)), reviewer: false };
      return q(`SELECT j.id, j.title, j.current_version, p.display_name AS expert_name, v.content FROM judgments j JOIN people p ON p.id = j.expert_person_id
                JOIN knowledge_artifacts a ON a.judgment_id = j.id AND a.status = 'active' JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version
                WHERE j.status = 'approved' AND ${visibleSql(viewer)} ${workflowId ? "AND j.workflow_id = $1" : ""} ORDER BY j.created_at DESC LIMIT 12`, workflowId ? [workflowId] : []);
    });
    // Confirmed Work Maps the person may open are sources too (same access rule as the map pages).
    const mapRows = maps() ? await maps().readableForAsk(ctx).catch(() => []) : [];
    const expert = [...new Set([...rows, ...mapRows].map((r) => r.expert_name))].join(", ") || (lang === "mr" ? "तज्ज्ञ" : "the expert");
    if (!rows.length && !mapRows.length) return { language: lang, answer: msg(lang, "nothing"), grounded: false, insufficient: true, citations: [], source: "rule" };
    const items = rows.map((r) => {
      const f = r.content.fields ?? {};
      const lines = CHAIN_FIELDS.filter((k) => f[k]?.value && f[k]?.status !== "INSUFFICIENT_EVIDENCE").map((k) => `${k} (${f[k].status}): ${f[k].value}${f[k].quote ? ` | expert's words: "${f[k].quote}"` : ""}`);
      const b = r.content.boundary;
      if (b?.boundaryCondition) lines.push(`boundary (${b.status}): ${b.boundaryCondition}${b.boundaryQuote ? ` | expert's words: "${b.boundaryQuote}"` : ""}`);
      return { judgmentId: r.id, title: r.title, expertName: r.expert_name, text: `${r.content.rule ?? ""}\n${lines.join("\n")}` };
    }).concat(mapRows.map((m) => ({ judgmentId: null, mapSessionId: m.session_id, title: `Work Map: ${m.title}`, expertName: m.expert_name,
      text: m.map.steps.map((st, i) => `Step ${i + 1}: ${st.title}. Do: ${st.action}. Decision: ${st.decision}.${st.reason?.text ? ` Why: ${st.reason.text}${st.reason.quote ? ` | expert's words: "${st.reason.quote}"` : ""}` : ""}${st.guardrails.map((g) => ` [${g.kind}] ${g.text}${g.quote ? ` | expert's words: "${g.quote}"` : ""}`).join("")}`).join("\n") })));
    // Derived-artifact cache: same normalised question, language and model over the SAME knowledge versions → reuse.
    // The source set is part of the key, so an answer is only reused by someone who can see exactly the same sources.
    const sources = [...rows.map((r) => `${r.id}:${r.current_version}`), ...mapRows.map((m) => `wm:${m.id}:${m.version}`)].sort();
    const keyHash = sha256(JSON.stringify(["ask", text.normalize("NFC").toLowerCase().replace(/\s+/g, " "), lang, MODEL(), sources]));
    const [cached] = await T(ctx, (q) => q("UPDATE derived_cache SET hits = hits + 1, last_hit_at = now() WHERE org_id = $1 AND key_hash = $2 RETURNING payload", [ctx.orgId, keyHash]));
    let res;
    if (cached) res = { ...cached.payload, cached: true };
    else {
      res = await withAiContext({ orgId: ctx.orgId, workflowId, requestId: ctx.requestId }, () => answerFromKnowledge({ question: text, language: lang, items }));
      if (res.source === "gemini" && !res.unavailable) {
        const payload = JSON.stringify(res);
        await T(ctx, (q) => q(`INSERT INTO derived_cache (org_id, kind, key_hash, source_versions, language, model, payload, bytes) VALUES ($1,'ask',$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [ctx.orgId, keyHash, JSON.stringify(sources), lang, MODEL(), payload, Buffer.byteLength(payload)]));
      }
    }
    await T(ctx, (q) => audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.ask", requestId: ctx.requestId, metadata: { language: res.language ?? lang, grounded: Boolean(res.grounded), insufficient: Boolean(res.insufficient), cached: Boolean(res.cached), flags: scanForInjection(text) } }));
    const outLang = normalizeLanguage(res.language ?? lang);
    if (res.unavailable) return { language: lang, answer: msg(lang, "unavailable", { expert }), grounded: false, insufficient: true, unavailable: true, citations: [], source: "fallback" };
    // Withheld (ungrounded) or empty answers become an honest message in the learner's language.
    const answer = res.answer ?? msg(outLang, "insufficient", { expert });
    return { language: outLang, answer, grounded: res.grounded, insufficient: res.insufficient, needsClarification: res.needsClarification, clarifyingQuestion: res.clarifyingQuestion,
      citations: res.citations, withheldUngrounded: res.withheldUngrounded ?? false, source: res.source, cached: Boolean(res.cached), sourceVersions: sources };
  }

  return { ask };
}
