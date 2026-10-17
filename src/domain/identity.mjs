// Identity: users, organizations, memberships, sessions, invitations. Authentication only, no business authorization.
// Sessions are opaque server-side records: the browser holds a random 256-bit token in an HttpOnly cookie; the
// database holds only its SHA-256. A separate CSRF token (also hashed at rest) protects state-changing requests.
import { hashPassword, verifyPassword, passwordProblems, newToken, sha256, httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { ROLES, OWNER_GRANTED, COORDINATOR_INVITABLE } from "../platform/authz.mjs";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

export function createIdentity({ db, cfg }) {
  async function createSession(q, { userId, orgId, ip, ua }) {
    const token = newToken();
    const csrfToken = newToken();
    const [s] = await q(
      `INSERT INTO auth_sessions (user_id, token_hash, csrf_hash, active_org_id, expires_at, ip_hash, user_agent)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval, $6, $7) RETURNING id, expires_at`,
      [userId, sha256(token), sha256(csrfToken), orgId, String(cfg.auth.sessionTtlHours), ip, String(ua ?? "").slice(0, 200)],
    );
    return { token, csrfToken, sessionId: s.id, expiresAt: s.expires_at };
  }

  async function ensurePerson(q, orgId, user) {
    const [p] = await q("SELECT id FROM people WHERE org_id = $1 AND user_id = $2", [orgId, user.id]);
    if (p) return p.id;
    const [n] = await q("INSERT INTO people (org_id, user_id, display_name) VALUES ($1,$2,$3) RETURNING id", [orgId, user.id, user.display_name]);
    return n.id;
  }

  /** A space created by a person: Personal ('living') or Enterprise ('work'). The creator owns it. */
  async function insertSpace(q, { name, experience, userId }) {
    const slug = `${slugify(name)}-${newToken().slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const [org] = await q("INSERT INTO organizations (name, slug, settings, experience) VALUES ($1,$2,$3,$4) RETURNING *", [name.trim().slice(0, 80), slug, JSON.stringify(defaultOrgSettings(cfg)), experience === "living" ? "living" : "work"]);
    await q("INSERT INTO workspaces (org_id, name) VALUES ($1,'Default')", [org.id]);
    await q("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1,$2,$3)", [org.id, userId, founderRoles(org.experience)]);
    return org;
  }

  return {
    ensurePerson,

    /** A signed-in person creates another space (any number; membership in one never implies access to another). */
    async createSpace(ctx, { name, kind }, requestId) {
      if (!ctx?.userId) throw httpError(401, "sign in required");
      if (!cfg.auth.allowSignup) throw httpError(403, "creating spaces is disabled here; ask an administrator");
      name = String(name ?? "").trim();
      if (!name) throw httpError(400, "give the space a name");
      if (!["personal", "enterprise"].includes(kind)) throw httpError(400, "choose Personal or Enterprise");
      return db.system(async (q) => {
        const [{ n }] = await q("SELECT count(*)::int AS n FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND 'ORG_OWNER' = ANY(m.roles) AND o.deleted_at IS NULL AND o.sample_kind IS NULL", [ctx.userId]);
        if (n >= 20) throw httpError(429, "you already own 20 spaces");
        const [user] = await q("SELECT * FROM users WHERE id = $1", [ctx.userId]);
        const org = await insertSpace(q, { name, experience: kind === "personal" ? "living" : "work", userId: ctx.userId });
        await ensurePerson(q, org.id, user);
        await q("UPDATE auth_sessions SET active_org_id = $2 WHERE id = $1", [ctx.sessionId, org.id]);
        await audit(q, { orgId: org.id, userId: ctx.userId, action: "space.create", targetType: "organization", targetId: org.id, requestId, metadata: { kind } });
        return { id: org.id, name: org.name, kind };
      });
    },

    /** Self-service sign-up creates a new organization with the caller as its admin. */
    async signup({ orgName, email, password, displayName, experience = "work", ip, ua, requestId }) {
      if (!cfg.auth.allowSignup) throw httpError(403, "sign-up is disabled; ask your administrator for an invitation");
      email = String(email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw httpError(400, "enter a valid email address");
      const problems = passwordProblems(password, email);
      if (problems.length) throw httpError(400, `password: ${problems.join("; ")}`);
      if (!String(orgName ?? "").trim() || !String(displayName ?? "").trim()) throw httpError(400, "organization and name are required");
      const hash = await hashPassword(password);
      return db.system(async (q) => {
        const [exists] = await q("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
        if (exists) throw httpError(409, "an account with this email already exists");
        const [user] = await q("INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING *", [email, displayName.trim().slice(0, 80), hash]);
        const slug = `${slugify(orgName)}-${newToken().slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
        const [org] = await q("INSERT INTO organizations (name, slug, settings, experience) VALUES ($1,$2,$3,$4) RETURNING *", [orgName.trim().slice(0, 80), slug, JSON.stringify(defaultOrgSettings(cfg)), experience === "living" ? "living" : "work"]);
        await q("INSERT INTO workspaces (org_id, name) VALUES ($1,'Default')", [org.id]);
        // In a family / community space the founder is usually also the first teacher.
        await q("INSERT INTO memberships (org_id, user_id, roles) VALUES ($1,$2,$3)", [org.id, user.id, founderRoles(org.experience)]);
        await ensurePerson(q, org.id, user);
        const s = await createSession(q, { userId: user.id, orgId: org.id, ip, ua });
        await audit(q, { orgId: org.id, userId: user.id, action: "auth.signup", targetType: "organization", targetId: org.id, requestId, ipHash: ip });
        return { ...s, userId: user.id, orgId: org.id };
      });
    },

    async login({ email, password, ip, ua, requestId }) {
      email = String(email ?? "").trim().toLowerCase();
      const user = (await db.system((q) => q("SELECT * FROM users WHERE lower(email) = $1 AND status = 'active'", [email])))[0];
      const judge = Boolean(cfg.judges?.enabled && cfg.judges.accounts.some((a) => a.email === email));
      if (!judge && user?.locked_until && new Date(user.locked_until) > new Date()) {
        await db.system((q) => audit(q, { userId: user.id, action: "auth.login", outcome: "denied", requestId, ipHash: ip, metadata: { reason: "locked" } }));
        throw httpError(429, "too many failed attempts; try again later");
      }
      const ok = await verifyPassword(String(password ?? ""), user?.password_hash);
      if (!user || !ok) {
        // Record the failure in its own committed transaction, THEN reject (throwing inside it would roll it back).
        await db.system(async (q) => {
          if (user) {
            await q(`UPDATE users SET failed_logins = failed_logins + 1,
                     locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
              [user.id, cfg.auth.maxFailedLogins, String(cfg.auth.lockoutMinutes)]);
          }
          await audit(q, { userId: user?.id ?? null, action: "auth.login", outcome: "denied", requestId, ipHash: ip, metadata: { reason: "bad_credentials" } });
        });
        throw httpError(401, "email or password is incorrect"); // same message whether or not the account exists
      }
      return db.system(async (q) => {
        await q("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);
        const [m] = await q("SELECT org_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1", [user.id]);
        const s = await createSession(q, { userId: user.id, orgId: m?.org_id ?? null, ip, ua });
        await audit(q, { orgId: m?.org_id ?? null, userId: user.id, action: "auth.login", requestId, ipHash: ip });
        return { ...s, userId: user.id, orgId: m?.org_id ?? null };
      });
    },

    /**
     * Demo-only passwordless sign-in. Enabled only with DEMO_LOGIN (never in production by default), and only for
     * accounts whose every membership is in a demo organization, so it can never be used to enter a real tenant.
     */
    async demoLogin({ email, ip, ua, requestId }) {
      return db.system(async (q) => {
        const [u] = await q("SELECT id FROM users WHERE lower(email) = lower($1) AND status = 'active'", [String(email ?? "")]);
        if (!u) throw httpError(404, "not a demo account");
        const ms = await q("SELECT m.org_id, o.is_demo, o.sample_kind FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND m.status = 'active'", [u.id]);
        // Shared demo org only: never a real organization, never a visitor's private sample space.
        if (!ms.length || ms.some((m) => !m.is_demo || m.sample_kind)) throw httpError(403, "not a demo account");
        await q("UPDATE users SET last_login_at = now() WHERE id = $1", [u.id]);
        const s = await createSession(q, { userId: u.id, orgId: ms[0].org_id, ip, ua });
        await audit(q, { orgId: ms[0].org_id, userId: u.id, action: "auth.demo_login", requestId, ipHash: ip });
        return { ...s, userId: u.id, orgId: ms[0].org_id };
      });
    },

    /** OIDC (Google Workspace / enterprise IdP): link or create a user from a verified ID token's claims. */
    async loginWithOidc({ provider, subject, email, emailVerified, name, ip, ua, requestId }) {
      if (!emailVerified) throw httpError(403, "your identity provider did not verify this email");
      return db.system(async (q) => {
        let [ident] = await q("SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2", [provider, subject]);
        let userId = ident?.user_id;
        if (!userId) {
          let [u] = await q("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
          if (!u) [u] = await q("INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id", [email, String(name || email).slice(0, 80)]);
          userId = u.id;
          await q("INSERT INTO user_identities (user_id, provider, subject) VALUES ($1,$2,$3)", [userId, provider, subject]);
        }
        const [m] = await q("SELECT org_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1", [userId]);
        const [active] = await q("UPDATE users SET last_login_at = now() WHERE id = $1 AND status = 'active' RETURNING id", [userId]);
        if (!active) throw httpError(403, "this account is disabled");
        const s = await createSession(q, { userId, orgId: m?.org_id ?? null, ip, ua });
        await audit(q, { orgId: m?.org_id ?? null, userId, action: "auth.login", requestId, ipHash: ip, metadata: { provider } });
        return { ...s, userId, orgId: m?.org_id ?? null };
      });
    },

    /** Resolve a cookie token into a request context. Expiry + idle timeout enforced here. */
    async resolve(token) {
      if (!token || token.length < 40) return null;
      const rows = await db.system((q) => q(
        `SELECT s.id AS session_id, s.user_id, s.active_org_id, s.csrf_hash, s.expires_at, s.last_seen_at,
                u.email, u.display_name, u.status, u.preferred_language, m.roles, m.status AS membership_status, o.name AS org_name, o.is_demo, o.experience, o.sample_kind,
                o.passcode_hash IS NOT NULL AS has_passcode, (s.active_org_id = ANY(s.unlocked_orgs)) AS unlocked
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN memberships m ON m.org_id = s.active_org_id AND m.user_id = s.user_id
         LEFT JOIN organizations o ON o.id = s.active_org_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL`, [sha256(token)]));
      const r = rows[0];
      if (!r || r.status !== "active") return null;
      const now = Date.now();
      if (new Date(r.expires_at).getTime() < now) return null;
      if (now - new Date(r.last_seen_at).getTime() > cfg.auth.idleTimeoutMinutes * 60000) return null;
      if (now - new Date(r.last_seen_at).getTime() > 60000) db.system((q) => q("UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1", [r.session_id])).catch(() => {});
      const active = r.membership_status === "active";
      let personId = null;
      if (active) personId = (await db.tenant({ orgId: r.active_org_id, userId: r.user_id }, (q) => q("SELECT id FROM people WHERE user_id = $1", [r.user_id])))[0]?.id ?? null;
      return {
        sessionId: r.session_id, userId: r.user_id, email: r.email, displayName: r.display_name, csrfHash: r.csrf_hash,
        orgId: active ? r.active_org_id : null, orgName: active ? r.org_name : null, isDemoOrg: Boolean(r.is_demo), experience: r.experience ?? "work", sampleKind: r.sample_kind ?? null, language: r.preferred_language ?? null,
        roles: active ? r.roles : [], personId,
        // Optional space passcode: until it is entered in this sign-in session, only sign-in and space switching work.
        spaceHasPasscode: Boolean(active && r.has_passcode), spaceLocked: Boolean(active && r.has_passcode && !r.unlocked),
      };
    },

    /** Owner: set, change or remove this space's passcode. Changing it locks the space again in every other session. */
    async setSpacePasscode(ctx, { passcode = null }, requestId) {
      if (!ctx.orgId || !ctx.roles?.includes("ORG_OWNER")) throw httpError(403, "only the owner of this space can set its passcode");
      const code = passcode == null ? null : String(passcode);
      if (code !== null && (code.length < 6 || code.length > 128)) throw httpError(400, "use a passcode of at least 6 characters");
      const hash = code === null ? null : await hashPassword(code);
      return db.system(async (q) => {
        await q("UPDATE organizations SET passcode_hash = $2, passcode_set_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1", [ctx.orgId, hash]);
        await q("UPDATE auth_sessions SET unlocked_orgs = array_remove(unlocked_orgs, $1) WHERE $1 = ANY(unlocked_orgs)", [ctx.orgId]);
        if (hash) await q("UPDATE auth_sessions SET unlocked_orgs = array_append(unlocked_orgs, $2) WHERE id = $1", [ctx.sessionId, ctx.orgId]);
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: hash ? "space.passcode_set" : "space.passcode_remove", targetType: "organization", targetId: ctx.orgId, requestId });
        return { passcode: Boolean(hash) };
      });
    },

    /** Enter the space's passcode for this sign-in session. */
    async unlockSpace(ctx, { passcode }, requestId) {
      if (!ctx.orgId) throw httpError(400, "no space selected");
      const [o] = await db.system((q) => q("SELECT passcode_hash FROM organizations WHERE id = $1", [ctx.orgId]));
      if (!o?.passcode_hash) return { unlocked: true };
      const ok = await verifyPassword(String(passcode ?? ""), o.passcode_hash);
      await db.system(async (q) => {
        if (ok) await q("UPDATE auth_sessions SET unlocked_orgs = array_append(array_remove(unlocked_orgs, $2), $2) WHERE id = $1", [ctx.sessionId, ctx.orgId]);
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "space.unlock", outcome: ok ? "success" : "denied", targetType: "organization", targetId: ctx.orgId, requestId });
      });
      if (!ok) throw httpError(401, "that passcode is not right; ask the space owner");
      return { unlocked: true };
    },

    async logout(ctx, requestId) {
      await db.system(async (q) => {
        await q("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1", [ctx.sessionId]);
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "auth.logout", requestId });
      });
    },

    async rotateCsrf(ctx) {
      const csrfToken = newToken();
      await db.system((q) => q("UPDATE auth_sessions SET csrf_hash = $2 WHERE id = $1", [ctx.sessionId, sha256(csrfToken)]));
      return csrfToken;
    },

    async organizationsOf(userId) {
      return db.system((q) => q(`SELECT o.id, o.name, m.roles, CASE WHEN o.experience = 'living' THEN 'personal' ELSE 'enterprise' END AS kind, o.sample_kind FROM memberships m JOIN organizations o ON o.id = m.org_id
                                 WHERE m.user_id = $1 AND m.status = 'active' AND o.deleted_at IS NULL ORDER BY o.name`, [userId]));
    },

    async switchOrg(ctx, orgId) {
      const [m] = await db.system((q) => q("SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'active'", [ctx.userId, orgId]));
      if (!m) throw httpError(403, "not a member of that organization");
      await db.system(async (q) => {
        await q("UPDATE auth_sessions SET active_org_id = $2 WHERE id = $1", [ctx.sessionId, orgId]);
        await audit(q, { orgId, userId: ctx.userId, action: "auth.switch_org" });
      });
    },

    // ---------------------------------------------------------------- members & invitations (admin; authz checked by caller)
    async listMembers(ctx) {
      return db.system((q) => q(`SELECT u.id AS user_id, u.email, u.display_name, m.roles, m.status, u.last_login_at
                                 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.status = 'active' ORDER BY u.display_name`, [ctx.orgId]));
    },

    /**
     * Remove someone from this space (owners and admins). Their access ends at once (open sessions in this space are
     * closed) and they leave the space's groups. What they contributed stays with the space; an invitation can bring
     * them back. You cannot remove yourself or the last owner; only an owner removes an owner or an administrator.
     */
    async removeMember(ctx, userId, requestId) {
      if (userId === ctx.userId) throw httpError(409, "you cannot remove yourself; ask another admin");
      return db.system(async (q) => {
        const [m] = await q("SELECT roles, status FROM memberships WHERE org_id = $1 AND user_id = $2", [ctx.orgId, userId]);
        if (!m || m.status !== "active") throw httpError(404, "member not found");
        if (OWNER_GRANTED.some((r) => m.roles.includes(r)) && !ctx.roles.includes("ORG_OWNER")) throw httpError(403, "only the space owner can remove an owner or administrator");
        if (m.roles.includes("ORG_OWNER")) {
          const owners = await q("SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND status = 'active' AND 'ORG_OWNER' = ANY(roles)", [ctx.orgId]);
          if (owners[0].n <= 1) throw httpError(409, "a space must keep at least one owner");
        }
        await q("UPDATE memberships SET status = 'removed', updated_at = now() WHERE org_id = $1 AND user_id = $2", [ctx.orgId, userId]);
        await q("UPDATE auth_sessions SET active_org_id = NULL WHERE user_id = $1 AND active_org_id = $2", [userId, ctx.orgId]);
        await q(`UPDATE group_members SET removed_at = now() WHERE removed_at IS NULL AND person_id IN (SELECT id FROM people WHERE org_id = $1 AND user_id = $2)`, [ctx.orgId, userId]);
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "members.remove", targetType: "user", targetId: userId, requestId });
        return { removed: true };
      });
    },

    async setRoles(ctx, userId, roles, requestId) {
      if (!Array.isArray(roles) || !roles.length || roles.some((r) => !ROLES.includes(r))) throw httpError(400, "invalid roles");
      return db.system(async (q) => {
        const [current] = await q("SELECT roles FROM memberships WHERE org_id = $1 AND user_id = $2", [ctx.orgId, userId]);
        if (!current) throw httpError(404, "member not found");
        // Ownership is distinct from administration: only an owner grants or removes the owner and administrator roles.
        const touchesOwnerRoles = OWNER_GRANTED.some((r) => current.roles.includes(r) !== roles.includes(r));
        if (touchesOwnerRoles && !ctx.roles.includes("ORG_OWNER")) throw httpError(403, "only the space owner can change owner or administrator roles");
        const owners = await q("SELECT user_id FROM memberships WHERE org_id = $1 AND status = 'active' AND 'ORG_OWNER' = ANY(roles)", [ctx.orgId]);
        if (owners.length === 1 && owners[0].user_id === userId && !roles.includes("ORG_OWNER")) throw httpError(409, "a space must keep at least one owner");
        const admins = await q("SELECT user_id FROM memberships WHERE org_id = $1 AND status = 'active' AND 'ORG_ADMIN' = ANY(roles)", [ctx.orgId]);
        if (admins.length === 1 && admins[0].user_id === userId && !roles.includes("ORG_ADMIN")) throw httpError(409, "an organization must keep at least one admin");
        const r = await q("UPDATE memberships SET roles = $3, updated_at = now() WHERE org_id = $1 AND user_id = $2 RETURNING user_id", [ctx.orgId, userId, roles]);
        if (!r.length) throw httpError(404, "member not found");
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "members.set_roles", targetType: "user", targetId: userId, requestId, metadata: { roles } });
      });
    },

    async invite(ctx, { email, roles }, requestId) {
      email = String(email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw httpError(400, "enter a valid email address");
      if (!Array.isArray(roles) || !roles.length || roles.some((r) => !ROLES.includes(r))) throw httpError(400, "invalid roles");
      const manager = ctx.roles.some((r) => ["ORG_OWNER", "ORG_ADMIN"].includes(r));
      if (!manager && roles.some((r) => !COORDINATOR_INVITABLE.includes(r))) throw httpError(403, "coordinators can invite subject matter experts and receivers only");
      if (roles.some((r) => OWNER_GRANTED.includes(r)) && !ctx.roles.includes("ORG_OWNER")) throw httpError(403, "only the space owner can invite owners or administrators");
      const token = newToken();
      const invitationId = await db.system(async (q) => {
        const [inv] = await q("INSERT INTO invitations (org_id, email, roles, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id", [ctx.orgId, email, roles, sha256(token), ctx.userId]);
        // An existing account sees the invitation in its inbox (it is listed there by email; nothing is emailed).
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "members.invite", targetType: "invitation", targetId: inv.id, requestId, metadata: { roles, emailHash: sha256(email).slice(0, 16) } });
        return inv.id;
      });
      // No email delivery in this build: the admin shares the link out of band.
      return { id: invitationId, inviteUrl: `${cfg.publicOrigin}/#/invite/${token}`, expiresInDays: 7 };
    },

    async listInvitations(ctx) {
      return db.system((q) => q(`SELECT i.id, i.email, i.roles, i.status, i.created_at, i.expires_at, u.display_name AS invited_by
                                 FROM invitations i LEFT JOIN users u ON u.id = i.invited_by WHERE i.org_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [ctx.orgId]));
    },

    async revokeInvitation(ctx, invitationId, requestId) {
      return db.system(async (q) => {
        const [inv] = await q("UPDATE invitations SET status = 'revoked', revoked_at = now(), revoked_by = $3 WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING id", [invitationId, ctx.orgId, ctx.userId]);
        if (!inv) throw httpError(404, "no pending invitation with that id");
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "members.revoke_invite", targetType: "invitation", targetId: inv.id, requestId });
        return { revoked: true };
      });
    },

    /** What the join page needs to explain the next step (only to the holder of the link). */
    async inviteInfo(token) {
      return db.system(async (q) => {
        const [inv] = await q(`SELECT i.email, i.expires_at, o.name AS space_name, o.experience, u.display_name AS invited_by,
                                      EXISTS (SELECT 1 FROM users x WHERE lower(x.email) = lower(i.email)) AS has_account
                               FROM invitations i JOIN organizations o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by
                               WHERE i.token_hash = $1 AND i.status = 'pending' AND i.accepted_at IS NULL AND i.expires_at > now()`, [sha256(String(token ?? ""))]);
        if (!inv) throw httpError(404, "this invitation is invalid, already used or expired: ask for a new one");
        return { email: inv.email, spaceName: inv.space_name, experience: inv.experience, invitedBy: inv.invited_by, hasAccount: inv.has_account, expiresAt: inv.expires_at };
      });
    },

    async acceptInvite({ token, displayName, password, ip, ua, requestId }) {
      return db.system(async (q) => {
        const [inv] = await q("SELECT * FROM invitations WHERE token_hash = $1 AND status = 'pending' AND accepted_at IS NULL AND expires_at > now()", [sha256(String(token ?? ""))]);
        if (!inv) throw httpError(404, "invitation is invalid or expired");
        let [user] = await q("SELECT * FROM users WHERE lower(email) = $1", [inv.email]);
        // An existing account must prove it is theirs: the link alone never signs anyone in to an existing account
        // (otherwise whoever held the link could enter that person's account and every space they belong to).
        if (user && !user.password_hash) throw httpError(403, "this email already has an account that signs in another way: sign in, then accept the invitation from your Invitations page");
        if (user && !(await verifyPassword(String(password ?? ""), user.password_hash))) throw httpError(401, "this email already has an Agamya account: enter that account's password to join");
        if (!user) {
          const problems = passwordProblems(password, inv.email);
          if (problems.length) throw httpError(400, `password: ${problems.join("; ")}`);
          [user] = await q("INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING *", [inv.email, String(displayName || inv.email).slice(0, 80), await hashPassword(password)]);
        }
        await q(`INSERT INTO memberships (org_id, user_id, roles) VALUES ($1,$2,$3)
                 ON CONFLICT (org_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, status = 'active', updated_at = now()`, [inv.org_id, user.id, inv.roles]);
        await ensurePerson(q, inv.org_id, user);
        await q("UPDATE invitations SET accepted_at = now(), status = 'accepted' WHERE id = $1", [inv.id]);
        const s = await createSession(q, { userId: user.id, orgId: inv.org_id, ip, ua });
        await audit(q, { orgId: inv.org_id, userId: user.id, action: "members.accept_invite", requestId, ipHash: ip });
        return { ...s, userId: user.id, orgId: inv.org_id };
      });
    },

    /** Used by seeding and tests (system scope). */
    /**
     * Sign in to a per-visitor sample space. Only for users whose every membership is in that one sample space, so it can
     * never be used to enter a real organization or another visitor's sample.
     */
    async sampleLogin({ userId, orgId, ip, ua, requestId, carryPoliciesFrom = null }) {
      return db.system(async (q) => {
        const [o] = await q("SELECT id FROM organizations WHERE id = $1 AND is_demo AND sample_kind IS NOT NULL AND deleted_at IS NULL", [orgId]);
        if (!o) throw httpError(404, "sample space not found");
        const ms = await q("SELECT org_id FROM memberships WHERE user_id = $1 AND status = 'active'", [userId]);
        if (!ms.length || ms.some((m) => m.org_id !== orgId)) throw httpError(403, "not a sample account");
        const [u] = await q("UPDATE users SET last_login_at = now() WHERE id = $1 AND status = 'active' RETURNING id", [userId]);
        if (!u) throw httpError(403, "account disabled");
        if (carryPoliciesFrom) {
          // The same visitor already accepted these policies as another person in this sample space; record that link.
          const acc = await q("SELECT * FROM policy_acceptances WHERE org_id = $1 AND user_id = $2", [orgId, carryPoliciesFrom]);
          for (const a of acc) {
            await q(`INSERT INTO policy_acceptances (org_id, user_id, policy_document_id, policy_type, policy_version, content_sha256, ip_hash, user_agent)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [orgId, userId, a.policy_document_id, a.policy_type, a.policy_version, a.content_sha256, ip, "sample space: carried from the same visitor"]);
          }
          if (acc.length) await audit(q, { orgId, userId, action: "policy.accept", requestId, metadata: { carriedFromUser: carryPoliciesFrom, sampleSpace: true, count: acc.length } });
        }
        const s = await createSession(q, { userId, orgId, ip, ua });
        await audit(q, { orgId, userId, action: "auth.sample_login", requestId, ipHash: ip });
        return s;
      });
    },

    /** The user's language preference (interface and default content language). Stored on the user; never shared. */
    async setLanguage(ctx, code) {
      await db.system((q) => q("UPDATE users SET preferred_language = $2, updated_at = now() WHERE id = $1", [ctx.userId, code]));
    },

    async createUserWithMembership({ email, displayName, password, orgId, roles, title = "" }) {
      const hash = password ? await hashPassword(password) : null;
      return db.system(async (q) => {
        let [user] = await q("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
        if (!user) [user] = await q("INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING *", [email, displayName, hash]);
        await q(`INSERT INTO memberships (org_id, user_id, roles) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO UPDATE SET roles = EXCLUDED.roles`, [orgId, user.id, roles]);
        const personId = await ensurePerson(q, orgId, user);
        if (title) await q("UPDATE people SET title = $2 WHERE id = $1", [personId, title]);
        return { userId: user.id, personId };
      });
    },
  };
}

/** The creator of a space owns it. In a Personal space they are usually also its first teacher. */
export function founderRoles(experience) {
  return experience === "living" ? ["ORG_OWNER", "ORG_ADMIN", "WORKFLOW_OWNER", "EXPERT"] : ["ORG_OWNER", "ORG_ADMIN", "WORKFLOW_OWNER"];
}

export function defaultOrgSettings(cfg) {
  return {
    aiMonthlyBudgetUsd: cfg.ai.defaultMonthlyBudgetUsd,
    // Retention (days) per data class. Validated knowledge and audit records are long-lived by design.
    retention: { raw_media: 30, transcript: 180, semantic: 730, knowledge: null, audit: 2555 },
    captureDefaults: { recordVideoEvidence: false },
  };
}
