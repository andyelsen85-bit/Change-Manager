import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  signSession,
  setSessionCookie,
  setCsrfCookie,
  generateCsrfToken,
  loadUserRoles,
} from "../lib/auth";
import { audit } from "../lib/audit";
import { acceptSpnego, getSso } from "../lib/sso";

const router: IRouter = Router();

// Defence-in-depth against credentialed cross-origin SSO. The global CORS
// policy reflects the request origin (`origin: true`) for credentialed
// requests, which combined with SameSite=None session cookies would let
// a malicious page silently complete SPNEGO from a victim's browser
// (Negotiate is handled by the browser any time the URL is in the
// trusted/intranet zone, regardless of the originating page) and then
// read authenticated APIs cross-origin. We reject any request to
// /auth/sso whose Origin header doesn't match the Host. Same-origin
// browser calls (Origin == our host) and non-browser callers (no Origin
// header) still work — the latter matters for curl-based diagnostics.
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      res.status(403).json({ error: "Cross-origin requests are not allowed for SSO" });
      return;
    }
    if (originHost !== (req.headers.host ?? "")) {
      res.status(403).json({ error: "Cross-origin requests are not allowed for SSO" });
      return;
    }
  }
  next();
}

// GET /auth/sso/status — public, used by the login page to decide whether
// to render the "Sign in with Windows" button. Returns only the bits the
// frontend needs; the keytab and krb5.conf bytes are NEVER exposed.
router.get("/auth/sso/status", async (_req, res): Promise<void> => {
  const cfg = await getSso();
  res.json({
    enabled: !!(cfg && cfg.enabled && cfg.servicePrincipal && cfg.keytabB64),
  });
});

// POST /auth/sso — drives the SPNEGO handshake.
//
// First leg (no Authorization header):
//   401 + WWW-Authenticate: Negotiate
//
// Second leg (Authorization: Negotiate <base64>):
//   200 + session cookie + user JSON, OR
//   401 + WWW-Authenticate: Negotiate <continuation> for multi-round
//        handshakes (rare with modern AD), OR
//   401/403 with a JSON {error, stage, details} body when the handshake
//        fails outright (bad ticket, missing keytab, clock skew, ...).
router.post("/auth/sso", requireSameOrigin, async (req, res): Promise<void> => {
  const cfg = await getSso();
  if (!cfg || !cfg.enabled) {
    res.status(404).json({ error: "SSO is not enabled" });
    return;
  }
  const auth = req.headers["authorization"] ?? null;
  const result = await acceptSpnego(typeof auth === "string" ? auth : null);

  if (!result.ok) {
    if (result.wwwAuthenticate) {
      // Tell the browser to (re)attempt SPNEGO. We must send 401 here so
      // the WWW-Authenticate negotiation kicks in client-side.
      res.setHeader("WWW-Authenticate", result.wwwAuthenticate);
      res.status(401).json({ error: result.reason, stage: result.stage });
      return;
    }
    // Configuration / module / ticket failure: surface the diagnostic so
    // the admin can act on it.
    const status = result.stage === "config" || result.stage === "module" ? 503 : 401;
    res.status(status).json({
      error: result.reason,
      stage: result.stage,
      details: "details" in result ? result.details : undefined,
    });
    await audit(
      req,
      {
        action: "auth.sso_failed",
        entityType: "user",
        entityId: null,
        summary: `SSO handshake failed at stage=${result.stage}`,
        after: { stage: result.stage, reason: result.reason },
      },
      { id: null, name: "anonymous" },
    );
    return;
  }

  // Successful handshake — map the principal onto a local user. The flow
  // mirrors the LDAP login path: look up by username, optionally
  // auto-create with sensible defaults, then mint a session.
  const username = result.username;
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.username, username));
  let userRow = existing;
  if (!userRow) {
    if (!cfg.autoCreateUsers) {
      res.status(403).json({
        error:
          `User "${username}" is not provisioned in this app. Ask an administrator ` +
          `to add the account first, or enable "Auto-create users on first SSO" in Settings → SSO.`,
        stage: "provisioning",
      });
      await audit(
        req,
        {
          action: "auth.sso_failed",
          entityType: "user",
          entityId: null,
          summary: `SSO bind ok but user ${username} is not provisioned`,
          after: { principal: result.principal, username, reason: "not_provisioned" },
        },
        { id: null, name: username },
      );
      return;
    }
    const emailDomain = cfg.defaultEmailDomain || "sso.local";
    const [created] = await db
      .insert(usersTable)
      .values({
        username,
        email: `${username}@${emailDomain}`,
        fullName: username,
        // Reuse the `ldap` source so the existing UI distinguishes
        // directory-backed accounts from local ones — they have the
        // same semantics (no local password, no rotation prompt).
        source: "ldap",
        isActive: true,
        isAdmin: false,
      })
      .returning();
    userRow = created;
  } else if (!userRow.isActive) {
    res.status(401).json({ error: "Account disabled" });
    await audit(
      req,
      {
        action: "auth.sso_failed",
        entityType: "user",
        entityId: userRow.id,
        summary: `SSO bind ok but ${username} is disabled`,
        after: { principal: result.principal, reason: "account_disabled" },
      },
      { id: userRow.id, name: userRow.username },
    );
    return;
  }

  // If the SPNEGO exchange produced a final continuation token, the spec
  // says we should hand it back so the client can complete mutual
  // authentication. Modern browsers ignore it but it's free to include.
  if (result.continuationToken) {
    res.setHeader("WWW-Authenticate", `Negotiate ${result.continuationToken}`);
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
      summary: `User ${userRow.username} logged in (sso/kerberos)`,
      after: { authMethod: "sso", principal: result.principal, username: userRow.username },
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
});

export default router;
