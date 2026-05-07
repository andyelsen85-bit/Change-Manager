import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, attachmentsTable, usersTable, changeRequestsTable } from "@workspace/db";
import { requireAuth, getChangeAccess } from "../lib/auth";
import { audit } from "../lib/audit";

const router: IRouter = Router();

// 20 MB hard cap per file. The express.json limit (25mb in app.ts) leaves
// some headroom for the base64 expansion (~33%) plus JSON envelope.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

router.get("/changes/:id/attachments", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [c] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!c) {
    res.status(404).json({ error: "Change not found" });
    return;
  }
  if (!(await getChangeAccess(req.session!, c))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rows = await db
    .select({
      id: attachmentsTable.id,
      changeId: attachmentsTable.changeId,
      filename: attachmentsTable.filename,
      mimeType: attachmentsTable.mimeType,
      size: attachmentsTable.size,
      uploadedById: attachmentsTable.uploadedById,
      uploadedAt: attachmentsTable.uploadedAt,
      uploadedByName: usersTable.fullName,
    })
    .from(attachmentsTable)
    .leftJoin(usersTable, eq(usersTable.id, attachmentsTable.uploadedById))
    .where(eq(attachmentsTable.changeId, id))
    .orderBy(desc(attachmentsTable.uploadedAt));
  res.json(rows);
});

router.post("/changes/:id/attachments", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [c] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!c) {
    res.status(404).json({ error: "Change not found" });
    return;
  }
  if (!(await getChangeAccess(req.session!, c))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const session = req.session!;
  const body = req.body ?? {};
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const mimeType = typeof body.mimeType === "string" && body.mimeType.trim()
    ? body.mimeType.trim()
    : "application/octet-stream";
  const dataB64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
  if (!filename || !dataB64) {
    res.status(400).json({ error: "filename and dataBase64 are required" });
    return;
  }
  let data: Buffer;
  try {
    data = Buffer.from(dataB64, "base64");
  } catch {
    res.status(400).json({ error: "Invalid base64 payload" });
    return;
  }
  if (data.length === 0) {
    res.status(400).json({ error: "Empty file" });
    return;
  }
  if (data.length > MAX_FILE_BYTES) {
    res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES} bytes)` });
    return;
  }
  const [row] = await db
    .insert(attachmentsTable)
    .values({
      changeId: id,
      filename: filename.slice(0, 255),
      mimeType: mimeType.slice(0, 255),
      size: data.length,
      data,
      uploadedById: session.uid,
    })
    .returning({
      id: attachmentsTable.id,
      changeId: attachmentsTable.changeId,
      filename: attachmentsTable.filename,
      mimeType: attachmentsTable.mimeType,
      size: attachmentsTable.size,
      uploadedById: attachmentsTable.uploadedById,
      uploadedAt: attachmentsTable.uploadedAt,
    });
  await audit(req, {
    action: "attachment.uploaded",
    entityType: "attachment",
    entityId: row!.id,
    summary: `Uploaded ${row!.filename} to ${c.ref}`,
    after: { changeId: id, filename: row!.filename, size: row!.size, mimeType: row!.mimeType },
  });
  res.status(201).json({ ...row, uploadedByName: session.username });
});

router.get("/attachments/:id/download", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(attachmentsTable).where(eq(attachmentsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  const [c] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, row.changeId));
  if (!c || !(await getChangeAccess(req.session!, c))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await audit(req, {
    action: "attachment.downloaded",
    entityType: "attachment",
    entityId: row.id,
    summary: `Downloaded ${row.filename} from ${c.ref}`,
  });
  const safeName = row.filename.replace(/[^\w.\-]+/g, "_");
  res.setHeader("Content-Type", row.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(row.size));
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.end(row.data);
});

router.delete("/attachments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .select({
      id: attachmentsTable.id,
      changeId: attachmentsTable.changeId,
      filename: attachmentsTable.filename,
      uploadedById: attachmentsTable.uploadedById,
    })
    .from(attachmentsTable)
    .where(eq(attachmentsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }
  const [c] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, row.changeId));
  if (!c) {
    res.status(404).json({ error: "Change not found" });
    return;
  }
  const session = req.session!;
  // Uploader can always delete their own; admins / change owner / assignee
  // can delete any. Otherwise refuse.
  const allowed =
    session.isAdmin ||
    row.uploadedById === session.uid ||
    c.ownerId === session.uid ||
    c.assigneeId === session.uid;
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.delete(attachmentsTable).where(eq(attachmentsTable.id, id));
  await audit(req, {
    action: "attachment.deleted",
    entityType: "attachment",
    entityId: id,
    summary: `Deleted ${row.filename} from ${c.ref}`,
    before: { changeId: row.changeId, filename: row.filename },
  });
  res.status(204).end();
});

export default router;
