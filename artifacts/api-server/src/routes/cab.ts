import { Router, type IRouter } from "express";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  cabMeetingsTable,
  cabMembersTable,
  cabChangesTable,
  changeRequestsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import { audit } from "../lib/audit";
import { buildCabIcs } from "../lib/ics";
import { notify, getUserEmail } from "../lib/email";

// Format a date in a human-friendly way for plain-text emails. CAB members
// read these in their mail client, so use a readable representation rather
// than the raw ISO string. Falls back to "TBD" when no date is set.
function fmtAgendaDate(d: Date | null): string {
  if (!d) return "TBD";
  return d.toUTCString();
}

function titleCase(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render one change as an HTML "card" with field-per-line layout. Used in
// the CAB agenda email so that recipients with HTML-capable clients see
// each change visually grouped (header + key/value lines + description),
// instead of the previous single text blob with everything jammed together.
function renderAgendaChangeHtml(
  c: {
    ref: string;
    title: string;
    description: string | null;
    track: string;
    status: string;
    risk: string;
    impact: string;
    plannedStart: Date | null;
    plannedEnd: Date | null;
  },
  index: number,
): string {
  const desc = (c.description || "").trim();
  const row = (label: string, value: string): string => `
    <tr>
      <td style="padding:4px 12px 4px 0;font-size:12px;color:#5a6677;white-space:nowrap;vertical-align:top;width:120px;">${escapeHtml(label)}</td>
      <td style="padding:4px 0;font-size:13px;color:#1f2933;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e2d6;border-radius:8px;overflow:hidden;background:#fbfaf6;margin:0 0 12px 0;">
      <tr>
        <td style="background:#00543f;padding:10px 14px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;opacity:0.85;">Change #${index + 1} &middot; ${escapeHtml(c.ref)}</div>
          <div style="font-size:15px;font-weight:600;margin-top:2px;">${escapeHtml(c.title)}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
            ${row("Track", titleCase(c.track))}
            ${row("Status", c.status.replace(/_/g, " "))}
            ${row("Risk", titleCase(c.risk))}
            ${row("Impact", titleCase(c.impact))}
            ${row("Planned start", fmtAgendaDate(c.plannedStart))}
            ${row("Planned end", fmtAgendaDate(c.plannedEnd))}
          </table>
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid #ece7d8;">
            <div style="font-size:12px;color:#5a6677;margin-bottom:4px;">Description</div>
            <div style="font-size:13px;color:#1f2933;white-space:pre-wrap;line-height:1.5;">${
              desc ? escapeHtml(desc) : '<span style="color:#8a96a4;font-style:italic;">(no description provided)</span>'
            }</div>
          </div>
        </td>
      </tr>
    </table>`;
}

const router: IRouter = Router();
const requireCabManager = requireRole(["change_manager", "ecab_member", "cab_chair"]);

async function expandMeeting(m: typeof cabMeetingsTable.$inferSelect) {
  const memberRows = await db
    .select({
      id: cabMembersTable.id,
      meetingId: cabMembersTable.meetingId,
      userId: cabMembersTable.userId,
      roleKey: cabMembersTable.roleKey,
      isDeputy: cabMembersTable.isDeputy,
      userName: usersTable.fullName,
      userEmail: usersTable.email,
    })
    .from(cabMembersTable)
    .leftJoin(usersTable, eq(usersTable.id, cabMembersTable.userId))
    .where(eq(cabMembersTable.meetingId, m.id));
  const changeRows = await db
    .select({
      id: changeRequestsTable.id,
      ref: changeRequestsTable.ref,
      title: changeRequestsTable.title,
      track: changeRequestsTable.track,
      status: changeRequestsTable.status,
      risk: changeRequestsTable.risk,
    })
    .from(cabChangesTable)
    .innerJoin(changeRequestsTable, eq(changeRequestsTable.id, cabChangesTable.changeId))
    .where(eq(cabChangesTable.meetingId, m.id));
  let chairName: string | null = null;
  if (m.chairUserId != null) {
    const [c] = await db.select().from(usersTable).where(eq(usersTable.id, m.chairUserId));
    chairName = c?.fullName ?? null;
  }
  return {
    ...m,
    chairName,
    members: memberRows.map((r) => ({
      ...r,
      userName: r.userName ?? "Unknown",
      userEmail: r.userEmail ?? "",
    })),
    changes: changeRows,
  };
}

router.get("/cab-meetings", requireAuth, async (req, res): Promise<void> => {
  const from = typeof req.query["from"] === "string" ? new Date(req.query["from"]) : null;
  const to = typeof req.query["to"] === "string" ? new Date(req.query["to"]) : null;
  const kind = typeof req.query["kind"] === "string" ? req.query["kind"] : null;
  const conds = [];
  if (from) conds.push(gte(cabMeetingsTable.scheduledStart, from));
  if (to) conds.push(lte(cabMeetingsTable.scheduledStart, to));
  if (kind) conds.push(eq(cabMeetingsTable.kind, kind));
  const rows = conds.length
    ? await db
        .select()
        .from(cabMeetingsTable)
        .where(and(...conds))
        .orderBy(asc(cabMeetingsTable.scheduledStart))
    : await db.select().from(cabMeetingsTable).orderBy(asc(cabMeetingsTable.scheduledStart));
  res.json(
    rows.map((m) => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      scheduledStart: m.scheduledStart,
      scheduledEnd: m.scheduledEnd,
      location: m.location,
      status: m.status,
    })),
  );
});

router.post("/cab-meetings", requireCabManager, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.title || !b.scheduledStart || !b.scheduledEnd) {
    res.status(400).json({ error: "title, scheduledStart, scheduledEnd required" });
    return;
  }
  const [created] = await db
    .insert(cabMeetingsTable)
    .values({
      title: b.title,
      kind: b.kind === "ecab" ? "ecab" : "cab",
      scheduledStart: new Date(b.scheduledStart),
      scheduledEnd: new Date(b.scheduledEnd),
      location: b.location ?? "",
      agenda: b.agenda ?? "",
      chairUserId: typeof b.chairUserId === "number" ? b.chairUserId : null,
    })
    .returning();
  if (Array.isArray(b.memberIds)) {
    for (const uid of b.memberIds) {
      if (typeof uid === "number") {
        await db.insert(cabMembersTable).values({ meetingId: created.id, userId: uid }).onConflictDoNothing();
      }
    }
  }
  if (Array.isArray(b.changeIds)) {
    for (const cid of b.changeIds) {
      if (typeof cid === "number") {
        await db.insert(cabChangesTable).values({ meetingId: created.id, changeId: cid }).onConflictDoNothing();
        await db.update(changeRequestsTable).set({ cabMeetingId: created.id }).where(eq(changeRequestsTable.id, cid));
      }
    }
  }
  await audit(req, {
    action: "cab.created",
    entityType: "cab",
    entityId: created.id,
    summary: `Created ${created.kind.toUpperCase()} meeting "${created.title}"`,
    after: created,
  });
  res.status(201).json(await expandMeeting(created));
});

router.get("/cab-meetings/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(await expandMeeting(row));
});

router.patch("/cab-meetings/:id", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const b = req.body ?? {};
  const updates: Partial<typeof cabMeetingsTable.$inferInsert> = {};
  if (typeof b.title === "string") updates.title = b.title;
  if (typeof b.location === "string") updates.location = b.location;
  if (typeof b.agenda === "string") updates.agenda = b.agenda;
  if (typeof b.minutes === "string") updates.minutes = b.minutes;
  if (typeof b.status === "string") updates.status = b.status;
  if (b.scheduledStart) updates.scheduledStart = new Date(b.scheduledStart);
  if (b.scheduledEnd) updates.scheduledEnd = new Date(b.scheduledEnd);
  if (typeof b.chairUserId === "number") updates.chairUserId = b.chairUserId;
  if (b.chairUserId === null) updates.chairUserId = null;
  const [updated] = await db.update(cabMeetingsTable).set(updates).where(eq(cabMeetingsTable.id, id)).returning();
  if (Array.isArray(b.memberIds)) {
    await db.delete(cabMembersTable).where(eq(cabMembersTable.meetingId, id));
    for (const uid of b.memberIds) {
      if (typeof uid === "number") {
        await db.insert(cabMembersTable).values({ meetingId: id, userId: uid }).onConflictDoNothing();
      }
    }
  }
  if (Array.isArray(b.changeIds)) {
    await db.delete(cabChangesTable).where(eq(cabChangesTable.meetingId, id));
    for (const cid of b.changeIds) {
      if (typeof cid === "number") {
        await db.insert(cabChangesTable).values({ meetingId: id, changeId: cid }).onConflictDoNothing();
        await db.update(changeRequestsTable).set({ cabMeetingId: id }).where(eq(changeRequestsTable.id, cid));
      }
    }
  }
  await audit(req, {
    action: "cab.updated",
    entityType: "cab",
    entityId: id,
    summary: `Updated meeting "${before.title}"`,
    before,
    after: updated,
  });
  res.json(await expandMeeting(updated));
});

router.delete("/cab-meetings/:id", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(cabMembersTable).where(eq(cabMembersTable.meetingId, id));
  await db.delete(cabChangesTable).where(eq(cabChangesTable.meetingId, id));
  await db.delete(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  await audit(req, {
    action: "cab.deleted",
    entityType: "cab",
    entityId: id,
    summary: `Deleted meeting "${before.title}"`,
    before,
  });
  res.status(204).end();
});

router.get("/cab-meetings/:id/ics", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [m] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!m) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const memberRows = await db
    .select({
      id: cabMembersTable.id,
      meetingId: cabMembersTable.meetingId,
      userId: cabMembersTable.userId,
      roleKey: cabMembersTable.roleKey,
      isDeputy: cabMembersTable.isDeputy,
      email: usersTable.email,
      fullName: usersTable.fullName,
    })
    .from(cabMembersTable)
    .leftJoin(usersTable, eq(usersTable.id, cabMembersTable.userId))
    .where(eq(cabMembersTable.meetingId, id));
  const ics = buildCabIcs(
    m,
    memberRows.map((r) => ({ ...r, email: r.email ?? "", fullName: r.fullName ?? "Unknown" })),
  );
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="cab-${m.id}.ics"`);
  res.send(ics);
});

// Send the full meeting agenda (including every change on the docket with
// its title, description, planned dates, risk and impact) to every member,
// so they can review the material before the meeting starts. No calendar
// invite is attached — members already have the meeting on their calendar
// (downloaded via the .ics endpoint) and the purpose of this email is the
// agenda content itself.
router.post("/cab-meetings/:id/send-agenda", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [m] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!m) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const memberRows = await db
    .select({
      userId: cabMembersTable.userId,
      isDeputy: cabMembersTable.isDeputy,
      meetingId: cabMembersTable.meetingId,
      id: cabMembersTable.id,
      roleKey: cabMembersTable.roleKey,
      email: usersTable.email,
      fullName: usersTable.fullName,
    })
    .from(cabMembersTable)
    .leftJoin(usersTable, eq(usersTable.id, cabMembersTable.userId))
    .where(eq(cabMembersTable.meetingId, id));
  const targets = (
    await Promise.all(memberRows.map((r) => getUserEmail(r.userId)))
  ).filter((t): t is { userId: number; email: string; name: string } => !!t);

  // Pull the full change record for every change attached to this meeting.
  const changeRows = await db
    .select({
      id: changeRequestsTable.id,
      ref: changeRequestsTable.ref,
      title: changeRequestsTable.title,
      description: changeRequestsTable.description,
      track: changeRequestsTable.track,
      status: changeRequestsTable.status,
      risk: changeRequestsTable.risk,
      impact: changeRequestsTable.impact,
      plannedStart: changeRequestsTable.plannedStart,
      plannedEnd: changeRequestsTable.plannedEnd,
    })
    .from(cabChangesTable)
    .innerJoin(changeRequestsTable, eq(changeRequestsTable.id, cabChangesTable.changeId))
    .where(eq(cabChangesTable.meetingId, id))
    // Deterministic order: chronological by planned start, then by ref so
    // the numbering in the email is stable across re-sends and reads.
    .orderBy(asc(changeRequestsTable.plannedStart), asc(changeRequestsTable.ref));

  const meetingKindLabel = m.kind === "ecab" ? "Emergency CAB" : "CAB";
  // Plain-text version: each change as its own block with one
  // field-per-line for screen readers and text-only mail clients.
  const agendaItems = changeRows.length
    ? changeRows
        .map((c, i) => {
          const desc = (c.description || "").trim() || "(no description provided)";
          return [
            `--- Change #${i + 1} — [${c.ref}] ${c.title} ---`,
            `Track:         ${titleCase(c.track)}`,
            `Status:        ${c.status.replace(/_/g, " ")}`,
            `Risk:          ${titleCase(c.risk)}`,
            `Impact:        ${titleCase(c.impact)}`,
            `Planned start: ${fmtAgendaDate(c.plannedStart)}`,
            `Planned end:   ${fmtAgendaDate(c.plannedEnd)}`,
            `Description:`,
            ...desc.split("\n").map((line) => `  ${line}`),
          ].join("\n");
        })
        .join("\n\n")
    : "(no changes on the agenda)";

  const text = [
    `${meetingKindLabel} agenda — ${m.title}`,
    "",
    `When:  ${m.scheduledStart.toUTCString()}`,
    `Where: ${m.location}`,
    "",
    "Notes:",
    m.agenda?.trim() || "(none)",
    "",
    "─────────────────────────────────────────",
    `Changes for review (${changeRows.length}):`,
    "─────────────────────────────────────────",
    "",
    agendaItems,
  ].join("\n");

  // HTML version: meeting header + one card per change so each change is
  // visually grouped and the fields render one per line. Mail clients with
  // HTML support will use this; text-only clients fall back to `text` above.
  const meetingHeaderHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px 0;">
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#5a6677;width:80px;">When</td>
        <td style="padding:4px 0;font-size:13px;color:#1f2933;">${escapeHtml(m.scheduledStart.toUTCString())}</td>
      </tr>
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#5a6677;">Where</td>
        <td style="padding:4px 0;font-size:13px;color:#1f2933;">${escapeHtml(m.location)}</td>
      </tr>
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#5a6677;vertical-align:top;">Notes</td>
        <td style="padding:4px 0;font-size:13px;color:#1f2933;white-space:pre-wrap;">${
          m.agenda?.trim() ? escapeHtml(m.agenda.trim()) : '<span style="color:#8a96a4;font-style:italic;">(none)</span>'
        }</td>
      </tr>
    </table>
    <div style="margin:8px 0 12px 0;padding:8px 12px;background:#f6f4ee;border-left:3px solid #7a5a3a;font-size:12px;color:#5a6677;letter-spacing:0.04em;text-transform:uppercase;">
      Changes for review (${changeRows.length})
    </div>`;
  const agendaItemsHtml = changeRows.length
    ? changeRows.map((c, i) => renderAgendaChangeHtml(c, i)).join("")
    : '<div style="padding:12px;font-style:italic;color:#8a96a4;">(no changes on the agenda)</div>';
  const html = `<div>${meetingHeaderHtml}${agendaItemsHtml}</div>`;

  const result = await notify({
    eventKey: "cab.invited",
    to: targets,
    subject: `${m.kind === "ecab" ? "[eCAB Agenda]" : "[CAB Agenda]"} ${m.title} — ${m.scheduledStart.toUTCString()}`,
    text,
    html,
  });
  await audit(req, {
    action: "cab.agenda_sent",
    entityType: "cab",
    entityId: id,
    summary: `Sent CAB agenda: ${result.sent} sent, ${result.skipped} skipped, ${result.errors} errors (${changeRows.length} changes)`,
    after: { ...result, changeCount: changeRows.length },
  });
  res.json(result);
});

// Mark the CAB meeting as in-progress. This is the gate that authorises the
// per-change approval votes — once a meeting is in_progress (or later
// completed), votes can be recorded against the changes on the docket.
router.post("/cab-meetings/:id/start", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (before.status === "completed") {
    res.status(409).json({ error: "Meeting is already completed" });
    return;
  }
  const [updated] = await db
    .update(cabMeetingsTable)
    .set({ status: "in_progress" })
    .where(eq(cabMeetingsTable.id, id))
    .returning();
  await audit(req, {
    action: "cab.started",
    entityType: "cab",
    entityId: id,
    summary: `Started ${before.kind.toUpperCase()} meeting "${before.title}"`,
    before: { status: before.status },
    after: { status: updated.status },
  });
  res.json(await expandMeeting(updated));
});

// Mark the CAB meeting completed. Approvals can still be recorded after
// completion; this transition is what unblocks the change manager from
// moving Normal-track changes through the awaiting_approval -> approved flip.
router.post("/cab-meetings/:id/complete", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [before] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  if (!before) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [updated] = await db
    .update(cabMeetingsTable)
    .set({ status: "completed" })
    .where(eq(cabMeetingsTable.id, id))
    .returning();
  await audit(req, {
    action: "cab.completed",
    entityType: "cab",
    entityId: id,
    summary: `Completed ${before.kind.toUpperCase()} meeting "${before.title}"`,
    before: { status: before.status },
    after: { status: updated.status },
  });
  res.json(await expandMeeting(updated));
});

export default router;
