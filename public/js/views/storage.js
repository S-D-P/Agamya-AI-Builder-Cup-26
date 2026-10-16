// STORAGE & AI: what this space stores, by knowledge layer, and what its AI use cost. Measured figures only; the one
// computed baseline is labelled. Original evidence is kept distinct from everything derived from it.
import { api, esc, render, toast } from "../core.js";
import { icon } from "../icons.js";

let data = null;
export function invalidateStorage() { data = null; }
const kb = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
const num = (n) => Number(n ?? 0).toLocaleString();

export function storageView() {
  if (!data) { api("GET", "/api/storage/report").then((d) => { data = d; render(); }).catch((e) => { data = { error: e.message }; render(); toast(e.message, true); }); return `<span class="thinking">Measuring</span>`; }
  if (data.error) return `<div class="card pad">${icon("lock", 16)} ${esc(data.error)}</div>`;
  const { A, B, C, D } = data.layers, ai = data.ai;
  return `<div class="page-head"><div><div class="eyebrow">Measured ${new Date(data.measuredAt).toLocaleString()}</div><h1>Storage and AI use</h1>
    <p>Original evidence, the index built from it, approved knowledge and learner-ready material are stored and counted separately. A summary never replaces its source.</p></div></div>
  <div class="layer-grid">
    <section class="card pad stack" aria-labelledby="la"><h2 id="la" class="h3">A · ${esc(A.label)}</h2><dl class="kv left">
      <dt>Live (referenced by records)</dt><dd>${kb(A.liveBytes)}</dd><dt>Actually stored</dt><dd>${kb(A.storedObjectBytes)}</dd>
      <dt>Reused identical uploads</dt><dd>${num(A.reusedUploads)} (${kb(A.reusedBytes)} not stored twice)</dd><dt>Kept as evidence for knowledge</dt><dd>${kb(A.evidenceKeptBytes)}</dd><dt>Released by retention or deletion</dt><dd>${kb(A.releasedBytes)}</dd></dl>
      ${A.byKind.length ? `<div class="table-wrap" role="region" aria-label="Original evidence by kind" tabindex="0"><table class="t"><caption class="sr-only">Original evidence by kind</caption><thead><tr><th scope="col">Kind</th><th scope="col">Items</th><th scope="col">Size</th></tr></thead><tbody>${A.byKind.map((k) => `<tr><td>${esc(k.kind.replace("_", " "))}</td><td>${num(k.items)}</td><td>${kb(k.bytes)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <p class="small muted">Stored in object storage, never in the database. Identical bytes in this space are stored once; each upload keeps its own record, consent and deletion state.</p></section>
    <section class="card pad stack" aria-labelledby="lb"><h2 id="lb" class="h3">B · ${esc(B.label)}</h2><dl class="kv left">
      <dt>Observations</dt><dd>${num(B.observations)} (${kb(B.observationBytes)})</dd><dt>Not sent to the model (no meaningful change)</dt><dd>${num(B.observationsNotSentToModel)}</dd>
      <dt>Transcript text</dt><dd>${kb(B.transcriptBytes)}</dd><dt>Evidence links behind knowledge</dt><dd>${num(B.evidenceLinks)}</dd></dl></section>
    <section class="card pad stack" aria-labelledby="lc"><h2 id="lc" class="h3">C · ${esc(C.label)}</h2><dl class="kv left">
      <dt>Approved knowledge</dt><dd>${num(C.approved)} (${kb(C.approvedBytes)})</dd><dt>All versions kept</dt><dd>${num(C.versions)} (${kb(C.allVersionsBytes)})</dd><dt>Compiled rules</dt><dd>${kb(C.compiledBytes)}</dd></dl></section>
    <section class="card pad stack" aria-labelledby="ld"><h2 id="ld" class="h3">D · ${esc(D.label)}</h2><dl class="kv left">
      <dt>Practice cases</dt><dd>${num(D.cases)} (${kb(D.caseBytes)})</dd><dt>Cached answers</dt><dd>${num(D.cacheEntries)} (${kb(D.cacheBytes)})</dd><dt>Model calls avoided by the cache</dt><dd>${num(D.cacheHits)}</dd></dl>
      <p class="small muted">A cached answer is reused only for the same question, language and model over exactly the same knowledge versions the asker can see.</p></section>
  </div>
  <section class="card pad stack" style="margin-top:16px" aria-labelledby="ai-h"><h2 id="ai-h" class="h3">${icon("coin", 15)} AI use</h2>
    <dl class="kv left ai-kv"><dt>Calls</dt><dd>${num(ai.calls)} (${num(ai.ok)} ok, ${num(ai.errors)} failed, ${num(ai.skipped_budget)} skipped by budget)</dd><dt>Retries</dt><dd>${num(ai.retries)} (one retry at most per call; ${num(ai.rate_limited)} rate-limited, ${num(ai.timeouts)} timed out)</dd>
      <dt>Tokens</dt><dd>${num(ai.prompt_tokens)} in · ${num(ai.output_tokens)} out · ${num(ai.thought_tokens)} thinking · ${num(ai.image_tokens)} image</dd><dt>Cost (estimated from list prices)</dt><dd>$${Number(ai.cost_usd).toFixed(4)}</dd><dt>Average latency</dt><dd>${num(ai.avg_latency_ms)} ms</dd></dl>
    ${ai.byOp.length ? `<div class="table-wrap" role="region" aria-label="AI use by operation" tabindex="0"><table class="t"><caption>By operation</caption><thead><tr><th scope="col">Operation</th><th scope="col">Calls</th><th scope="col">Failed</th><th scope="col">Tokens</th><th scope="col">Cost</th><th scope="col">Avg latency</th></tr></thead><tbody>
      ${ai.byOp.map((o) => `<tr><td class="mono">${esc(o.op)}</td><td>${num(o.calls)}</td><td>${num(o.failed)}</td><td>${num(o.tokens)}</td><td>$${Number(o.cost_usd).toFixed(4)}</td><td>${num(o.avg_latency_ms)} ms</td></tr>`).join("")}</tbody></table></div>` : ""}
    <p class="small"><b>Baseline (computed):</b> sending every captured observation at default resolution would have used about ${num(data.baseline.rawEquivalentTokens)} tokens across ${num(data.baseline.sessions)} sessions. <span class="muted">${esc(data.baseline.note)}</span></p>
    <p class="small muted">${esc(data.savings.note)}</p></section>`;
}
