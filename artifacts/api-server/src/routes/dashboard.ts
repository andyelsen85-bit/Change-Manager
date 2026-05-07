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

/**
 * Resolve a `range` query value into an inclusive [start, end] window over
 * `created_at`. Always anchored to whole calendar months so the result is
 * stable regardless of the time of day the request is made.
 *
 * Supported values:
 *   - "all" (default)  : no filtering
 *   - "last_month"     : the previous calendar month (e.g. on 2026-05-07
 *                        this is 2026-04-01 00:00 .. 2026-04-30 23:59:59.999)
 *   - "last_6_months"  : rolling 6 months back from now (e.g. on 2026-05-07
 *                        this is 2025-11-07 00:00 .. now)
 *   - "last_year"      : rolling 12 months back from now (e.g. on 2026-05-07
 *                        this is 2025-05-07 00:00 .. now)
 *
 * Returns `null` for "all" / unknown values so callers can skip filtering.
 */
function resolveRange(range: string | undefined): { start: Date; end: Date } | null {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  switch (range) {
    case "last_month": {
      // Previous calendar month: from day 1 to last instant of that month.
      const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
      const end = new Date(y, m, 0, 23, 59, 59, 999); // day 0 of current month = last day of previous
      return { start, end };
    }
    case "last_6_months": {
      // Rolling 6 months back from today (inclusive of today). Day-of-month
      // is preserved; if the target month doesn't have that day (e.g. Aug 31
      // - 6 months would be Feb 31), Date arithmetic rolls forward, which is
      // acceptable for a dashboard window.
      const start = new Date(y, m - 6, now.getDate(), 0, 0, 0, 0);
      return { start, end: now };
    }
    case "last_year": {
      // Rolling 12 months back from today (inclusive of today).
      const start = new Date(y - 1, m, now.getDate(), 0, 0, 0, 0);
      return { start, end: now };
    }
    default:
      return null;
  }
}

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const range = resolveRange(typeof req.query.range === "string" ? req.query.range : undefined);
  // We pull all rows then filter in-process. The dataset is small (single-org
  // change log) and this keeps the in-memory aggregations identical to the
  // unfiltered branch — switching to SQL aggregates would only matter once
  // we hit tens of thousands of changes.
  const allRaw = await db.select().from(changeRequestsTable);
  const all = range
    ? allRaw.filter((c) => c.createdAt >= range.start && c.createdAt <= range.end)
    : allRaw;
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
