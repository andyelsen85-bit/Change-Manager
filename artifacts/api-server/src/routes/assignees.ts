import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  changeAssigneesTable,
  changeRequestsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, getChangeAccess } from "../lib/auth";
import { audit } from "../lib/audit";
import { notify, getUserEmails } from "../lib/email";

// Roles that can be assigned per-change. Mirrors the seeded role keys but
// scoped to those that map onto a single human contributor for an
// individual change record (Tech Reviewer / Implementer / Tester).
const ASSIGNABLE_ROLES = ["technical_reviewer", "implementer", "tester"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const router: IRouter = Router();

router.get("/changes/:id/assignees", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [chg] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!chg) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await getChangeAccess(req.session!, chg))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rows = await db
    .select({
      id: changeAssigneesTable.id,
      changeId: changeAssigneesTable.changeId,
      roleKey: changeAssigneesTable.roleKey,
      userId: changeAssigneesTable.userId,
      userName: usersTable.fullName,
    })
    .from(changeAssigneesTable)
    .leftJoin(usersTable, eq(usersTable.id, changeAssigneesTable.userId))
    .where(eq(changeAssigneesTable.changeId, id));
  res.json(rows.map((r) => ({ ...r, userName: r.userName ?? "Unknown" })));
});

router.put("/changes/:id/assignees", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [chg] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!chg) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await getChangeAccess(req.session!, chg))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const body = req.body ?? {};
  // Body shape: { assignments: { roleKey: userId | null, ... } }
  const assignments: Record<string, unknown> = body.assignments ?? body ?? {};
  const before = await db.select().from(changeAssigneesTable).where(eq(changeAssigneesTable.changeId, id));
  for (const role of ASSIGNABLE_ROLES) {
    if (!(role in assignments)) continue;
    const v = assignments[role];
    await db
      .delete(changeAssigneesTable)
      .where(and(eq(changeAssigneesTable.changeId, id), eq(changeAssigneesTable.roleKey, role)));
    if (typeof v === "number" && Number.isFinite(v)) {
      const [u] = await db.select().from(usersTable).where(eq(usersTable.id, v));
      if (u) {
        await db
          .insert(changeAssigneesTable)
          .values({ changeId: id, roleKey: role, userId: v });
      }
    }
  }
  const after = await db.select().from(changeAssigneesTable).where(eq(changeAssigneesTable.changeId, id));
  await audit(req, {
    action: "change.assignees_updated",
    entityType: "change",
    entityId: id,
    summary: `Updated per-change assignees on ${chg.ref}`,
    before,
    after,
  });
  // Notify the union of previous + new assignees so dropped users learn
  // they're off the change and freshly assigned users are looped in.
  const userIds = new Set<number>();
  for (const r of [...before, ...after]) userIds.add(r.userId);
  if (userIds.size > 0) {
    const targets = await getUserEmails(Array.from(userIds));
    if (targets.length > 0) {
      await notify({
        eventKey: "change.assignee_changed",
        to: targets,
        subject: `[CHG ${chg.ref}] Assignees updated`,
        text: `Per-change assignees were updated on ${chg.ref} ${chg.title}.`,
      });
    }
  }
  const rows = await db
    .select({
      id: changeAssigneesTable.id,
      changeId: changeAssigneesTable.changeId,
      roleKey: changeAssigneesTable.roleKey,
      userId: changeAssigneesTable.userId,
      userName: usersTable.fullName,
    })
    .from(changeAssigneesTable)
    .leftJoin(usersTable, eq(usersTable.id, changeAssigneesTable.userId))
    .where(eq(changeAssigneesTable.changeId, id));
  res.json(rows.map((r) => ({ ...r, userName: r.userName ?? "Unknown" })));
});

// Helper used by other routes (changes / approvals / notify) to pull the
// assigned user IDs for a given change. Returns an empty list when no
// per-change assignment exists for that role — callers fall back to the
// global role pool in that case.
export async function getAssignedUserIds(changeId: number, roleKey: AssignableRole): Promise<number[]> {
  const rows = await db
    .select({ userId: changeAssigneesTable.userId })
    .from(changeAssigneesTable)
    .where(and(eq(changeAssigneesTable.changeId, changeId), eq(changeAssigneesTable.roleKey, roleKey)));
  return rows.map((r) => r.userId);
}

export default router;
