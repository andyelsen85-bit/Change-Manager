import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  loadUserRoles,
  generateCsrfToken,
  setCsrfCookie,
  clearCsrfCookie,
  readCsrfCookie,
} from "../lib/auth";
import { audit } from "../lib/audit";
import { authenticateLdap, getLdap } from "../lib/ldap";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }
  // Find local user
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.username, username));

  if (existing && existing.source === "local") {
    if (!existing.isActive) {
      await audit(
        req,
        {
          action: "auth.login_failed",
          entityType: "user",
          entityId: existing.id,
          summary: `Failed login for ${username} (account disabled)`,
          after: { authMethod: "local", failureReason: "account_disabled", username },
        },
        { id: null, name: username },
      );
      res.status(401).json({ error: "Account disabled" });
      return;
    }
    const ok = existing.passwordHash ? await verifyPassword(password, existing.passwordHash) : false;
    if (!ok) {
      await audit(
        req,
        {
          action: "auth.login_failed",
          entityType: "user",
          entityId: existing.id,
          summary: `Failed login for ${username}`,
          after: { authMethod: "local", failureReason: "bad_password", username },
        },
        { id: null, name: username },
      );
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const roles = await loadUserRoles(existing.id);
    const token = signSession({ uid: existing.id, username: existing.username, isAdmin: existing.isAdmin });
    setSessionCookie(req, res, token);
    setCsrfCookie(req, res, generateCsrfToken());
    await audit(
      req,
      {
        action: "auth.login",
        entityType: "user",
        entityId: existing.id,
        summary: `User ${existing.username} logged in (local)`,
        after: { authMethod: "local", username: existing.username },
      },
      { id: existing.id, name: existing.username },
    );
    res.json({
      id: existing.id,
      username: existing.username,
      email: existing.email,
      fullName: existing.fullName,
      source: existing.source,
      roles,
      isAdmin: existing.isAdmin,
      mustChangePassword: existing.mustChangePassword,
    });
    return;
  }

  // Try LDAP
  const ldapCfg = await getLdap();
  if (ldapCfg?.enabled) {
    const r = await authenticateLdap(username, password);
    if (r.ok) {
      let userRow = existing;
      if (!userRow) {
        const [created] = await db
          .insert(usersTable)
          .values({
            username: r.username,
            email: r.email,
            fullName: r.fullName,
            source: "ldap",
            isActive: true,
            isAdmin: false,
          })
          .returning();
        userRow = created;
      } else if (userRow.source === "ldap") {
        // Self-heal: keep the local copy of name + email in sync with the
        // directory so role-assignment lists, CAB rosters, and notifications
        // always show the current attributes. We only touch fields where the
        // LDAP value is non-empty so a transient attribute miss doesn't blank
        // out a previously-good record. Admin-set isAdmin / isActive flags
        // are never overwritten.
        const desired: Partial<typeof usersTable.$inferInsert> = {};
        if (r.fullName && r.fullName !== userRow.fullName) desired.fullName = r.fullName;
        if (r.email && r.email !== userRow.email) desired.email = r.email;
        if (Object.keys(desired).length > 0) {
          const [refreshed] = await db
            .update(usersTable)
            .set(desired)
            .where(eq(usersTable.id, userRow.id))
            .returning();
          if (refreshed) userRow = refreshed;
        }
      }
      const roles = await loadUserRoles(userRow.id);
      const token = signSession({ uid: userRow.id, username: userRow.username, isAdmin: userRow.isAdmin });
      setSessionCookie(req, res, token);
      setCsrfCookie(req, res, generateCsrfToken());
      await audit(
        req,
        {
          action: "auth.login",
          entityType: "user",
          entityId: userRow.id,
          summary: `User ${userRow.username} logged in (ldap)`,
          after: { authMethod: "ldap", username: userRow.username },
        },
        { id: userRow.id, name: userRow.username },
      );
      res.json({
        id: userRow.id,
        username: userRow.username,
        email: userRow.email,
        fullName: userRow.fullName,
        source: userRow.source,
        roles,
        isAdmin: userRow.isAdmin,
        mustChangePassword: false,
      });
      return;
    }
  }

  await audit(
    req,
    {
      action: "auth.login_failed",
      entityType: "user",
      entityId: null,
      summary: `Failed login for ${username}`,
      after: {
        authMethod: existing?.source === "ldap" || ldapCfg?.enabled ? "ldap" : "local",
        failureReason: existing ? "bad_credentials" : "unknown_user",
        username,
      },
    },
    { id: null, name: username },
  );
  res.status(401).json({ error: "Invalid credentials" });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const session = readSessionCookie(req);
  clearSessionCookie(res);
  clearCsrfCookie(res);
  if (session) {
    await audit(req, {
      action: "auth.logout",
      entityType: "user",
      entityId: session.uid,
      summary: `User ${session.username} logged out`,
    }, { id: session.uid, name: session.username });
  }
  res.status(204).end();
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const session = readSessionCookie(req);
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, session.uid));
  if (!u) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  // Heal sessions that pre-date CSRF rollout (or where the CSRF cookie was
  // pruned by the browser) by minting a fresh token. Without this the user
  // would be unable to perform any mutating action until they log out and
  // back in.
  if (!readCsrfCookie(req)) {
    setCsrfCookie(req, res, generateCsrfToken());
  }
  const roles = await loadUserRoles(u.id);
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    source: u.source,
    roles,
    isAdmin: u.isAdmin,
    mustChangePassword: u.mustChangePassword,
  });
});

// First-time setup. The seeded admin row is created with password_hash=NULL.
// Until that row gets a password, the app exposes a setup wizard that lets
// any visitor set the admin password. Once set, this endpoint refuses
// further calls and the only way to change the admin password is through
// the authenticated /auth/change-password flow.
router.get("/auth/setup-status", async (_req, res): Promise<void> => {
  const [admin] = await db
    .select({ id: usersTable.id, passwordHash: usersTable.passwordHash })
    .from(usersTable)
    .where(eq(usersTable.username, "admin"));
  // We only consider the system "needs setup" when the seeded admin row
  // exists with no password. If the admin has been seeded with a password
  // (env: INITIAL_ADMIN_PASSWORD) or has already claimed it, the wizard is
  // off. If the admin row is missing entirely, that's a degenerate state we
  // also treat as "no setup" so we don't expose a wizard that would create
  // an admin out of nowhere.
  const needsSetup = !!admin && admin.passwordHash === null;
  res.json({ needsSetup });
});

router.post("/auth/setup", async (req, res): Promise<void> => {
  const { password } = req.body ?? {};
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  // Atomic claim: hash first, then a single conditional UPDATE that
  // matches only the un-claimed admin row. This ensures that if two
  // requests race, only the first one gets a row back; the loser sees 0
  // rows and returns 409 without overwriting the winner's password. We
  // intentionally do not run a SELECT-then-UPDATE, which is racy.
  const passwordHash = await hashPassword(password);
  const claimed = await db
    .update(usersTable)
    .set({ passwordHash, mustChangePassword: false })
    .where(and(eq(usersTable.username, "admin"), isNull(usersTable.passwordHash)))
    .returning();
  if (claimed.length === 0) {
    // Either no admin row exists (degenerate) or it is already claimed.
    // We return the same generic 409 in both cases so the response does
    // not leak which.
    res.status(409).json({ error: "Setup already completed" });
    return;
  }
  const admin = claimed[0]!;
  // Auto-login: mint a session so the operator goes straight into the app.
  const token = signSession({ uid: admin.id, username: admin.username, isAdmin: admin.isAdmin });
  setSessionCookie(req, res, token);
  setCsrfCookie(req, res, generateCsrfToken());
  await audit(
    req,
    {
      action: "auth.setup_completed",
      entityType: "user",
      entityId: admin.id,
      summary: `First-time setup completed for ${admin.username}`,
    },
    { id: admin.id, name: admin.username },
  );
  const roles = await loadUserRoles(admin.id);
  res.json({
    id: admin.id,
    username: admin.username,
    email: admin.email,
    fullName: admin.fullName,
    source: admin.source,
    roles,
    isAdmin: admin.isAdmin,
    mustChangePassword: false,
  });
});

router.post("/auth/change-password", async (req, res): Promise<void> => {
  const session = readSessionCookie(req);
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8) {
    res.status(400).json({ error: "newPassword must be at least 8 characters" });
    return;
  }
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, session.uid));
  if (!u || u.source !== "local") {
    res.status(400).json({ error: "Password change is only supported for local accounts" });
    return;
  }
  if (!u.passwordHash || !(await verifyPassword(currentPassword, u.passwordHash))) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: "New password must be different from the current password" });
    return;
  }
  const newHash = await hashPassword(newPassword);
  await db
    .update(usersTable)
    .set({ passwordHash: newHash, mustChangePassword: false })
    .where(eq(usersTable.id, u.id));
  await audit(req, {
    action: "auth.password_changed",
    entityType: "user",
    entityId: u.id,
    summary: `User ${u.username} changed their password`,
  });
  res.status(204).end();
});

export default router;
