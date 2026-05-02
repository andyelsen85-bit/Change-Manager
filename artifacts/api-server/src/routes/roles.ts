import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, rolesTable, roleAssignmentsTable, usersTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get("/roles", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(rolesTable);
  res.json(rows);
});

router.get("/role-assignments", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: roleAssignmentsTable.id,
      roleKey: roleAssignmentsTable.roleKey,
      userId: roleAssignmentsTable.userId,
      isDeputy: roleAssignmentsTable.isDeputy,
      primaryAssignmentId: roleAssignmentsTable.primaryAssignmentId,
      userName: usersTable.fullName,
    })
    .from(roleAssignmentsTable)
    .leftJoin(usersTable, eq(usersTable.id, roleAssignmentsTable.userId));
  res.json(rows.map((r) => ({ ...r, userName: r.userName ?? "Unknown" })));
});

router.post("/role-assignments", requireAdmin, async (req, res): Promise<void> => {
  const { roleKey, userId, isDeputy, primaryAssignmentId } = req.body ?? {};
  if (typeof roleKey !== "string" || typeof userId !== "number" || typeof isDeputy !== "boolean") {
    res.status(400).json({ error: "roleKey, userId, isDeputy required" });
    return;
  }
  const [created] = await db
    .insert(roleAssignmentsTable)
    .values({ roleKey, userId, isDeputy, primaryAssignmentId: primaryAssignmentId ?? null })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    res.status(400).json({ error: "Assignment already exists" });
    return;
  }
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  await audit(req, {
    action: "role.assigned",
    entityType: "role",
    entityId: null,
    summary: `Assigned ${u?.username ?? userId} to role ${roleKey}${isDeputy ? " (deputy)" : ""}`,
    after: { roleKey, userId, isDeputy },
  });
  res.status(201).json({ ...created, userName: u?.fullName ?? "Unknown" });
});

router.delete("/role-assignments/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(roleAssignmentsTable).where(eq(roleAssignmentsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(roleAssignmentsTable).where(eq(roleAssignmentsTable.id, id));
  await audit(req, {
    action: "role.unassigned",
    entityType: "role",
    entityId: null,
    summary: `Removed assignment ${before.roleKey} from user ${before.userId}`,
    before,
  });
  res.status(204).end();
});

export default router;
