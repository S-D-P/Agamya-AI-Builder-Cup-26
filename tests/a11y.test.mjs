// Accessibility regression tests (automated part of the WCAG 2.2 AA work; manual checks are in docs/ACCESSIBILITY.md).
//   1. Palette contrast: every text colour token against every surface it is used on (1.4.3), computed from styles.css.
//   2. The real client (public/js) boots in jsdom against the real server (fake model, PGlite) and every route is rendered
//      for each persona; axe-core then checks names, labels, roles, landmarks, headings, lang, ARIA and more.
// jsdom has no layout engine, so axe's colour-contrast rule is disabled here; (1) covers contrast and the browser run in
// docs/ACCESSIBILITY.md covers the rendered page. Passing these tests is not a claim of WCAG conformance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { harness, user, waitFor } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

// ---------------------------------------------------------------- 1. contrast
const token = (name) => { const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)); assert.ok(m, `token --${name}`); return m[1]; };
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test("palette: text tokens reach 4.5:1 on every surface they are used on (WCAG 1.4.3)", () => {
  const surfaces = ["cream", "paper", "paper-2"];
  for (const t of ["ink", "ink-2", "muted", "faint", "sage", "coral-ink", "amber", "red", "sky"]) for (const s of surfaces) {
    const r = contrast(token(t), token(s));
    assert.ok(r >= 4.5, `--${t} on --${s} is ${r.toFixed(2)}:1`);
  }
  // tinted tags and callouts: text colour on its own tint
  for (const [fg, bg] of [["sage", "sage-soft"], ["amber", "amber-soft"], ["red", "red-soft"], ["sky", "sky-soft"], ["coral-ink", "coral-soft"], ["muted", "sage-soft"], ["ink-2", "coral-soft"]]) {
    const r = contrast(token(fg), token(bg));
    assert.ok(r >= 4.5, `--${fg} on --${bg} is ${r.toFixed(2)}:1`);
  }
  // white text on filled controls
  for (const fill of ["sage", "coral-strong", "red", "ink"]) assert.ok(contrast("#ffffff", token(fill)) >= 4.5, `white on --${fill}`);
  // filled coral buttons and steps must use the strong coral, not the decorative one (white on --coral is 3.2:1)
  assert.doesNotMatch(css, /\.accent \{[^}]*background: var\(--(flesh|coral)\);/);
  assert.doesNotMatch(css, /\.step\.now \{[^}]*background: var\(--(flesh|coral)\);/);
});

test("document shell: language, zoom, skip link, live region, reduced motion, focus ring", () => {
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?["',]/, "zoom must not be disabled (1.4.4)");
  assert.match(html, /class="sr-only skip-link" href="#main"/);
  assert.match(css, /\.skip-link:focus[^{]*\{[^}]*clip: auto/, "skip link becomes visible on focus (2.4.1, 2.4.7)");
  assert.match(html, /id="announcer"[^>]*aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible \{ outline: 3px solid var\(--ink\)/);
});

test("no aria-label on a generic div or span without a role (4.1.2: it is not reliably announced)", () => {
  const dir = path.join(ROOT, "public", "js");
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, "views")).map((f) => path.join(dir, "views", f))];
  const bad = [];
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/<(div|span)[^>]*aria-label=[^>]*>/g)) if (!/role=/.test(m[0])) bad.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
  assert.deepEqual(bad, []);
});

test("reflow at 320px (WCAG 1.4.10): no single-column grid that cannot shrink, no clipped page", () => {
  // `1fr` alone has an automatic minimum (its content's min-content width), which forced the shell wider than a phone.
  assert.doesNotMatch(css, /grid-template-columns:\s*1fr\s*;/);
  assert.doesNotMatch(css, /repeat\(auto-(fill|fit),\s*minmax\(\d+px/, "auto-fill grids use minmax(min(Npx, 100%), 1fr)");
  assert.doesNotMatch(css, /html,\s*body\s*\{[^}]*overflow-x:\s*hidden/, "clipping the page hides content instead of reflowing it");
});

// ---------------------------------------------------------------- 2. rendered routes + axe
async function bootClient(app) {
  const u = user(app);
  const vc = new VirtualConsole(); // jsdom reports unimplemented APIs (scrollTo) here; they are not page errors
  const errors = [];
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(html, { url: "http://localhost:3200/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  // Route the client's fetch through the real server (same cookie jar as `u`).
  w.fetch = async (url, opts = {}) => {
    const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    const r = await u.call(opts.method ?? "GET", String(url), body, headers);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status, headers: { "content-type": r.headers["content-type"] ?? "application/json" } });
  };
  for (const k of ["window", "document", "location", "localStorage", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "confirm", "Audio"]) {
    Object.defineProperty(globalThis, k, { value: k === "window" ? w : w[k] ?? (() => true), configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
  globalThis.fetch = w.fetch;
  globalThis.CSS = w.CSS ?? { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
  w.CSS ??= globalThis.CSS;
  w.scrollTo = () => {};
  w.eval(fs.readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8"));
  const client = await import("../public/js/app.js");
  return { u, w, errors, client };
}

const settle = async (w, ms = 4000) => {
  const end = Date.now() + ms;
  await new Promise((r) => setTimeout(r, 150));
  while (Date.now() < end && w.document.querySelector("#app .thinking:not(.small)")) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 250));
};
async function visit(ctx, hash) {
  ctx.w.location.hash = hash;
  await settle(ctx.w);
  return ctx.w.document.getElementById("app").innerHTML;
}
async function axeCheck(ctx, label) {
  const res = await ctx.w.axe.run(ctx.w.document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  const v = res.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  assert.equal(v.join("\n"), "", `${label}: axe violations`); // compare as text: the array comes from jsdom's realm
}

async function switchTo(u, name) {
  const p = (await u.get("/api/samples/people")).body.find((x) => x.display_name.startsWith(name));
  assert.ok(p, name);
  assert.equal((await u.post("/api/samples/switch", { personId: p.id })).status, 200);
  await u.acceptPolicies();
}
const DONE = ["asking", "validating", "no_judgment", "done"];
async function capture(u, wfName, source) {
  const wf = (await u.get("/api/workflows")).body.find((w) => w.name === wfName);
  let s = (await u.post("/api/sessions", { workflowId: wf.id, source })).body;
  const mods = ["SCREEN", "CAMERA", "MICROPHONE"].filter((m) => wf.modalities?.[m.toLowerCase()]);
  s = (await u.post(`/api/sessions/${s.id}/consent`, { modalities: mods, clientTime: Date.now() })).body;
  for (const [action, param] of s.sim.script.steps) { s = (await u.post(`/api/sessions/${s.id}/sim`, { action, param })).body; if (s.status !== "capturing") break; }
  if (s.status === "capturing") await u.post(`/api/sessions/${s.id}/end`);
  const settled = () => waitFor(async () => { const r = (await u.get(`/api/sessions/${s.id}`)).body; return DONE.includes(r.status) && !r.processing.pending ? r : null; }, { timeoutMs: 30000 });
  s = await settled();
  for (let i = 0; s.status === "asking" && i < 3; i++) { await u.post(`/api/sessions/${s.id}/answer`, { text: s.sim.script.answers[i] ?? "Because of the month-end close." }); s = await settled(); }
  return { wf, s };
}

test("every route renders without axe violations, for each persona (Work and Living samples, English and Marathi)", { timeout: 300000 }, async (t) => {
  const h = await harness();
  try {
    const ctx = await bootClient(h.app);
    await t.test("signed out: landing (two modes, demo videos), sign-in, sign-up", async () => {
      await settle(ctx.w);
      await axeCheck(ctx, "landing");
      const d = ctx.w.document;
      assert.match(d.body.textContent, /Agamya for Work[\s\S]*Agamya for Culture/);
      const art = d.querySelector(".lp-hero-art img");
      assert.ok(art?.getAttribute("alt")?.length > 80, "the hero artwork has a full text alternative");
      assert.equal(d.querySelectorAll(".lp-hero-crafts li").length, 6, "each of the six crafts is named in text, in order");
      assert.ok(art.getAttribute("width") && art.getAttribute("height"), "the image reserves its space (no layout shift)");
      assert.equal(d.querySelectorAll('[data-act="sample"]').length, 0, "no sample or demo entry points");
      const frame = d.querySelector(".video-frame.drive iframe");
      assert.match(frame?.getAttribute("src") ?? "", /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/preview$/, "the product demo plays in Google Drive's player");
      assert.ok((frame?.getAttribute("title") ?? "").length > 10, "the embedded player has a descriptive title");
      const demos = [...d.querySelectorAll(".lp-demos a")];
      assert.equal(demos.length, 3, "Culture, Work and Learner demos are linked");
      assert.ok(demos.every((a) => /^https:\/\/drive\.google\.com\//.test(a.href) && a.rel.includes("noopener")), "demo links open Drive safely");
      assert.equal(d.querySelectorAll(".video-section video, .video-section button").length, 0, "no dead play button, no fabricated video");
      await visit(ctx, "#/login");
      await axeCheck(ctx, "login");
      await visit(ctx, "#/signup/personal");
      assert.ok(d.querySelector('input[name="signup-kind"][value="living"]').checked, "the Culture entry point preselects a Personal space");
      await axeCheck(ctx, "signup");
    });

    // ---- Work sample: Dana captures; Alex manages; Jordan learns.
    assert.equal((await ctx.u.post("/api/samples", { kind: "work" })).status, 200);
    await ctx.u.acceptPolicies();
    await switchTo(ctx.u, "Dana");
    const { s } = await capture(ctx.u, "Legacy payment operations", "sim:payments-console");
    assert.ok(s.judgmentId, "a judgment was captured");
    await ctx.client.reboot();
    await t.test("expert (Dana): session review, missing-knowledge panel, capture setup", async () => {
      await visit(ctx, `#/session/${s.id}`); await axeCheck(ctx, "session");
      const k = await visit(ctx, `#/knowledge/${s.judgmentId}`);
      assert.match(k, /Missing knowledge/);
      await waitFor(async () => ctx.w.document.querySelector("article.gap"), { timeoutMs: 10000 });
      await axeCheck(ctx, "knowledge + gaps");
      // Every gap answer box is labelled and described by its own question.
      for (const ta of ctx.w.document.querySelectorAll("article.gap textarea")) {
        assert.ok(ctx.w.document.querySelector(`label[for="${ta.id}"]`), "textarea has a label");
        const q = ta.getAttribute("aria-describedby").split(" ")[0];
        assert.ok(ctx.w.document.getElementById(q)?.textContent.length > 10, "described by its question");
      }
      // Status is written in words, not only colour.
      for (const tag of ctx.w.document.querySelectorAll("article.gap .tag")) assert.ok(tag.textContent.trim().length > 3);
      await visit(ctx, "#/capture"); await axeCheck(ctx, "capture setup");
    });
    const j = (await ctx.u.get(`/api/judgments/${s.judgmentId}`)).body;
    const ap = (await ctx.u.post(`/api/judgments/${j.id}/validate`, { decision: "approve", confirmBoundary: true, expectedVersion: j.version })).body;
    await ctx.u.post(`/api/knowledge/${ap.artifact.id}/sharing`, { visibility: "organization" });
    await t.test("expert (Dana): approved knowledge with the stress-test panel, in Marathi", async () => {
      assert.equal((await ctx.u.post("/api/me/language", { language: "mr" })).status, 200);
      await ctx.client.reboot();
      await visit(ctx, `#/knowledge/${s.judgmentId}`);
      // Marathi interface coverage is partial: the page stays lang="en" and every translated string carries lang="mr" (3.1.2).
      assert.equal(ctx.w.document.documentElement.lang, "en");
      const mr = [...ctx.w.document.querySelectorAll('[lang="mr"]')].map((e) => e.textContent);
      assert.ok(mr.some((x) => /हरवलेले ज्ञान/.test(x)), "the Missing knowledge heading is Marathi and marked as such");
      for (const el of ctx.w.document.querySelectorAll("#app *")) {
        if (el.children.length || !/[\u0900-\u097F]/.test(el.textContent)) continue;
        assert.ok(el.closest("[lang]:not(html)")?.getAttribute("lang") === "mr", `Devanagari text is marked lang="mr": ${el.outerHTML.slice(0, 120)}`);
      }
      await axeCheck(ctx, "knowledge (mr)");
      await ctx.u.post("/api/me/language", { language: "en" });
    });

    await switchTo(ctx.u, "Alex");
    await ctx.client.reboot();
    for (const route of ["#/", "#/radar", "#/transfers", "#/workflows", `#/knowledge/${s.judgmentId}`, "#/progress", "#/insights", "#/admin"]) {
      await t.test(`manager (Alex): ${route}`, async () => { await visit(ctx, route); await axeCheck(ctx, route); });
    }
    await t.test("radar: status in words with evidence and a next action", async () => {
      const page = await visit(ctx, "#/radar");
      assert.match(page, /At risk|Needs attention|Insufficient evidence|Covered/);
      assert.match(page, /Next:/);
      assert.match(page, /Sample data/);
    });

    await switchTo(ctx.u, "Jordan");
    await ctx.client.reboot();
    await t.test("learner (Jordan): lessons, Ask, a completed missing-information case", async () => {
      await visit(ctx, "#/learn"); await axeCheck(ctx, "lessons");
      assert.ok(ctx.w.document.getElementById("ask-q"), "Ask box");
      const lessons = (await ctx.u.get(`/api/workflows/${j.workflowId}/lessons`)).body;
      const sc = lessons.flatMap((l) => l.scenarios).find((x) => x.kind === "insufficient");
      assert.ok(sc, "the payments lesson includes a missing-information case");
      const at = (await ctx.u.post("/api/attempts", { scenarioId: sc.id })).body;
      await visit(ctx, `#/learn/${at.id}`);
      assert.ok([...ctx.w.document.querySelectorAll("button.option")].some((b) => /Stop and ask the expert/.test(b.textContent)), "escalation is an answer option");
      await axeCheck(ctx, "attempt (deciding)");
      await ctx.u.post(`/api/attempts/${at.id}/decide`, { choice: "__ask_expert__", reasoning: "There is no feeder reference, so I cannot check the upstream record." });
      await ctx.client.reboot();
      const page = await visit(ctx, `#/learn/${at.id}`);
      assert.match(page, /Demonstrated in simulation/);
      assert.match(page, /not a certification/);
      await axeCheck(ctx, "attempt (complete)");
    });

    // ---- New platform surfaces, back in the Work sample as the coordinator (Alex) and the expert (Dana).
    await switchTo(ctx.u, "Alex");
    await ctx.client.reboot();
    const d = ctx.w.document;
    const waitDom = (fn, ms = 8000) => waitFor(async () => fn(), { timeoutMs: ms });
    let missionId;
    await t.test("coordinator: spaces, inbox, groups, storage, invitations", async () => {
      for (const route of ["#/spaces", "#/inbox", "#/groups", "#/storage", "#/admin"]) { await visit(ctx, route); await axeCheck(ctx, route); }
      const g = (await ctx.u.get("/api/groups")).body.groups[0];
      await visit(ctx, `#/groups/${g.id}`);
      await waitDom(() => d.querySelector(".member-list"));
      await axeCheck(ctx, "group detail");
      assert.match(d.body.textContent, /not synchronised|What membership gives today/);
    });
    await t.test("coordinator: the mission wizard, step by step, through the real UI", async () => {
      const dana = (await ctx.u.get("/api/people")).body.find((p) => p.display_name.startsWith("Dana")).id;
      await visit(ctx, "#/missions/new");
      await waitDom(() => d.getElementById("wm-name"));
      await axeCheck(ctx, "wizard step 1");
      d.querySelector('[data-act="wiz-next"]').click();
      await waitDom(() => d.getElementById("wm-name-err")?.textContent.length > 0);
      assert.match(d.getElementById("wm-name-err").textContent, /name/, "errors are shown next to the field, not only in a toast");
      d.getElementById("wm-name").value = "Month-end exceptions (a11y)";
      d.querySelector(`[data-wf="experts"][value="${dana}"]`).checked = true;
      d.querySelectorAll('[data-wf="receiverGroups"]')[0].checked = true;
      d.querySelector('[data-act="wiz-next"]').click();
      await waitDom(() => d.querySelector('input[name="tpl"]'));
      await axeCheck(ctx, "wizard step 2");
      d.querySelector('[data-act="wiz-create"]').click();
      await waitDom(() => d.getElementById("bf-objectives"));
      await axeCheck(ctx, "wizard step 3");
      d.getElementById("bf-objectives").value = "Jordan handles E217 at month-end";
      d.getElementById("bf-blindSpots").value = "Feeder reference missing";
      d.querySelector('[data-act="wiz-brief"]').click();
      await waitDom(() => d.querySelector('[data-act="send"]'));
      await axeCheck(ctx, "wizard step 4 (review)");
      assert.match(d.body.textContent, /Operations-New-Joiners/);
      missionId = d.querySelector('[data-act="send"]').dataset.id;
      d.querySelector('[data-act="send"]').click();
      await waitDom(() => ctx.w.location.hash === `#/missions/${missionId}` && d.querySelector(".stage-line"));
      await settle(ctx.w);
      await axeCheck(ctx, "mission overview (coordinator)");
      assert.ok(d.querySelector('.stage-line [aria-current="step"]'), "the current stage is exposed, not only coloured");
    });
    await t.test("expert: mission overview with Moti's summary and capture-method choice", async () => {
      await switchTo(ctx.u, "Dana");
      await ctx.client.reboot();
      await visit(ctx, `#/missions/${missionId}`);
      await waitDom(() => d.querySelector(".moti-brief"));
      await axeCheck(ctx, "mission overview (expert, before confirming)");
      d.querySelector('[data-act="m-confirm"]').click();
      await waitDom(() => d.querySelector('input[name="m-method"]'));
      await axeCheck(ctx, "mission overview (expert, capture choice)");
      const radios = [...d.querySelectorAll('input[name="m-method"]')];
      assert.ok(radios.every((r) => d.querySelector(`label input[name="m-method"][value="${r.value}"]`)), "every method is a labelled radio");
      assert.match(d.getElementById("announcer").textContent + d.body.textContent, /Brief confirmed|confirmed Moti/);
    });
    // ---- Living sample: Lakshmi and Meera.
    assert.equal((await ctx.u.post("/api/samples", { kind: "living" })).status, 200);
    await ctx.u.acceptPolicies();
    await ctx.client.reboot();
    for (const route of ["#/", "#/journey", "#/capture", "#/knowledge", "#/sharing", "#/people"]) {
      await t.test(`teacher (Lakshmi): ${route}`, async () => { await visit(ctx, route); await axeCheck(ctx, route); });
    }
    await t.test("live: the consent card, then the Work Map and its debrief prompt (typed path, no Live needed)", async () => {
      for (const route of ["#/start/camera", "#/start/screen"]) {
        const page = await visit(ctx, route);
        assert.match(page, /I agree, start/); assert.doesNotMatch(page, /class="sidebar"|living-nav/, "no navigation chrome between the person and the work");
        await axeCheck(ctx, route);
      }
      const st = await ctx.u.post("/api/live/start", { kind: "camera", name: "Ghee from butter", language: "mr" });
      assert.equal(st.status, 200, JSON.stringify(st.body));
      await ctx.u.post(`/api/sessions/${st.body.sessionId}/consent`, { modalities: ["CAMERA", "MICROPHONE"], clientTime: Date.now() });
      assert.equal((await ctx.u.post(`/api/live/${st.body.sessionId}/text`, { text: "anything over fifty thousand I hold" })).status, 200);
      assert.equal((await ctx.u.post(`/api/live/${st.body.sessionId}/finish`, { phase: "capture" })).status, 200);
      await waitFor(async () => { const r = (await ctx.u.get(`/api/maps/${st.body.sessionId}`)).body; return r.steps && !r.building; }, { timeoutMs: 20000 });
      const page = await visit(ctx, `#/map/${st.body.sessionId}`);
      assert.match(page, /Start the debrief/); assert.match(page, /AI-inferred, not said by the expert/);
      await axeCheck(ctx, "work map (draft)");
      await visit(ctx, "#/"); assert.match(ctx.w.document.body.textContent, /Ghee from butter|Supplier invoices/, "home lists the Work Map");
    });
    assert.deepEqual(ctx.errors, [], "no script errors while rendering");
  } finally {
    await h.close();
  }
});
