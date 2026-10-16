// ASK: a learner asks in their own language (Marathi, English or a mix) and gets an answer only from approved knowledge
// they may see, with the expert's exact words cited. If the knowledge does not cover it, the answer says so; an answer
// whose citations do not match the knowledge is withheld rather than shown.
import { state, api, esc, render, act, draft, toast, workflow } from "../core.js";
import { icon } from "../icons.js";
import { DraftRecorder } from "../capture.js";
import { t, langAttr, langName } from "../i18n.js";
import { announce } from "../a11y.js";

let last = null, rec = null, busyVoice = false;

export function askPanel() {
  return `<section class="card pad stack" aria-labelledby="ask-h"><h2 id="ask-h" class="h3">${icon("question", 15)} ${t("Ask a question")}</h2>
    <p class="small muted">Answers come only from approved knowledge shared with you, with the expert's own words. Ask in Marathi, English or a mix.</p>
    <label class="field" for="ask-q">${t("Your question")}<textarea id="ask-q" data-draft="ask-q" data-focus="ask-q" rows="2" maxlength="1000"></textarea></label>
    <div class="row wrap"><button class="primary sm" data-act="ask" ${state.busy ? "disabled" : ""}>${t("Ask")}</button>
      ${navigator.mediaDevices && window.MediaRecorder ? `<button class="sm" data-act="ask-voice" aria-pressed="${Boolean(rec)}" ${busyVoice ? "disabled" : ""}>${icon("mic", 14)} ${rec ? t("Stop recording") : "Ask by voice"}</button>` : ""}
      ${busyVoice ? `<span class="thinking small" role="status">Transcribing</span>` : state.busy === "ask" ? `<span class="thinking small" role="status">Looking in the approved knowledge</span>` : ""}</div>
    ${last ? answerView(last) : ""}</section>`;
}

function answerView(r) {
  const tone = r.grounded ? "green" : r.needsClarification ? "sky" : "amber";
  const label = r.grounded ? "Grounded in approved knowledge" : r.needsClarification ? "Needs clarification" : r.unavailable ? "Answering is unavailable right now" : "Not covered by the approved knowledge";
  return `<div class="stack" aria-live="polite"><div class="row"><span class="tag ${tone}">${esc(label)}</span>${r.language ? `<span class="small muted">${esc(langName(r.language))}</span>` : ""}</div>
    <p${langAttr(r.language)} style="white-space:pre-wrap">${esc(r.needsClarification && r.clarifyingQuestion ? r.clarifyingQuestion : r.answer)}</p>
    ${r.withheldUngrounded ? `<p class="small muted">An AI answer was drafted but its sources could not be verified against the knowledge, so it is not shown.</p>` : ""}
    ${r.citations?.length ? `<div class="small"><b>${t("Sources")}</b><ul class="plain">${r.citations.map((c) => `<li><q${langAttr(r.language)}>${esc(c.quote)}</q> · ${esc(c.expertName)}, <i>${esc(c.title)}</i></li>`).join("")}</ul></div>` : ""}</div>`;
}

export async function askClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return false;
  if (el.dataset.act === "ask") {
    const question = draft("ask-q");
    if (!question) { document.getElementById("ask-q")?.focus(); toast("Type or say a question first.", true); return true; }
    act("ask", async () => {
      last = await api("POST", "/api/ask", { question, workflowId: workflow()?.id });
      announce(last.grounded ? "Answer ready, with sources." : last.needsClarification ? "A clarifying question is shown." : "The approved knowledge does not cover this.");
    });
    return true;
  }
  if (el.dataset.act === "ask-voice") {
    if (rec) {
      const r = rec; rec = null; busyVoice = true; render();
      try { const out = await r.stop(state.me?.user?.language); if (out.text) { state.drafts["ask-q"] = out.text; announce("Transcript ready. Check it, then press Ask."); } else toast("No speech was heard.", true); }
      catch (err) { toast(err.message, true); } finally { busyVoice = false; render(); document.getElementById("ask-q")?.focus(); }
    } else {
      try { rec = new DraftRecorder(); await rec.start(); announce("Recording. Press the button again to stop."); render(); } catch { rec = null; toast("Microphone unavailable. You can type instead.", true); }
    }
    return true;
  }
  return false;
}
export function invalidateAsk() { last = null; }
