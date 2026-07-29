// Tests for the SD+ create-change webhook, asserting the on-create status
// write-back (sdpSetInitialStatus) fires exactly once for a newly created
// change and never on an idempotent replay for an already-linked request.
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp } from "./test-helpers";

const dbMock = new DbMock();
const getSdpConfigMock = vi.fn();
const sdpAddBackLinkNoteMock = vi.fn().mockResolvedValue(undefined);
const sdpSetInitialStatusMock = vi.fn().mockResolvedValue(undefined);
const nextRefMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  changeRequestsTable: { _t: "change_requests", sdpRequestId: "sdp_request_id", deletedAt: "deleted_at" },
  planningRecordsTable: { _t: "planning_records" },
  usersTable: { _t: "users", email: "email", isActive: "is_active", isAdmin: "is_admin" },
  sdpSettingsTable: { _t: "sdp_settings", key: "key" },
  changeCategoriesTable: { _t: "change_categories", isActive: "is_active" },
  standardTemplatesTable: { _t: "standard_templates", isActive: "is_active" },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
  isNull: () => ({}),
}));

vi.mock("./changes", () => ({
  createApprovalsForChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/ref", () => ({ nextRef: nextRefMock }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../lib/sdp", () => ({
  getSdpConfig: (...a: unknown[]) => getSdpConfigMock(...a),
  sdpAddBackLinkNote: (...a: unknown[]) => sdpAddBackLinkNoteMock(...a),
  sdpSetInitialStatus: (...a: unknown[]) => sdpSetInitialStatusMock(...a),
  sdpRequestUrl: () => "https://sdp.example.org/WorkOrder.do?woMode=viewWO&woID=555",
  appBaseUrl: () => "https://changeit.example.org",
}));

const { default: sdpRouter } = await import("./sdp");

const SECRET = "hook-secret";
const cfg = {
  enabled: true,
  webhookSecret: SECRET,
  baseUrl: "https://sdp.example.org",
};

const adminUser = { id: 1, username: "admin", isAdmin: true, isActive: true };

describe("POST /integrations/sdp/create-change — on-create status write-back", () => {
  beforeEach(() => {
    dbMock.reset();
    getSdpConfigMock.mockReset().mockResolvedValue(cfg);
    sdpAddBackLinkNoteMock.mockClear();
    sdpSetInitialStatusMock.mockClear();
    nextRefMock.mockReset().mockResolvedValue("NOR-00042");
  });

  it("fires the SD+ status update exactly once when a change is newly created", async () => {
    dbMock.enqueue("select", []); // idempotency lookup → no existing change
    dbMock.enqueue("select", [adminUser]); // admin fallback owner (no emails in payload)
    dbMock.enqueue("select", [{ key: "general", isActive: true }]); // categories
    const created = {
      id: 42,
      ref: "NOR-00042",
      title: "Replace ward switch",
      sdpRequestId: "555",
    };
    dbMock.enqueue("insert", [created]); // change insert .returning()
    dbMock.enqueue("insert", undefined); // planning record
    dbMock.enqueue("update", undefined); // recordWebhook

    const app = buildTestApp(sdpRouter, null);
    const res = await request(app)
      .post("/api/integrations/sdp/create-change")
      .set("X-Webhook-Secret", SECRET)
      .send({ request_id: "555", subject: "Replace ward switch", description: "..." });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(sdpSetInitialStatusMock).toHaveBeenCalledTimes(1);
    expect(sdpSetInitialStatusMock).toHaveBeenCalledWith("555");
    expect(sdpAddBackLinkNoteMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the status update on an idempotent replay (change already linked)", async () => {
    const existing = { id: 42, ref: "NOR-00042", sdpRequestId: "555" };
    dbMock.enqueue("select", [existing]); // idempotency lookup → hit
    dbMock.enqueue("update", undefined); // recordWebhook

    const app = buildTestApp(sdpRouter, null);
    const res = await request(app)
      .post("/api/integrations/sdp/create-change")
      .set("X-Webhook-Secret", SECRET)
      .send({ request_id: "555", subject: "Replace ward switch" });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.ref).toBe("NOR-00042");
    expect(sdpSetInitialStatusMock).not.toHaveBeenCalled();
    expect(sdpAddBackLinkNoteMock).not.toHaveBeenCalled();
  });

  it("does NOT fire the status update when the unique-index race is lost (concurrent duplicate)", async () => {
    dbMock.enqueue("select", []); // idempotency lookup → miss
    dbMock.enqueue("select", [adminUser]); // admin fallback owner
    dbMock.enqueue("select", [{ key: "general", isActive: true }]); // categories
    // change insert loses the unique-index race
    const dup = Promise.reject(Object.assign(new Error("duplicate"), { code: "23505" }));
    dup.catch(() => {}); // pre-handle so vitest doesn't flag an unhandled rejection before the route awaits it
    dbMock.enqueue("insert", dup);
    const winner = { id: 43, ref: "NOR-00043", sdpRequestId: "555" };
    dbMock.enqueue("select", [winner]); // re-fetch the winner
    dbMock.enqueue("update", undefined); // recordWebhook

    const app = buildTestApp(sdpRouter, null);
    const res = await request(app)
      .post("/api/integrations/sdp/create-change")
      .set("X-Webhook-Secret", SECRET)
      .send({ request_id: "555", subject: "Replace ward switch" });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.ref).toBe("NOR-00043");
    expect(sdpSetInitialStatusMock).not.toHaveBeenCalled();
  });

  it("rejects a bad webhook secret without touching SD+", async () => {
    const app = buildTestApp(sdpRouter, null);
    const res = await request(app)
      .post("/api/integrations/sdp/create-change")
      .set("X-Webhook-Secret", "wrong")
      .send({ request_id: "555" });
    expect(res.status).toBe(401);
    expect(sdpSetInitialStatusMock).not.toHaveBeenCalled();
  });
});
