// Signed-out experience: the landing page (two experiences + the featured journey), sign in, create a space,
// accept an invitation, and the policy gate. Sample spaces are private to the visitor who starts them.
import { state, api, esc, act, go, draft, render, md } from "../core.js";
import { icon } from "../icons.js";
import { orb, pearl } from "../persona.js";
import { stageMarkup, startStage } from "../stage.js";
import { announce } from "../a11y.js";

let config = null;
let policyDocs = {};
let spaceType = "work";

/** Radio change on the sign-up form (Personal / Enterprise). */
document.addEventListener("change", (e) => { if (e.target.name === "signup-kind") { spaceType = e.target.value; render(); document.querySelector(`input[name="signup-kind"][value="${spaceType}"]`)?.focus(); } });

export async function loadAuthConfig() { config = await api("GET", "/api/auth/config"); state.config = config; }

export const brand = (href = "#/") => `<a class="brand" href="${href}" aria-label="Agamya home"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 100 100">${pearl("bm", { still: true })}</svg></span><span class="brand-name">Agamya</span></a>`;

export function authView(r) {
  if (!config) { loadAuthConfig().then(render); return `<div class="landing"><span class="thinking" style="margin:40px">Loading</span></div>`; }
  if (r.name === "login") return page(loginCard());
  if (r.name === "signup") { if (r.id === "personal") spaceType = "living"; if (r.id === "enterprise") spaceType = "work"; return page(signupCard()); }
  if (r.name === "invite") return page(inviteCard(r.id));
  setTimeout(startStage, 0);
  return landing();
}

const page = (card) => `<div class="landing"><header class="land-head">${brand()}<span class="spacer"></span><a class="btn ghost" href="#/">Back</a></header>
  <main id="main" class="land-auth"><form class="auth-card card pad" data-noop-submit>${card}</form></main></div>`;

function landing() {
  const steps = [["Capture", "The expert works as usual, on screen or on camera, and talks if they like. Only what they agree to is captured."],
    ["Understand", "Moti watches quietly and asks one short question at a natural pause, about what just happened."],
    ["Validate", "A short debrief, then Moti explains it back until the expert says: yes, that is how it works."],
    ["Transfer", "The next person practises on their own screen. Moti steps in before a wrong decision, in the expert's words."]];
  return `<div class="landing">
  <header class="lp-head">${brand()}<span class="spacer"></span><a class="btn ghost sm" href="#/login">Sign in</a></header>
  <main id="main" class="lp-main" tabindex="-1">
    <div class="stage-wrap" style="position:relative">${stageMarkup()}<div class="stage-scrim" aria-hidden="true"></div>
      <div class="stage-copy"><h1>Pass on what you know, without losing why.</h1>
        <p>From a dancer's footwork to a month-end payment run: Agamya watches an expert work, asks why at the right moment, and teaches the next person to decide the same way.</p></div></div>
    <section class="lp-modes" aria-label="Choose how you use Agamya">
      <article class="lp-mode work" aria-labelledby="m-work">
        <div class="eyebrow">Agamya for Work</div>
        <h2 id="m-work">Before your expert retires, their judgment is captured, mapped and taught.</h2>
        <ul><li>Share your screen and work; Moti asks why at natural pauses</li><li>A Work Map of every step, reason and guardrail, in the expert's words</li><li>A tutor that stops the new hire before a wrong decision</li><li>Schedules, permissions and groups for your organization</li></ul>
        ${config.allowSignup ? `<a class="btn primary" href="#/signup/enterprise">Start with your screen</a>` : `<a class="btn primary" href="#/login">Sign in</a>`}
      </article>
      <article class="lp-mode culture" aria-labelledby="m-culture">
        <div class="eyebrow">Agamya for Culture</div>
        <h2 id="m-culture">Crafts, dance, recipes and languages, kept with their reasons.</h2>
        <ul><li>Point your camera and practise; Moti asks in your language</li><li>Private by default; you choose who learns from you</li></ul>
        ${config.allowSignup ? `<a class="btn primary" href="#/signup/personal">Start with your camera</a>` : ""}
      </article>
    </section>
    ${config.judges?.length ? `<p class="lp-judges"><b>Judging?</b> Ready-made Work and Culture accounts are on the <a href="#/login">sign-in page</a>.</p>` : ""}
    <section class="lp-section" aria-labelledby="how-h"><h2 id="how-h">How Agamya works</h2>
      <ol class="lp-steps">${steps.map(([t, d], n) => `<li><span class="n">0${n + 1}</span><b>${t}</b><span class="small muted">${d}</span></li>`).join("")}</ol>
      <p class="small muted" style="margin-top:16px">Built on Gemini (Vertex AI) and Google Cloud. A practice result shows understanding in simulation; it is not a certification.</p>
    </section>
    ${videoSection()}
  </main>
  <footer class="land-foot small muted">Agamya · <a href="#/login">Sign in</a></footer>
</div>`;
}

/** "See how Agamya works": a real player only when a video is configured (DEMO_VIDEO_URL); otherwise an honest, non-playable placeholder. */
function videoSection() {
  const v = config.demoVideo;
  if (v?.url) {
    return `<section class="video-section" aria-labelledby="vid-h"><h2 id="vid-h">${esc(v.title)}</h2>
      <figure class="video-frame"><video controls preload="metadata" ${v.poster ? `poster="${esc(v.poster)}"` : ""} aria-describedby="vid-desc">
        <source src="${esc(v.url)}">${v.captionsUrl ? `<track kind="captions" src="${esc(v.captionsUrl)}" srclang="en" label="English" default>` : ""}
        Your browser cannot play this video.${v.transcriptUrl ? ` <a href="${esc(v.transcriptUrl)}">Read the transcript</a>.` : ""}</video>
        <figcaption id="vid-desc" class="small muted">A walkthrough of capture, understanding, validation and transfer.${v.transcriptUrl ? ` <a href="${esc(v.transcriptUrl)}">Transcript</a>.` : ""}${v.captionsUrl ? "" : " Captions are not available for this video yet."}</figcaption></figure></section>`;
  }
  return `<section class="video-section" aria-labelledby="vid-h"><h2 id="vid-h">See how Agamya works</h2>
    <div class="video-frame placeholder" role="note" aria-label="Product walkthrough video: coming soon, not yet playable">
      <div class="video-ph-inner">${orb("observing", 72, { caption: false })}<p><b>Product walkthrough coming soon</b></p><p class="small muted">There is no video here yet, so there is nothing to play. Until then, open a sample space above to see the real product.</p></div>
    </div></section>`;
}

function loginCard() {
  return `<h1>Sign in</h1>
    <label class="field" for="li-email">Email<input id="li-email" data-draft="li-email" type="email" autocomplete="username" required aria-required="true"></label>
    <label class="field" for="li-pw">Password<input id="li-pw" data-draft="li-pw" type="password" autocomplete="current-password" required aria-required="true"></label>
    <button class="primary" data-act="login" ${state.busy ? "disabled" : ""}>${icon("lock", 15)} Sign in</button>
    ${config.oidc ? `<a class="btn" href="/api/auth/oidc/start">Continue with ${esc(config.oidc.label)}</a>` : ""}
    ${config.allowSignup ? `<a class="small" href="#/signup">Create a new space</a>` : ""}
    ${judgeBox()}`;
}

/** Shared judge accounts (when the deployment turns them on): credentials shown, one click fills the form. */
function judgeBox() {
  if (!config.judges?.length) return "";
  return `<section class="judge-box" aria-labelledby="judge-h"><h2 id="judge-h" class="h3">Judging Agamya?</h2>
    <p class="small muted">Shared accounts with real, empty spaces. Anything you capture is visible to other judges.</p>
    <ul class="plain">${config.judges.map((j) => `<li><b>${esc(j.label)}</b><br><span class="small mono">${esc(j.email)} · ${esc(j.password)}</span><br>
      <button class="sm" data-act="judge-fill" data-key="${esc(j.key)}">Fill in ${j.key === "work" ? "Work" : "Culture"} judge</button></li>`).join("")}</ul></section>`;
}

function signupCard() {
  if (!config.allowSignup) return `<h1>Sign-up is closed</h1><p class="muted">Ask an administrator to invite you.</p>`;
  const personal = spaceType === "living";
  return `<h1>Create a space</h1>
    <fieldset class="seg-fieldset"><legend class="small"><b>Kind of space</b> <span class="muted">(you can create the other kind later)</span></legend>
      <div class="kind-choices">${[["living", "Agamya Personal", "For you, your family, friends or community. Private by default."], ["work", "Agamya Enterprise", "For an organization: KT missions, roles, groups, outcomes. You become the owner."]]
        .map(([k, l, d]) => `<label class="kind-choice ${spaceType === k ? "on" : ""}"><input type="radio" name="signup-kind" value="${k}" ${spaceType === k ? "checked" : ""}> <span><b>${l}</b><br><span class="small muted">${d}</span></span></label>`).join("")}</div></fieldset>
    <label class="field" for="su-org">${personal ? "Name of your space" : "Organization"}<input id="su-org" data-draft="su-org" autocomplete="organization" placeholder="${personal ? "Our family kitchen" : "Northwind Operations"}" required aria-required="true"></label>
    <label class="field" for="su-name">Your name<input id="su-name" data-draft="su-name" autocomplete="name" required aria-required="true"></label>
    <label class="field" for="su-email">Email<input id="su-email" data-draft="su-email" type="email" autocomplete="email" required aria-required="true"></label>
    <label class="field" for="su-pw">Password <span class="faint">(12+ characters)</span><input id="su-pw" data-draft="su-pw" type="password" autocomplete="new-password" required aria-required="true" aria-describedby="su-pw-help"></label>
    <span id="su-pw-help" class="small muted">At least 12 characters. Not your email.</span>
    <button class="primary" data-act="signup" ${state.busy ? "disabled" : ""}>Create ${personal ? "Personal space" : "Enterprise organization"}</button>
    <a class="small" href="#/login">I already have an account</a>`;
}

let inviteInfo = null, inviteInfoFor = null;
function inviteCard(token) {
  if (inviteInfoFor !== token) {
    inviteInfoFor = token; inviteInfo = null;
    api("POST", "/api/auth/invite-info", { token }).then((x) => { inviteInfo = x; render(); }).catch((e) => { inviteInfo = { error: e.message }; render(); });
  }
  if (!inviteInfo) return `<span class="thinking">Opening your invitation</span>`;
  if (inviteInfo.error) return `<h1>Invitation not available</h1><p class="muted">${esc(inviteInfo.error)}</p><a class="btn" href="#/login">Sign in</a>`;
  const i = inviteInfo;
  return `<h1>Join ${esc(i.spaceName)}</h1>
    <p class="muted">${i.invitedBy ? `${esc(i.invitedBy)} invited` : "You were invited as"} <b>${esc(i.email)}</b>.</p>
    ${i.hasAccount
      ? `<p class="callout small">You already have an Agamya account with this email. Enter <b>your own Agamya password</b> (the one you sign in with) to add this space to your account. There is no separate password for a space.</p>
         <label class="field">Your Agamya password<input data-draft="in-pw" type="password" autocomplete="current-password"></label>`
      : `<p class="callout small">Create your Agamya account: choose your name and a password of at least 12 characters. This password is yours, for every space you join; there is no separate password for a space.</p>
         <label class="field">Your name<input data-draft="in-name" autocomplete="name"></label>
         <label class="field">Choose a password<input data-draft="in-pw" type="password" autocomplete="new-password" minlength="12"></label>`}
    <button class="primary" data-act="accept-invite" data-token="${esc(token ?? "")}" ${state.busy ? "disabled" : ""}>Join ${esc(i.spaceName)}</button>
    <p class="small muted">Signed in already with this email? You can also accept from your <a href="#/inbox">Invitations</a> page.</p>`;
}

async function finishLogin(next = "#/") {
  state.me = await api("GET", "/api/auth/me");
  state.workflows = [];
  go(state.me.policies?.pending?.length ? "#/policies" : next);
}

export async function authClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "space") { spaceType = t.dataset.v; return render(); }
  if (a === "sample") return act("sample", async () => { await api("POST", "/api/samples", { kind: t.dataset.kind }); await finishLogin(t.dataset.kind === "living" ? "#/journey" : "#/missions"); location.reload(); });
  if (a === "judge-fill") {
    const j = config.judges.find((x) => x.key === t.dataset.key);
    state.drafts["li-email"] = j.email; state.drafts["li-pw"] = j.password; render();
    document.querySelector('[data-act="login"]')?.focus(); announce(`Filled in the ${j.label} account. Press Sign in.`); return;
  }
  if (a === "login") return act("login", async () => { await api("POST", "/api/auth/login", { email: draft("li-email"), password: state.drafts["li-pw"] ?? "" }); state.drafts["li-pw"] = ""; await finishLogin(); location.reload(); });
  if (a === "signup") return act("signup", async () => { await api("POST", "/api/auth/signup", { orgName: draft("su-org"), displayName: draft("su-name"), email: draft("su-email"), password: state.drafts["su-pw"] ?? "", experience: spaceType }); state.drafts["su-pw"] = ""; await finishLogin(spaceType === "living" ? "#/start/camera" : "#/start/screen"); location.reload(); });
  if (a === "accept-invite") return act("invite", async () => { await api("POST", "/api/auth/accept-invite", { token: t.dataset.token, displayName: draft("in-name"), password: state.drafts["in-pw"] ?? "" }); await finishLogin(); location.reload(); });
}

// ---------------------------------------------------------------- policies gate
export function policiesView() {
  const p = state.me?.policies;
  if (!p) return `<span class="thinking">Loading</span>`;
  const pending = new Set(p.pending);
  for (const d of p.policies) if (!policyDocs[d.id]) { policyDocs[d.id] = "loading"; api("GET", `/api/policies/${d.id}`).then((doc) => { policyDocs[d.id] = doc; render(); }); }
  return `<div class="page-head"><div><div class="eyebrow">Before you continue</div><h1>Policies for ${esc(state.me.org?.name)}</h1>
    <p>These are versioned. Your acceptance is recorded with the version and a hash of its text. Recording consent is asked separately, each time capture starts.</p></div></div>
    <div class="grid" style="max-width:900px">${p.policies.map((d) => `<details class="card pad" ${pending.has(d.id) && p.policies.indexOf(d) === 0 ? "open" : ""}>
      <summary class="row between" style="cursor:pointer"><span><b>${esc(d.title)}</b> <span class="small muted">v${esc(d.version)}</span> ${d.requiredAtSignIn ? "" : '<span class="tag sky">accepted per capture session</span>'}</span>
      ${d.accepted ? '<span class="tag green">accepted</span>' : d.requiredAtSignIn ? '<span class="tag pink">required</span>' : ""}</summary>
      <div class="policy-doc" style="margin-top:10px">${typeof policyDocs[d.id] === "object" ? md(policyDocs[d.id].content_md) : '<span class="thinking">Loading</span>'}</div></details>`).join("")}
    ${p.pending.length ? `<label class="check"><input type="checkbox" id="accept-all" data-focus="accept-all"> I have read and accept the required policies above</label>
      <div><button class="primary" data-act="accept-policies" ${state.busy ? "disabled" : ""}>Accept and continue</button></div>` : `<div><a class="btn primary" href="#/">Continue</a></div>`}</div>`;
}

export async function policiesClick(e) {
  const t = e.target.closest("[data-act]");
  if (t?.dataset.act === "accept-policies") {
    if (!document.getElementById("accept-all")?.checked) return void document.getElementById("accept-all")?.focus();
    return act("accept", async () => { await api("POST", "/api/policies/accept", { ids: state.me.policies.pending }); state.me = await api("GET", "/api/auth/me"); go(state.me.org?.sampleKind === "living" ? "#/journey" : state.me.org?.sampleKind === "work" ? "#/transfers" : state.me.org?.experience === "living" ? "#/start/camera" : "#/start/screen"); location.reload(); });
  }
}
