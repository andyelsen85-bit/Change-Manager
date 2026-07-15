import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, commentsTable, changeRequestsTable, discussionReadsTable } from "@workspace/db";
import { requireAuth, getChangeViewAccess } from "../lib/auth";

const router: IRouter = Router();

type DiscussionState = {
  changeId: number;
  ref: string;
  title: string;
  lastMessageAt: string;
  lastReadAt: string | null;
  unread: boolean;
};

// Build the per-user discussion read state for every change that has at
// least one comment AND that the caller is allowed to view. Used by both
// the changes-list post-it column and the header bell.
async function loadDiscussionStates(session: NonNullable<Express.Request["session"]>): Promise<DiscussionState[]> {
  const latest = await db
    .select({
      changeId: commentsTable.changeId,
      lastMessageAt: sql<string>`max(${commentsTable.createdAt})`,
    })
    .from(commentsTable)
    .groupBy(commentsTable.changeId);
  if (latest.length === 0) return [];

  const reads = await db
    .select()
    .from(discussionReadsTable)
    .where(eq(discussionReadsTable.userId, session.uid));
  const readByChange = new Map(reads.map((r) => [r.changeId, r.lastReadAt]));

  const out: DiscussionState[] = [];
  for (const l of latest) {
    const [chg] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, l.changeId));
    if (!chg) continue;
    if (!(await getChangeViewAccess(session, chg))) continue;
    const lastReadAt = readByChange.get(l.changeId) ?? null;
    const lastMessage = new Date(l.lastMessageAt);
    out.push({
      changeId: l.changeId,
      ref: chg.ref,
      title: chg.title,
      lastMessageAt: lastMessage.toISOString(),
      lastReadAt: lastReadAt ? lastReadAt.toISOString() : null,
      unread: !lastReadAt || lastReadAt.getTime() < lastMessage.getTime(),
    });
  }
  out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return out;
}

router.get("/discussions/state", requireAuth, async (req, res): Promise<void> => {
  res.json(await loadDiscussionStates(req.session!));
});

async function upsertRead(userId: number, changeId: number, lastReadAt: Date): Promise<void> {
  await db
    .insert(discussionReadsTable)
    .values({ userId, changeId, lastReadAt })
    .onConflictDoUpdate({
      target: [discussionReadsTable.userId, discussionReadsTable.changeId],
      set: { lastReadAt },
    });
}

// Mark one change's discussion read (opening the Discussion tab).
router.post("/changes/:id/discussion/read", requireAuth, async (req, res): Promise<void> => {
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
  if (!(await getChangeViewAccess(req.session!, chg))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await upsertRead(req.session!.uid, id, new Date());
  res.json({ ok: true });
});

// Mark unread again from a specific message onward: the read pointer is moved
// to just before that comment's timestamp, so it (and anything newer) counts
// as unread again.
router.post("/changes/:id/discussion/unread", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  const commentId = Number((req.body ?? {}).commentId);
  if (!Number.isFinite(id) || !Number.isFinite(commentId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [chg] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, id));
  if (!chg) {
    res.status(404).json({ error: "Change not found" });
    return;
  }
  if (!(await getChangeViewAccess(req.session!, chg))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [comment] = await db.select().from(commentsTable).where(eq(commentsTable.id, commentId));
  if (!comment || comment.changeId !== id) {
    res.status(404).json({ error: "Comment not found" });
    return;
  }
  await upsertRead(req.session!.uid, id, new Date(comment.createdAt.getTime() - 1));
  res.json({ ok: true });
});

// Header bell: mark every visible unread discussion as read in one click.
router.post("/discussions/read-all", requireAuth, async (req, res): Promise<void> => {
  const states = await loadDiscussionStates(req.session!);
  const now = new Date();
  for (const s of states) {
    if (s.unread) await upsertRead(req.session!.uid, s.changeId, now);
  }
  res.json({ ok: true, marked: states.filter((s) => s.unread).length });
});

export default router;
