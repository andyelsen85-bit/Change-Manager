import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  OWNER_SESSION,
  ADMIN_SESSION,
  CHANGE_MANAGER_SESSION,
} from "./test-helpers";

const dbMock = new DbMock();
const getChangeAccessMock = vi.fn();
const nextRefMock = vi.fn();
const isTransitionAllowedMock = vi.fn();
const checkPhaseGatesMock = vi.fn();

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
vi.mock("../lib/ref", () => ({ nextRef: nextRefMock }));

vi.mock("../lib/state-machine", () => ({
  isTransitionAllowed: isTransitionAllowedMock,
  listAllowedTransitions: vi.fn().mockReturnValue([]),
  checkPhaseGates: checkPhaseGatesMock,
}));

const { default: changesRouter } = await import("./changes");

const sampleOwner = { id: 10, fullName: "Owner" };
const sampleAssignee = { id: 20, fullName: "Assignee" };

describe("POST /changes — creation per track", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
    nextRefMock.mockReset();
  });

  it("rejects creation when required fields (incl. category) are missing", async () => {
    const app = buildTestApp(changesRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes").send({
      title: "no category",
      description: "x",
      track: "normal",
      risk: "low",
      impact: "low",
      priority: "medium",
      // category missing — must be rejected
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("creates a normal change in draft, generates ref, seeds approvals", async () => {
    nextRefMock.mockResolvedValueOnce("NOR-00001");
    const created = {
      id: 11,
      ref: "NOR-00001",
      title: "Patch app server",
      description: "...",
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
    };
    dbMock.enqueue("insert", [created]); // change insert
    dbMock.enqueue("insert", undefined); // empty planning record
    // Only one approver role for normal track: change_manager
    dbMock.enqueue("insert", undefined); // approval for change_manager
    // notifyApprovers approvals lookup → empty so no per-role fanout
    dbMock.enqueue("select", []);
    // expandChangeRow lookups
    dbMock.enqueue("select", [sampleOwner]);
    dbMock.enqueue("select", [sampleAssignee]);

    const app = buildTestApp(changesRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes").send({
      title: "Patch app server",
      description: "Apply patches",
      track: "normal",
      risk: "low",
      impact: "low",
      priority: "medium",
      category: "general",
      assigneeId: 20,
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toBe("NOR-00001");
    expect(res.body.track).toBe("normal");
    expect(res.body.status).toBe("draft");
    expect(nextRefMock).toHaveBeenCalledWith("normal");
  });

  it("creates an emergency change with two approval rows seeded", async () => {
    nextRefMock.mockResolvedValueOnce("EMR-00001");
    const created = {
      id: 12,
      ref: "EMR-00001",
      title: "Restart prod",
      description: "...",
      track: "emergency",
      status: "draft",
      risk: "high",
      impact: "high",
      priority: "critical",
      category: "incident",
      ownerId: 10,
      assigneeId: null,
      templateId: null,
      cabMeetingId: null,
      plannedStart: null,
      plannedEnd: null,
    };
    dbMock.enqueue("insert", [created]); // change insert
    dbMock.enqueue("insert", undefined); // empty planning
    // Two approvals required for emergency: change_manager + ecab_member
    dbMock.enqueue("insert", undefined);
    dbMock.enqueue("insert", undefined);
    // notifyApprovers approvals lookup → empty
    dbMock.enqueue("select", []);
    // expandChangeRow lookups (assigneeId is null so only owner lookup)
    dbMock.enqueue("select", [sampleOwner]);

    const app = buildTestApp(changesRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes").send({
      title: "Restart prod",
      description: "...",
      track: "emergency",
      risk: "high",
      impact: "high",
      priority: "critical",
      category: "incident",
    });
    expect(res.status).toBe(201);
    expect(res.body.ref).toBe("EMR-00001");
    expect(res.body.track).toBe("emergency");
    expect(nextRefMock).toHaveBeenCalledWith("emergency");
  });

  it("rejects standard track without templateId", async () => {
    const app = buildTestApp(changesRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes").send({
      title: "Std",
      description: "...",
      track: "standard",
      risk: "low",
      impact: "low",
      priority: "low",
      category: "general",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/templateId/i);
  });

  it("rejects standard track when template is inactive", async () => {
    dbMock.enqueue("select", [
      { id: 99, isActive: false, autoApprove: true, bypassCab: true },
    ]);
    const app = buildTestApp(changesRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes").send({
      title: "Std",
      description: "...",
      track: "standard",
      risk: "low",
      impact: "low",
      priority: "low",
      category: "general",
      templateId: 99,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive|unknown/i);
  });

  it("creates a standard change auto-approved + bypassing CAB → status=scheduled", async () => {
    nextRefMock.mockResolvedValueOnce("STD-00001");
    // template lookup #1 (validity check)
    dbMock.enqueue("select", [
      {
        id: 33,
        isActive: true,
        autoApprove: true,
        bypassCab: true,
        prefilledPlanning: "do thing",
        prefilledTestPlan: "verify thing",
      },
    ]);
    const created = {
      id: 13,
      ref: "STD-00001",
      title: "Patch fleet",
      description: "...",
      track: "standard",
      status: "scheduled",
      risk: "low",
      impact: "low",
      priority: "low",
      category: "patching",
      ownerId: 10,
      assigneeId: null,
      templateId: 33,
      cabMeetingId: null,
      plannedStart: null,
      plannedEnd: null,
    };
    dbMock.enqueue("insert", [created]); // change insert
    dbMock.enqueue("insert", undefined); // empty planning record
    // template lookup #2 (for prefill)
    dbMock.enqueue("select", [
      {
        id: 33,
        prefilledPlanning: "do thing",
        prefilledTestPlan: "verify thing",
      },
    ]);
    dbMock.enqueue("update", undefined); // increment template usage
    dbMock.enqueue("update", undefined); // populate planning
    dbMock.enqueue("insert", undefined); // testRecord prefill
    // expandChangeRow: owner + template (assignee null)
    dbMock.enqueue("select", [sampleOwner]);
    dbMock.enqueue("select", [{ id: 33, name: "DNS template" }]);

    const app = buildTestApp(changesRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes").send({
      title: "Patch fleet",
      description: "...",
      track: "standard",
      risk: "low",
      impact: "low",
      priority: "low",
      category: "patching",
      templateId: 33,
    });
    expect(res.status).toBe(201);
    expect(res.body.track).toBe("standard");
    expect(res.body.status).toBe("scheduled");
    expect(res.body.templateName).toBe("DNS template");
  });
});

describe("POST /changes/:id/transition — gates", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
    isTransitionAllowedMock.mockReset();
    checkPhaseGatesMock.mockReset();
  });

  const baseChange = {
    id: 1,
    ref: "NOR-1",
    title: "t",
    description: "d",
    track: "normal",
    status: "approved",
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
  };

  it("returns 400 with `allowed` when state machine rejects", async () => {
    dbMock.enqueue("select", [baseChange]);
    getChangeAccessMock.mockResolvedValueOnce("admin");
    isTransitionAllowedMock.mockReturnValueOnce(false);
    const app = buildTestApp(changesRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/changes/1/transition")
      .send({ toStatus: "completed" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
    expect(res.body).toHaveProperty("allowed");
  });

  it("returns 409 when moving to awaiting_approval without a completed CAB", async () => {
    dbMock.enqueue("select", [
      { ...baseChange, status: "in_review", cabMeetingId: 5 },
    ]);
    getChangeAccessMock.mockResolvedValueOnce("change_manager");
    isTransitionAllowedMock.mockReturnValueOnce(true);
    dbMock.enqueue("select", [{ id: 5, status: "scheduled" }]); // CAB not done
    const app = buildTestApp(changesRouter, CHANGE_MANAGER_SESSION);
    const res = await request(app)
      .post("/api/changes/1/transition")
      .send({ toStatus: "awaiting_approval" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cab.*completed|completed.*before/i);
  });

  it("returns 400 when checkPhaseGates returns a reason (planning not signed off)", async () => {
    dbMock.enqueue("select", [{ ...baseChange, status: "approved" }]);
    getChangeAccessMock.mockResolvedValueOnce("admin");
    isTransitionAllowedMock.mockReturnValueOnce(true);
    // phase data lookups (planning, testing, pir, approvals)
    dbMock.enqueue("select", [{ changeId: 1, signedOff: false }]);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);
    checkPhaseGatesMock.mockReturnValueOnce("Planning must be signed off");
    const app = buildTestApp(changesRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/changes/1/transition")
      .send({ toStatus: "in_progress" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Planning must be signed off");
  });

  it("happy path — admin transitions through state machine + phase gates", async () => {
    dbMock.enqueue("select", [{ ...baseChange, status: "approved" }]);
    getChangeAccessMock.mockResolvedValueOnce("admin");
    isTransitionAllowedMock.mockReturnValueOnce(true);
    dbMock.enqueue("select", [{ changeId: 1, signedOff: true }]);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", [{ decision: "approved" }]);
    checkPhaseGatesMock.mockReturnValueOnce(null);
    dbMock.enqueue("update", [
      { ...baseChange, status: "in_progress", actualStart: new Date() },
    ]);
    dbMock.enqueue("select", [sampleOwner]); // expand owner
    dbMock.enqueue("select", [sampleAssignee]); // expand assignee
    const app = buildTestApp(changesRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/changes/1/transition")
      .send({ toStatus: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });
});
