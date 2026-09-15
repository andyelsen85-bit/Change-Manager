import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp, type SessionLike } from "./test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  auditLogTable: {
    _t: "audit_log",
    id: "id",
    timestamp: "timestamp",
    actorId: "actorId",
    action: "action",
    entityType: "entityType",
    entityId: "entityId",
  },
  // Required by the password-rotation gate inside `requireAdmin`.
  usersTable: {
    _t: "users",
    id: "id",
    username: "username",
    isAdmin: "is_admin",
    isActive: "is_active",
    sessionGeneration: "session_generation",
    mustChangePassword: "must_change_password",
  },
  roleAssignmentsTable: {
    _t: "role_assignments",
    userId: "user_id",
    roleKey: "role_key",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  desc: () => ({}),
  eq: () => ({}),
  ilike: () => ({}),
  gte: () => ({}),
  lte: () => ({}),
}));

const { default: auditRouter } = await import("./audit");

// We deliberately exercise the REAL `requireAdmin` middleware here (no mock)
// using the test-only in-memory session injection and a fresh user row.
function buildApp(session: SessionLike | null): ReturnType<typeof buildTestApp> {
  return buildTestApp(auditRouter, session);
}

function freshUser(session: SessionLike) {
  return {
    id: session.uid,
    username: session.username,
    isAdmin: session.isAdmin,
    isActive: true,
    mustChangePassword: false,
    sessionGeneration: session.generation ?? 0,
  };
}

describe("audit-log admin gating", () => {
  beforeEach(() => {
    dbMock.reset();
  });

  it("returns 401 when no session is present", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/api/admin/audit-log");
    expect(res.status).toBe(401);
  });

  it("returns 403 for an authenticated non-admin user", async () => {
    const session = {
      uid: 99,
      username: "stranger",
      isAdmin: false,
      generation: 0,
    };
    dbMock.enqueue("select", [freshUser(session)]);
    const app = buildApp(session);
    const res = await request(app).get("/api/admin/audit-log");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("allows admin and returns rows", async () => {
    const fakeRow = {
      id: 1,
      timestamp: new Date("2026-05-01T00:00:00Z"),
      actorId: 1,
      actorName: "admin",
      action: "auth.login",
      entityType: "user",
      entityId: 1,
      summary: "admin logged in",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      before: null,
      after: null,
    };
    // First select: requireAdmin's fresh user lookup. Then the audit query.
    const session = { uid: 1, username: "admin", isAdmin: true, generation: 0 };
    dbMock.enqueue("select", [freshUser(session)]);
    dbMock.enqueue("select", [fakeRow]);
    const app = buildApp(session);
    const res = await request(app).get("/api/admin/audit-log");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].action).toBe("auth.login");
  });

  it("returns 401/403 on the CSV export endpoint for non-admins", async () => {
    // No session cookie at all → 401
    const app = buildApp(null);
    const res = await request(app).get("/api/admin/audit-log/export");
    expect(res.status).toBe(401);

    const session = {
      uid: 5,
      username: "user",
      isAdmin: false,
      generation: 0,
    };
    dbMock.enqueue("select", [freshUser(session)]);
    const res2 = await request(buildApp(session)).get("/api/admin/audit-log/export");
    expect(res2.status).toBe(403);
  });

  it("admin export emits CSV with header row + escaped fields", async () => {
    // First select: requireAdmin's fresh user lookup.
    const session = { uid: 1, username: "admin", isAdmin: true, generation: 0 };
    dbMock.enqueue("select", [freshUser(session)]);
    dbMock.enqueue("select", [
      {
        id: 1,
        timestamp: new Date("2026-05-01T00:00:00Z"),
        actorId: 1,
        actorName: 'name "with" quotes',
        action: "change.created",
        entityType: "change",
        entityId: 5,
        summary: "Created change with, comma",
        ipAddress: "10.0.0.1",
        userAgent: "ua",
        before: null,
        after: null,
      },
    ]);
    const res = await request(buildApp(session)).get("/api/admin/audit-log/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/audit-log-/);
    const lines = res.text.split("\n");
    expect(lines[0]).toContain("id,timestamp,actorId,actorName,action");
    // Field with comma must be quoted
    expect(res.text).toContain('"Created change with, comma"');
    // Field with embedded quotes must be doubled and wrapped
    expect(res.text).toContain('"name ""with"" quotes"');
  });
});
