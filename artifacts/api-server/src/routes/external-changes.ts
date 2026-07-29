// External changes: third-party maintenance windows (provider/vendor work)
// shown on the Change Plannings calendar for visibility only. They carry no
// workflow, approvals or CAB involvement, so any authenticated user may
// create, edit and delete them; every mutation is written to the audit log.
import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, externalChangesTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

type ExternalChangeRow = typeof externalChangesTable.$inferSelect;

function serialize(row: ExternalChangeRow) {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    description: row.description,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt ? row.endAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// undefined = field absent (keep), null = explicit clear, Date = new value,
// "invalid" = present but unparseable (caller must reject with 400).
function parseDate(v: unknown): Date | null | undefined | "invalid" {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") return "invalid";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "invalid" : d;
}

router.get("/external-changes", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(externalChangesTable).orderBy(asc(externalChangesTable.startAt));
  res.json(rows.map(serialize));
});

router.post("/external-changes", requireAuth, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const start = parseDate(b.startAt);
  if (start === "invalid") {
    res.status(400).json({ error: "Invalid start date", fields: ["startAt"] });
    return;
  }
  if (!title || !start) {
    res.status(400).json({ error: "Missing required fields", fields: ["title", "startAt"] });
    return;
  }
  const end = parseDate(b.endAt);
  if (end === "invalid") {
    res.status(400).json({ error: "Invalid end date", fields: ["endAt"] });
    return;
  }
  if (end && end < start) {
    res.status(400).json({ error: "End must not be before start", fields: ["endAt"] });
    return;
  }
  const [row] = await db
    .insert(externalChangesTable)
    .values({
      title,
      provider: typeof b.provider === "string" ? b.provider.trim() : "",
      description: typeof b.description === "string" && b.description.trim() ? b.description.trim() : null,
      startAt: start,
      endAt: end ?? null,
      createdBy: req.session?.uid ?? null,
    })
    .returning();
  await audit(req, {
    action: "external_change.created",
    entityType: "external_change",
    entityId: row!.id,
    summary: `Created external change “${row!.title}”${row!.provider ? ` (${row!.provider})` : ""}`,
    after: serialize(row!),
  });
  res.status(201).json(serialize(row!));
});

router.patch("/external-changes/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(externalChangesTable).where(eq(externalChangesTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const b = req.body ?? {};
  const patch: Partial<typeof externalChangesTable.$inferInsert> = {};
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
  if (typeof b.provider === "string") patch.provider = b.provider.trim();
  if (typeof b.description === "string") patch.description = b.description.trim() || null;
  const start = parseDate(b.startAt);
  const end = parseDate(b.endAt);
  if (start === "invalid" || end === "invalid") {
    res.status(400).json({ error: "Invalid date", fields: [start === "invalid" ? "startAt" : "endAt"] });
    return;
  }
  if (start instanceof Date) patch.startAt = start;
  else if (start === null && b.startAt !== undefined) {
    // startAt is required — an explicit clear is not allowed.
    res.status(400).json({ error: "Start date cannot be empty", fields: ["startAt"] });
    return;
  }
  if (end !== undefined) patch.endAt = end;
  const effStart = patch.startAt ?? before.startAt;
  const effEnd = patch.endAt === undefined ? before.endAt : patch.endAt;
  if (effEnd && effEnd < effStart) {
    res.status(400).json({ error: "End must not be before start", fields: ["endAt"] });
    return;
  }
  if (Object.keys(patch).length === 0) {
    res.json(serialize(before));
    return;
  }
  patch.updatedAt = new Date();
  const [after] = await db
    .update(externalChangesTable)
    .set(patch)
    .where(eq(externalChangesTable.id, id))
    .returning();
  await audit(req, {
    action: "external_change.updated",
    entityType: "external_change",
    entityId: id,
    summary: `Updated external change “${after!.title}”`,
    before: serialize(before),
    after: serialize(after!),
  });
  res.json(serialize(after!));
});

router.delete("/external-changes/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(externalChangesTable).where(eq(externalChangesTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(externalChangesTable).where(eq(externalChangesTable.id, id));
  await audit(req, {
    action: "external_change.deleted",
    entityType: "external_change",
    entityId: id,
    summary: `Deleted external change “${before.title}”`,
    before: serialize(before),
  });
  res.status(204).end();
});

export default router;
