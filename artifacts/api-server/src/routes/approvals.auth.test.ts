import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  OWNER_SESSION,
  STRANGER_SESSION,
  ADMIN_SESSION,
} from "./test-helpers";

const dbMock = new DbMock();
const getChangeAccessMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  approvalsTable: { _t: "approvals" },
  changeRequestsTable: { _t: "change_requests" },
  cabMeetingsTable: { _t: "cab_meetings" },
  rolesTable: { _t: "roles" },
  usersTable: { _t: "users" },
  roleAssignmentsTable: { _t: "role_assignments" },
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

const { default: approvalsRouter } = await import("./approvals");

const sampleChange = {
  id: 1,
  ref: "CHG-1",
  title: "t",
  status: "awaiting_approval",
  track: "normal",
  ownerId: 10,
  assigneeId: 20,
  cabMeetingId: 5,
};

describe("approvals.ts authorization gates", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
  });

  it("GET /changes/:id/approvals returns 403 when getChangeAccess returns null", async () => {
    dbMock.enqueue("select", [sampleChange]);
    getChangeAccessMock.mockResolvedValueOnce(null);
    const app = buildTestApp(approvalsRouter, STRANGER_SESSION);
    const res = await request(app).get("/api/changes/1/approvals");
    expect(res.status).toBe(403);
  });

  it("GET /changes/:id/approvals allows owner", async () => {
    dbMock.enqueue("select", [sampleChange]);
    dbMock.enqueue("select", []);
    getChangeAccessMock.mockResolvedValueOnce("owner");
    const app = buildTestApp(approvalsRouter, OWNER_SESSION);
    const res = await request(app).get("/api/changes/1/approvals");
    expect(res.status).toBe(200);
  });

  describe("POST /approvals/:id/vote", () => {
    it("returns 403 when caller is not assigned to the role and is not admin", async () => {
      dbMock.enqueue("select", [
        { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
      ]); // approval row
      dbMock.enqueue("select", [sampleChange]); // chgForGate
      dbMock.enqueue("select", [{ id: 5, status: "completed" }]); // cab meeting
      dbMock.enqueue("select", []); // role assignments — caller not in role
      const app = buildTestApp(approvalsRouter, OWNER_SESSION);
      const res = await request(app)
        .post("/api/approvals/7/vote")
        .send({ decision: "approved" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/not assigned/i);
    });

    it("allows admin to vote even without role assignment", async () => {
      dbMock.enqueue("select", [
        { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
      ]);
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("select", [{ id: 5, status: "completed" }]); // cab
      dbMock.enqueue("select", []); // role assignments — empty, but admin bypasses
      dbMock.enqueue("update", [
        {
          id: 7,
          changeId: 1,
          roleKey: "change_manager",
          decision: "approved",
        },
      ]); // updated approval
      dbMock.enqueue("select", [
        { id: 7, changeId: 1, roleKey: "change_manager", decision: "approved" },
      ]); // all approvals
      dbMock.enqueue("select", [{ status: "awaiting_approval" }]); // current change status
      dbMock.enqueue("update", undefined); // change status update
      dbMock.enqueue("select", [sampleChange]); // change for audit/notify
      const app = buildTestApp(approvalsRouter, ADMIN_SESSION);
      const res = await request(app)
        .post("/api/approvals/7/vote")
        .send({ decision: "approved" });
      expect(res.status).not.toBe(403);
    });
  });
});
