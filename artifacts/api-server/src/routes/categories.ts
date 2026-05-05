import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, changeCategoriesTable, changeRequestsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "category";
}

router.get("/categories", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(changeCategoriesTable)
    .orderBy(asc(changeCategoriesTable.sortOrder), asc(changeCategoriesTable.name));
  res.json(rows);
});

router.post("/categories", requireAdmin, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.name || typeof b.name !== "string") {
    res.status(400).json({ error: "Missing required fields", fields: ["name"] });
    return;
  }
  const key = (typeof b.key === "string" && b.key.trim()) ? slugify(b.key) : slugify(b.name);
  try {
    const [row] = await db
      .insert(changeCategoriesTable)
      .values({
        key,
        name: b.name.trim(),
        sortOrder: Number.isFinite(b.sortOrder) ? Number(b.sortOrder) : 100,
        isActive: b.isActive !== false,
      })
      .returning();
    await audit(req, {
      action: "category.created",
      entityType: "category",
      entityId: row!.id,
      summary: `Created category ${row!.name}`,
      after: row,
    });
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message)) {
      res.status(409).json({ error: "Category key already exists", fields: ["key"] });
      return;
    }
    throw err;
  }
});

router.patch("/categories/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(changeCategoriesTable).where(eq(changeCategoriesTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string") patch["name"] = b.name.trim();
  if (typeof b.sortOrder === "number") patch["sortOrder"] = b.sortOrder;
  if (typeof b.isActive === "boolean") patch["isActive"] = b.isActive;
  if (Object.keys(patch).length === 0) {
    res.json(before);
    return;
  }
  const [after] = await db
    .update(changeCategoriesTable)
    .set(patch)
    .where(eq(changeCategoriesTable.id, id))
    .returning();
  await audit(req, {
    action: "category.updated",
    entityType: "category",
    entityId: id,
    summary: `Updated category ${after!.name}`,
    before,
    after,
  });
  res.json(after);
});

router.delete("/categories/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(changeCategoriesTable).where(eq(changeCategoriesTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Hard-delete only if no change references it; otherwise soft-deactivate to
  // preserve historical category labels on existing changes.
  const [used] = await db
    .select({ count: changeRequestsTable.id })
    .from(changeRequestsTable)
    .where(eq(changeRequestsTable.category, before.key))
    .limit(1);
  if (used) {
    const [after] = await db
      .update(changeCategoriesTable)
      .set({ isActive: false })
      .where(eq(changeCategoriesTable.id, id))
      .returning();
    await audit(req, {
      action: "category.deactivated",
      entityType: "category",
      entityId: id,
      summary: `Deactivated category ${before.name} (in use)`,
      before,
      after,
    });
    res.json({ deactivated: true, category: after });
    return;
  }
  await db.delete(changeCategoriesTable).where(eq(changeCategoriesTable.id, id));
  await audit(req, {
    action: "category.deleted",
    entityType: "category",
    entityId: id,
    summary: `Deleted category ${before.name}`,
    before,
  });
  res.status(204).end();
});

export default router;
