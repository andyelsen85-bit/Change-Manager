import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  changeRequestsTable,
  usersTable,
  standardTemplatesTable,
  planningRecordsTable,
  testRecordsTable,
  pirRecordsTable,
  approvalsTable,
  commentsTable,
  rolesTable,
  roleAssignmentsTable,
  cabMeetingsTable,
} from "@workspace/db";
import { requireAuth, getChangeAccess } from "../lib/auth";
import { audit } from "../lib/audit";
import { nextRef } from "../lib/ref";
import { notify, getUserEmail } from "../lib/email";
import {
  isTransitionAllowed,
  listAllowedTransitions,
  checkPhaseGates,
  type ChangeTrack,
  type ChangeStatus,
} from "../lib/state-machine";

const router: IRouter = Router();

// Approver roles required per track. Per policy, Normal changes are signed off by the
// Change Manager only after the CAB meeting; their deputy can vote in their absence
// (handled at vote time via roleAssignmentsTable.isDeputy). Technical and business sign-off
// is captured in the planning + CAB-meeting records, not as separate approval votes.
// Emergency changes still require an eCAB member alongside the Change Manager.
const APPROVER_ROLES_BY_TRACK: Record<string, string[]> = {
  normal: ["change_manager"],
  emergency: ["change_manager", "ecab_member"],
  standard: [],
};

async function expandChangeRow(c: typeof changeRequestsTable.$inferSelect) {
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, c.ownerId));
  let assigneeName: string | null = null;
  if (c.assigneeId != null) {
    const [a] = await db.select().from(usersTable).where(eq(usersTable.id, c.assigneeId));
    assigneeName = a?.fullName ?? null;
  }
  let templateName: string | null = null;
  if (c.templateId != null) {
    const [t] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, c.templateId));
    templateName = t?.name ?? null;
  }
  return {
    ...c,
    ownerName: owner?.fullName ?? "Unknown",
    assigneeName,
    templateName,
  };
}

async function createApprovalsForChange(changeId: number, track: string) {
  const roleKeys = APPROVER_ROLES_BY_TRACK[track] ?? [];
  for (const roleKey of roleKeys) {
    await db.insert(approvalsTable).values({ changeId, roleKey, decision: "pending" });
  }
}

async function notifyApprovers(changeId: number, change: typeof changeRequestsTable.$inferSelect) {
  const approvals = await db.select().from(approvalsTable).where(eq(approvalsTable.changeId, changeId));
  for (const ap of approvals) {
    if (ap.decision !== "pending") continue;
    const assignees = await db
      .select({ userId: roleAssignmentsTable.userId })
      .from(roleAssignmentsTable)
      .where(eq(roleAssignmentsTable.roleKey, ap.roleKey));
    const targets = (
      await Promise.all(assignees.map((a) => getUserEmail(a.userId)))
    ).filter((t): t is { userId: number; email: string; name: string } => !!t);
    if (targets.length === 0) continue;
    await notify({
      eventKey: "approval.requested",
      to: targets,
      subject: `[CHG ${change.ref}] Approval requested: ${change.title}`,
      text: `Your approval is required for change ${change.ref} (${change.track}).\n\n${change.description}\n\nRisk: ${change.risk}, Impact: ${change.impact}, Priority: ${change.priority}.`,
    });
  }
}

router.get("/changes", requireAuth, async (req, res): Promise<void> => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : null;
  const track = typeof req.query["track"] === "string" ? req.query["track"] : null;
  const ownerId = req.query["ownerId"] ? Number(req.query["ownerId"]) : null;
  const search = typeof req.query["search"] === "string" ? req.query["search"] : null;
  const conds = [];
  if (status) conds.push(eq(changeRequestsTable.status, status));
  if (track) conds.push(eq(changeRequestsTable.track, track));
  if (ownerId && Number.isFinite(ownerId)) conds.push(eq(changeRequestsTable.ownerId, ownerId));
  if (search) {
    conds.push(
      or(
        ilike(changeRequestsTable.title, `%${search}%`),
        ilike(changeRequestsTable.ref, `%${search}%`),
        ilike(changeRequestsTable.description, `%${search}%`),
      )!,
    );
  }
  const rows = conds.length
    ? await db
        .select()
        .from(changeRequestsTable)
        .where(and(...conds))
        .orderBy(desc(changeRequestsTable.createdAt))
    : await db.select().from(changeRequestsTable).orderBy(desc(changeRequestsTable.createdAt));
  const dtos = await Promise.all(rows.map(expandChangeRow));
  res.json(dtos);
});

router.post("/changes", requireAuth, async (req, res): Promise<void> => {
  const session = req.session!;
  const b = req.body ?? {};
  if (!b.title || !b.description || !b.track || !b.risk || !b.impact || !b.priority || !b.category) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  // Standard-track classification: only allowed when an active, existing template is
  // referenced. Submissions that claim 'standard' without a valid + active template are
  // rejected with HTTP 400 so callers cannot smuggle changes around the approval
  // pipeline by claiming a non-existent or disabled template.
  let track = b.track;
  let templateId: number | null = null;
  let initialStatus = "draft";
  let bypassCab = false;
  let autoApprove = false;
  if (track === "standard") {
    if (!b.templateId) {
      res.status(400).json({ error: "Standard changes require a templateId." });
      return;
    }
    const [t] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, b.templateId));
    if (!t || !t.isActive) {
      res.status(400).json({ error: "Selected template is unknown or inactive." });
      return;
    }
    templateId = t.id;
    bypassCab = t.bypassCab;
    autoApprove = t.autoApprove;
    if (autoApprove) initialStatus = "approved";
    if (bypassCab) initialStatus = autoApprove ? "scheduled" : "awaiting_implementation";
  }
  const ref = await nextRef(track);
  const [created] = await db
    .insert(changeRequestsTable)
    .values({
      ref,
      title: b.title,
      description: b.description,
      track,
      status: initialStatus,
      risk: b.risk,
      impact: b.impact,
      priority: b.priority,
      category: b.category,
      ownerId: session.uid,
      assigneeId: b.assigneeId ?? null,
      templateId,
      plannedStart: b.plannedStart ? new Date(b.plannedStart) : null,
      plannedEnd: b.plannedEnd ? new Date(b.plannedEnd) : null,
    })
    .returning();
  // Always create an empty planning record
  await db.insert(planningRecordsTable).values({ changeId: created.id }).onConflictDoNothing();
  // Pre-fill planning from template + bump the template's usage counter so admins can
  // see which templates are most relied on.
  if (templateId) {
    const [t] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, templateId));
    await db
      .update(standardTemplatesTable)
      .set({ usageCount: sql`${standardTemplatesTable.usageCount} + 1` })
      .where(eq(standardTemplatesTable.id, templateId));
    if (t?.prefilledPlanning) {
      await db
        .update(planningRecordsTable)
        .set({ implementationPlan: t.prefilledPlanning })
        .where(eq(planningRecordsTable.changeId, created.id));
    }
    if (t?.prefilledTestPlan) {
      await db
        .insert(testRecordsTable)
        .values({ changeId: created.id, testPlan: t.prefilledTestPlan })
        .onConflictDoNothing();
    }
  }
  if (track !== "standard") {
    await createApprovalsForChange(created.id, track);
  }
  await audit(req, {
    action: "change.created",
    entityType: "change",
    entityId: created.id,
    summary: `Created ${b.track} change ${ref}: ${b.title}`,
    after: created,
  });
  if (initialStatus === "draft" && b.track !== "standard") {
    await notifyApprovers(created.id, created);
  }
  res.status(201).json(await expandChangeRow(created));
});

router.get("/changes/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await getChangeAccess(req.session!, row))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const dto = await expandChangeRow(row);
  const [planning] = await db.select().from(planningRecordsTable).where(eq(planningRecordsTable.changeId, id));
  const [testing] = await db.select().from(testRecordsTable).where(eq(testRecordsTable.changeId, id));
  const [pir] = await db.select().from(pirRecordsTable).where(eq(pirRecordsTable.changeId, id));
  const approvals = await db
    .select({
      id: approvalsTable.id,
      changeId: approvalsTable.changeId,
      roleKey: approvalsTable.roleKey,
      approverId: approvalsTable.approverId,
      decision: approvalsTable.decision,
      comment: approvalsTable.comment,
      decidedAt: approvalsTable.decidedAt,
      viaDeputy: approvalsTable.viaDeputy,
      roleName: rolesTable.name,
      approverName: usersTable.fullName,
    })
    .from(approvalsTable)
    .leftJoin(rolesTable, eq(rolesTable.key, approvalsTable.roleKey))
    .leftJoin(usersTable, eq(usersTable.id, approvalsTable.approverId))
    .where(eq(approvalsTable.changeId, id));
  const comments = await db
    .select({
      id: commentsTable.id,
      changeId: commentsTable.changeId,
      authorId: commentsTable.authorId,
      body: commentsTable.body,
      createdAt: commentsTable.createdAt,
      authorName: usersTable.fullName,
    })
    .from(commentsTable)
    .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
    .where(eq(commentsTable.changeId, id))
    .orderBy(desc(commentsTable.createdAt));
  res.json({
    ...dto,
    planning: planning ?? { changeId: id, scope: "", implementationPlan: "", rollbackPlan: "", riskAssessment: "", impactedServices: "", communicationsPlan: "", successCriteria: "", signedOff: false },
    testing: testing ?? { changeId: id, testPlan: "", environment: "", overallResult: "pending", notes: "", cases: [] },
    pir: pir ?? { changeId: id, outcome: "successful", objectivesMet: "", issuesEncountered: "", lessonsLearned: "", followupActions: "" },
    approvals: approvals.map((a) => ({
      ...a,
      roleName: a.roleName ?? a.roleKey,
      approverName: a.approverName ?? null,
    })),
    comments: comments.map((c) => ({ ...c, authorName: c.authorName ?? "Unknown" })),
  });
});

router.patch("/changes/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const access = await getChangeAccess(req.session!, before);
  if (!access) {
    res.status(403).json({ error: "Only the owner, assignee, change manager, or an admin can edit this change." });
    return;
  }
  const b = req.body ?? {};
  const updates: Partial<typeof changeRequestsTable.$inferInsert> = {};
  for (const k of ["title", "description", "risk", "impact", "priority", "category"] as const) {
    if (typeof b[k] === "string") (updates as Record<string, unknown>)[k] = b[k];
  }
  if (b.assigneeId === null) updates.assigneeId = null;
  else if (typeof b.assigneeId === "number") updates.assigneeId = b.assigneeId;
  if (b.cabMeetingId === null) updates.cabMeetingId = null;
  else if (typeof b.cabMeetingId === "number") updates.cabMeetingId = b.cabMeetingId;
  if (b.plannedStart) updates.plannedStart = new Date(b.plannedStart);
  if (b.plannedStart === null) updates.plannedStart = null;
  if (b.plannedEnd) updates.plannedEnd = new Date(b.plannedEnd);
  if (b.plannedEnd === null) updates.plannedEnd = null;

  const [updated] = await db
    .update(changeRequestsTable)
    .set(updates)
    .where(eq(changeRequestsTable.id, id))
    .returning();
  await audit(req, {
    action: "change.updated",
    entityType: "change",
    entityId: id,
    summary: `Updated change ${before.ref}`,
    before,
    after: updated,
  });
  res.json(await expandChangeRow(updated));
});

router.delete("/changes/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Only admins or change_managers can delete a change. Owners cannot delete an
  // already-progressed change to preserve the immutable audit trail.
  const access = await getChangeAccess(req.session!, before);
  if (access !== "admin" && access !== "change_manager") {
    res.status(403).json({ error: "Only an admin or change manager can delete a change." });
    return;
  }
  await db.delete(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  await audit(req, {
    action: "change.deleted",
    entityType: "change",
    entityId: id,
    summary: `Deleted change ${before.ref}`,
    before,
  });
  res.status(204).end();
});

router.post("/changes/:id/transition", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { toStatus, note } = req.body ?? {};
  if (typeof toStatus !== "string") {
    res.status(400).json({ error: "toStatus is required" });
    return;
  }
  const [before] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Authorization
  const access = await getChangeAccess(req.session!, before);
  if (!access) {
    res.status(403).json({ error: "Only the owner, assignee, change manager, or an admin can transition this change." });
    return;
  }
  // Per-track state machine
  const track = before.track as ChangeTrack;
  const fromStatus = before.status as ChangeStatus;
  const targetStatus = toStatus as ChangeStatus;
  if (!isTransitionAllowed(track, fromStatus, targetStatus)) {
    res.status(400).json({
      error: `Transition ${fromStatus} → ${targetStatus} is not allowed for ${track} changes.`,
      allowed: listAllowedTransitions(track, fromStatus),
    });
    return;
  }
  // Governance gates on the transition itself.
  // 1) Moving INTO the post-CAB approval state (`awaiting_approval`) for Normal /
  //    Emergency tracks requires that the linked CAB / eCAB meeting has actually
  //    concluded. This complements the per-vote gate so a status flip itself cannot
  //    be used to fast-track around CAB.
  // 2) Only an admin or change_manager may put a change into `awaiting_approval` —
  //    owners/assignees should not be able to self-flip into the approval state.
  if (targetStatus === "awaiting_approval" && (track === "normal" || track === "emergency")) {
    if (access !== "admin" && access !== "change_manager") {
      res
        .status(403)
        .json({ error: "Only an admin or Change Manager can move a change into approval." });
      return;
    }
    let postCab = false;
    if (before.cabMeetingId != null) {
      const [meeting] = await db
        .select()
        .from(cabMeetingsTable)
        .where(eq(cabMeetingsTable.id, before.cabMeetingId));
      if (meeting?.status === "completed") postCab = true;
    }
    if (!postCab) {
      res.status(409).json({
        error: "The CAB / eCAB meeting must be marked completed before approval can begin.",
      });
      return;
    }
  }
  // Phase gates (planning sign-off, testing passed, PIR completed, approvals)
  const [planning] = await db.select().from(planningRecordsTable).where(eq(planningRecordsTable.changeId, id));
  const [testing] = await db.select().from(testRecordsTable).where(eq(testRecordsTable.changeId, id));
  const [pir] = await db.select().from(pirRecordsTable).where(eq(pirRecordsTable.changeId, id));
  const allApprovals = await db.select().from(approvalsTable).where(eq(approvalsTable.changeId, id));
  const approvalsAllApproved =
    allApprovals.length === 0 || allApprovals.every((a) => a.decision === "approved");
  const gateError = checkPhaseGates({
    track,
    toStatus: targetStatus,
    planning: planning ? { signedOff: planning.signedOff } : null,
    testing: testing
      ? {
          overallResult: testing.overallResult,
          cases: (testing.cases ?? []).map((c) => ({ status: c.status })),
        }
      : null,
    pir: pir ? { completedAt: pir.completedAt ?? null } : null,
    approvalsAllApproved,
  });
  if (gateError) {
    res.status(400).json({ error: gateError });
    return;
  }
  const updates: Partial<typeof changeRequestsTable.$inferInsert> = { status: toStatus };
  if (toStatus === "in_progress" && !before.actualStart) updates.actualStart = new Date();
  if ((toStatus === "implemented" || toStatus === "completed") && !before.actualEnd) updates.actualEnd = new Date();
  const [updated] = await db
    .update(changeRequestsTable)
    .set(updates)
    .where(eq(changeRequestsTable.id, id))
    .returning();
  await audit(req, {
    action: "change.transitioned",
    entityType: "change",
    entityId: id,
    summary: `${before.ref}: ${before.status} → ${toStatus}${note ? ` (${note})` : ""}`,
    before: { status: before.status },
    after: { status: toStatus, note: note ?? null },
  });
  // Notify owner + assignee
  const targets = [];
  const owner = await getUserEmail(before.ownerId);
  if (owner) targets.push(owner);
  if (before.assigneeId && before.assigneeId !== before.ownerId) {
    const a = await getUserEmail(before.assigneeId);
    if (a) targets.push(a);
  }
  if (targets.length > 0) {
    await notify({
      eventKey: "change.transitioned",
      to: targets,
      subject: `[CHG ${before.ref}] Status: ${toStatus}`,
      text: `${before.ref} ${before.title}\n\n${before.status} → ${toStatus}${note ? "\n\nNote: " + note : ""}`,
    });
  }
  res.json(await expandChangeRow(updated));
});

export default router;
