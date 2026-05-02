import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  OWNER_SESSION,
  STRANGER_SESSION,
  ADMIN_SESSION,
  CHANGE_MANAGER_SESSION,
} from "./test-helpers";

const dbMock = new DbMock();
const getChangeAccessMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  planningRecordsTable: { _t: "planning_records" },
  testRecordsTable: { _t: "test_records" },
  pirRecordsTable: { _t: "pir_records" },
  changeRequestsTable: { _t: "change_requests" },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

vi.mock("../lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    requireAuth: (req: unknown, _res: unknown, next: () => void) => next(),
    getChangeAccess: getChangeAccessMock,
  };
});

vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/email", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  getUserEmail: vi.fn().mockResolvedValue(null),
}));

const { default: phasesRouter } = await import("./phases");

const sampleChange = {
  id: 1,
  ref: "CHG-1",
  title: "t",
  ownerId: 10,
  assigneeId: 20,
};

describe("phases.ts authorization gates", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
  });

  describe.each([
    ["planning", "/api/changes/1/planning"],
    ["testing", "/api/changes/1/testing"],
    ["pir", "/api/changes/1/pir"],
  ])("%s endpoints", (_name, url) => {
    it(`GET ${url} returns 403 when getChangeAccess returns null`, async () => {
      dbMock.enqueue("select", [sampleChange]);
      getChangeAccessMock.mockResolvedValueOnce(null);
      const app = buildTestApp(phasesRouter, STRANGER_SESSION);
      const res = await request(app).get(url);
      expect(res.status).toBe(403);
    });

    it(`GET ${url} allows the owner`, async () => {
      dbMock.enqueue("select", [sampleChange]); // change lookup
      dbMock.enqueue("select", []); // record lookup
      getChangeAccessMock.mockResolvedValueOnce("owner");
      const app = buildTestApp(phasesRouter, OWNER_SESSION);
      const res = await request(app).get(url);
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
    });

    it(`PUT ${url} returns 403 when getChangeAccess returns null`, async () => {
      dbMock.enqueue("select", [sampleChange]);
      getChangeAccessMock.mockResolvedValueOnce(null);
      const app = buildTestApp(phasesRouter, STRANGER_SESSION);
      const res = await request(app).put(url).send({});
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /changes/:id/planning lock", () => {
    it("denies owner from overwriting signed-off planning", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("select", [{ changeId: 1, signedOff: true }]); // existing signed off
      // second getChangeAccess call for the lock check
      getChangeAccessMock
        .mockResolvedValueOnce("owner") // first: gate
        .mockResolvedValueOnce("owner"); // second: lock check
      const app = buildTestApp(phasesRouter, OWNER_SESSION);
      const res = await request(app)
        .put("/api/changes/1/planning")
        .send({ scope: "x" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/signed off/i);
    });

    it("allows change_manager to overwrite signed-off planning", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("select", [{ changeId: 1, signedOff: true }]);
      dbMock.enqueue("insert", [{ changeId: 1, scope: "x", signedOff: false }]);
      getChangeAccessMock
        .mockResolvedValueOnce("change_manager")
        .mockResolvedValueOnce("change_manager");
      const app = buildTestApp(phasesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app)
        .put("/api/changes/1/planning")
        .send({ scope: "x" });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(409);
    });

    it("allows ecab_member (governance) to overwrite signed-off planning", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("select", [{ changeId: 1, signedOff: true }]);
      dbMock.enqueue("insert", [{ changeId: 1, scope: "x" }]);
      getChangeAccessMock
        .mockResolvedValueOnce("ecab_member")
        .mockResolvedValueOnce("ecab_member");
      const app = buildTestApp(phasesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app)
        .put("/api/changes/1/planning")
        .send({ scope: "x" });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(409);
    });

    it("allows admin to overwrite signed-off planning", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("select", [{ changeId: 1, signedOff: true }]);
      dbMock.enqueue("insert", [{ changeId: 1, scope: "x" }]);
      getChangeAccessMock
        .mockResolvedValueOnce("admin")
        .mockResolvedValueOnce("admin");
      const app = buildTestApp(phasesRouter, ADMIN_SESSION);
      const res = await request(app)
        .put("/api/changes/1/planning")
        .send({ scope: "x" });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(409);
    });
  });
});
