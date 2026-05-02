import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  ADMIN_SESSION,
  OWNER_SESSION,
  STRANGER_SESSION,
  CHANGE_MANAGER_SESSION,
  ASSIGNEE_SESSION,
} from "./test-helpers";

const dbMock = new DbMock();
const getChangeAccessMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  changeRequestsTable: { _t: "change_requests" },
  usersTable: { _t: "users" },
  standardTemplatesTable: { _t: "standard_templates" },
  planningRecordsTable: { _t: "planning_records" },
  testRecordsTable: { _t: "test_records" },
  pirRecordsTable: { _t: "pir_records" },
  approvalsTable: { _t: "approvals" },
  commentsTable: { _t: "comments" },
  rolesTable: { _t: "roles" },
  roleAssignmentsTable: { _t: "role_assignments" },
  cabMeetingsTable: { _t: "cab_meetings" },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  desc: () => ({}),
  eq: () => ({}),
  ilike: () => ({}),
  or: () => ({}),
  sql: () => ({}),
}));

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

vi.mock("../lib/ref", () => ({ nextRef: vi.fn().mockResolvedValue("CHG-TEST-1") }));

vi.mock("../lib/state-machine", () => ({
  isTransitionAllowed: vi.fn().mockReturnValue(true),
  listAllowedTransitions: vi.fn().mockReturnValue([]),
  checkPhaseGates: vi.fn().mockReturnValue(null),
}));

const { default: changesRouter } = await import("./changes");

const sampleChange = {
  id: 1,
  ref: "CHG-1",
  title: "t",
  description: "d",
  track: "normal",
  status: "draft",
  risk: "low",
  impact: "low",
  priority: "medium",
  category: "general",
  ownerId: 10,
  assigneeId: 20,
  templateId: null,
  cabMeetingId: null,
  plannedStart: null,
  plannedEnd: null,
  actualStart: null,
  actualEnd: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("changes.ts authorization gates", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
  });

  describe("GET /changes/:id", () => {
    it("returns 403 when getChangeAccess returns null", async () => {
      dbMock.enqueue("select", [sampleChange]); // change lookup
      getChangeAccessMock.mockResolvedValueOnce(null);
      const app = buildTestApp(changesRouter, STRANGER_SESSION);
      const res = await request(app).get("/api/changes/1");
      expect(res.status).toBe(403);
      expect(getChangeAccessMock).toHaveBeenCalledOnce();
    });

    it("allows owner to read (auth gate passes)", async () => {
      dbMock.enqueue("select", [sampleChange]); // change lookup
      // After auth passes the handler does many more lookups; queue dummies
      // so the handler doesn't crash. We only assert it didn't 403.
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]); // owner user
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]); // assignee user
      dbMock.enqueue("select", []); // planning
      dbMock.enqueue("select", []); // testing
      dbMock.enqueue("select", []); // pir
      dbMock.enqueue("select", []); // approvals
      dbMock.enqueue("select", []); // comments
      getChangeAccessMock.mockResolvedValueOnce("owner");
      const app = buildTestApp(changesRouter, OWNER_SESSION);
      const res = await request(app).get("/api/changes/1");
      expect(res.status).not.toBe(403);
    });
  });

  describe("PATCH /changes/:id", () => {
    it("returns 403 when getChangeAccess returns null", async () => {
      dbMock.enqueue("select", [sampleChange]);
      getChangeAccessMock.mockResolvedValueOnce(null);
      const app = buildTestApp(changesRouter, STRANGER_SESSION);
      const res = await request(app)
        .patch("/api/changes/1")
        .send({ title: "hacked" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/owner|assignee|change manager|admin/i);
    });

    it("allows the owner to edit", async () => {
      dbMock.enqueue("select", [sampleChange]); // before
      dbMock.enqueue("update", [{ ...sampleChange, title: "new" }]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]); // expand owner
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]); // expand assignee
      getChangeAccessMock.mockResolvedValueOnce("owner");
      const app = buildTestApp(changesRouter, OWNER_SESSION);
      const res = await request(app)
        .patch("/api/changes/1")
        .send({ title: "new" });
      expect(res.status).not.toBe(403);
    });

    it("allows the assignee to edit", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("update", [sampleChange]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]);
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]);
      getChangeAccessMock.mockResolvedValueOnce("assignee");
      const app = buildTestApp(changesRouter, ASSIGNEE_SESSION);
      const res = await request(app).patch("/api/changes/1").send({});
      expect(res.status).not.toBe(403);
    });

    it("allows a change_manager to edit", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("update", [sampleChange]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]);
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]);
      getChangeAccessMock.mockResolvedValueOnce("change_manager");
      const app = buildTestApp(changesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app).patch("/api/changes/1").send({});
      expect(res.status).not.toBe(403);
    });

    it("allows an admin to edit", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("update", [sampleChange]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]);
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]);
      getChangeAccessMock.mockResolvedValueOnce("admin");
      const app = buildTestApp(changesRouter, ADMIN_SESSION);
      const res = await request(app).patch("/api/changes/1").send({});
      expect(res.status).not.toBe(403);
    });
  });

  describe("DELETE /changes/:id", () => {
    it("returns 403 for a stranger (no relationship, no governance role)", async () => {
      dbMock.enqueue("select", [sampleChange]);
      getChangeAccessMock.mockResolvedValueOnce(null);
      const app = buildTestApp(changesRouter, STRANGER_SESSION);
      const res = await request(app).delete("/api/changes/1");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/owner|assignee|governance|admin/i);
    });

    it("allows the owner to delete", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("delete", undefined);
      getChangeAccessMock.mockResolvedValueOnce("owner");
      const app = buildTestApp(changesRouter, OWNER_SESSION);
      const res = await request(app).delete("/api/changes/1");
      expect(res.status).toBe(204);
    });

    it("allows the assignee to delete", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("delete", undefined);
      getChangeAccessMock.mockResolvedValueOnce("assignee");
      const app = buildTestApp(changesRouter, ASSIGNEE_SESSION);
      const res = await request(app).delete("/api/changes/1");
      expect(res.status).toBe(204);
    });

    it("allows admin to delete", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("delete", undefined);
      getChangeAccessMock.mockResolvedValueOnce("admin");
      const app = buildTestApp(changesRouter, ADMIN_SESSION);
      const res = await request(app).delete("/api/changes/1");
      expect(res.status).toBe(204);
    });

    it("allows change_manager to delete", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("delete", undefined);
      getChangeAccessMock.mockResolvedValueOnce("change_manager");
      const app = buildTestApp(changesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app).delete("/api/changes/1");
      expect(res.status).toBe(204);
    });

    it("allows ecab_member to delete (governance role)", async () => {
      dbMock.enqueue("select", [sampleChange]);
      dbMock.enqueue("delete", undefined);
      getChangeAccessMock.mockResolvedValueOnce("ecab_member");
      const app = buildTestApp(changesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app).delete("/api/changes/1");
      expect(res.status).toBe(204);
    });
  });

  describe("POST /changes/:id/transition", () => {
    it("returns 403 when getChangeAccess returns null", async () => {
      dbMock.enqueue("select", [sampleChange]);
      getChangeAccessMock.mockResolvedValueOnce(null);
      const app = buildTestApp(changesRouter, STRANGER_SESSION);
      const res = await request(app)
        .post("/api/changes/1/transition")
        .send({ toStatus: "submitted" });
      expect(res.status).toBe(403);
    });

    it("rejects owner attempting to flip into awaiting_approval", async () => {
      dbMock.enqueue("select", [{ ...sampleChange, status: "draft" }]);
      getChangeAccessMock.mockResolvedValueOnce("owner");
      const app = buildTestApp(changesRouter, OWNER_SESSION);
      const res = await request(app)
        .post("/api/changes/1/transition")
        .send({ toStatus: "awaiting_approval" });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/governance|admin/i);
    });

    it("rejects assignee attempting to flip into awaiting_approval", async () => {
      dbMock.enqueue("select", [{ ...sampleChange, status: "draft" }]);
      getChangeAccessMock.mockResolvedValueOnce("assignee");
      const app = buildTestApp(changesRouter, ASSIGNEE_SESSION);
      const res = await request(app)
        .post("/api/changes/1/transition")
        .send({ toStatus: "awaiting_approval" });
      expect(res.status).toBe(403);
    });

    it("allows change_manager to transition into awaiting_approval (when CAB completed)", async () => {
      const change = {
        ...sampleChange,
        status: "draft",
        cabMeetingId: 5,
      };
      dbMock.enqueue("select", [change]); // change lookup
      dbMock.enqueue("select", [{ id: 5, status: "completed" }]); // cab meeting
      dbMock.enqueue("select", []); // planning
      dbMock.enqueue("select", []); // testing
      dbMock.enqueue("select", []); // pir
      dbMock.enqueue("select", []); // approvals (none means allApproved=true)
      dbMock.enqueue("update", [{ ...change, status: "awaiting_approval" }]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]); // expand owner
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]); // expand assignee
      getChangeAccessMock.mockResolvedValueOnce("change_manager");
      const app = buildTestApp(changesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app)
        .post("/api/changes/1/transition")
        .send({ toStatus: "awaiting_approval" });
      expect(res.status).not.toBe(403);
    });

    it("allows ecab_member to transition into awaiting_approval", async () => {
      const change = {
        ...sampleChange,
        track: "emergency",
        status: "draft",
        cabMeetingId: 5,
      };
      dbMock.enqueue("select", [change]);
      dbMock.enqueue("select", [{ id: 5, status: "completed" }]);
      dbMock.enqueue("select", []);
      dbMock.enqueue("select", []);
      dbMock.enqueue("select", []);
      dbMock.enqueue("select", []);
      dbMock.enqueue("update", [{ ...change, status: "awaiting_approval" }]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]);
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]);
      getChangeAccessMock.mockResolvedValueOnce("ecab_member");
      const app = buildTestApp(changesRouter, CHANGE_MANAGER_SESSION);
      const res = await request(app)
        .post("/api/changes/1/transition")
        .send({ toStatus: "awaiting_approval" });
      expect(res.status).not.toBe(403);
    });

    it("allows owner to make non-approval transitions", async () => {
      const change = { ...sampleChange, status: "draft" };
      dbMock.enqueue("select", [change]); // change lookup
      dbMock.enqueue("select", []); // planning
      dbMock.enqueue("select", []); // testing
      dbMock.enqueue("select", []); // pir
      dbMock.enqueue("select", []); // approvals
      dbMock.enqueue("update", [{ ...change, status: "submitted" }]);
      dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]); // expand owner
      dbMock.enqueue("select", [{ id: 20, fullName: "Assignee" }]); // expand assignee
      getChangeAccessMock.mockResolvedValueOnce("owner");
      const app = buildTestApp(changesRouter, OWNER_SESSION);
      const res = await request(app)
        .post("/api/changes/1/transition")
        .send({ toStatus: "submitted" });
      expect(res.status).not.toBe(403);
    });
  });
});
