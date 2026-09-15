import type { Request } from "express";
import { createHash } from "node:crypto";
import * as workspaceDb from "@workspace/db";

type PoolQueryResult<T> = { rows: T[] };
type PoolLike = {
  query: <T = unknown>(text: string, values?: unknown[]) => Promise<PoolQueryResult<T>>;
};

function getPool(): PoolLike | undefined {
  try {
    return (workspaceDb as unknown as { pool?: PoolLike }).pool;
  } catch {
    return undefined;
  }
}

const NODE_ENV = process.env["NODE_ENV"] ?? "development";

function getPoolOrThrow(): PoolLike | undefined {
  const pool = getPool();
  // Unit tests inject a mocked @workspace/db module without a pool. Every
  // real environment must fail closed rather than silently bypassing login
  // throttling when PostgreSQL is unavailable.
  if (!pool && NODE_ENV !== "test") {
    throw new Error("PostgreSQL pool is unavailable; login throttling cannot be enforced.");
  }
  return pool;
}

const MAX_ROWS_TO_CLEAN = 500;
const MAX_IDENTITY_BUCKETS_PER_IP = 128;
const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;

export type LoginThrottleStatus = {
  blocked: boolean;
  retryAfterSeconds: number;
};

export function normalizeLoginIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

export function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown-peer";
}

function hashBucket(prefix: string, value: string): string {
  return createHash("sha256").update(`${prefix}:${value}`).digest("hex");
}

function bucketKeys(ip: string, identity: string): {
  ipKey: string;
  identityKey: string;
  aggregateKey: string;
} {
  return {
    ipKey: hashBucket("ip", ip),
    identityKey: hashBucket("identity", normalizeLoginIdentity(identity)),
    aggregateKey: hashBucket("ip-aggregate", ip),
  };
}

async function cleanupExpiredCounters(): Promise<void> {
  const pool = getPoolOrThrow();
  if (!pool) return;
  await pool.query(
    `WITH expired AS (
       SELECT ip_address, identity
         FROM auth_login_throttle
        WHERE updated_at < now() - ($1::double precision * interval '1 millisecond')
        LIMIT $2
     )
     DELETE FROM auth_login_throttle AS t
      USING expired
      WHERE t.ip_address = expired.ip_address
        AND t.identity = expired.identity`,
    [COUNTER_RETENTION_MS, MAX_ROWS_TO_CLEAN],
  );
}

async function trimIdentityBuckets(
  pool: PoolLike,
  ipKey: string,
  identityKey: string,
  aggregateKey: string,
): Promise<void> {
  // Keep the aggregate row and the current identity row, while bounding
  // attacker-controlled identity rotation to a fixed number of recent rows
  // per source IP.
  await pool.query(
    `DELETE FROM auth_login_throttle
      WHERE ip_address = $1
        AND identity NOT IN ($2, $3)
        AND identity IN (
          SELECT identity
            FROM auth_login_throttle
           WHERE ip_address = $1
             AND identity NOT IN ($2, $3)
           ORDER BY updated_at DESC
           OFFSET $4
        )`,
    [ipKey, identityKey, aggregateKey, MAX_IDENTITY_BUCKETS_PER_IP],
  );
}

export async function checkLoginThrottle(ip: string, identity: string): Promise<LoginThrottleStatus> {
  const pool = getPoolOrThrow();
  if (!pool) return { blocked: false, retryAfterSeconds: 0 };
  const { ipKey, identityKey, aggregateKey } = bucketKeys(ip, identity);
  await cleanupExpiredCounters();
  const result = await pool.query<{ locked_until: Date | string | null }>(
    `SELECT locked_until
       FROM auth_login_throttle
      WHERE ip_address = $1 AND identity IN ($2, $3)
        AND (locked_until IS NULL OR locked_until > now())`,
    [ipKey, identityKey, aggregateKey],
  );
  const lockedUntil = result.rows
    .map((row) => row.locked_until)
    .filter(Boolean)
    .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0];
  if (!lockedUntil) return { blocked: false, retryAfterSeconds: 0 };
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000),
  );
  return { blocked: true, retryAfterSeconds };
}

/**
 * Atomically reserve one pre-authentication attempt in both the normalized
 * identity bucket and the source-IP aggregate bucket. The two-row UPSERT is
 * the serialization point, so concurrent requests cannot all pass a racy
 * read-before-increment check.
 */
export async function reserveLoginAttempt(ip: string, identity: string): Promise<LoginThrottleStatus> {
  const pool = getPoolOrThrow();
  if (!pool) return { blocked: false, retryAfterSeconds: 0 };
  const { ipKey, identityKey, aggregateKey } = bucketKeys(ip, identity);
  await cleanupExpiredCounters();
  const result = await pool.query<{ failure_count: number; locked_until: Date | string | null }>(
    `INSERT INTO auth_login_throttle
       (ip_address, identity, failure_count, locked_until, updated_at, window_started_at, lock_level)
     VALUES ($1, $2, 1, NULL, now(), now(), 0), ($1, $3, 1, NULL, now(), now(), 0)
     ON CONFLICT (ip_address, identity) DO UPDATE
       SET failure_count = CASE
              WHEN auth_login_throttle.locked_until > now()
               THEN auth_login_throttle.failure_count
              WHEN auth_login_throttle.identity = $3
                AND auth_login_throttle.window_started_at < now() - interval '1 minute'
               THEN 1
              WHEN auth_login_throttle.identity <> $3
                AND auth_login_throttle.window_started_at < now() - ($4::double precision * interval '1 millisecond')
               THEN 1
              WHEN auth_login_throttle.locked_until IS NOT NULL
               THEN 1
              ELSE auth_login_throttle.failure_count + 1
           END,
           locked_until = CASE
              WHEN auth_login_throttle.locked_until > now()
               THEN auth_login_throttle.locked_until
              WHEN auth_login_throttle.identity = $3
                AND auth_login_throttle.window_started_at < now() - interval '1 minute'
               THEN NULL
              WHEN auth_login_throttle.identity <> $3
                AND auth_login_throttle.window_started_at < now() - ($4::double precision * interval '1 millisecond')
               THEN NULL
              WHEN auth_login_throttle.locked_until IS NOT NULL
               THEN NULL
              WHEN auth_login_throttle.identity = $3
                AND auth_login_throttle.failure_count + 1 >= 60
               THEN now() + interval '1 minute'
              WHEN auth_login_throttle.identity <> $3
                AND auth_login_throttle.failure_count + 1 >= 5
               THEN CASE LEAST(auth_login_throttle.lock_level + 1, 4)
                 WHEN 1 THEN now() + interval '1 minute'
                 WHEN 2 THEN now() + interval '5 minutes'
                 WHEN 3 THEN now() + interval '15 minutes'
                 ELSE now() + interval '30 minutes'
               END
              ELSE NULL
            END,
           window_started_at = CASE
              WHEN auth_login_throttle.locked_until > now()
               THEN auth_login_throttle.window_started_at
              WHEN auth_login_throttle.identity = $3
                AND auth_login_throttle.window_started_at < now() - interval '1 minute'
               THEN now()
              WHEN auth_login_throttle.identity <> $3
                AND auth_login_throttle.window_started_at < now() - ($4::double precision * interval '1 millisecond')
               THEN now()
              ELSE auth_login_throttle.window_started_at
            END,
           lock_level = CASE
              WHEN auth_login_throttle.locked_until > now()
               THEN auth_login_throttle.lock_level
              WHEN auth_login_throttle.identity <> $3
                AND auth_login_throttle.window_started_at < now() - ($4::double precision * interval '1 millisecond')
               THEN 0
              WHEN auth_login_throttle.identity <> $3
                AND auth_login_throttle.failure_count + 1 >= 5
                AND auth_login_throttle.locked_until IS NULL
               THEN LEAST(auth_login_throttle.lock_level + 1, 4)
              ELSE auth_login_throttle.lock_level
            END,
           updated_at = now()
      RETURNING identity, failure_count, locked_until`,
    [ipKey, identityKey, aggregateKey, COUNTER_RETENTION_MS],
  );
  await trimIdentityBuckets(pool, ipKey, identityKey, aggregateKey);
  const lockedUntil = result.rows
    .map((row) => row.locked_until)
    .filter(Boolean)
    .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0];
  if (!lockedUntil) return { blocked: false, retryAfterSeconds: 0 };
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000)),
  };
}

/** Compatibility name for callers/tests; failures are now reserved pre-auth. */
export async function recordLoginFailure(ip: string, identity: string): Promise<LoginThrottleStatus> {
  return reserveLoginAttempt(ip, identity);
}

export async function clearLoginFailures(ip: string, identity: string): Promise<void> {
  const pool = getPoolOrThrow();
  if (!pool) return;
  const { ipKey, identityKey } = bucketKeys(ip, identity);
  await pool.query(
    "DELETE FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
    [ipKey, identityKey],
  );
}