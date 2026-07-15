import { and, eq } from "drizzle-orm";
import {
  db,
  notificationRoutingRulesTable,
  roleAssignmentsTable,
  changeAssigneesTable,
  pentestCollaboratorsTable,
  type NotificationRoutingRule,
} from "@workspace/db";
import { getUserEmails, type NotifyTarget } from "./email";

// Catalogue of events whose recipients are driven by notification_routing_rules.
// Events not in this list (cab.*, approval.requested) keep their bespoke
// routing because the recipient list is dynamic to the meeting roster /
// approval row, not configurable on a per-event basis.
export const ROUTABLE_EVENTS = [
  "change.submitted",
  "change.cancelled",
  "change.completed",
  "approval.granted",
  "approval.rejected",
  "test.signed_off",
  "comment.added",
  "pir.due",
  "pir.reminder",
  "pentest.requested",
  "pentest.status_changed",
] as const;
export type RoutableEvent = (typeof ROUTABLE_EVENTS)[number];

// owner/assignee/per_change_role come from the change context; "collaborator"
// is pentest-specific (the per-request collaborator list). "role" works for
// both (a global role pool such as change_manager or pentest_mgmt).
export type RoutingKind = "owner" | "assignee" | "role" | "per_change_role" | "collaborator";

export type RoutingContext = {
  changeId?: number;
  ownerId?: number | null;
  assigneeId?: number | null;
  track?: string;
  actorUserId?: number;
  // PenTest context: the request id, used to expand "collaborator" rules.
  // For pentest events "ownerId" carries the request creator's id.
  pentestId?: number;
};

export const DEFAULT_ROUTING_RULES: Array<{
  eventKey: string;
  kind: RoutingKind;
  roleKey?: string | null;
  trackFilter?: string | null;
  excludeActor?: boolean;
  sortOrder?: number;
}> = [
  { eventKey: "change.submitted", kind: "role", roleKey: "change_manager", sortOrder: 10 },
  { eventKey: "change.submitted", kind: "owner", sortOrder: 20 },
  { eventKey: "change.submitted", kind: "role", roleKey: "ecab_member", trackFilter: "emergency", sortOrder: 30 },

  { eventKey: "change.cancelled", kind: "owner", sortOrder: 10 },
  { eventKey: "change.cancelled", kind: "assignee", sortOrder: 20 },

  { eventKey: "change.completed", kind: "owner", sortOrder: 10 },
  { eventKey: "change.completed", kind: "assignee", sortOrder: 20 },
  { eventKey: "change.completed", kind: "per_change_role", roleKey: "implementer", sortOrder: 30 },
  { eventKey: "change.completed", kind: "per_change_role", roleKey: "tester", sortOrder: 40 },

  { eventKey: "approval.granted", kind: "owner", sortOrder: 10 },

  // Rejections always go to the owner (and assignee, when set) so the
  // requester learns the outcome and the mandatory rejection reason.
  { eventKey: "approval.rejected", kind: "owner", sortOrder: 10 },
  { eventKey: "approval.rejected", kind: "assignee", sortOrder: 20 },

  { eventKey: "test.signed_off", kind: "owner", sortOrder: 10 },

  { eventKey: "comment.added", kind: "owner", excludeActor: true, sortOrder: 10 },
  { eventKey: "comment.added", kind: "assignee", excludeActor: true, sortOrder: 20 },

  { eventKey: "pir.due", kind: "owner", sortOrder: 10 },
  { eventKey: "pir.due", kind: "assignee", sortOrder: 20 },

  // PIR deadline approaching (<10 days left): escalate to the Change Manager
  // pool — deputies are included because deputy assignments live in the same
  // role pool (role_assignments.role_key = change_manager).
  { eventKey: "pir.reminder", kind: "role", roleKey: "change_manager", sortOrder: 10 },

  // PenTesting (TopSecret) — defaults preserve the original fixed audience:
  // the request creator, its collaborators, and the pentest_mgmt role pool.
  { eventKey: "pentest.requested", kind: "owner", sortOrder: 10 },
  { eventKey: "pentest.requested", kind: "collaborator", sortOrder: 20 },
  { eventKey: "pentest.requested", kind: "role", roleKey: "pentest_mgmt", sortOrder: 30 },

  { eventKey: "pentest.status_changed", kind: "owner", excludeActor: true, sortOrder: 10 },
  { eventKey: "pentest.status_changed", kind: "collaborator", excludeActor: true, sortOrder: 20 },
  { eventKey: "pentest.status_changed", kind: "role", roleKey: "pentest_mgmt", excludeActor: true, sortOrder: 30 },
];

async function expandRule(
  rule: NotificationRoutingRule,
  ctx: RoutingContext,
): Promise<number[]> {
  switch (rule.kind) {
    case "owner":
      return ctx.ownerId ? [ctx.ownerId] : [];
    case "assignee":
      return ctx.assigneeId ? [ctx.assigneeId] : [];
    case "role": {
      if (!rule.roleKey) return [];
      const rows = await db
        .select({ userId: roleAssignmentsTable.userId })
        .from(roleAssignmentsTable)
        .where(eq(roleAssignmentsTable.roleKey, rule.roleKey));
      return rows.map((r) => r.userId);
    }
    case "per_change_role": {
      if (!rule.roleKey || !ctx.changeId) return [];
      const perChange = await db
        .select({ userId: changeAssigneesTable.userId })
        .from(changeAssigneesTable)
        .where(
          and(
            eq(changeAssigneesTable.changeId, ctx.changeId),
            eq(changeAssigneesTable.roleKey, rule.roleKey),
          ),
        );
      if (perChange.length > 0) return perChange.map((r) => r.userId);
      const fallback = await db
        .select({ userId: roleAssignmentsTable.userId })
        .from(roleAssignmentsTable)
        .where(eq(roleAssignmentsTable.roleKey, rule.roleKey));
      return fallback.map((r) => r.userId);
    }
    case "collaborator": {
      if (!ctx.pentestId) return [];
      const rows = await db
        .select({ userId: pentestCollaboratorsTable.userId })
        .from(pentestCollaboratorsTable)
        .where(eq(pentestCollaboratorsTable.pentestId, ctx.pentestId));
      return rows.map((r) => r.userId);
    }
    default:
      return [];
  }
}

export async function resolveRecipientIds(
  eventKey: string,
  ctx: RoutingContext,
): Promise<number[]> {
  const rules = await db
    .select()
    .from(notificationRoutingRulesTable)
    .where(
      and(
        eq(notificationRoutingRulesTable.eventKey, eventKey),
        eq(notificationRoutingRulesTable.isActive, true),
      ),
    );
  const out = new Set<number>();
  for (const r of rules) {
    if (r.trackFilter && r.trackFilter !== ctx.track) continue;
    const ids = await expandRule(r, ctx);
    for (const id of ids) {
      if (r.excludeActor && ctx.actorUserId === id) continue;
      out.add(id);
    }
  }
  return Array.from(out);
}

export async function resolveRecipients(
  eventKey: string,
  ctx: RoutingContext,
): Promise<NotifyTarget[]> {
  const ids = await resolveRecipientIds(eventKey, ctx);
  return getUserEmails(ids);
}

// Idempotent seed that tops up defaults per event. An event's default rules are
// only inserted when that event currently has zero rules, so admin edits to
// existing events are never overwritten, while newly added routable events
// (e.g. pentest.*) get their defaults on the next restart of an existing install.
export async function seedDefaultRoutingRules(): Promise<void> {
  const existing = await db
    .select({ eventKey: notificationRoutingRulesTable.eventKey })
    .from(notificationRoutingRulesTable);
  const eventsWithRules = new Set(existing.map((r) => r.eventKey));
  for (const r of DEFAULT_ROUTING_RULES) {
    if (eventsWithRules.has(r.eventKey)) continue;
    await db.insert(notificationRoutingRulesTable).values({
      eventKey: r.eventKey,
      kind: r.kind,
      roleKey: r.roleKey ?? null,
      trackFilter: r.trackFilter ?? null,
      excludeActor: r.excludeActor ?? false,
      isActive: true,
      sortOrder: r.sortOrder ?? 0,
    });
  }
}
