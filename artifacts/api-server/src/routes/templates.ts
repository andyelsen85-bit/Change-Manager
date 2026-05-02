import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, standardTemplatesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

router.get("/templates", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(standardTemplatesTable);
  res.json(rows);
});

router.post("/templates", requireAdmin, async (req, res): Promise<void> => {
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
      autoApprove: b.autoApprove !== false,
      bypassCab: b.bypassCab !== false,
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

router.patch("/templates/:id", requireAdmin, async (req, res): Promise<void> => {
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
  const [updated] = await db
    .update(standardTemplatesTable)
    .set(updates)
    .where(eq(standardTemplatesTable.id, id))
    .returning();
  await audit(req, {
    action: "template.updated",
    entityType: "template",
    entityId: id,
    summary: `Updated template "${before.name}"`,
    before,
    after: updated,
  });
  res.json(updated);
});

router.delete("/templates/:id", requireAdmin, async (req, res): Promise<void> => {
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
