import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { DbMock } from "./test-helpers";

const dbMock = new DbMock();
const auditMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@workspace/db", () => ({
  db: dbMock,
  usersTable: { _t: "users", id: "id", username: "username", passwordHash: "password_hash" },
  roleAssignmentsTable: { _t: "role_assignments" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  isNull: () => ({}),
}));

vi.mock("../lib/audit", () => ({ audit: auditMock }));
vi.mock("../lib/ldap", () => ({
  authenticateLdap: vi.fn().mockResolvedValue({ ok: false }),
  getLdap: vi.fn().mockResolvedValue(null),
}));

const { default: authRouter } = await import("./auth");

function buildApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", authRouter);
  return app;
}

describe("auth routes — setup-status", () => {
  beforeEach(() => {
    dbMock.reset();
    auditMock.mockClear();
  });

  it("reports needsSetup=true when admin row exists with no password", async () => {
    dbMock.enqueue("select", [{ id: 1, passwordHash: null }]);
    const res = await request(buildApp()).get("/api/auth/setup-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: true });
  });

  it("reports needsSetup=false when admin already has a password", async () => {
    dbMock.enqueue("select", [{ id: 1, passwordHash: "$2b$10$abc" }]);
    const res = await request(buildApp()).get("/api/auth/setup-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: false });
  });

  it("reports needsSetup=false when no admin row exists", async () => {
    dbMock.enqueue("select", []);
    const res = await request(buildApp()).get("/api/auth/setup-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: false });
  });
});

describe("auth routes — setup", () => {
  beforeEach(() => {
    dbMock.reset();
    auditMock.mockClear();
  });

  it("rejects passwords shorter than 8 characters", async () => {
    const res = await request(buildApp())
      .post("/api/auth/setup")
      .send({ password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it("rejects non-string passwords", async () => {
    const res = await request(buildApp())
      .post("/api/auth/setup")
      .send({ password: 12345678 });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the conditional update matches no rows (already claimed)", async () => {
    // The atomic UPDATE ... WHERE password_hash IS NULL RETURNING * matches
    // zero rows because the admin already has a password. The handler must
    // not mint a session.
    dbMock.enqueue("update", []);
    const res = await request(buildApp())
      .post("/api/auth/setup")
      .send({ password: "validpassword1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already completed/i);
    const cookies = res.headers["set-cookie"] as unknown as string[] | undefined;
    const joined = Array.isArray(cookies) ? cookies.join(";") : String(cookies ?? "");
    expect(joined).not.toMatch(/cm_session=/);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("claims the admin atomically, mints session+csrf cookies, and audits", async () => {
    // Conditional UPDATE returns the freshly-claimed row.
    dbMock.enqueue("update", [
      {
        id: 1,
        username: "admin",
        email: "admin@change-mgmt.local",
        fullName: "System Administrator",
        source: "local",
        isAdmin: true,
        passwordHash: "irrelevant",
        mustChangePassword: false,
      },
    ]);
    // loadUserRoles
    dbMock.enqueue("select", []);
    const res = await request(buildApp())
      .post("/api/auth/setup")
      .send({ password: "supersecret123" });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("admin");
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.mustChangePassword).toBe(false);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const joined = Array.isArray(cookies) ? cookies.join(";") : String(cookies ?? "");
    expect(joined).toMatch(/cm_session=/);
    expect(joined).toMatch(/cm_csrf=/);
    expect(auditMock).toHaveBeenCalledOnce();
    expect(auditMock.mock.calls[0]![1].action).toBe("auth.setup_completed");
  });
});
