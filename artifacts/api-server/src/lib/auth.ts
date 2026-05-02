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

export type ChangeAccessReason = "owner" | "assignee" | "admin" | "change_manager" | null;

export async function getChangeAccess(
  session: SessionPayload,
  change: { ownerId: number; assigneeId: number | null },
): Promise<ChangeAccessReason> {
  if (session.isAdmin) return "admin";
  if (change.ownerId === session.uid) return "owner";
  if (change.assigneeId === session.uid) return "assignee";
  const userRoles = await loadUserRoles(session.uid);
  if (userRoles.includes("change_manager")) return "change_manager";
  return null;
}
