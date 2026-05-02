import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, commentsTable, usersTable, changeRequestsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { audit } from "../lib/audit";
import { notify, getUserEmail } from "../lib/email";

const router: IRouter = Router();

router.get("/changes/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select({
      id: commentsTable.id,
      changeId: commentsTable.changeId,
      authorId: commentsTable.authorId,
      body: commentsTable.body,
      createdAt: commentsTable.createdAt,
      authorName: usersTable.fullName,
    })
    .from(commentsTable)
    .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
    .where(eq(commentsTable.changeId, id))
    .orderBy(desc(commentsTable.createdAt));
  res.json(rows.map((c) => ({ ...c, authorName: c.authorName ?? "Unknown" })));
});

router.post("/changes/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = (req.body ?? {}).body;
  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body required" });
    return;
  }
  const session = req.session!;
  const [created] = await db
    .insert(commentsTable)
    .values({ changeId: id, authorId: session.uid, body: body.trim() })
    .returning();
  const [author] = await db.select().from(usersTable).where(eq(usersTable.id, session.uid));
  await audit(req, {
    action: "comment.added",
    entityType: "change",
    entityId: id,
    summary: `Comment by ${session.username}`,
    after: { body: body.trim() },
  });
  const [c] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (c) {
    const targets = [];
    if (c.ownerId !== session.uid) {
      const o = await getUserEmail(c.ownerId);
      if (o) targets.push(o);
    }
    if (c.assigneeId && c.assigneeId !== session.uid && c.assigneeId !== c.ownerId) {
      const a = await getUserEmail(c.assigneeId);
      if (a) targets.push(a);
    }
    if (targets.length) {
      await notify({
        eventKey: "comment.added",
        to: targets,
        subject: `[CHG ${c.ref}] New comment from ${session.username}`,
        text: `${session.username} commented on ${c.ref} ${c.title}:\n\n${body.trim()}`,
      });
    }
  }
  res.status(201).json({ ...created, authorName: author?.fullName ?? session.username });
});

export default router;
