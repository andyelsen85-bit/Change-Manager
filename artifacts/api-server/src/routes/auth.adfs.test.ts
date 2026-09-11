import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { DbMock } from "./test-helpers";

const dbMock = new DbMock();
const adfs = vi.hoisted(() => {
  class TestAdfsError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  const state = { state: "state-value", nonce: "nonce-value", verifier: "verifier", returnTo: "/changes/123?tab=history" };
  return {
    TestAdfsError,
    state,
    authorizationUrl: vi.fn(),
    completeAdfsLogin: vi.fn(),
    consumeAdfsState: vi.fn(),
    createAdfsState: vi.fn(),
    createAdfsStateTransaction: vi.fn(),
    getAdfsConfig: vi.fn(),
    getAdfsPublicConfig: vi.fn(),
    isAdfsConfigured: vi.fn(),
    readAdfsState: vi.fn(),
    sanitizeReturnTo: vi.fn((value: unknown) => typeof value === "string" && value.startsWith("/") ? value : "/"),
    stateMatches: vi.fn(),
  };
});
const audit = vi.fn().mockResolvedValue(undefined);

vi.mock("@workspace/db", () => ({
  db: dbMock,
  usersTable: { _t: "users", id: "id", username: "username" },
  roleAssignmentsTable: { _t: "role_assignments", userId: "user_id", roleKey: "role_key" },
}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}), isNull: () => ({}) }));
vi.mock("../lib/audit", () => ({ audit }));
vi.mock("../lib/ldap", () => ({ authenticateLdap: vi.fn(), getLdap: vi.fn() }));
vi.mock("./pentest", () => ({ userCanAccessPentest: vi.fn().mockResolvedValue(false) }));
vi.mock("../lib/adfs", () => ({
  adfsStateCookieName: "cm_adfs_state",
  adfsStateTtlMs: 600_000,
  AdfsError: adfs.TestAdfsError,
  authorizationUrl: adfs.authorizationUrl,
  completeAdfsLogin: adfs.completeAdfsLogin,
  consumeAdfsState: adfs.consumeAdfsState,
  createAdfsState: adfs.createAdfsState,
  createAdfsStateTransaction: adfs.createAdfsStateTransaction,
  getAdfsConfig: adfs.getAdfsConfig,
  getAdfsPublicConfig: adfs.getAdfsPublicConfig,
  isAdfsConfigured: adfs.isAdfsConfigured,
  readAdfsState: adfs.readAdfsState,
  sanitizeReturnTo: adfs.sanitizeReturnTo,
  stateMatches: adfs.stateMatches,
}));

const { default: authRouter } = await import("./auth");
const { signSession } = await import("../lib/auth");

function buildApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", authRouter);
  return app;
}

function callbackRequest() {
  return request(buildApp())
    .get("/api/auth/adfs/callback?code=one-time-code&state=state-value")
    .set("Cookie", "cm_adfs_state=signed-state");
}

function cookies(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value.join("; ") : String(value ?? "");
}

describe("AD FS callback session boundary", () => {
  beforeEach(() => {
    dbMock.reset();
    audit.mockClear();
    adfs.getAdfsConfig.mockResolvedValue({ enabled: true, clientId: "client" });
    adfs.isAdfsConfigured.mockReturnValue(true);
    adfs.readAdfsState.mockReturnValue(adfs.state);
    adfs.stateMatches.mockReturnValue(true);
    adfs.consumeAdfsState.mockResolvedValue(true);
    adfs.completeAdfsLogin.mockReset();
  });

  it("creates the normal session only after a successful verified AD FS login", async () => {
    adfs.completeAdfsLogin.mockResolvedValue({
      id: 42, username: "alice", email: "alice@example.test", fullName: "Alice", isAdmin: false,
    });
    const response = await callbackRequest();
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/changes/123?tab=history");
    expect(adfs.completeAdfsLogin).toHaveBeenCalledWith("one-time-code", adfs.state, expect.any(Object));
    expect(cookies(response)).toMatch(/cm_session=/);
    expect(cookies(response)).toMatch(/cm_csrf=/);
    expect(cookies(response)).toMatch(/cm_login_method=adfs/);
  });

  it("creates no session for state mismatch, replay, changed/invalid configuration, or token validation failure", async () => {
    adfs.stateMatches.mockReturnValueOnce(false);
    const mismatch = await callbackRequest();
    expect(mismatch.headers.location).toMatch(/adfsError=state/);
    expect(cookies(mismatch)).not.toMatch(/cm_session=/);
    expect(adfs.completeAdfsLogin).not.toHaveBeenCalled();

    adfs.consumeAdfsState.mockResolvedValueOnce(false);
    const replay = await callbackRequest();
    expect(replay.headers.location).toMatch(/adfsError=state/);
    expect(cookies(replay)).not.toMatch(/cm_session=/);

    adfs.isAdfsConfigured.mockReturnValueOnce(false);
    const configFailure = await callbackRequest();
    expect(configFailure.headers.location).toMatch(/adfsError=configuration/);
    expect(cookies(configFailure)).not.toMatch(/cm_session=/);

    adfs.completeAdfsLogin.mockRejectedValueOnce(new adfs.TestAdfsError("token_validation"));
    const nonceOrTokenFailure = await callbackRequest();
    expect(nonceOrTokenFailure.headers.location).toMatch(/adfsError=token_validation/);
    expect(cookies(nonceOrTokenFailure)).not.toMatch(/cm_session=/);
  });

  it("clears the AD FS login preference on explicit logout", async () => {
    const session = signSession({ uid: 42, username: "alice", isAdmin: false });
    const response = await request(buildApp())
      .post("/api/auth/logout")
      .set("Cookie", [`cm_session=${session}`, "cm_login_method=adfs"]);
    expect(response.status).toBe(204);
    expect(cookies(response)).toMatch(/cm_login_method=;/);
  });
});