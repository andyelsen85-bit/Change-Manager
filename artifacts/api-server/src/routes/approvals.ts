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
  // Post-CAB sign-off gate: only enforced for the Normal track. Normal changes
  // are reviewed at a scheduled CAB meeting and votes are recorded after the
  // meeting has concluded, so we require the linked meeting to be `completed`.
  // Emergency changes vote directly in the Approvals tab without a meeting
  // (that is the entire point of the emergency flow), so they only need to be
  // in `awaiting_approval`. Standard changes carry no approval rows at all.
  const [chgForGate] = await db
    .select()
    .from(changeRequestsTable)
    .where(eq(changeRequestsTable.id, ap.changeId));
  if (chgForGate && (chgForGate.track === "normal" || chgForGate.track === "emergency")) {
    // Resolve the linked CAB meeting (if any) up-front. For Normal-track
    // changes the meeting must be in_progress|completed before votes count.
    let meetingActive = false;
    if (chgForGate.cabMeetingId != null) {
      const [meeting] = await db
        .select()
        .from(cabMeetingsTable)
        .where(eq(cabMeetingsTable.id, chgForGate.cabMeetingId));
      if (meeting?.status === "in_progress" || meeting?.status === "completed") meetingActive = true;
    }
    // When the Change Manager (or deputy) approves a docketed change in the
    // meeting view, the change should be auto-promoted into `awaiting_approval`
    // if it isn't there yet. This lets the approval happen "in parallel" with
    // the meeting workflow without forcing a manual status flip first.
    const promotable = ["draft", "submitted", "in_review"];
    if (
      chgForGate.status !== "awaiting_approval" &&
      promotable.includes(chgForGate.status) &&
      ((chgForGate.track === "normal" && meetingActive) || chgForGate.track === "emergency")
    ) {
      await db
        .update(changeRequestsTable)
        .set({ status: "awaiting_approval" })
        .where(eq(changeRequestsTable.id, chgForGate.id));
      chgForGate.status = "awaiting_approval";
      await audit(req, {
        action: "change.transitioned",
        entityType: "change",
        entityId: chgForGate.id,
        summary: `${chgForGate.ref}: auto-promoted to awaiting_approval on CAB vote`,
        before: { status: chgForGate.status },
        after: { status: "awaiting_approval" },
      });
    }
    if (chgForGate.status !== "awaiting_approval") {
      res.status(409).json({
        error: "Approval votes can only be recorded while the change is awaiting approval.",
      });
      return;
    }
    if (chgForGate.track === "normal" && !meetingActive) {
      res.status(409).json({
        error: "Approval can only be recorded after the CAB meeting has started or concluded.",
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
  // Auto-flip to "approved" requires that EVERY required approval is explicitly
  // `approved`. Abstain or pending votes do NOT count as approval — abstaining
  // approvers must either approve or reject before the change is approved.
  // This prevents an Emergency change from being implemented on a single
  // change_manager abstain + ecab_member approved (or vice versa).
  const allExplicitlyApproved = all.length > 0 && all.every((a) => a.decision === "approved");
  let newStatus: string | null = null;
  if (anyRejected) newStatus = "rejected";
  else if (allExplicitlyApproved) newStatus = "approved";
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
