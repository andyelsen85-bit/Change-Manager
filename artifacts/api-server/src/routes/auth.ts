import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
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
    setSessionCookie(res, token);
    setCsrfCookie(res, generateCsrfToken());
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
      }
      const roles = await loadUserRoles(userRow.id);
      const token = signSession({ uid: userRow.id, username: userRow.username, isAdmin: userRow.isAdmin });
      setSessionCookie(res, token);
      setCsrfCookie(res, generateCsrfToken());
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
    setCsrfCookie(res, generateCsrfToken());
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
  const newHash = await hashPassword(newPassword);
  await db.update(usersTable).set({ passwordHash: newHash }).where(eq(usersTable.id, u.id));
  await audit(req, {
    action: "auth.password_changed",
    entityType: "user",
    entityId: u.id,
    summary: `User ${u.username} changed their password`,
  });
  res.status(204).end();
});

export default router;
