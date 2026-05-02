import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  approvalsTable,
  changeRequestsTable,
  cabMeetingsTable,
  rolesTable,
  usersTable,
  roleAssignmentsTable,
} from "@workspace/db";
import { requireAuth, getChangeAccess } from "../lib/auth";
import { audit } from "../lib/audit";
import { notify, getUserEmail } from "../lib/email";

const router: IRouter = Router();

router.get("/changes/:id/approvals", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [chg] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!chg) {
    res.status(404).json({ error: "Change not found" });
    return;
  }
  if (!(await getChangeAccess(req.session!, chg))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rows = await db
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
  res.json(rows.map((r) => ({ ...r, roleName: r.roleName ?? r.roleKey, approverName: r.approverName ?? null })));
});

router.post("/approvals/:id/vote", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const session = req.session!;
  const { decision, comment } = req.body ?? {};
  if (!["approved", "rejected", "abstain"].includes(decision)) {
    res.status(400).json({ error: "Invalid decision" });
    return;
  }
  // ITIL: a rejection must always include the rejection reason for audit and PIR.
  if (decision === "rejected" && (typeof comment !== "string" || comment.trim().length < 3)) {
    res.status(400).json({ error: "A rejection comment (at least 3 characters) is required." });
    return;
  }
  const [ap] = await db.select().from(approvalsTable).where(eq(approvalsTable.id, id));
  if (!ap) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  // Post-CAB sign-off gate: for Normal and Emergency tracks the approval vote must be
  // recorded *after* the linked CAB / eCAB meeting has concluded. We allow either
  // (a) the change to already be in `awaiting_approval` status (meaning the state
  //     machine has explicitly moved it past the CAB step), or
  // (b) the linked cab meeting status to be `completed`.
  // Standard-track changes never carry approval rows, so this never fires for them.
  const [chgForGate] = await db
    .select()
    .from(changeRequestsTable)
    .where(eq(changeRequestsTable.id, ap.changeId));
  if (chgForGate && (chgForGate.track === "normal" || chgForGate.track === "emergency")) {
    // The vote is only valid when the change is in `awaiting_approval` AND the linked
    // CAB / eCAB meeting has been marked completed. Both checks are required: the
    // status-only check would otherwise let a caller who flipped status by another
    // path bypass the CAB requirement.
    if (chgForGate.status !== "awaiting_approval") {
      res.status(409).json({
        error: "Approval votes can only be recorded while the change is awaiting approval.",
      });
      return;
    }
    let cabCompleted = false;
    if (chgForGate.cabMeetingId != null) {
      const [meeting] = await db
        .select()
        .from(cabMeetingsTable)
        .where(eq(cabMeetingsTable.id, chgForGate.cabMeetingId));
      if (meeting?.status === "completed") cabCompleted = true;
    }
    if (!cabCompleted) {
      res.status(409).json({
        error: "Approval can only be recorded after the CAB / eCAB meeting has concluded.",
      });
      return;
    }
  }
  // Verify the user is in this role (or its deputy)
  const assignments = await db
    .select()
    .from(roleAssignmentsTable)
    .where(eq(roleAssignmentsTable.roleKey, ap.roleKey));
  const me = assignments.find((a) => a.userId === session.uid);
  if (!me && !session.isAdmin) {
    res.status(403).json({ error: "You are not assigned to this approver role" });
    return;
  }
  const [updated] = await db
    .update(approvalsTable)
    .set({
      decision,
      comment: typeof comment === "string" ? comment : null,
      approverId: session.uid,
      decidedAt: new Date(),
      viaDeputy: !!me?.isDeputy,
    })
    .where(eq(approvalsTable.id, id))
    .returning();

  // Check whether all approvals decided -> set change status. Critically, this auto-flip
  // only happens when the change is currently in `awaiting_approval` so a vote on a stale
  // approval row cannot teleport a draft/cancelled/in-progress change into approved/rejected
  // and bypass the state machine.
  const all = await db.select().from(approvalsTable).where(eq(approvalsTable.changeId, ap.changeId));
  const anyRejected = all.some((a) => a.decision === "rejected");
  const allDecided = all.every((a) => a.decision === "approved" || a.decision === "abstain" || a.decision === "rejected");
  let newStatus: string | null = null;
  if (anyRejected) newStatus = "rejected";
  else if (allDecided && all.every((a) => a.decision !== "pending")) newStatus = "approved";
  if (newStatus) {
    const [current] = await db
      .select({ status: changeRequestsTable.status })
      .from(changeRequestsTable)
      .where(eq(changeRequestsTable.id, ap.changeId));
    if (current?.status === "awaiting_approval") {
      await db
        .update(changeRequestsTable)
        .set({ status: newStatus })
        .where(eq(changeRequestsTable.id, ap.changeId));
    } else {
      // Vote was recorded but change isn't in awaiting_approval — don't auto-flip status.
      newStatus = null;
    }
  }
  const [change] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, ap.changeId));
  await audit(req, {
    action: "approval.voted",
    entityType: "change",
    entityId: ap.changeId,
    summary: `${change?.ref ?? ap.changeId}: ${ap.roleKey} ${decision}${comment ? ` — ${comment}` : ""}`,
    after: { decision, comment, viaDeputy: !!me?.isDeputy },
  });
  if (change) {
    const owner = await getUserEmail(change.ownerId);
    if (owner) {
      await notify({
        eventKey: decision === "rejected" ? "approval.rejected" : "approval.granted",
        to: [owner],
        subject: `[CHG ${change.ref}] ${ap.roleKey} ${decision}`,
        text: `${change.ref} ${change.title}\n\n${ap.roleKey} decision: ${decision}${comment ? "\n\n" + comment : ""}`,
      });
    }
  }
  res.json({ ...updated, status: newStatus });
});

export default router;
