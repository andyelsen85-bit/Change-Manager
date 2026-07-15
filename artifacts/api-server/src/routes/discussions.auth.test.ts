import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp, OWNER_SESSION, STRANGER_SESSION } from "./test-helpers";

const dbMock = new DbMock();
const getChangeViewAccessMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  commentsTable: { _t: "comments" },
  changeRequestsTable: { _t: "change_requests" },
  discussionReadsTable: { _t: "discussion_reads" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  desc: () => ({}),
  sql: () => ({}),
}));

vi.mock("../lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    requireAuth: (req: unknown, _res: unknown, next: () => void) => next(),
    getChangeViewAccess: getChangeViewAccessMock,
  };
});

const { default: discussionsRouter } = await import("./discussions");

const sampleChange = { id: 1, ref: "CHG-1", title: "t", ownerId: 10, assigneeId: 20 };

describe("discussions.ts read-state routes", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeViewAccessMock.mockReset();
  });

  it("GET /discussions/state hides changes the caller cannot view", async () => {
    dbMock.enqueue("select", [{ changeId: 1, lastMessageAt: new Date().toISOString() }]); // latest comments
    dbMock.enqueue("select", []); // reads
    dbMock.enqueue("select", [sampleChange]); // change lookup
    getChangeViewAccessMock.mockResolvedValueOnce(null);
    const app = buildTestApp(discussionsRouter, STRANGER_SESSION);
    const res = await request(app).get("/api/discussions/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /discussions/state marks a never-read discussion as unread", async () => {
    const ts = new Date("2026-07-01T10:00:00Z");
    dbMock.enqueue("select", [{ changeId: 1, lastMessageAt: ts.toISOString() }]);
    dbMock.enqueue("select", []); // no read rows
    dbMock.enqueue("select", [sampleChange]);
    getChangeViewAccessMock.mockResolvedValueOnce("owner");
    const app = buildTestApp(discussionsRouter, OWNER_SESSION);
    const res = await request(app).get("/api/discussions/state");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ changeId: 1, ref: "CHG-1", unread: true });
  });

  it("GET /discussions/state marks read when lastReadAt >= lastMessageAt", async () => {
    const ts = new Date("2026-07-01T10:00:00Z");
    dbMock.enqueue("select", [{ changeId: 1, lastMessageAt: ts.toISOString() }]);
    dbMock.enqueue("select", [{ userId: 10, changeId: 1, lastReadAt: new Date("2026-07-02T00:00:00Z") }]);
    dbMock.enqueue("select", [sampleChange]);
    getChangeViewAccessMock.mockResolvedValueOnce("owner");
    const app = buildTestApp(discussionsRouter, OWNER_SESSION);
    const res = await request(app).get("/api/discussions/state");
    expect(res.body[0].unread).toBe(false);
  });

  it("POST /changes/:id/discussion/read returns 403 without view access", async () => {
    dbMock.enqueue("select", [sampleChange]);
    getChangeViewAccessMock.mockResolvedValueOnce(null);
    const app = buildTestApp(discussionsRouter, STRANGER_SESSION);
    const res = await request(app).post("/api/changes/1/discussion/read");
    expect(res.status).toBe(403);
  });

  it("POST /changes/:id/discussion/read upserts for a viewer", async () => {
    dbMock.enqueue("select", [sampleChange]);
    dbMock.enqueue("insert", []);
    getChangeViewAccessMock.mockResolvedValueOnce("owner");
    const app = buildTestApp(discussionsRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes/1/discussion/read");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("POST /changes/:id/discussion/unread 404s when comment belongs to another change", async () => {
    dbMock.enqueue("select", [sampleChange]);
    getChangeViewAccessMock.mockResolvedValueOnce("owner");
    dbMock.enqueue("select", [{ id: 7, changeId: 999, createdAt: new Date() }]);
    const app = buildTestApp(discussionsRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes/1/discussion/unread").send({ commentId: 7 });
    expect(res.status).toBe(404);
  });

  it("POST /changes/:id/discussion/unread rewinds the read pointer", async () => {
    dbMock.enqueue("select", [sampleChange]);
    getChangeViewAccessMock.mockResolvedValueOnce("owner");
    dbMock.enqueue("select", [{ id: 7, changeId: 1, createdAt: new Date() }]);
    dbMock.enqueue("insert", []);
    const app = buildTestApp(discussionsRouter, OWNER_SESSION);
    const res = await request(app).post("/api/changes/1/discussion/unread").send({ commentId: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
