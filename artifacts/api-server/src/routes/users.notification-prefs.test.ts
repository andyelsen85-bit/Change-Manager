import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  ADMIN_SESSION,
  STRANGER_SESSION,
  type SessionLike,
} from "./test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  usersTable: { _t: "users", id: "id" },
  roleAssignmentsTable: { _t: "role_assignments", userId: "userId" },
  notificationPreferencesTable: {
    _t: "notification_preferences",
    userId: "userId",
    eventKey: "eventKey",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
  ilike: () => ({}),
  or: () => ({}),
}));

vi.mock("../lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    requireAuth: (req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { default: usersRouter } = await import("./users");

const SELF_SESSION: SessionLike = { uid: 42, username: "self", isAdmin: false };

describe("GET /users/:id/notification-preferences", () => {
  beforeEach(() => {
    dbMock.reset();
  });

  it("forbids reading another user's preferences when not admin and not self", async () => {
    const app = buildTestApp(usersRouter, STRANGER_SESSION);
    const res = await request(app).get("/api/users/42/notification-preferences");
    expect(res.status).toBe(403);
  });

  it("returns full event list with defaults (emailEnabled=true, inAppEnabled=true) when no rows stored", async () => {
    dbMock.enqueue("select", []); // no stored prefs
    const app = buildTestApp(usersRouter, SELF_SESSION);
    const res = await request(app).get("/api/users/42/notification-preferences");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // sample at least one well-known key
    const change = res.body.find((p: { eventKey: string }) => p.eventKey === "change.created");
    expect(change).toBeTruthy();
    expect(change.emailEnabled).toBe(true);
    expect(change.inAppEnabled).toBe(true);
    // every entry should expose the canonical contract shape
    for (const p of res.body) {
      expect(typeof p.eventKey).toBe("string");
      expect(typeof p.emailEnabled).toBe("boolean");
      expect(typeof p.inAppEnabled).toBe("boolean");
    }
  });

  it("admin can read another user's preferences", async () => {
    dbMock.enqueue("select", [
      { userId: 42, eventKey: "change.created", emailEnabled: false, inAppEnabled: true },
    ]);
    const app = buildTestApp(usersRouter, ADMIN_SESSION);
    const res = await request(app).get("/api/users/42/notification-preferences");
    expect(res.status).toBe(200);
    const p = res.body.find((x: { eventKey: string }) => x.eventKey === "change.created");
    expect(p.emailEnabled).toBe(false);
    expect(p.inAppEnabled).toBe(true);
  });
});

describe("PUT /users/:id/notification-preferences — round-trip", () => {
  beforeEach(() => {
    dbMock.reset();
  });

  it("accepts an array body and re-emits the same canonical contract shape (no `enabled`, only `emailEnabled` + `inAppEnabled`)", async () => {
    // Two upsert inserts (one per submitted item)
    dbMock.enqueue("insert", undefined);
    dbMock.enqueue("insert", undefined);
    // Re-fetch
    dbMock.enqueue("select", [
      { userId: 42, eventKey: "change.created", emailEnabled: false, inAppEnabled: true },
      { userId: 42, eventKey: "approval.requested", emailEnabled: true, inAppEnabled: false },
    ]);

    const app = buildTestApp(usersRouter, SELF_SESSION);
    const res = await request(app)
      .put("/api/users/42/notification-preferences")
      .send([
        { eventKey: "change.created", emailEnabled: false, inAppEnabled: true },
        { eventKey: "approval.requested", emailEnabled: true, inAppEnabled: false },
      ]);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // No legacy `enabled` key on any entry. This is exactly the contract drift the
    // task description called out (notification-preferences round-trip).
    for (const p of res.body) {
      expect(p).not.toHaveProperty("enabled");
      expect(typeof p.emailEnabled).toBe("boolean");
      expect(typeof p.inAppEnabled).toBe("boolean");
    }
    const change = res.body.find((x: { eventKey: string }) => x.eventKey === "change.created");
    expect(change).toMatchObject({ emailEnabled: false, inAppEnabled: true });
    const ap = res.body.find((x: { eventKey: string }) => x.eventKey === "approval.requested");
    expect(ap).toMatchObject({ emailEnabled: true, inAppEnabled: false });
  });

  it("forbids writing another user's preferences when not admin and not self", async () => {
    const app = buildTestApp(usersRouter, STRANGER_SESSION);
    const res = await request(app)
      .put("/api/users/42/notification-preferences")
      .send([{ eventKey: "change.created", emailEnabled: false }]);
    expect(res.status).toBe(403);
  });
});
