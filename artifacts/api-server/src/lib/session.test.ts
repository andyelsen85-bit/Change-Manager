import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const pool = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool }));

const {
  regenerateAuthenticatedSession,
  revokeUserSessions,
} = await import("./session");

describe("PostgreSQL session lifecycle", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it("regenerates the identifier and saves authenticated state", async () => {
    const save = vi.fn((callback: (error?: unknown) => void) => callback());
    const regenerate = vi.fn((callback: (error?: unknown) => void) => callback());
    const req = {
      session: { regenerate, save, destroy: vi.fn() },
    } as unknown as Request;
    const res = { cookie: vi.fn() } as unknown as Response;

    await regenerateAuthenticatedSession(req, res, {
      uid: 7,
      username: "carol",
      isAdmin: false,
      generation: 0,
    });

    expect(regenerate).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(req.session?.uid).toBe(7);
    expect(req.session?.username).toBe("carol");
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("fails explicitly when the application omitted session middleware", async () => {
    const req = {} as Request;
    const res = { cookie: vi.fn() } as unknown as Response;

    await expect(
      regenerateAuthenticatedSession(req, res, {
        uid: 7,
        username: "carol",
        isAdmin: false,
      generation: 0,
      }),
    ).rejects.toThrow(/middleware is not registered/i);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("revokes every persisted session for a user through the shared store", async () => {
    pool.query.mockResolvedValue({ rowCount: 2, rows: [] });

    await revokeUserSessions(42);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM user_sessions"),
      ["42"],
    );
  });

  it("can retain the current session while revoking other sessions", async () => {
    pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

    await revokeUserSessions(42, "current-sid");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("sid <> $2"),
      ["42", "current-sid"],
    );
  });
});