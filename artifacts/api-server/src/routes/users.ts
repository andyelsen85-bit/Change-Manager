import { Router, type IRouter } from "express";
import { and, eq, ilike, or } from "drizzle-orm";
import {
  db,
  usersTable,
  roleAssignmentsTable,
  notificationPreferencesTable,
} from "@workspace/db";
import { hashPassword, requireAuth, requireAdmin } from "../lib/auth";
import { audit } from "../lib/audit";
import { NOTIFICATION_EVENTS } from "../lib/events";

const router: IRouter = Router();

async function userToDto(u: typeof usersTable.$inferSelect) {
  const roleRows = await db
    .select({ roleKey: roleAssignmentsTable.roleKey })
    .from(roleAssignmentsTable)
    .where(eq(roleAssignmentsTable.userId, u.id));
  const roles = Array.from(new Set(roleRows.map((r) => r.roleKey)));
  let deputyName: string | null = null;
  if (u.deputyUserId != null) {
    const [d] = await db.select().from(usersTable).where(eq(usersTable.id, u.deputyUserId));
    deputyName = d ? d.fullName : null;
  }
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    source: u.source,
    isActive: u.isActive,
    isAdmin: u.isAdmin,
    deputyUserId: u.deputyUserId,
    deputyUserName: deputyName,
    roles,
    createdAt: u.createdAt,
  };
}

// Slim DTO returned to non-admin callers. The full directory (including email,
// admin flag, deputies, account source) is admin-only — non-admins only need to
// pick assignees / display names. We deliberately omit username so identifiers
// useful for authentication enumeration aren't leaked.
function userToPublicDto(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    fullName: u.fullName,
    isActive: u.isActive,
  };
}

router.get("/users", requireAuth, async (req, res): Promise<void> => {
  const search = typeof req.query["search"] === "string" ? req.query["search"] : null;
  const role = typeof req.query["role"] === "string" ? req.query["role"] : null;
  const conds = [];
  if (search) {
    conds.push(
      or(
        ilike(usersTable.username, `%${search}%`),
        ilike(usersTable.email, `%${search}%`),
        ilike(usersTable.fullName, `%${search}%`),
      )!,
    );
  }
  let rows = conds.length
    ? await db.select().from(usersTable).where(and(...conds))
    : await db.select().from(usersTable);
  if (role) {
    const ra = await db.select().from(roleAssignmentsTable).where(eq(roleAssignmentsTable.roleKey, role));
    const ids = new Set(ra.map((r) => r.userId));
    rows = rows.filter((u) => ids.has(u.id));
  }
  if (req.session?.isAdmin) {
    const dtos = await Promise.all(rows.map(userToDto));
    res.json(dtos);
    return;
  }
  // Non-admin: only active users, slim public DTO (assignee dropdown use case).
  res.json(rows.filter((u) => u.isActive).map(userToPublicDto));
});

router.post("/users", requireAdmin, async (req, res): Promise<void> => {
  const { username, email, fullName, password, source, isAdmin, deputyUserId, roles } = req.body ?? {};
  if (typeof username !== "string" || typeof email !== "string" || typeof fullName !== "string") {
    res.status(400).json({ error: "username, email, fullName required" });
    return;
  }
  const src = source === "ldap" ? "ldap" : "local";
  const passwordHash = src === "local" && typeof password === "string" && password ? await hashPassword(password) : null;
  const [created] = await db
    .insert(usersTable)
    .values({
      username,
      email,
      fullName,
      source: src,
      passwordHash,
      isAdmin: !!isAdmin,
      deputyUserId: deputyUserId ?? null,
    })
    .returning();
  if (Array.isArray(roles)) {
    for (const r of roles) {
      if (typeof r === "string" && r) {
        await db.insert(roleAssignmentsTable).values({ roleKey: r, userId: created.id, isDeputy: false }).onConflictDoNothing();
      }
    }
  }
  await audit(req, {
    action: "user.created",
    entityType: "user",
    entityId: created.id,
    summary: `Created ${src} user ${username}`,
    after: { username, email, fullName, source: src, isAdmin: !!isAdmin },
  });
  res.status(201).json(await userToDto(created));
});

router.patch("/users/me", requireAuth, async (req, res): Promise<void> => {
  const session = req.session!;
  const [before] = await db.select().from(usersTable).where(eq(usersTable.id, session.uid));
  if (!before) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const { email, fullName } = req.body ?? {};
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (typeof email === "string" && email.length > 0) updates.email = email;
  if (typeof fullName === "string" && fullName.length > 0) updates.fullName = fullName;
  if (Object.keys(updates).length === 0) {
    res.json(await userToDto(before));
    return;
  }
  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, session.uid)).returning();
  await audit(req, {
    action: "user.self_updated",
    entityType: "user",
    entityId: session.uid,
    summary: `Updated own profile`,
    before: { email: before.email, fullName: before.fullName },
    after: { email: updated.email, fullName: updated.fullName },
  });
  res.json(await userToDto(updated));
});

router.get("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!u) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // Admins and the user themselves get the full record. Everyone else gets the
  // slim public DTO (no email, no admin flag, no deputy, no source).
  if (req.session?.isAdmin || req.session?.uid === id) {
    res.json(await userToDto(u));
    return;
  }
  res.json(userToPublicDto(u));
});

router.patch("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!before) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const { email, fullName, isActive, isAdmin, password, deputyUserId, roles } = req.body ?? {};
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (typeof email === "string") updates.email = email;
  if (typeof fullName === "string") updates.fullName = fullName;
  if (typeof isActive === "boolean") updates.isActive = isActive;
  if (typeof isAdmin === "boolean") updates.isAdmin = isAdmin;
  if (deputyUserId === null) updates.deputyUserId = null;
  else if (typeof deputyUserId === "number") updates.deputyUserId = deputyUserId;
  if (typeof password === "string" && password.length >= 8) {
    updates.passwordHash = await hashPassword(password);
  }
  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (Array.isArray(roles)) {
    await db.delete(roleAssignmentsTable).where(eq(roleAssignmentsTable.userId, id));
    for (const r of roles) {
      if (typeof r === "string" && r) {
        await db.insert(roleAssignmentsTable).values({ roleKey: r, userId: id, isDeputy: false }).onConflictDoNothing();
      }
    }
  }
  await audit(req, {
    action: "user.updated",
    entityType: "user",
    entityId: id,
    summary: `Updated user ${before.username}`,
    before: { email: before.email, fullName: before.fullName, isActive: before.isActive, isAdmin: before.isAdmin },
    after: { email: updated.email, fullName: updated.fullName, isActive: updated.isActive, isAdmin: updated.isAdmin },
  });
  res.json(await userToDto(updated));
});

router.delete("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  if (req.session?.uid === id) {
    res.status(400).json({ error: "Cannot delete yourself" });
    return;
  }
  const [before] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!before) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  await audit(req, {
    action: "user.deleted",
    entityType: "user",
    entityId: id,
    summary: `Deleted user ${before.username}`,
    before,
  });
  res.status(204).end();
});

router.get("/users/:id/notification-preferences", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  if (req.session && req.session.uid !== id && !req.session.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const existing = await db
    .select()
    .from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.userId, id));
  const byKey = new Map(existing.map((p) => [p.eventKey, p]));
  const merged = NOTIFICATION_EVENTS.map((e) => {
    const found = byKey.get(e.key);
    return {
      eventKey: e.key,
      emailEnabled: found ? found.emailEnabled : true,
      inAppEnabled: found ? found.inAppEnabled : true,
    };
  });
  res.json(merged);
});

router.put("/users/:id/notification-preferences", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  if (req.session && req.session.uid !== id && !req.session.isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const body = Array.isArray(req.body) ? req.body : [];
  for (const item of body) {
    if (!item || typeof item.eventKey !== "string") continue;
    await db
      .insert(notificationPreferencesTable)
      .values({
        userId: id,
        eventKey: item.eventKey,
        emailEnabled: item.emailEnabled !== false,
        inAppEnabled: item.inAppEnabled !== false,
      })
      .onConflictDoUpdate({
        target: [notificationPreferencesTable.userId, notificationPreferencesTable.eventKey],
        set: { emailEnabled: item.emailEnabled !== false, inAppEnabled: item.inAppEnabled !== false },
      });
  }
  await audit(req, {
    action: "user.notification_prefs_updated",
    entityType: "user",
    entityId: id,
    summary: `Updated notification preferences`,
    after: body,
  });
  const updated = await db
    .select()
    .from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.userId, id));
  const byKey = new Map(updated.map((p) => [p.eventKey, p]));
  res.json(
    NOTIFICATION_EVENTS.map((e) => {
      const found = byKey.get(e.key);
      return {
        eventKey: e.key,
        emailEnabled: found ? found.emailEnabled : true,
        inAppEnabled: found ? found.inAppEnabled : true,
      };
    }),
  );
});

export default router;
