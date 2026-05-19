import { Router, type IRouter } from "express";
import { asc } from "drizzle-orm";
import { db, notificationRoutingRulesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import {
  ROUTABLE_EVENTS,
  DEFAULT_ROUTING_RULES,
  seedDefaultRoutingRules,
} from "../lib/notification-routing";
import { audit } from "../lib/audit";

const router: IRouter = Router();

const VALID_KINDS = new Set(["owner", "assignee", "role", "per_change_role"]);
const VALID_TRACKS = new Set(["normal", "emergency", "standard"]);

router.get("/notification-routing", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(notificationRoutingRulesTable)
    .orderBy(
      asc(notificationRoutingRulesTable.eventKey),
      asc(notificationRoutingRulesTable.sortOrder),
      asc(notificationRoutingRulesTable.id),
    );
  res.json({
    events: ROUTABLE_EVENTS,
    rules: rows,
  });
});

router.put(
  "/notification-routing",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const body = req.body ?? {};
    if (!Array.isArray(body.rules)) {
      res.status(400).json({ error: "Body must contain a 'rules' array." });
      return;
    }
    const sanitized: Array<{
      eventKey: string;
      kind: string;
      roleKey: string | null;
      trackFilter: string | null;
      excludeActor: boolean;
      isActive: boolean;
      sortOrder: number;
    }> = [];
    for (const raw of body.rules) {
      if (!raw || typeof raw !== "object") continue;
      const eventKey = String(raw.eventKey ?? "");
      const kind = String(raw.kind ?? "");
      if (!ROUTABLE_EVENTS.includes(eventKey as (typeof ROUTABLE_EVENTS)[number])) {
        res.status(400).json({ error: `Unknown eventKey: ${eventKey}` });
        return;
      }
      if (!VALID_KINDS.has(kind)) {
        res.status(400).json({ error: `Unknown kind: ${kind}` });
        return;
      }
      const roleKey = raw.roleKey ? String(raw.roleKey) : null;
      const trackFilter = raw.trackFilter ? String(raw.trackFilter) : null;
      if ((kind === "role" || kind === "per_change_role") && !roleKey) {
        res
          .status(400)
          .json({ error: `Rule of kind '${kind}' requires a roleKey.` });
        return;
      }
      if (trackFilter && !VALID_TRACKS.has(trackFilter)) {
        res.status(400).json({ error: `Unknown track: ${trackFilter}` });
        return;
      }
      sanitized.push({
        eventKey,
        kind,
        roleKey,
        trackFilter,
        excludeActor: !!raw.excludeActor,
        isActive: raw.isActive !== false,
        sortOrder: Number.isFinite(raw.sortOrder) ? Number(raw.sortOrder) : 0,
      });
    }

    await db.transaction(async (tx) => {
      await tx.delete(notificationRoutingRulesTable);
      if (sanitized.length > 0) {
        await tx.insert(notificationRoutingRulesTable).values(sanitized);
      }
    });

    await audit(req, {
      action: "notification_routing.updated",
      entityType: "settings",
      entityId: 0,
      summary: `Notification routing rules replaced (${sanitized.length} rules)`,
      after: { count: sanitized.length },
    });

    const rows = await db
      .select()
      .from(notificationRoutingRulesTable)
      .orderBy(
        asc(notificationRoutingRulesTable.eventKey),
        asc(notificationRoutingRulesTable.sortOrder),
        asc(notificationRoutingRulesTable.id),
      );
    res.json({ events: ROUTABLE_EVENTS, rules: rows });
  },
);

router.post(
  "/notification-routing/reset",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.delete(notificationRoutingRulesTable);
    });
    await seedDefaultRoutingRules();
    await audit(req, {
      action: "notification_routing.reset",
      entityType: "settings",
      entityId: 0,
      summary: `Notification routing reset to defaults (${DEFAULT_ROUTING_RULES.length} rules)`,
    });
    const rows = await db
      .select()
      .from(notificationRoutingRulesTable)
      .orderBy(
        asc(notificationRoutingRulesTable.eventKey),
        asc(notificationRoutingRulesTable.sortOrder),
        asc(notificationRoutingRulesTable.id),
      );
    res.json({ events: ROUTABLE_EVENTS, rules: rows });
  },
);

export default router;
