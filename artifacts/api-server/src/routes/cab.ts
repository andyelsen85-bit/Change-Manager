import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import {
  db,
  cabMeetingsTable,
  cabMembersTable,
  cabChangesTable,
  cabAttendeesTable,
  changeRequestsTable,
  roleAssignmentsTable,
  usersTable,
} from "@workspace/db";
import { standardTemplatesTable } from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import { getCompletedCountsByTemplate, getPromotionThreshold } from "../lib/template-promotion";
import { audit } from "../lib/audit";
import { buildCabIcs } from "../lib/ics";
import { buildCabAgendaPdf, buildCabResultsPdf } from "../lib/agenda-pdf";
import { notify, getUserEmail, getUserEmails } from "../lib/email";

// Format a date for emails as dd/MM/yyyy HH:mm in 24-hour time. We do
// the formatting manually rather than via toLocaleString("en-GB") because
// some Node builds incorrectly return a 12-hour AM/PM string for the
// en-GB locale, which the user explicitly does not want. Falls back to
// "TBD" when no date is set.
function fmtAgendaDate(d: Date | null): string {
  if (!d) return "TBD";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
      potentialTemplateId: changeRequestsTable.potentialTemplateId,
      outcome: cabChangesTable.outcome,
      outcomeNote: cabChangesTable.outcomeNote,
      postponedToMeetingId: cabChangesTable.postponedToMeetingId,
    })
    .from(cabChangesTable)
    .innerJoin(changeRequestsTable, eq(changeRequestsTable.id, cabChangesTable.changeId))
    .where(eq(cabChangesTable.meetingId, m.id));
  // "Potential Standard Change" flag for the meeting page: a docketed change
  // whose linked disabled template has reached the promotion threshold gets a
  // visible marker so the CAB can decide to enable the template.
  const potIds = [...new Set(changeRows.map((c) => c.potentialTemplateId).filter((x): x is number => x != null))];
  const promo = new Map<number, { name: string; completedCount: number; threshold: number; ready: boolean }>();
  if (potIds.length > 0) {
    const [counts, threshold] = await Promise.all([getCompletedCountsByTemplate(potIds), getPromotionThreshold()]);
    const tpls = await db.select().from(standardTemplatesTable).where(inArray(standardTemplatesTable.id, potIds));
    for (const t of tpls) {
      // Once a template has been enabled (promoted), stop flagging it — the
      // trial links are kept for history but the CAB no longer needs to act.
      if (t.isActive) continue;
      const completedCount = counts.get(t.id) ?? 0;
      promo.set(t.id, { name: t.name, completedCount, threshold, ready: completedCount >= threshold });
    }
  }
  return {
    ...m,
    members: memberRows.map((r) => ({
      ...r,
      userName: r.userName ?? "Unknown",
      userEmail: r.userEmail ?? "",
    })),
    changes: changeRows.map((c) => ({
      ...c,
      standardPromotion: c.potentialTemplateId != null ? (promo.get(c.potentialTemplateId) ?? null) : null,
    })),
  };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// UTC offset (in ms) that `timeZone` has at instant `d`. Positive east of
// UTC (e.g. Europe/Luxembourg is +3600000 in winter, +7200000 in summer).
function tzOffsetMs(d: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return asUtc - d.getTime();
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
  if (!b.title || !b.scheduledStart) {
    res.status(400).json({ error: "title and scheduledStart required" });
    return;
  }
  const kind = b.kind === "ecab" ? "ecab" : "cab";
  const firstStart = new Date(b.scheduledStart);
  if (Number.isNaN(firstStart.getTime())) {
    res.status(400).json({ error: "Invalid scheduledStart" });
    return;
  }
  if (b.scheduledEnd && Number.isNaN(new Date(b.scheduledEnd).getTime())) {
    res.status(400).json({ error: "Invalid scheduledEnd" });
    return;
  }
  // Duration in minutes (default 60). Used to compute scheduledEnd; if the
  // caller still passes a literal scheduledEnd we honour it for backwards
  // compatibility.
  const durationMin = Number.isFinite(b.durationMinutes) && b.durationMinutes > 0
    ? Math.floor(b.durationMinutes)
    : null;
  const computeEnd = (start: Date): Date => {
    if (durationMin != null) return new Date(start.getTime() + durationMin * 60_000);
    if (b.scheduledEnd) return new Date(b.scheduledEnd);
    return new Date(start.getTime() + 60 * 60_000);
  };
  // Recurrence parameters. Repeat-until is required when recurring is on;
  // we generate the full series up-front so each occurrence has its own row
  // (members, changes, status) and the calendar reflects them immediately.
  const recurring = !!b.recurring;
  const intervalWeeks = Number.isFinite(b.recurrenceIntervalWeeks) && b.recurrenceIntervalWeeks > 0
    ? Math.floor(b.recurrenceIntervalWeeks)
    : 1;
  let recurrenceUntil: Date | null = null;
  if (recurring) {
    if (!b.recurrenceUntil) {
      res.status(400).json({ error: "recurrenceUntil is required when recurring is true" });
      return;
    }
    recurrenceUntil = new Date(b.recurrenceUntil);
    if (Number.isNaN(recurrenceUntil.getTime())) {
      res.status(400).json({ error: "Invalid recurrenceUntil" });
      return;
    }
  }
  // The creator's IANA timezone (sent by the frontend). Recurring
  // occurrences must keep the same *wall-clock* time in that zone across
  // DST transitions — a naive "+N weeks in milliseconds" drifts by ±1 hour
  // when summer/winter time flips between two occurrences. An unknown zone
  // is rejected rather than silently ignored (silent fallback would
  // reintroduce the drift without any signal to the user).
  let timeZone: string | null = null;
  if (typeof b.timeZone === "string" && b.timeZone) {
    if (!isValidTimeZone(b.timeZone)) {
      res.status(400).json({ error: `Unknown timeZone "${b.timeZone}"` });
      return;
    }
    timeZone = b.timeZone;
  }
  // Build occurrence start dates: first occurrence then +N weeks while
  // <= recurrenceUntil. Cap at 200 to keep an honest mistake from blowing up.
  const starts: Date[] = [firstStart];
  if (recurring && recurrenceUntil) {
    // Inclusive cutoff: end of the recurrenceUntil day in the creator's
    // timezone (falling back to UTC), so an occurrence late on the "until"
    // day in a negative-offset zone is not dropped by a UTC-day comparison.
    const untilEndOfDayOffset = timeZone ? tzOffsetMs(recurrenceUntil, timeZone) : 0;
    const untilMs = recurrenceUntil.getTime() + 24 * 60 * 60_000 - 1 - untilEndOfDayOffset;
    const stepMs = intervalWeeks * 7 * 24 * 60 * 60_000;
    // Step through an UNADJUSTED base sequence (first + k*step) and apply
    // the DST correction to each candidate independently — adjusting
    // relative to the previous (already corrected) occurrence would apply
    // the offset delta twice once the timezone has switched.
    let base = firstStart;
    while (starts.length < 200) {
      base = new Date(base.getTime() + stepMs);
      let next = base;
      if (timeZone) {
        // Preserve wall-clock time: shift by the UTC-offset delta between
        // the first occurrence and the candidate (e.g. CEST 14:00 stays
        // 14:00 CET after the October switch).
        const delta = tzOffsetMs(firstStart, timeZone) - tzOffsetMs(base, timeZone);
        if (delta !== 0) next = new Date(base.getTime() + delta);
      }
      if (next.getTime() > untilMs) break;
      starts.push(next);
    }
  }
  const groupId = recurring ? randomUUID() : null;
  const createdRows: Array<typeof cabMeetingsTable.$inferSelect> = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const [row] = await db
      .insert(cabMeetingsTable)
      .values({
        title: b.title,
        kind,
        scheduledStart: s,
        scheduledEnd: computeEnd(s),
        location: b.location ?? "",
        agenda: b.agenda ?? "",
        recurrenceIntervalWeeks: recurring ? intervalWeeks : null,
        recurrenceUntil: recurring && recurrenceUntil
          ? recurrenceUntil.toISOString().slice(0, 10)
          : null,
        recurrenceGroupId: groupId,
      })
      .returning();
    createdRows.push(row);
    if (Array.isArray(b.memberIds)) {
      for (const uid of b.memberIds) {
        if (typeof uid === "number") {
          await db.insert(cabMembersTable).values({ meetingId: row.id, userId: uid }).onConflictDoNothing();
        }
      }
    }
    // Only the first occurrence carries the requested change-set; later
    // occurrences start with an empty agenda the chair can populate.
    if (i === 0 && Array.isArray(b.changeIds)) {
      for (const cid of b.changeIds) {
        if (typeof cid === "number") {
          await db.insert(cabChangesTable).values({ meetingId: row.id, changeId: cid }).onConflictDoNothing();
          await db.update(changeRequestsTable).set({ cabMeetingId: row.id }).where(eq(changeRequestsTable.id, cid));
        }
      }
    }
  }
  const primary = createdRows[0];
  await audit(req, {
    action: "cab.created",
    entityType: "cab",
    entityId: primary.id,
    summary: recurring
      ? `Created recurring ${primary.kind.toUpperCase()} series "${primary.title}" (${createdRows.length} occurrences)`
      : `Created ${primary.kind.toUpperCase()} meeting "${primary.title}"`,
    after: primary,
  });
  res.status(201).json(await expandMeeting(primary));
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
  // A membership/docket-only PATCH carries no column updates — skip the
  // UPDATE (drizzle rejects an empty set) and keep the row as-is.
  const updated = Object.keys(updates).length
    ? (await db.update(cabMeetingsTable).set(updates).where(eq(cabMeetingsTable.id, id)).returning())[0]!
    : before;
  if (Array.isArray(b.memberIds)) {
    await db.delete(cabMembersTable).where(eq(cabMembersTable.meetingId, id));
    for (const uid of b.memberIds) {
      if (typeof uid === "number") {
        await db.insert(cabMembersTable).values({ meetingId: id, userId: uid }).onConflictDoNothing();
      }
    }
  }
  if (Array.isArray(b.changeIds)) {
    // Diff instead of delete-all + reinsert: existing docket rows carry the
    // meeting outcome (postponed etc.) which a blanket reinsert would erase.
    const wanted = b.changeIds.filter((x: unknown): x is number => typeof x === "number");
    if (wanted.length === 0) {
      await db.delete(cabChangesTable).where(eq(cabChangesTable.meetingId, id));
    } else {
      await db
        .delete(cabChangesTable)
        .where(and(eq(cabChangesTable.meetingId, id), notInArray(cabChangesTable.changeId, wanted)));
    }
    for (const cid of wanted) {
      await db.insert(cabChangesTable).values({ meetingId: id, changeId: cid }).onConflictDoNothing();
      await db.update(changeRequestsTable).set({ cabMeetingId: id }).where(eq(changeRequestsTable.id, cid));
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
  await db.delete(cabAttendeesTable).where(eq(cabAttendeesTable.meetingId, id));
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

// Download the meeting agenda as an A4 PDF: overview page + one page per
// docketed change with its full details. Lets the Change Manager validate
// the exact document that Send-Agenda will attach to the email.
router.get("/cab-meetings/:id/agenda-pdf", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const pdf = await buildCabAgendaPdf(id);
  if (!pdf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
  res.send(pdf.content);
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
    `When:  ${fmtAgendaDate(m.scheduledStart)}`,
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
        <td style="padding:4px 0;font-size:13px;color:#1f2933;">${escapeHtml(fmtAgendaDate(m.scheduledStart))}</td>
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

  // Attach the same A4 agenda PDF (one page per change) that the Change
  // Manager can download and validate on the meeting page — the email
  // attachment and the download must never diverge. If PDF generation
  // fails, still send the agenda email (degraded, without attachment)
  // rather than failing the whole request.
  let pdf: { filename: string; content: Buffer } | null = null;
  try {
    pdf = await buildCabAgendaPdf(id);
  } catch (err) {
    console.error(`Failed to build agenda PDF for meeting ${id}; sending agenda without attachment`, err);
  }

  const result = await notify({
    eventKey: "cab.invited",
    to: targets,
    subject: `${m.kind === "ecab" ? "[eCAB Agenda]" : "[CAB Agenda]"} ${m.title} — ${fmtAgendaDate(m.scheduledStart)}`,
    text,
    html,
    pdf: pdf ?? undefined,
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

// ---------------------------------------------------------------------------
// Attendance
//
// GET returns the merged attendance list: everyone who holds a CAB role
// (cab_chair / cab_member, or ecab_member for eCAB meetings) plus any stored
// rows — including ad-hoc people added via the LDAP directory search. Stored
// rows win over the seeded candidates so a recorded present/absent choice is
// never reset by role changes.
// PUT replaces the stored list wholesale (the frontend always sends the full
// list it displays).
// ---------------------------------------------------------------------------
const cabRolesForKind = (kind: string): string[] =>
  kind === "ecab" ? ["ecab_member", "cab_chair"] : ["cab_member", "cab_chair"];

router.get("/cab-meetings/:id/attendance", requireAuth, async (req, res): Promise<void> => {
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
  const stored = await db.select().from(cabAttendeesTable).where(eq(cabAttendeesTable.meetingId, id));
  const roleUsers = await db
    .select({ userId: roleAssignmentsTable.userId, name: usersTable.fullName, email: usersTable.email, isActive: usersTable.isActive })
    .from(roleAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, roleAssignmentsTable.userId))
    .where(inArray(roleAssignmentsTable.roleKey, cabRolesForKind(m.kind)));
  const byUser = new Map<number, (typeof stored)[number]>();
  const externals: typeof stored = [];
  for (const s of stored) {
    if (s.userId != null) byUser.set(s.userId, s);
    else externals.push(s);
  }
  const seenUsers = new Set<number>();
  const out: Array<{ userId: number | null; name: string; email: string; present: boolean; adHoc: boolean }> = [];
  for (const u of roleUsers) {
    if (!u.isActive || seenUsers.has(u.userId)) continue;
    seenUsers.add(u.userId);
    const s = byUser.get(u.userId);
    out.push({ userId: u.userId, name: u.name, email: u.email ?? "", present: s?.present ?? false, adHoc: false });
  }
  // Stored rows for users who no longer hold a CAB role stay visible.
  for (const [uid, s] of byUser) {
    if (!seenUsers.has(uid)) out.push({ userId: uid, name: s.name, email: s.email, present: s.present, adHoc: false });
  }
  for (const s of externals) out.push({ userId: null, name: s.name, email: s.email, present: s.present, adHoc: true });
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ attendees: out });
});

router.put("/cab-meetings/:id/attendance", requireCabManager, async (req, res): Promise<void> => {
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
  const list = Array.isArray(req.body?.attendees) ? req.body.attendees : null;
  if (!list) {
    res.status(400).json({ error: "attendees array required" });
    return;
  }
  const rows: Array<typeof cabAttendeesTable.$inferInsert> = [];
  const seen = new Set<string>();
  for (const a of list) {
    const name = typeof a?.name === "string" ? a.name.trim() : "";
    if (!name) continue;
    const userId = typeof a?.userId === "number" ? a.userId : null;
    const email = typeof a?.email === "string" ? a.email.trim() : "";
    // Externals with an email are unique by email alone (prevents duplicate
    // result mails to one mailbox); email-less entries fall back to the name.
    const key = userId != null ? `u${userId}` : email ? `e${email.toLowerCase()}` : `n${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ meetingId: id, userId, name, email, present: !!a?.present });
  }
  await db.transaction(async (tx) => {
    await tx.delete(cabAttendeesTable).where(eq(cabAttendeesTable.meetingId, id));
    if (rows.length > 0) await tx.insert(cabAttendeesTable).values(rows);
  });
  await audit(req, {
    action: "cab.attendance_updated",
    entityType: "cab",
    entityId: id,
    summary: `Updated attendance for "${m.title}" (${rows.filter((r) => r.present).length}/${rows.length} present)`,
  });
  res.json({ ok: true, count: rows.length });
});

// ---------------------------------------------------------------------------
// Postpone a docketed change to another CAB meeting: marks the entry on this
// meeting as "postponed" (kept for the results PDF) and dockets the change on
// the target meeting, which becomes its linked meeting.
// ---------------------------------------------------------------------------
router.post("/cab-meetings/:id/changes/:changeId/postpone", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  const changeId = Number(req.params["changeId"]);
  const targetId = Number(req.body?.targetMeetingId);
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!Number.isFinite(id) || !Number.isFinite(changeId) || !Number.isFinite(targetId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  if (targetId === id) {
    res.status(400).json({ error: "Target meeting must be a different meeting" });
    return;
  }
  const [m] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, id));
  const [target] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, targetId));
  if (!m || !target) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  if (target.status === "completed" || target.status === "cancelled") {
    res.status(409).json({ error: "Target meeting is already completed or cancelled" });
    return;
  }
  const [docket] = await db
    .select()
    .from(cabChangesTable)
    .where(and(eq(cabChangesTable.meetingId, id), eq(cabChangesTable.changeId, changeId)));
  if (!docket) {
    res.status(404).json({ error: "Change is not on this meeting" });
    return;
  }
  const [chg] = await db.select().from(changeRequestsTable).where(eq(changeRequestsTable.id, changeId));
  if (!chg || chg.deletedAt) {
    res.status(404).json({ error: "Change not found" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(cabChangesTable)
      .set({ outcome: "postponed", outcomeNote: note || null, postponedToMeetingId: targetId })
      .where(eq(cabChangesTable.id, docket.id));
    // Upsert: if the change was already docketed on the target (e.g. it was
    // postponed through that meeting earlier), reset any stale outcome so it
    // shows up as an active docket item there, not as "postponed".
    await tx
      .insert(cabChangesTable)
      .values({ meetingId: targetId, changeId })
      .onConflictDoUpdate({
        target: [cabChangesTable.meetingId, cabChangesTable.changeId],
        set: { outcome: null, outcomeNote: null, postponedToMeetingId: null },
      });
    await tx.update(changeRequestsTable).set({ cabMeetingId: targetId }).where(eq(changeRequestsTable.id, changeId));
  });
  await audit(req, {
    action: "cab.change_postponed",
    entityType: "cab",
    entityId: id,
    summary: `${chg.ref}: postponed from "${m.title}" to "${target.title}" (${fmtAgendaDate(target.scheduledStart)})${note ? ` — ${note}` : ""}`,
    after: { changeId, from: id, to: targetId, note: note || null },
  });
  res.json(await expandMeeting(m));
});

// Download the meeting results as an A4 PDF (details + attendance, then the
// changes with their outcomes). Same builder as the Complete-meeting email.
router.get("/cab-meetings/:id/results-pdf", requireCabManager, async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const pdf = await buildCabResultsPdf(id);
  if (!pdf) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
  res.send(pdf.content);
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

  // Send the results PDF to every user holding a CAB role for this meeting
  // kind, plus the ad-hoc attendees added via the directory search (matched
  // by email; they may not be local users). A mail failure must never block
  // the completion itself — the meeting is completed either way.
  let mailResult: { sent: number; skipped: number; errors: number } | null = null;
  try {
    const pdf = await buildCabResultsPdf(id);
    if (pdf) {
      const roleRows = await db
        .select({ userId: roleAssignmentsTable.userId })
        .from(roleAssignmentsTable)
        .where(inArray(roleAssignmentsTable.roleKey, cabRolesForKind(before.kind)));
      const roleTargets = await getUserEmails([...new Set(roleRows.map((r) => r.userId))]);
      const attendeeRows = await db.select().from(cabAttendeesTable).where(eq(cabAttendeesTable.meetingId, id));
      // Ad-hoc attendees (no local user account) get the mail directly by
      // email; a negative pseudo-id skips the per-user preference lookup.
      // Dedup all recipients by normalized email — notify() only dedups by
      // userId, and externals carry synthetic negative ids.
      const seenEmails = new Set(roleTargets.map((t) => t.email.toLowerCase()));
      const externals: Array<{ userId: number; email: string; name: string }> = [];
      for (const a of attendeeRows) {
        if (a.userId != null || !a.email.includes("@")) continue;
        const norm = a.email.toLowerCase();
        if (seenEmails.has(norm)) continue;
        seenEmails.add(norm);
        externals.push({ userId: -(externals.length + 1), email: a.email, name: a.name });
      }
      const targets = [...roleTargets, ...externals];
      const kindLabel = before.kind === "ecab" ? "[eCAB Results]" : "[CAB Results]";
      const text = [
        `${before.kind === "ecab" ? "Emergency CAB" : "CAB"} results — ${before.title}`,
        "",
        `When:  ${fmtAgendaDate(before.scheduledStart)}`,
        `Where: ${before.location}`,
        "",
        "The meeting has been completed. The attached PDF contains the meeting",
        "details, the attendance list and the outcome of every change discussed",
        "(approved / rejected / postponed) with the recorded notes.",
      ].join("\n");
      mailResult = await notify({
        eventKey: "cab.minutes",
        to: targets,
        subject: `${kindLabel} ${before.title} — ${fmtAgendaDate(before.scheduledStart)}`,
        text,
        pdf,
      });
      await audit(req, {
        action: "cab.results_sent",
        entityType: "cab",
        entityId: id,
        summary: `Sent CAB results: ${mailResult.sent} sent, ${mailResult.skipped} skipped, ${mailResult.errors} errors`,
        after: mailResult,
      });
    }
  } catch (err) {
    console.error(`Failed to send CAB results for meeting ${id}`, err);
  }
  res.json({ ...(await expandMeeting(updated)), resultsMail: mailResult });
});

export default router;
