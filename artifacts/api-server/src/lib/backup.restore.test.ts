import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const release = vi.fn();
const connect = vi.fn();
const client = { query, release };

vi.mock("@workspace/db", () => ({
  pool: { connect },
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn() },
}));

const { exportAll, importAll } = await import("./backup");

const TABLES = [
  "roles",
  "users",
  "role_assignments",
  "cab_meetings",
  "cab_members",
  "standard_templates",
  "change_categories",
  "change_requests",
  "change_assignees",
  "cab_changes",
  "planning_records",
  "test_records",
  "pir_records",
  "approvals",
  "comments",
  "pentest_test_types",
  "pentest_requests",
  "pentest_collaborators",
  "pentest_attachments",
  "notification_preferences",
  "ref_counters",
  "smtp_settings",
  "ldap_settings",
  "ssl_settings",
  "notification_settings",
  "sdp_settings",
  "notification_queue",
  "notification_routing_rules",
  "audit_log",
] as const;

function validPayload(extraTables: Record<string, Array<Record<string, unknown>>> = {}) {
  return {
    version: 2,
    exportedAt: new Date(0).toISOString(),
    tables: {
      ...Object.fromEntries(TABLES.map((table) => [table, []])),
      ...extraTables,
    },
  };
}

describe("backup restore session invalidation", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    connect.mockReset().mockResolvedValue(client);
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT table_name") || sql.startsWith("SELECT c.table_name")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  it("never exports operational session or login-throttle tables", async () => {
    const payload = await exportAll();
    const statements = query.mock.calls.map(([sql]) => sql as string);

    expect(payload.tables).not.toHaveProperty("user_sessions");
    expect(payload.tables).not.toHaveProperty("auth_login_throttle");
    expect(statements).not.toContain("SELECT * FROM user_sessions");
    expect(statements).not.toContain("SELECT * FROM auth_login_throttle");
  });

  it("clears sessions and login throttle before replacing users and ignores malicious operational tables", async () => {
    const result = await importAll(
      validPayload({
        user_sessions: [{ sid: "attacker-session", sess: { uid: 1 } }],
        auth_login_throttle: [{ ip_address: "127.0.0.1", identity: "admin", failure_count: 99 }],
      }),
    );
    const statements = query.mock.calls.map(([sql]) => sql as string);

    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("SELECT id, session_generation");
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements.slice(2, 6)).toEqual([
      "DELETE FROM user_sessions",
      "DELETE FROM auth_login_throttle",
      "ALTER TABLE audit_log DISABLE TRIGGER USER",
      "DELETE FROM audit_log",
    ]);
    expect(statements.indexOf("DELETE FROM user_sessions")).toBeLessThan(
      statements.indexOf("DELETE FROM users"),
    );
    expect(statements.some((sql) => sql.startsWith("INSERT INTO user_sessions"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("INSERT INTO auth_login_throttle"))).toBe(false);
    expect(result.restored).not.toHaveProperty("user_sessions");
    expect(result.restored).not.toHaveProperty("auth_login_throttle");
    expect(statements).toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores forged generations and assigns every restored user a barrier above the old maximum", async () => {
    const userInserts: Array<{ sql: string; values: unknown[] }> = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FOR UPDATE")) {
        return {
          rows: [
            { id: 1, session_generation: 4 },
            { id: 2, session_generation: 19 },
          ],
        };
      }
      if (sql.startsWith("SELECT table_name")) {
        return {
          rows: [
            { table_name: "users", column_name: "id" },
            { table_name: "users", column_name: "username" },
            { table_name: "users", column_name: "email" },
            { table_name: "users", column_name: "session_generation" },
          ],
        };
      }
      if (sql.startsWith("INSERT INTO users")) {
        userInserts.push({ sql, values: values ?? [] });
      }
      return { rows: [] };
    });

    await importAll(
      validPayload({
        users: [
          { id: 101, username: "restored-a", email: "a@example.test", session_generation: 999999 },
          { id: 102, username: "restored-b", email: "b@example.test", session_generation: 1 },
        ],
      }),
    );

    expect(userInserts).toHaveLength(2);
    expect(userInserts.every(({ sql }) => sql.includes('"session_generation"'))).toBe(true);
    expect(userInserts.map(({ values }) => values.at(-1))).toEqual([20, 20]);
    expect(userInserts.flatMap(({ values }) => values)).not.toContain(999999);
  });

  it("fails clearly rather than wrapping an exhausted session generation", async () => {
    const statements: string[] = [];
    query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 1, session_generation: 2_147_483_647 }] };
      }
      return { rows: [] };
    });

    await expect(importAll(validPayload())).rejects.toThrow(/session_generation would overflow/);
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql === "DELETE FROM user_sessions")).toBe(false);
    expect(statements.some((sql) => sql === "COMMIT")).toBe(false);
  });

  it("rolls back session invalidation atomically when replacement fails", async () => {
    const statements: string[] = [];
    query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql === "DELETE FROM users") {
        throw new Error("simulated restore failure");
      }
      return { rows: [] };
    });

    await expect(importAll(validPayload({ users: [{ id: 42 }] }))).rejects.toThrow(
      "simulated restore failure",
    );
    expect(statements.indexOf("DELETE FROM user_sessions")).toBeGreaterThanOrEqual(0);
    expect(statements.indexOf("DELETE FROM auth_login_throttle")).toBeGreaterThanOrEqual(0);
    expect(statements.indexOf("DELETE FROM user_sessions")).toBeLessThan(statements.indexOf("DELETE FROM users"));
    expect(statements).toContain("ROLLBACK");
    expect(statements).toContain("ALTER TABLE audit_log ENABLE TRIGGER USER");
    expect(statements).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});