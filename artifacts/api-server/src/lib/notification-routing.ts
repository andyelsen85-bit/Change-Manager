import { and, eq } from "drizzle-orm";
import {
  db,
  notificationRoutingRulesTable,
  roleAssignmentsTable,
  changeAssigneesTable,
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
  "test.signed_off",
  "comment.added",
  "pir.due",
] as const;
export type RoutableEvent = (typeof ROUTABLE_EVENTS)[number];

export type RoutingKind = "owner" | "assignee" | "role" | "per_change_role";

export type RoutingContext = {
  changeId?: number;
  ownerId?: number | null;
  assigneeId?: number | null;
  track?: string;
  actorUserId?: number;
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

  { eventKey: "test.signed_off", kind: "owner", sortOrder: 10 },

  { eventKey: "comment.added", kind: "owner", excludeActor: true, sortOrder: 10 },
  { eventKey: "comment.added", kind: "assignee", excludeActor: true, sortOrder: 20 },

  { eventKey: "pir.due", kind: "owner", sortOrder: 10 },
  { eventKey: "pir.due", kind: "assignee", sortOrder: 20 },
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

export async function seedDefaultRoutingRules(): Promise<void> {
  const existing = await db.select().from(notificationRoutingRulesTable);
  if (existing.length > 0) return;
  for (const r of DEFAULT_ROUTING_RULES) {
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
