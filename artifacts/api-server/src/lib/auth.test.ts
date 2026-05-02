import { describe, it, expect, beforeEach, vi } from "vitest";

const selectMock = vi.fn();
const fromMock = vi.fn();
const whereMock = vi.fn();

vi.mock("@workspace/db", () => {
  return {
    db: {
      select: (...args: unknown[]) => {
        selectMock(...args);
        return {
          from: (...fromArgs: unknown[]) => {
            fromMock(...fromArgs);
            return {
              where: (...whereArgs: unknown[]) => whereMock(...whereArgs),
            };
          },
        };
      },
    },
    usersTable: { _name: "usersTable" },
    roleAssignmentsTable: { _name: "roleAssignmentsTable" },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

import {
  getChangeAccess,
  isPrivilegedAccess,
  GOVERNANCE_ROLES,
  type SessionPayload,
} from "./auth";

const adminSession: SessionPayload = { uid: 1, username: "admin", isAdmin: true };
const userSession: SessionPayload = { uid: 42, username: "alice", isAdmin: false };

describe("getChangeAccess", () => {
  beforeEach(() => {
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    whereMock.mockResolvedValue([]);
  });

  it("returns 'admin' for admin sessions without consulting roles", async () => {
    const result = await getChangeAccess(adminSession, { ownerId: 100, assigneeId: 101 });
    expect(result).toBe("admin");
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("returns 'owner' when the session user is the owner", async () => {
    const result = await getChangeAccess(userSession, { ownerId: 42, assigneeId: 99 });
    expect(result).toBe("owner");
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("returns 'assignee' when the session user is the assignee", async () => {
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 42 });
    expect(result).toBe("assignee");
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("returns 'change_manager' when the user holds that role", async () => {
    whereMock.mockResolvedValueOnce([{ roleKey: "change_manager" }]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBe("change_manager");
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it("returns 'ecab_member' when the user holds the eCAB role", async () => {
    whereMock.mockResolvedValueOnce([{ roleKey: "ecab_member" }]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBe("ecab_member");
  });

  it("returns 'cab_chair' when the user holds the CAB chair role", async () => {
    whereMock.mockResolvedValueOnce([{ roleKey: "cab_chair" }]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBe("cab_chair");
  });

  it("returns null for non-governance roles like technical_reviewer / business_owner / implementer", async () => {
    whereMock.mockResolvedValueOnce([
      { roleKey: "technical_reviewer" },
      { roleKey: "business_owner" },
      { roleKey: "implementer" },
    ]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBeNull();
  });

  it("returns null for an authenticated user with no relationship and no governance role", async () => {
    whereMock.mockResolvedValueOnce([{ roleKey: "auditor" }]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBeNull();
  });

  it("returns null for an authenticated user with no roles assigned", async () => {
    whereMock.mockResolvedValueOnce([]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBeNull();
  });

  it("returns null when assignee is null and user is not the owner / governance", async () => {
    whereMock.mockResolvedValueOnce([{ roleKey: "submitter" }]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: null });
    expect(result).toBeNull();
  });

  it("treats users with multiple roles correctly when one is change_manager", async () => {
    whereMock.mockResolvedValueOnce([
      { roleKey: "auditor" },
      { roleKey: "change_manager" },
      { roleKey: "ecab_member" },
    ]);
    const result = await getChangeAccess(userSession, { ownerId: 7, assigneeId: 8 });
    expect(result).toBe("change_manager");
  });
});

describe("isPrivilegedAccess", () => {
  it("treats admin and governance roles as privileged", () => {
    expect(isPrivilegedAccess("admin")).toBe(true);
    for (const role of GOVERNANCE_ROLES) {
      expect(isPrivilegedAccess(role)).toBe(true);
    }
  });

  it("does not treat owner / assignee / null as privileged", () => {
    expect(isPrivilegedAccess("owner")).toBe(false);
    expect(isPrivilegedAccess("assignee")).toBe(false);
    expect(isPrivilegedAccess(null)).toBe(false);
  });
});
