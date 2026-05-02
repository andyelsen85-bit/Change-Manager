import { randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, roleAssignmentsTable } from "@workspace/db";

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const RAW_SECRET = process.env["JWT_SECRET"];
if (NODE_ENV === "production" && (!RAW_SECRET || RAW_SECRET.length < 16)) {
  throw new Error(
    "JWT_SECRET environment variable is required in production (min 16 chars). " +
      "Refusing to start with a default secret.",
  );
}
const JWT_SECRET = RAW_SECRET ?? "dev-only-change-mgmt-secret-do-not-use-in-prod";
const COOKIE_NAME = "cm_session";
const CSRF_COOKIE_NAME = "cm_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const TOKEN_TTL_SECONDS = 60 * 60 * 12;

export type SessionPayload = {
  uid: number;
  username: string;
  isAdmin: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionPayload;
    return { uid: decoded.uid, username: decoded.username, isAdmin: !!decoded.isAdmin };
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

// Sets the CSRF token cookie used by the double-submit pattern. The cookie
// is intentionally NOT HttpOnly so the frontend can read it and echo the
// value back in the `X-CSRF-Token` header on every mutating request.
export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: NODE_ENV === "production",
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: "/",
  });
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
}

export function readCsrfCookie(req: Request): string | null {
  const value = (req as Request & { cookies?: Record<string, string> }).cookies?.[CSRF_COOKIE_NAME];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Double-submit CSRF check: requires the request to carry both the
// non-HttpOnly `cm_csrf` cookie and a matching `X-CSRF-Token` header on
// state-changing methods. Safe (read-only) methods are passed through.
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  const cookieToken = readCsrfCookie(req);
  const headerRaw = req.headers[CSRF_HEADER_NAME];
  const headerToken = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    res.status(403).json({ error: "Invalid or missing CSRF token" });
    return;
  }
  next();
}

export function readSessionCookie(req: Request): SessionPayload | null {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) return null;
  return verifySession(token);
}

// Returns true when the request carried a session cookie that failed verification —
// i.e. an expired or tampered JWT. Used by middleware to emit `auth.session_expired`
// audit events distinct from anonymous (no-cookie) traffic.
export function hasInvalidSessionCookie(req: Request): boolean {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) return false;
  return verifySession(token) === null;
}

async function maybeAuditExpired(req: Request): Promise<void> {
  if (!hasInvalidSessionCookie(req)) return;
  // Best-effort; never fail the request because of audit IO.
  try {
    const { audit } = await import("./audit");
    await audit(
      req,
      {
        action: "auth.session_expired",
        entityType: "user",
        entityId: null,
        summary: "Rejected request: expired or invalid session token",
        after: { reason: "invalid_or_expired_token" },
      },
      { id: null, name: "anonymous" },
    );
  } catch {
    // swallow — audit failures shouldn't change request semantics
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = readSessionCookie(req);
  if (!session) {
    await maybeAuditExpired(req);
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.session = session;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = readSessionCookie(req);
  if (!session) {
    await maybeAuditExpired(req);
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!session.isAdmin) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  req.session = session;
  next();
}

export async function loadUserRoles(userId: number): Promise<string[]> {
  const rows = await db
    .select({ roleKey: roleAssignmentsTable.roleKey })
    .from(roleAssignmentsTable)
    .where(eq(roleAssignmentsTable.userId, userId));
  return Array.from(new Set(rows.map((r) => r.roleKey)));
}

export async function loadUserById(id: number) {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  return u;
}

export function requireRole(roles: string[]) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = readSessionCookie(req);
    if (!session) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (session.isAdmin) {
      req.session = session;
      next();
      return;
    }
    const userRoles = await loadUserRoles(session.uid);
    const ok = userRoles.some((r) => roles.includes(r));
    if (!ok) {
      res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
      return;
    }
    req.session = session;
    next();
  };
}

// Governance roles whose holders are authorised to act on any change request
// regardless of ownership / assignment. These are the cross-cutting roles that
// run the change-management process: the Change Manager, the eCAB members who
// authorise emergency changes, and the CAB chair who runs the meeting. Other
// roles (technical_reviewer, business_owner, implementer, ...) are scoped to
// their specific contributions and do not get blanket access.
export const GOVERNANCE_ROLES = ["change_manager", "ecab_member", "cab_chair"] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

export type ChangeAccessReason =
  | "owner"
  | "assignee"
  | "admin"
  | GovernanceRole
  | null;

export async function getChangeAccess(
  session: SessionPayload,
  change: { ownerId: number; assigneeId: number | null },
): Promise<ChangeAccessReason> {
  if (session.isAdmin) return "admin";
  if (change.ownerId === session.uid) return "owner";
  if (change.assigneeId === session.uid) return "assignee";
  const userRoles = await loadUserRoles(session.uid);
  for (const role of GOVERNANCE_ROLES) {
    if (userRoles.includes(role)) return role;
  }
  return null;
}

// Returns true when the access reason represents a privileged caller — admin
// or any governance role — i.e. someone who can perform restricted operations
// (deletion, signed-off planning override, transitions into the approval
// state) regardless of whether they are owner / assignee.
export function isPrivilegedAccess(reason: ChangeAccessReason): boolean {
  if (reason === "admin") return true;
  if (reason === null) return false;
  return (GOVERNANCE_ROLES as readonly string[]).includes(reason);
}
