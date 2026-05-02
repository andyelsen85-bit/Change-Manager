import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import {
  db,
  changeRequestsTable,
  cabMeetingsTable,
  approvalsTable,
  auditLogTable,
  roleAssignmentsTable,
  testRecordsTable,
  pirRecordsTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

const OPEN_STATUSES = [
  "draft",
  "submitted",
  "in_review",
  "awaiting_approval",
  "approved",
  "scheduled",
  "in_progress",
  "implemented",
  "in_testing",
  "awaiting_implementation",
  "awaiting_pir",
];

router.get("/dashboard/summary", requireAuth, async (_req, res): Promise<void> => {
  const all = await db.select().from(changeRequestsTable);
  const totalChanges = all.length;
  const openChanges = all.filter((c) => OPEN_STATUSES.includes(c.status)).length;
  const awaitingApproval = all.filter((c) => c.status === "awaiting_approval" || c.status === "in_review").length;
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 86400000);
  const scheduledThisWeek = all.filter(
    (c) => c.plannedStart && c.plannedStart >= now && c.plannedStart <= weekFromNow,
  ).length;
  const emergencyOpen = all.filter((c) => c.track === "emergency" && OPEN_STATUSES.includes(c.status)).length;
  const completed = all.filter((c) => c.status === "completed");
  const successful = completed.length;
  const total = all.filter((c) => c.status === "completed" || c.status === "rejected" || c.status === "rolled_back").length;
  const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;

  const byStatus: Record<string, number> = {};
  const byTrack: Record<string, number> = { normal: 0, standard: 0, emergency: 0 };
  const byRisk: Record<string, number> = { low: 0, medium: 0, high: 0 };
  for (const c of all) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    byTrack[c.track] = (byTrack[c.track] ?? 0) + 1;
    byRisk[c.risk] = (byRisk[c.risk] ?? 0) + 1;
  }
  res.json({
    totalChanges,
    openChanges,
    awaitingApproval,
    scheduledThisWeek,
    emergencyOpen,
    successRate,
    byStatus: Object.entries(byStatus).map(([key, count]) => ({ key, count })),
    byTrack: Object.entries(byTrack).map(([key, count]) => ({ key, count })),
    byRisk: Object.entries(byRisk).map(([key, count]) => ({ key, count })),
  });
});

router.get("/dashboard/activity", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(auditLogTable).orderBy(desc(auditLogTable.timestamp)).limit(20);
  res.json(
    rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      actorName: r.actorName,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
    })),
  );
});

router.get("/dashboard/upcoming-cab", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(cabMeetingsTable)
    .where(gte(cabMeetingsTable.scheduledStart, new Date()))
    .orderBy(cabMeetingsTable.scheduledStart)
    .limit(10);
  res.json(
    rows.map((m) => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      location: m.location,
    })),
  );
});

router.get("/dashboard/my-tasks", requireAuth, async (req, res): Promise<void> => {
  const session = req.session!;
  const tasks: Array<{ kind: string; changeId: number; ref: string; title: string; due?: Date | null; note?: string }> = [];

  // Pending approvals where I'm in the role (or deputy)
  const myAssignments = await db
    .select()
    .from(roleAssignmentsTable)
    .where(eq(roleAssignmentsTable.userId, session.uid));
  if (myAssignments.length > 0) {
    const myRoles = Array.from(new Set(myAssignments.map((a) => a.roleKey)));
    const pending = await db
      .select({
        approvalId: approvalsTable.id,
        roleKey: approvalsTable.roleKey,
        changeId: approvalsTable.changeId,
        ref: changeRequestsTable.ref,
        title: changeRequestsTable.title,
      })
      .from(approvalsTable)
      .innerJoin(changeRequestsTable, eq(changeRequestsTable.id, approvalsTable.changeId))
      .where(and(eq(approvalsTable.decision, "pending"), inArray(approvalsTable.roleKey, myRoles)));
    for (const p of pending) {
      tasks.push({
        kind: "approval",
        changeId: p.changeId,
        ref: p.ref,
        title: p.title,
        note: `Pending ${p.roleKey} approval`,
      });
    }
  }

  // Changes I own that need testing/PIR
  const myChanges = await db
    .select()
    .from(changeRequestsTable)
    .where(or(eq(changeRequestsTable.ownerId, session.uid), eq(changeRequestsTable.assigneeId, session.uid))!);
  for (const c of myChanges) {
    if (c.status === "in_testing" || (c.status === "implemented" && c.track !== "standard")) {
      const [t] = await db.select().from(testRecordsTable).where(eq(testRecordsTable.changeId, c.id));
      if (!t || t.overallResult === "pending") {
        tasks.push({ kind: "testing", changeId: c.id, ref: c.ref, title: c.title, note: "Testing pending" });
      }
    }
    if (c.status === "completed" || c.status === "awaiting_pir") {
      const [p] = await db.select().from(pirRecordsTable).where(eq(pirRecordsTable.changeId, c.id));
      if (!p || !p.completedAt) {
        tasks.push({ kind: "pir", changeId: c.id, ref: c.ref, title: c.title, note: "PIR due" });
      }
    }
  }
  res.json(tasks.slice(0, 20));
});

export default router;
