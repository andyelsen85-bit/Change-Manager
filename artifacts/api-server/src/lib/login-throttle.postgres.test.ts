import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const realDescribe = hasDatabase ? describe : describe.skip;
const { pool } = hasDatabase
  ? await import("@workspace/db")
  : { pool: null as never };
const {
  clearLoginFailures,
  reserveLoginAttempt,
} = hasDatabase
  ? await import("./login-throttle")
  : { clearLoginFailures: async () => undefined, reserveLoginAttempt: async () => ({ blocked: false, retryAfterSeconds: 0 }) };

const runId = `real-throttle-${process.pid}-${randomUUID()}`;
const testIps = Array.from({ length: 8 }, (_, index) => `${runId}-ip-${index}`);

function storageKey(prefix: string, value: string): string {
  return createHash("sha256").update(`${prefix}:${value}`).digest("hex");
}

realDescribe("login throttle PostgreSQL transitions", () => {
  beforeAll(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_login_throttle (
        ip_address    text NOT NULL,
        identity      text NOT NULL,
        failure_count integer NOT NULL DEFAULT 0,
        locked_until  timestamptz,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        window_started_at timestamptz NOT NULL DEFAULT now(),
        lock_level    integer NOT NULL DEFAULT 0,
        PRIMARY KEY (ip_address, identity)
      )
    `);
    await pool.query(
      "ALTER TABLE auth_login_throttle ADD COLUMN IF NOT EXISTS window_started_at timestamptz NOT NULL DEFAULT now()",
    );
    await pool.query(
      "ALTER TABLE auth_login_throttle ADD COLUMN IF NOT EXISTS lock_level integer NOT NULL DEFAULT 0",
    );
  });

  afterAll(async () => {
    // Delete only this run's hashed IP keys; never truncate shared data.
    for (const ip of testIps) {
      await pool.query("DELETE FROM auth_login_throttle WHERE ip_address = $1", [
        storageKey("ip", ip),
      ]);
    }
  });

  it("does not extend an active identity lock and permits the first retry after expiry", async () => {
    const ip = testIps[0]!;
    const identity = `${runId}-locked`;
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await reserveLoginAttempt(ip, identity)).blocked).toBe(false);
    }
    expect((await reserveLoginAttempt(ip, identity)).blocked).toBe(true);

    const identityKey = storageKey("identity", identity);
    const before = await pool.query<{ locked_until: Date; failure_count: number; lock_level: number }>(
      "SELECT locked_until, failure_count, lock_level FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", ip), identityKey],
    );
    expect(before.rows[0]?.locked_until).toBeTruthy();
    expect((await reserveLoginAttempt(ip, identity)).blocked).toBe(true);
    const unchanged = await pool.query<{ locked_until: Date; failure_count: number; lock_level: number }>(
      "SELECT locked_until, failure_count, lock_level FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", ip), identityKey],
    );
    expect(unchanged.rows[0]?.locked_until?.getTime()).toBe(before.rows[0]!.locked_until.getTime());
    expect(unchanged.rows[0]?.failure_count).toBe(before.rows[0]!.failure_count);
    expect(unchanged.rows[0]?.lock_level).toBe(1);

    await pool.query(
      "UPDATE auth_login_throttle SET locked_until = now() - interval '1 second' WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", ip), identityKey],
    );
    expect((await reserveLoginAttempt(ip, identity)).blocked).toBe(false);
    const retried = await pool.query<{ locked_until: Date | null; failure_count: number }>(
      "SELECT locked_until, failure_count FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", ip), identityKey],
    );
    expect(retried.rows[0]?.locked_until).toBeNull();
    expect(retried.rows[0]?.failure_count).toBe(1);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await reserveLoginAttempt(ip, identity)).blocked).toBe(false);
    }
    expect((await reserveLoginAttempt(ip, identity)).blocked).toBe(true);
    const secondCycle = await pool.query<{ locked_until: Date; lock_level: number }>(
      "SELECT locked_until, lock_level FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", ip), identityKey],
    );
    expect(secondCycle.rows[0]?.lock_level).toBe(2);
    expect(secondCycle.rows[0]!.locked_until.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("keeps the shared IP aggregate across identity success", async () => {
    const ip = testIps[1]!;
    const firstIdentity = `${runId}-first`;
    const secondIdentity = `${runId}-second`;
    await reserveLoginAttempt(ip, firstIdentity);
    await reserveLoginAttempt(ip, secondIdentity);
    await clearLoginFailures(ip, firstIdentity);

    const rows = await pool.query<{ identity: string; failure_count: number }>(
      "SELECT identity, failure_count FROM auth_login_throttle WHERE ip_address = $1",
      [storageKey("ip", ip)],
    );
    expect(rows.rows.find((row) => row.identity === storageKey("identity", firstIdentity))).toBeUndefined();
    expect(rows.rows.find((row) => row.identity === storageKey("ip-aggregate", ip))?.failure_count).toBe(2);
  });

  it("allows concurrent reservations and multiple NAT users below the generous aggregate capacity", async () => {
    const concurrentIp = testIps[2]!;
    const concurrentIdentity = `${runId}-concurrent`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => reserveLoginAttempt(concurrentIp, concurrentIdentity)),
    );
    expect(results.every((result) => !result.blocked)).toBe(true);
    const concurrent = await pool.query<{ failure_count: number }>(
      "SELECT failure_count FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", concurrentIp), storageKey("identity", concurrentIdentity)],
    );
    expect(concurrent.rows[0]?.failure_count).toBe(4);

    const natIp = testIps[3]!;
    const natResults = await Promise.all(
      Array.from({ length: 10 }, (_, index) => reserveLoginAttempt(natIp, `${runId}-nat-${index}`)),
    );
    expect(natResults.every((result) => !result.blocked)).toBe(true);
    const aggregate = await pool.query<{ failure_count: number }>(
      "SELECT failure_count FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", natIp), storageKey("ip-aggregate", natIp)],
    );
    expect(aggregate.rows[0]?.failure_count).toBe(10);

    await pool.query(
      "UPDATE auth_login_throttle SET failure_count = 59, locked_until = NULL, window_started_at = now(), updated_at = now() WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", natIp), storageKey("ip-aggregate", natIp)],
    );
    expect((await reserveLoginAttempt(natIp, `${runId}-nat-threshold`)).blocked).toBe(true);
    expect((await reserveLoginAttempt(natIp, `${runId}-nat-other`)).blocked).toBe(true);

    await pool.query(
      "UPDATE auth_login_throttle SET failure_count = 59, locked_until = NULL, window_started_at = now() - interval '61 seconds', updated_at = now() WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", natIp), storageKey("ip-aggregate", natIp)],
    );
    expect((await reserveLoginAttempt(natIp, `${runId}-nat-reset`)).blocked).toBe(false);
    const resetWindow = await pool.query<{ failure_count: number; window_started_at: Date }>(
      "SELECT failure_count, window_started_at FROM auth_login_throttle WHERE ip_address = $1 AND identity = $2",
      [storageKey("ip", natIp), storageKey("ip-aggregate", natIp)],
    );
    expect(resetWindow.rows[0]?.failure_count).toBe(1);
    expect(resetWindow.rows[0]!.window_started_at.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});