import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { DbMock } from "./test-helpers";

const dbMock = new DbMock();
const auditMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@workspace/db", () => ({
  db: dbMock,
  usersTable: { _t: "users", id: "id", username: "username" },
  roleAssignmentsTable: { _t: "role_assignments" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("../lib/audit", () => ({ audit: auditMock }));
vi.mock("../lib/ldap", () => ({
  authenticateLdap: vi.fn().mockResolvedValue({ ok: false }),
  getLdap: vi.fn().mockResolvedValue(null),
}));

const bcrypt = await import("bcryptjs");
const { default: authRouter } = await import("./auth");

function buildApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", authRouter);
  return app;
}

describe("auth routes — login", () => {
  beforeEach(() => {
    dbMock.reset();
    auditMock.mockClear();
  });

  it("rejects requests with missing credentials", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("returns 401 for unknown user (no audit-on-success)", async () => {
    dbMock.enqueue("select", []); // no user found
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "nobody", password: "whatever" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
    // audit was called for the failed login
    expect(auditMock).toHaveBeenCalledOnce();
    const arg = auditMock.mock.calls[0]![1];
    expect(arg.action).toBe("auth.login_failed");
  });

  it("returns 401 with 'Account disabled' when local user is inactive", async () => {
    dbMock.enqueue("select", [
      {
        id: 5,
        username: "alice",
        source: "local",
        isActive: false,
        passwordHash: "irrelevant",
        isAdmin: false,
        email: "a@x",
        fullName: "Alice",
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "alice", password: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/disabled/i);
    expect(auditMock).toHaveBeenCalledOnce();
    expect(auditMock.mock.calls[0]![1].action).toBe("auth.login_failed");
  });

  it("returns 401 for a wrong password against an active local user", async () => {
    const passwordHash = await bcrypt.hash("real-password", 4);
    dbMock.enqueue("select", [
      {
        id: 6,
        username: "bob",
        source: "local",
        isActive: true,
        passwordHash,
        isAdmin: false,
        email: "b@x",
        fullName: "Bob",
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "bob", password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it("logs in a valid local user, sets session + CSRF cookies, and emits an auth.login audit", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 4);
    dbMock.enqueue("select", [
      {
        id: 7,
        username: "carol",
        source: "local",
        isActive: true,
        passwordHash,
        isAdmin: false,
        email: "c@x",
        fullName: "Carol",
      },
    ]);
    // loadUserRoles
    dbMock.enqueue("select", [{ roleKey: "change_manager" }]);
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "carol", password: "correct-horse" });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("carol");
    expect(res.body.roles).toEqual(["change_manager"]);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const cookieJoined = Array.isArray(cookies) ? cookies.join(";") : String(cookies ?? "");
    expect(cookieJoined).toMatch(/cm_session=/);
    expect(cookieJoined).toMatch(/cm_csrf=/);
    expect(auditMock).toHaveBeenCalled();
    const lastCall = auditMock.mock.calls.at(-1)!;
    expect(lastCall[1].action).toBe("auth.login");
  });
});
