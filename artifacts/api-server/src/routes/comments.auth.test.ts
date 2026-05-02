import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  OWNER_SESSION,
  STRANGER_SESSION,
} from "./test-helpers";

const dbMock = new DbMock();
const getChangeAccessMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  commentsTable: { _t: "comments" },
  usersTable: { _t: "users" },
  changeRequestsTable: { _t: "change_requests" },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}), desc: () => ({}) }));

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

const { default: commentsRouter } = await import("./comments");

const sampleChange = {
  id: 1,
  ref: "CHG-1",
  title: "t",
  ownerId: 10,
  assigneeId: 20,
};

describe("comments.ts authorization gates", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
  });

  it("GET /changes/:id/comments returns 403 when getChangeAccess returns null", async () => {
    dbMock.enqueue("select", [sampleChange]);
    getChangeAccessMock.mockResolvedValueOnce(null);
    const app = buildTestApp(commentsRouter, STRANGER_SESSION);
    const res = await request(app).get("/api/changes/1/comments");
    expect(res.status).toBe(403);
  });

  it("GET /changes/:id/comments allows owner", async () => {
    dbMock.enqueue("select", [sampleChange]);
    dbMock.enqueue("select", []);
    getChangeAccessMock.mockResolvedValueOnce("owner");
    const app = buildTestApp(commentsRouter, OWNER_SESSION);
    const res = await request(app).get("/api/changes/1/comments");
    expect(res.status).toBe(200);
  });

  it("POST /changes/:id/comments returns 403 when getChangeAccess returns null", async () => {
    dbMock.enqueue("select", [sampleChange]);
    getChangeAccessMock.mockResolvedValueOnce(null);
    const app = buildTestApp(commentsRouter, STRANGER_SESSION);
    const res = await request(app)
      .post("/api/changes/1/comments")
      .send({ body: "hi" });
    expect(res.status).toBe(403);
  });

  it("POST /changes/:id/comments allows owner", async () => {
    dbMock.enqueue("select", [sampleChange]); // change lookup
    dbMock.enqueue("insert", [
      { id: 5, changeId: 1, authorId: 10, body: "hi", createdAt: new Date() },
    ]);
    dbMock.enqueue("select", [{ id: 10, fullName: "Owner" }]); // author
    dbMock.enqueue("select", [sampleChange]); // notify lookup
    getChangeAccessMock.mockResolvedValueOnce("owner");
    const app = buildTestApp(commentsRouter, OWNER_SESSION);
    const res = await request(app)
      .post("/api/changes/1/comments")
      .send({ body: "hi" });
    expect(res.status).toBe(201);
  });
});
