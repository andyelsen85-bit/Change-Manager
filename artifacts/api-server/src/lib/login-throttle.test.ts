import { beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool }));

const {
  checkLoginThrottle,
  clearLoginFailures,
  normalizeLoginIdentity,
  recordLoginFailure,
} = await import("./login-throttle");

describe("PostgreSQL login throttle", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it("normalizes only the throttle key, preserving route lookup casing", () => {
    expect(normalizeLoginIdentity("  Alice@EXAMPLE.test ")).toBe("alice@example.test");
  });

  it("blocks before credential work while a lock is active", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // bounded cleanup
      .mockResolvedValueOnce({
        rows: [{ locked_until: new Date(Date.now() + 30_000) }],
      });

    const status = await checkLoginThrottle("192.0.2.1", "Alice");

    expect(status.blocked).toBe(true);
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
    expect(pool.query.mock.calls[1]?.[0]).toMatch(/locked_until/);
  });

  it("records failures with an atomic upsert and clears on success", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // bounded cleanup
    pool.query.mockResolvedValueOnce({
      rows: [
        { failure_count: 5, locked_until: new Date(Date.now() + 60_000) },
        { failure_count: 5, locked_until: new Date(Date.now() + 60_000) },
      ],
    });
    const status = await recordLoginFailure("192.0.2.1", " Alice ");
    expect(status.blocked).toBe(true);
    expect(pool.query.mock.calls[1]?.[0]).toMatch(/ON CONFLICT.*DO UPDATE/s);
    expect(pool.query.mock.calls[1]?.[1]).not.toContain(" Alice ");
    expect(pool.query.mock.calls[1]?.[1]).not.toContain("alice");

    await clearLoginFailures("192.0.2.1", " Alice ");
    expect(pool.query.mock.calls[3]).toEqual([
      expect.stringContaining("DELETE FROM auth_login_throttle"),
      [expect.any(String), expect.any(String)],
    ]);
  });
});