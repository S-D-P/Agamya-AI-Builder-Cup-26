import { focusSelectorFor } from "./a11y.js";
// Client core: state cache, authenticated API (CSRF + policy gate handling), routing, focus-preserving rendering.
// The server is the source of truth for every permission decision; the UI only reflects it.
/** localStorage can be unavailable (private windows, blocked storage): never let that break the app. */
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } },
};

export const state = {
  me: null, csrf: "", workflows: [], workflowId: store.get("ag.wf"), busy: null, drafts: {}, cache: {}, config: null,
  speak: store.get("ag.speak") !== "0",
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
export const pct = (n) => (n == null ? "—" : `${n}%`);
export const usd = (n) => (n == null ? "—" : `$${Number(n) < 0.01 ? Number(n).toFixed(4) : Number(n).toFixed(3)}`);
export const ago = (d) => { const s = (Date.now() - new Date(d).getTime()) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(d).toLocaleDateString(); };
export const has = (...roles) => roles.some((r) => state.me?.roles?.includes(r));
/** Which experience the active space uses: a workplace ('work') or a family / community space ('living'). */
export const isLiving = () => state.me?.org?.experience === "living";
export const isSample = () => Boolean(state.me?.org?.sampleKind);

export class ApiError extends Error { constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; } }

export async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const isBlob = body instanceof Blob || body instanceof ArrayBuffer;
  const r = await fetch(path, {
    method, credentials: "same-origin",
    headers: { ...(body && !isBlob ? { "content-type": "application/json" } : {}), ...(method !== "GET" && state.csrf ? { "x-csrf-token": state.csrf } : {}), ...headers },
    body: body ? (isBlob ? body : JSON.stringify(body)) : undefined,
  });
  if (raw && r.ok) return r.blob();
  const data = await r.json().catch(() => ({}));
  if (data?.csrfToken) state.csrf = data.csrfToken;
  if (r.status === 401 && !path.startsWith("/api/auth/")) { state.me = null; go("#/login"); }
  if (r.status === 428) { go("#/policies"); }
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}

// ---------------------------------------------------------------- routing + rendering
let renderer = () => {};
export function onRender(fn) { renderer = fn; }
export function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
export function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { name: parts[0] || "home", id: parts[1] ?? null, sub: parts[2] ?? null };
}

/** Re-render while preserving keyboard focus and text selection (accessibility). */
export function render() {
  const a = document.activeElement;
  const selector = focusSelectorFor(a);
  const sel = a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
  renderer();
  if (selector) {
    let el = null; try { el = document.querySelector(selector); } catch { /* unusual attribute value */ }
    if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (sel && "setSelectionRange" in el) try { el.setSelectionRange(...sel); } catch {} }
  }
  document.querySelectorAll("[data-draft]").forEach((el) => { if (state.drafts[el.dataset.draft] !== undefined && el.value !== state.drafts[el.dataset.draft]) el.value = state.drafts[el.dataset.draft]; });
}
document.addEventListener("input", (e) => { if (e.target.dataset?.draft) state.drafts[e.target.dataset.draft] = e.target.value; });
export const draft = (k) => (state.drafts[k] ?? "").trim();

export async function act(label, fn) {
  if (state.busy) return;
  state.busy = label; render();
  try { return await fn(); }
  catch (e) { if (!(e instanceof ApiError && [401, 428].includes(e.status))) toast(e.message, true); }
  finally { state.busy = null; render(); }
}

export function toast(msg, bad = false) {
  let host = document.querySelector(".toast-host");
  if (!host) { host = Object.assign(document.createElement("div"), { className: "toast-host" }); host.setAttribute("role", "status"); host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
  const t = Object.assign(document.createElement("div"), { className: `toast ${bad ? "bad" : ""}`, textContent: msg });
  host.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

/** Polls while a condition holds; stops automatically when the route changes. */
const pollers = new Map();
export function poll(key, fn, everyMs = 1200) {
  if (pollers.has(key)) return;
  const h = location.hash;
  const tick = async () => {
    if (location.hash !== h) return stop(key);
    try { if ((await fn()) === false) return stop(key); } catch { /* transient */ }
    pollers.set(key, setTimeout(tick, everyMs));
  };
  pollers.set(key, setTimeout(tick, everyMs));
}
export function stop(key) { clearTimeout(pollers.get(key)); pollers.delete(key); }

export const workflow = () => state.workflows.find((w) => w.id === state.workflowId) ?? state.workflows[0] ?? null;
export function setWorkflow(id) { state.workflowId = id; store.set("ag.wf", id ?? ""); state.cache = {}; }

/** Minimal, safe Markdown → HTML for policy documents (escape first, then format). */
export function md(text) {
  return esc(text).split(/\n{2,}/).map((block) => {
    if (block.startsWith("&gt; ")) return `<blockquote>${block.replace(/^&gt; /gm, "")}</blockquote>`;
    if (/^# /.test(block)) return `<h1>${block.slice(2)}</h1>`;
    if (/^## /.test(block)) return `<h3>${block.slice(3)}</h3>`;
    if (/^(\d+\.|-) /m.test(block)) return `<ul>${block.split("\n").map((l) => `<li>${l.replace(/^(\d+\.|-)\s+/, "")}</li>`).join("")}</ul>`;
    return `<p>${block}</p>`;
  }).join("").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}
