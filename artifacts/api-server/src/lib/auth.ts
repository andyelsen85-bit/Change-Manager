import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, roleAssignmentsTable } from "@workspace/db";

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-change-mgmt-secret-change-me";
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
    secure: false,
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

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = readSessionCookie(req);
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.session = session;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = readSessionCookie(req);
  if (!session) {
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
