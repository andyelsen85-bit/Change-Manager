import type { Request, Response } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import * as workspaceDb from "@workspace/db";
import { assertStrongSecret, resolveSessionSecret } from "./secret-validation";

type PoolLike = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
};

function getPool(): PoolLike | undefined {
  try {
    return (workspaceDb as unknown as { pool?: PoolLike }).pool;
  } catch {
    return undefined;
  }
}

function requirePool(): PoolLike {
  const pool = getPool();
  if (!pool) {
    throw new Error("PostgreSQL pool is unavailable; persisted sessions cannot be used.");
  }
  return pool;
}

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "cm_session";
const DEV_SESSION_SECRET = "dev-only-change-mgmt-secret-do-not-use-in-prod";

/**
 * SESSION_SECRET is the new setting. JWT_SECRET remains an explicit
 * compatibility name for installations that have not renamed their key yet;
 * it is not used to create JWTs.
 */
export function getSessionSecret(): string {
  const secret = resolveSessionSecret();
  if (NODE_ENV === "production") {
    assertStrongSecret("SESSION_SECRET (or JWT_SECRET for compatibility)", secret);
  }
  return secret ?? DEV_SESSION_SECRET;
}

const PgSession = connectPgSimple(session);

export function createSessionMiddleware() {
  const pool = requirePool();
  return session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
      // Keep the server-side expiry fixed at the cookie TTL. With touch
      // enabled, any request could extend a stolen session indefinitely even
      // though rolling cookies are disabled.
      ttl: SESSION_TTL_MS / 1000,
      disableTouch: true,
    }),
    name: SESSION_COOKIE_NAME,
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      maxAge: SESSION_TTL_MS,
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
  });
}

export type SessionPayload = {
  uid: number;
  username: string;
  isAdmin: boolean;
  /**
   * Password/session-generation claim. It is optional only for non-request
   * authorization value objects retained by older callers; persisted request
   * sessions must always carry a safe integer and are rejected otherwise.
   */
  generation?: number;
};

/**
 * Rotate the session identifier before placing authenticated state in it.
 * This prevents session fixation and ensures every successful login has a
 * newly persisted session row.
 *
 * Requests without the application middleware are a programming/configuration
 * error. Do not issue an unauthenticated or in-memory fallback cookie.
 */
export async function regenerateAuthenticatedSession(
  req: Request,
  res: Response,
  payload: SessionPayload,
): Promise<void> {
  if (!req.session || typeof req.session.regenerate !== "function") {
    throw new Error("Session middleware is not registered on the request.");
  }
  if (!Number.isSafeInteger(payload.generation)) {
    throw new Error("Authenticated session is missing its user session generation.");
  }

  await new Promise<void>((resolve, reject) => {
    req.session!.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      req.session!.uid = payload.uid;
      req.session!.username = payload.username;
      req.session!.isAdmin = payload.isAdmin;
      req.session!.generation = payload.generation!;
      req.session!.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

export async function destroyAuthenticatedSession(req: Request): Promise<void> {
  if (!req.session || typeof req.session.destroy !== "function") {
    throw new Error("Session middleware is not registered on the request.");
  }
  await new Promise<void>((resolve, reject) => {
    req.session!.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export function readRequestSession(req: Request): SessionPayload | null {
  const data = req.session;
  if (
    !data ||
    !Number.isSafeInteger(data.uid) ||
    typeof data.username !== "string" ||
    typeof data.isAdmin !== "boolean" ||
    !Number.isSafeInteger(data.generation)
  ) {
    return null;
  }
  return { uid: data.uid, username: data.username, isAdmin: data.isAdmin, generation: data.generation };
}

/**
 * Delete all sessions for a user in the shared PostgreSQL store. The
 * `exceptSid` form lets a password change retain the session that made it,
 * while disabling/resetting an account can revoke every session.
 */
export async function revokeUserSessions(userId: number, exceptSid?: string): Promise<void> {
  const pool = requirePool();
  const clauses = ["sess->>'uid' = $1"];
  const values: unknown[] = [String(userId)];
  if (exceptSid) {
    clauses.push("sid <> $2");
    values.push(exceptSid);
  }
  await pool.query(`DELETE FROM user_sessions WHERE ${clauses.join(" AND ")}`, values);
}

export const SESSION_COOKIE_MAX_AGE_MS = SESSION_TTL_MS;