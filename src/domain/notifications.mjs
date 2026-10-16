// In-app notifications and the signed-in person's inbox (pending space invitations + notifications).
// No email or other external delivery exists in this build; nothing here sends messages outside the application.
// Inserts are idempotent per (user, dedupe key), so retried jobs and repeated actions never duplicate a notification.
// Content is deliberately minimal: a title naming the mission or space and who acted, never brief or knowledge content.
import { httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";

/** Notify one person (by people.id) inside a tenant transaction. People without a login are skipped. */
export async function notifyPerson(q, { orgId, personId, kind, title, body = "", link = "", dedupeKey }) {
  const [p] = await q("SELECT user_id FROM people WHERE id = $1", [personId]);
  if (!p?.user_id) return false;
  return notifyUser(q, { orgId, userId: p.user_id, kind, title, body, link, dedupeKey });
}
export async function notifyUser(q, { orgId, userId, kind, title, body = "", link = "", dedupeKey }) {
  // Through app_notify(): recipient must be an active member of the current space; only they can read it afterwards.
  void orgId; // the space is always the current tenant (app_org()), never a caller-supplied id
  const [r] = await q("SELECT app_notify($1,$2,$3,$4,$5,$6) AS ok", [userId, kind, String(title), String(body), link, dedupeKey]);
  return Boolean(r?.ok);
}

export function createNotifications({ db }) {
  async function inbox(ctx) {
    if (!ctx?.userId) throw httpError(401, "sign in required");
    return db.system(async (q) => {
      const invitations = await q(`SELECT i.id, i.org_id, o.name AS space_name, o.experience, i.roles, i.created_at, i.expires_at, u.display_name AS invited_by
                                   FROM invitations i JOIN organizations o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by
                                   WHERE lower(i.email) = lower($1) AND i.status = 'pending' AND i.expires_at > now() AND o.deleted_at IS NULL
                                     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = i.org_id AND m.user_id = $2 AND m.status = 'active')
                                   ORDER BY i.created_at DESC`, [ctx.email, ctx.userId]);
      const items = await q(`SELECT n.id, n.org_id, o.name AS space_name, n.kind, n.title, n.body, n.link, n.read_at, n.created_at
                             FROM notifications n LEFT JOIN organizations o ON o.id = n.org_id
                             WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [ctx.userId]);
      return {
        invitations: invitations.map((i) => ({ id: i.id, spaceId: i.org_id, spaceName: i.space_name, kind: i.experience === "living" ? "personal" : "enterprise", roles: i.roles, invitedBy: i.invited_by, createdAt: i.created_at, expiresAt: i.expires_at })),
        notifications: items.map((n) => ({ id: n.id, spaceId: n.org_id, spaceName: n.space_name, kind: n.kind, title: n.title, body: n.body, link: n.link, read: Boolean(n.read_at), createdAt: n.created_at })),
        unread: items.filter((n) => !n.read_at).length + invitations.length,
      };
    });
  }

  async function markRead(ctx, { ids = null, all = false }) {
    if (!ctx?.userId) throw httpError(401, "sign in required");
    await db.system((q) => all
      ? q("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [ctx.userId])
      : q("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL", [ctx.userId, ids ?? []]));
    return { ok: true };
  }

  /** Accept or decline a space invitation addressed to the signed-in user's email (no token needed: identity is proven). */
  async function respondToInvitation(ctx, invitationId, { accept }, ensurePerson) {
    if (!ctx?.userId) throw httpError(401, "sign in required");
    return db.system(async (q) => {
      const [inv] = await q("SELECT * FROM invitations WHERE id = $1 AND lower(email) = lower($2) AND status = 'pending' AND expires_at > now()", [invitationId, ctx.email]);
      if (!inv) throw httpError(404, "invitation not found");
      if (accept) {
        await q(`INSERT INTO memberships (org_id, user_id, roles) VALUES ($1,$2,$3)
                 ON CONFLICT (org_id, user_id) DO UPDATE SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(memberships.roles || EXCLUDED.roles) r), status = 'active', updated_at = now()`, [inv.org_id, ctx.userId, inv.roles]);
        const [u] = await q("SELECT * FROM users WHERE id = $1", [ctx.userId]);
        await ensurePerson(q, inv.org_id, u);
        await q("UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1", [inv.id]);
      } else {
        await q("UPDATE invitations SET status = 'declined', declined_at = now() WHERE id = $1", [inv.id]);
      }
      await audit(q, { orgId: inv.org_id, userId: ctx.userId, action: accept ? "members.accept_invite" : "members.decline_invite", targetType: "invitation", targetId: inv.id, requestId: ctx.requestId });
      return { spaceId: inv.org_id, accepted: Boolean(accept) };
    });
  }

  return { inbox, markRead, respondToInvitation };
}
