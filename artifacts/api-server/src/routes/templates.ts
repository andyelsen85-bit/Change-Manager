import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, standardTemplatesTable, templateSettingsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import { getCompletedCountsByTemplate, getPromotionThreshold, DEFAULT_PROMOTION_THRESHOLD } from "../lib/template-promotion";

// Template management is a governance duty: admins always pass (requireRole
// bypass) and Change Managers get the same edit/add/delete rights.
const requireTemplateManager = requireRole(["change_manager"]);
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get("/templates", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(standardTemplatesTable);
  // Promotion progress for the "Potential Standard Change" workflow: how many
  // linked normal changes have completed per (disabled) template, and the
  // global threshold at which the template becomes a promotion candidate.
  const [counts, threshold] = await Promise.all([getCompletedCountsByTemplate(), getPromotionThreshold()]);
  res.json(
    rows.map((t) => ({
      ...t,
      completedLinkedCount: counts.get(t.id) ?? 0,
      promotionThreshold: threshold,
      promotionReady: !t.isActive && (counts.get(t.id) ?? 0) >= threshold,
    })),
  );
});

// Global promotion threshold. Readable by every authenticated user (the flag
// is rendered on change detail + CAB pages); writable only by governance.
router.get("/templates/settings", requireAuth, async (_req, res): Promise<void> => {
  res.json({ promotionThreshold: await getPromotionThreshold() });
});

router.put("/templates/settings", requireTemplateManager, async (req, res): Promise<void> => {
  const n = Number(req.body?.promotionThreshold);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    res.status(400).json({ error: "promotionThreshold must be an integer between 1 and 1000." });
    return;
  }
  await db
    .insert(templateSettingsTable)
    .values({ key: "global", promotionThreshold: n })
    .onConflictDoUpdate({ target: templateSettingsTable.key, set: { promotionThreshold: n } });
  await audit(req, {
    action: "template.settings_updated",
    entityType: "template",
    entityId: 0,
    summary: `Standard-promotion threshold set to ${n} completed changes`,
    after: { promotionThreshold: n },
  });
  res.json({ promotionThreshold: n });
});

// Ad-hoc creation of a DISABLED template from the change form ("Potential
// Standard Change" → "create new"). Open to every authenticated user — the
// template starts disabled, so it cannot be used to run standard changes; it
// only serves as the bucket that counts completed trial runs. Enabling it
// remains a governance action (PATCH /templates/:id, admin/change manager).
router.post("/templates/potential", requireAuth, async (req, res): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 3) {
    res.status(400).json({ error: "Template name is required (min 3 characters)." });
    return;
  }
  const [created] = await db
    .insert(standardTemplatesTable)
    .values({
      name,
      description: typeof req.body?.description === "string" ? req.body.description.trim() : "",
      category: typeof req.body?.category === "string" && req.body.category ? req.body.category : "general",
      autoApprove: true,
      bypassCab: true,
      isActive: false,
    })
    .returning();
  await audit(req, {
    action: "template.created",
    entityType: "template",
    entityId: created.id,
    summary: `Created potential standard template "${created.name}" (disabled)`,
    after: created,
  });
  res.status(201).json({ ...created, completedLinkedCount: 0, promotionThreshold: DEFAULT_PROMOTION_THRESHOLD, promotionReady: false });
});

router.post("/templates", requireTemplateManager, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [created] = await db
    .insert(standardTemplatesTable)
    .values({
      name: b.name,
      description: b.description ?? "",
      category: b.category ?? "general",
      risk: b.risk ?? "low",
      impact: b.impact ?? "low",
      defaultPriority: b.defaultPriority ?? "medium",
      // Standard templates always auto-approve and bypass CAB — these flags
      // are part of the definition of a "standard" change. The UI surfaces
      // them as read-only switches; we force them to true here regardless of
      // what the client posted.
      autoApprove: true,
      bypassCab: true,
      prefilledPlanning: b.prefilledPlanning ?? null,
      prefilledTestPlan: b.prefilledTestPlan ?? null,
      isActive: true,
    })
    .returning();
  await audit(req, {
    action: "template.created",
    entityType: "template",
    entityId: created.id,
    summary: `Created standard change template "${created.name}"`,
    after: created,
  });
  res.status(201).json(created);
});

router.get("/templates/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.patch("/templates/:id", requireTemplateManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const b = req.body ?? {};
  const updates: Partial<typeof standardTemplatesTable.$inferInsert> = {};
  for (const k of [
    "name",
    "description",
    "category",
    "risk",
    "impact",
    "defaultPriority",
    "autoApprove",
    "bypassCab",
    "prefilledPlanning",
    "prefilledTestPlan",
    "isActive",
  ] as const) {
    if (b[k] !== undefined) (updates as Record<string, unknown>)[k] = b[k];
  }
  // Reinforce the read-only invariant on PATCH as well — even if the client
  // tries to set autoApprove/bypassCab to false on an existing template,
  // we keep them true.
  updates.autoApprove = true;
  updates.bypassCab = true;
  const [updated] = await db
    .update(standardTemplatesTable)
    .set(updates)
    .where(eq(standardTemplatesTable.id, id))
    .returning();
  // Promotion of a "Potential Standard Change" template: when a disabled
  // template gets enabled, record a dedicated audit entry — including the CAB
  // meeting it was promoted from when the client provides it (the one-click
  // action on the meeting page passes promotedFromMeetingId).
  const promoted = before.isActive === false && updated.isActive === true;
  const fromMeetingId = Number(b.promotedFromMeetingId);
  await audit(req, {
    action: promoted ? "template.promoted" : "template.updated",
    entityType: "template",
    entityId: id,
    summary: promoted
      ? `Enabled template "${before.name}" as a standard change template${Number.isFinite(fromMeetingId) && fromMeetingId > 0 ? ` (promoted from CAB meeting #${fromMeetingId})` : ""}`
      : `Updated template "${before.name}"`,
    before,
    after: updated,
  });
  res.json(updated);
});

router.delete("/templates/:id", requireTemplateManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(standardTemplatesTable).where(eq(standardTemplatesTable.id, id));
  await audit(req, {
    action: "template.deleted",
    entityType: "template",
    entityId: id,
    summary: `Deleted template "${before.name}"`,
    before,
  });
  res.status(204).end();
});

export default router;
