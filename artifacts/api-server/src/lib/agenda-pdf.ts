import PDFDocument from "pdfkit";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  cabMeetingsTable,
  cabChangesTable,
  cabAttendeesTable,
  approvalsTable,
  rolesTable,
  changeRequestsTable,
  changeCategoriesTable,
  planningRecordsTable,
  usersTable,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// CAB agenda PDF — DIN A4, each change starts on a fresh page and its full
// text flows onto continuation pages as needed (never truncated).
//
// Page 1: meeting header (title, kind, schedule, location, free-text agenda)
//         plus a docket overview table (one line per change).
// Then:   one A4 page per change with the full record: key/value grid
//         (track, status, risk, impact, priority, category, requester,
//         owner, planned window, ticket link) followed by the description
//         and the planning record (implementation / rollback plans, risk
//         assessment, impacted services, success criteria).
//
// The same builder backs the download endpoint (so the Change Manager can
// validate the layout) and the Send-Agenda email attachment — the two must
// never diverge.
// ---------------------------------------------------------------------------

// Change-it (CHdN) brand palette — mirrors artifacts/change-mgmt/src/index.css:
// olive green #96B423 primary, brown #966E3C accent / dark-brown sidebar,
// ochre #C8963C warning, espresso ink and warm sand-tinted lines.
const COLORS = {
  ink: "#262019", // espresso foreground (hsl 30 25% 12%)
  muted: "#6D6155", // muted foreground (hsl 30 12% 38%)
  line: "#E4DDD3", // warm sand border (hsl 35 25% 86%)
  headerBg: "#503C20", // dark brand brown, same as the app sidebar
  headerFg: "#F7F4EC", // warm off-white sidebar foreground
  accent: "#96B423", // CHdN olive green — accent rule under the header
  badgeHigh: "#D93025", // destructive red
  badgeMedium: "#C8963C", // CHdN ochre (warning)
  badgeLow: "#79901E", // darker brand green (success)
};

const MARGIN = 50; // pt — comfortable A4 margin
const A4_WIDTH = 595.28;
const CONTENT_W = A4_WIDTH - MARGIN * 2;

function fmt(d: Date | null | undefined): string {
  if (!d) return "TBD";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function titleCase(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function statusLabel(s: string): string {
  return titleCase(s.replace(/_/g, " "));
}

function riskColor(level: string): string {
  if (level === "high") return COLORS.badgeHigh;
  if (level === "medium") return COLORS.badgeMedium;
  return COLORS.badgeLow;
}

type Doc = InstanceType<typeof PDFDocument>;

type AgendaCategory = {
  key: string;
  name: string;
  sortOrder: number;
};

type AgendaChangeRow = {
  change: {
    category: string | null;
    risk: string;
    plannedStart: Date | null;
    ref: string;
    title: string;
  };
};

export type AgendaChangeGroup<T extends AgendaChangeRow = AgendaChangeRow> = {
  key: string;
  label: string;
  changes: T[];
};

const UNCATEGORIZED_KEY = "__uncategorized__";

function configuredCategoryOrder(a: AgendaCategory, b: AgendaCategory): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}

function riskRank(risk: string): number {
  if (risk === "high") return 0;
  if (risk === "medium") return 1;
  if (risk === "low") return 2;
  return 3;
}

function plannedStartValue(plannedStart: Date | null | undefined): number {
  return plannedStart ? plannedStart.getTime() : Number.NEGATIVE_INFINITY;
}

/**
 * Return the agenda's canonical grouping and order. Configured categories are
 * ordered by the settings catalogue (including inactive entries, which remain
 * relevant for historical changes). Categories not found in that catalogue
 * are grouped alphabetically after configured categories. Changes in a group
 * retain the established risk, planned-start, and reference ordering.
 */
export function groupAgendaChanges<T extends AgendaChangeRow>(
  changes: readonly T[],
  categories: readonly AgendaCategory[],
): AgendaChangeGroup<T>[] {
  const configured = [...categories].sort(configuredCategoryOrder);
  const categoryByKey = new Map(configured.map((category) => [category.key, category]));
  const groups = new Map<string, { label: string; configuredIndex: number; changes: T[] }>();

  for (const row of changes) {
    const key = typeof row.change.category === "string" ? row.change.category.trim() : "";
    const category = key ? categoryByKey.get(key) : undefined;
    const groupKey = key || UNCATEGORIZED_KEY;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.changes.push(row);
      continue;
    }
    groups.set(groupKey, {
      label: category?.name ?? (key || "Uncategorized"),
      configuredIndex: category ? configured.indexOf(category) : configured.length,
      changes: [row],
    });
  }

  return [...groups.entries()]
    .sort(([keyA, groupA], [keyB, groupB]) => {
      if (groupA.configuredIndex !== groupB.configuredIndex) {
        return groupA.configuredIndex - groupB.configuredIndex;
      }
      if (groupA.configuredIndex < configured.length) return 0;
      if (keyA === UNCATEGORIZED_KEY && keyB !== UNCATEGORIZED_KEY) return 1;
      if (keyB === UNCATEGORIZED_KEY && keyA !== UNCATEGORIZED_KEY) return -1;
      return groupA.label.localeCompare(groupB.label) || keyA.localeCompare(keyB);
    })
    .map(([key, group]) => ({
      key,
      label: group.label,
      changes: [...group.changes].sort((a, b) => {
        return (
          riskRank(a.change.risk) - riskRank(b.change.risk) ||
          plannedStartValue(a.change.plannedStart) - plannedStartValue(b.change.plannedStart) ||
          a.change.ref.localeCompare(b.change.ref)
        );
      }),
    }));
}

function pageHeader(doc: Doc, meetingTitle: string, right: string): void {
  doc.save();
  doc.rect(0, 0, A4_WIDTH, 34).fill(COLORS.headerBg);
  // Brand green accent rule under the brown band — echoes the app's logo wave.
  doc.rect(0, 34, A4_WIDTH, 2.5).fill(COLORS.accent);
  doc
    .fillColor(COLORS.headerFg)
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(meetingTitle, MARGIN, 12, { width: CONTENT_W - 160, ellipsis: true });
  doc
    .font("Helvetica")
    .fontSize(9)
    .text(right, A4_WIDTH - MARGIN - 150, 12, { width: 150, align: "right" });
  doc.restore();
  // Reset body text styles: pdfkit keeps the header's font/fill color as the
  // current state, and text that flows onto a new page mid-paragraph would
  // otherwise continue in the light header color.
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.ink);
  doc.y = 56;
}

function sectionTitle(doc: Doc, label: string): void {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLORS.ink).text(label, MARGIN, doc.y);
  const y = doc.y + 2;
  doc.moveTo(MARGIN, y).lineTo(A4_WIDTH - MARGIN, y).lineWidth(0.7).strokeColor(COLORS.line).stroke();
  doc.y = y + 6;
}

// Long free-text block: never truncated. pdfkit flows the text onto as many
// pages as needed (the pageAdded handler repaints the branded header and
// resets doc.y on every continuation page).
function textBlock(doc: Doc, value: string): void {
  const text = (value || "").trim() || "—";
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.ink);
  doc.text(text, MARGIN, doc.y, { width: CONTENT_W, lineGap: 1.5 });
}

// Optional clipped variant, used only on the overview page where the docket
// page references require page 1 content to stay bounded.
function clippedTextBlock(doc: Doc, value: string, maxY: number): void {
  const text = (value || "").trim() || "—";
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.ink);
  const available = maxY - doc.y;
  if (available <= 12) return;
  const height = doc.heightOfString(text, { width: CONTENT_W, lineGap: 1.5 });
  if (height <= available) {
    doc.text(text, MARGIN, doc.y, { width: CONTENT_W, lineGap: 1.5 });
    return;
  }
  doc.text(text, MARGIN, doc.y, { width: CONTENT_W, lineGap: 1.5, height: available - 12, ellipsis: true });
  doc.y = maxY;
}

function kvGrid(doc: Doc, rows: Array<[string, string, string?]>): void {
  const colW = CONTENT_W / 2;
  const labelW = 95;
  const startY = doc.y;
  const rowH = 16;
  rows.forEach(([label, value, color], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * colW;
    const y = startY + row * rowH;
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text(label, x, y, { width: labelW });
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(color ?? COLORS.ink)
      .text(value || "—", x + labelW, y, { width: colW - labelW - 10, ellipsis: true });
  });
  doc.y = startY + Math.ceil(rows.length / 2) * rowH + 2;
}

export async function buildCabAgendaPdf(meetingId: number): Promise<{ filename: string; content: Buffer } | null> {
  const [m] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, meetingId));
  if (!m) return null;

  const changes = await db
    .select({
      change: changeRequestsTable,
      ownerName: usersTable.fullName,
    })
    .from(cabChangesTable)
    .innerJoin(changeRequestsTable, eq(changeRequestsTable.id, cabChangesTable.changeId))
    .leftJoin(usersTable, eq(usersTable.id, changeRequestsTable.ownerId))
    .where(eq(cabChangesTable.meetingId, meetingId))
    .orderBy(asc(changeRequestsTable.plannedStart), asc(changeRequestsTable.ref));

  // The settings catalogue is the source of truth for category order. Read
  // inactive categories as well: existing changes can still carry one after
  // an administrator deactivates it.
  const categories = await db
    .select({
      key: changeCategoriesTable.key,
      name: changeCategoriesTable.name,
      sortOrder: changeCategoriesTable.sortOrder,
    })
    .from(changeCategoriesTable)
    .orderBy(asc(changeCategoriesTable.sortOrder), asc(changeCategoriesTable.name));
  const changeGroups = groupAgendaChanges(changes, categories);
  const orderedChanges = changeGroups.flatMap((group) => group.changes);

  // "Potential Standard Change" promotion flags: for docketed changes linked
  // to a disabled template, show trial progress — and call it out when the
  // completed-changes threshold is reached so the CAB can decide to enable
  // the template as a real standard change.
  const potIds = [...new Set(changes.map((c) => c.change.potentialTemplateId).filter((x): x is number => x != null))];
  const promoByTemplate = new Map<number, { name: string; completedCount: number; threshold: number; ready: boolean }>();
  if (potIds.length > 0) {
    const { getCompletedCountsByTemplate, getPromotionThreshold } = await import("./template-promotion");
    const { standardTemplatesTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const [counts, threshold] = await Promise.all([getCompletedCountsByTemplate(potIds), getPromotionThreshold()]);
    const tpls = await db.select().from(standardTemplatesTable).where(inArray(standardTemplatesTable.id, potIds));
    for (const t of tpls) {
      // Already-enabled (promoted) templates no longer need a callout.
      if (t.isActive) continue;
      const completedCount = counts.get(t.id) ?? 0;
      promoByTemplate.set(t.id, { name: t.name, completedCount, threshold, ready: completedCount >= threshold });
    }
  }

  const kindLabel = m.kind === "ecab" ? "Emergency CAB" : "CAB meeting";
  // bufferPages lets us go back to page 1 at the end and fill in the real
  // page number of each change (a change may now span several pages).
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Header repainted on every page pdfkit adds automatically while long text
  // flows past the bottom margin. Content of the header follows this state.
  const headerState = { title: "", right: "" };
  doc.on("pageAdded", () => {
    pageHeader(doc, headerState.title, headerState.right);
  });

  // ---- Page 1: meeting overview -------------------------------------------
  pageHeader(doc, "Change-it — CAB agenda", fmt(m.scheduledStart));
  doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.ink).text(m.title, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.2);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(COLORS.muted)
    .text(
      `${kindLabel} · ${fmt(m.scheduledStart)} – ${fmt(m.scheduledEnd)}${m.location ? ` · ${m.location}` : ""}`,
      { width: CONTENT_W },
    );

  // The overview must stay exactly ONE page: every change page reference is
  // "p. i+2", which only holds while page 1 never overflows. So the agenda
  // free-text is height-budgeted (leaving room for the docket rows) and the
  // docket list itself is clipped with a "+ N more" line if it cannot fit.
  const overviewBottom = 800 - MARGIN - 14; // keep clear of the footer line
  const ROW_H = 15;
  const docketHeaderH = 30; // sectionTitle for the docket list
  const overviewRowCount = changeGroups.reduce((count, group) => count + 1 + group.changes.length, 0);
  const rowsWanted = Math.max(overviewRowCount, 1);

  sectionTitle(doc, "Agenda");
  {
    const agendaText = (m.agenda || "").trim() || "(none)";
    // Reserve space for the docket header + rows (at least a handful of rows).
    const reservedForDocket = docketHeaderH + Math.min(rowsWanted, 8) * ROW_H;
    const agendaMaxY = Math.max(doc.y + 24, overviewBottom - reservedForDocket);
    clippedTextBlock(doc, agendaText, agendaMaxY);
  }

  // Docket rows whose "p. N" column is written after all change pages have
  // been rendered (each entry remembers its row's y position on page 1).
  const pageRefSlots: Array<{ index: number; y: number }> = [];
  const changeStartPage: number[] = []; // 1-based page number per change

  sectionTitle(doc, `Changes to be discussed (${changes.length})`);
  if (changes.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(COLORS.muted).text("No changes on the agenda.", MARGIN, doc.y);
  } else {
    // Category headings consume docket rows too. Keep one row for "+ N more"
    // when the one-page overview cannot display the complete docket.
    const fit = Math.max(1, Math.floor((overviewBottom - doc.y) / ROW_H));
    const totalRows = overviewRowCount;
    const rowBudget = totalRows <= fit ? fit : Math.max(0, fit - 1);
    let rowsUsed = 0;
    let shown = 0;
    let changeIndex = 0;
    for (const group of changeGroups) {
      if (rowsUsed >= rowBudget || rowsUsed + 2 > rowBudget) break;
      const headingY = doc.y;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.muted).text(group.label, MARGIN, headingY, {
        width: CONTENT_W,
        height: ROW_H,
        ellipsis: true,
      });
      doc.y = headingY + ROW_H;
      rowsUsed++;

      for (const row of group.changes) {
        if (rowsUsed >= rowBudget) break;
        const c = row.change;
        const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.ink).text(`${changeIndex + 1}.`, MARGIN, y, { width: 18 });
        doc.text(c.ref, MARGIN + 18, y, { width: 78 });
        doc.font("Helvetica").text(c.title, MARGIN + 100, y, { width: CONTENT_W - 250, height: ROW_H, ellipsis: true });
        doc.fillColor(riskColor(c.risk)).text(`Risk: ${titleCase(c.risk)}`, MARGIN + CONTENT_W - 145, y, { width: 75 });
        // Page number filled in later (see pageRefSlots) — a change can now
        // span multiple pages, so the target page is only known after render.
        pageRefSlots.push({ index: changeIndex, y });
        doc.y = y + ROW_H;
        rowsUsed++;
        shown++;
        changeIndex++;
      }
    }
    if (shown < changes.length) {
      doc
        .font("Helvetica-Oblique")
        .fontSize(9)
        .fillColor(COLORS.muted)
        .text(`… and ${changes.length - shown} more — see the following pages.`, MARGIN, doc.y, { width: CONTENT_W });
    }
  }
  doc
    .font("Helvetica-Oblique")
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(`Generated by Change-it on ${fmt(new Date())}`, MARGIN, 800 - MARGIN, { width: CONTENT_W });

  // ---- One A4 page per change ---------------------------------------------
  for (let i = 0; i < orderedChanges.length; i++) {
    const { change: c, ownerName } = orderedChanges[i]!;
    const [planning] = await db.select().from(planningRecordsTable).where(eq(planningRecordsTable.changeId, c.id));

    headerState.title = `${m.title} — change ${i + 1} of ${changes.length}`;
    headerState.right = c.ref;
    doc.addPage(); // pageAdded handler paints the header
    changeStartPage.push(doc.bufferedPageRange().count); // 1-based

    doc.font("Helvetica-Bold").fontSize(15).fillColor(COLORS.ink).text(`[${c.ref}] ${c.title}`, MARGIN, doc.y, {
      width: CONTENT_W,
    });
    doc.moveDown(0.4);

    kvGrid(doc, [
      ["Track", titleCase(c.track)],
      ["Status", statusLabel(c.status)],
      ["Risk", titleCase(c.risk), riskColor(c.risk)],
      ["Impact", titleCase(c.impact), riskColor(c.impact)],
      ["Priority", titleCase(c.priority)],
      ["Category", titleCase(c.category)],
      ["Requester", c.requesterName || "—"],
      ["Creator", ownerName || "—"],
      ["Planned start", fmt(c.plannedStart)],
      ["Planned end", fmt(c.plannedEnd)],
      ["Ticket", c.ticketLink || (c.sdpRequestId ? `SD+ #${c.sdpRequestId}` : "—")],
      ["Pre-prod env", c.hasPreprodEnv ? "Yes" : "No"],
    ]);

    // Potential Standard Change callout: trial progress, highlighted when the
    // promotion threshold is reached so the CAB explicitly discusses enabling
    // the template.
    const promo = c.potentialTemplateId != null ? promoByTemplate.get(c.potentialTemplateId) : undefined;
    if (promo) {
      doc.moveDown(0.3);
      const y = doc.y;
      const text = promo.ready
        ? `POTENTIAL STANDARD CHANGE — threshold reached: ${promo.completedCount} of ${promo.threshold} completed changes for template "${promo.name}". The CAB should consider enabling this template as a standard change.`
        : `Potential Standard Change — trial progress: ${promo.completedCount} of ${promo.threshold} completed changes for template "${promo.name}".`;
      const h = doc.font(promo.ready ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).heightOfString(text, { width: CONTENT_W - 16 }) + 10;
      doc
        .save()
        .rect(MARGIN, y, CONTENT_W, h)
        .fill(promo.ready ? "#FEF3C7" : "#F1F5F9")
        .restore();
      doc.fillColor(promo.ready ? "#92400E" : COLORS.muted).text(text, MARGIN + 8, y + 5, { width: CONTENT_W - 16 });
      doc.y = y + h + 4;
      doc.fillColor(COLORS.ink);
    }

    // Full text, no truncation: each section flows onto continuation pages
    // as needed; the next change always starts on a fresh page (addPage
    // above). Keep a section title from being orphaned at the page bottom.
    const bottom = 842 - MARGIN;
    const section = (label: string, value: string): void => {
      if (doc.y > bottom - 60) doc.addPage();
      sectionTitle(doc, label);
      textBlock(doc, value);
    };

    section("Description", c.description);
    section("Implementation plan", planning?.implementationPlan ?? "");
    section("Rollback plan", planning?.rollbackPlan ?? "");
    section("Risk assessment", planning?.riskAssessment ?? "");
    section("Impacted services", planning?.impactedServices ?? "");
    section("Success criteria", planning?.successCriteria ?? "");

    if (planning?.signedOff) {
      if (doc.y > bottom - 24) doc.addPage();
      doc.moveDown(0.8);
      doc
        .font("Helvetica-Oblique")
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(
          `Planning signed off${planning.signedOffBy ? ` by ${planning.signedOffBy}` : ""}${planning.signedOffAt ? ` on ${fmt(planning.signedOffAt)}` : ""}`,
          MARGIN,
          doc.y,
          { width: CONTENT_W },
        );
    }
  }

  // ---- Back-fill the docket page references on page 1 ----------------------
  if (pageRefSlots.length > 0) {
    doc.switchToPage(0);
    doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted);
    for (const slot of pageRefSlots) {
      const page = changeStartPage[slot.index];
      if (page == null) continue;
      doc.text(`p. ${page}`, MARGIN + CONTENT_W - 40, slot.y, { width: 40, align: "right", lineBreak: false });
    }
  }

  doc.end();
  const content = await done;
  const safeTitle = m.title.replace(/[^\w\-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "cab";
  return { filename: `cab-agenda-${safeTitle}-${meetingId}.pdf`, content };
}

// ---------------------------------------------------------------------------
// CAB results PDF — generated after (or during) the meeting.
//
// Page 1: meeting details (title, kind, schedule, location, notes) plus the
//         attendance list (present / absent per attendee).
// Then:   the changes of the meeting with their outcome — Approved, Rejected,
//         Postponed (with target meeting) or Pending — including the recorded
//         approval votes and their comments.
//
// The same builder backs the download endpoint and the email attachment sent
// on "Complete meeting" — the two must never diverge.
// ---------------------------------------------------------------------------

export type CabOutcome = "approved" | "rejected" | "postponed" | "pending";

function outcomeColor(o: CabOutcome): string {
  if (o === "approved") return COLORS.badgeLow;
  if (o === "rejected") return COLORS.badgeHigh;
  if (o === "postponed") return COLORS.badgeMedium;
  return COLORS.muted;
}

export async function buildCabResultsPdf(meetingId: number): Promise<{ filename: string; content: Buffer } | null> {
  const [m] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, meetingId));
  if (!m) return null;

  const rows = await db
    .select({
      change: changeRequestsTable,
      outcome: cabChangesTable.outcome,
      outcomeNote: cabChangesTable.outcomeNote,
      postponedToMeetingId: cabChangesTable.postponedToMeetingId,
    })
    .from(cabChangesTable)
    .innerJoin(changeRequestsTable, eq(changeRequestsTable.id, cabChangesTable.changeId))
    .where(eq(cabChangesTable.meetingId, meetingId))
    .orderBy(asc(changeRequestsTable.plannedStart), asc(changeRequestsTable.ref));

  const attendees = await db
    .select()
    .from(cabAttendeesTable)
    .where(eq(cabAttendeesTable.meetingId, meetingId))
    .orderBy(asc(cabAttendeesTable.name));

  const kindLabel = m.kind === "ecab" ? "Emergency CAB" : "CAB meeting";
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const headerState = { title: "Change-it — CAB results", right: fmt(m.scheduledStart) };
  doc.on("pageAdded", () => pageHeader(doc, headerState.title, headerState.right));

  // ---- Page 1: meeting details + attendance --------------------------------
  pageHeader(doc, headerState.title, headerState.right);
  doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.ink).text(`${m.title} — Results`, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.2);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(COLORS.muted)
    .text(
      `${kindLabel} · ${fmt(m.scheduledStart)} – ${fmt(m.scheduledEnd)}${m.location ? ` · ${m.location}` : ""} · Status: ${statusLabel(m.status)}`,
      { width: CONTENT_W },
    );

  sectionTitle(doc, "Notes");
  textBlock(doc, (m.minutes || "").trim() || "(none)");

  sectionTitle(doc, `Attendance (${attendees.filter((a) => a.present).length} of ${attendees.length} present)`);
  if (attendees.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(COLORS.muted).text("No attendance recorded.", MARGIN, doc.y);
  } else {
    const bottom = 842 - MARGIN;
    for (const a of attendees) {
      if (doc.y > bottom - 20) doc.addPage();
      const y = doc.y;
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor(a.present ? COLORS.badgeLow : COLORS.badgeHigh)
        .text(a.present ? "Present" : "Absent", MARGIN, y, { width: 55 });
      doc.font("Helvetica").fillColor(COLORS.ink).text(a.name + (a.email ? `  ·  ${a.email}` : ""), MARGIN + 62, y, {
        width: CONTENT_W - 62,
        height: 14,
        ellipsis: true,
      });
      doc.y = y + 14;
    }
  }

  // ---- Page 2+: changes with their outcome ---------------------------------
  headerState.title = `${m.title} — Results`;
  if (rows.length > 0) doc.addPage();
  if (rows.length === 0) {
    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(COLORS.muted).text("No changes were on this meeting.", MARGIN, doc.y);
  }

  const bottom = 842 - MARGIN;
  for (let i = 0; i < rows.length; i++) {
    const { change: c, outcome, outcomeNote, postponedToMeetingId } = rows[i]!;

    // Approval votes for this change (role name, decision, approver, comment).
    const votes = await db
      .select({
        roleKey: approvalsTable.roleKey,
        roleName: rolesTable.name,
        decision: approvalsTable.decision,
        comment: approvalsTable.comment,
        decidedAt: approvalsTable.decidedAt,
        approverName: usersTable.fullName,
      })
      .from(approvalsTable)
      .leftJoin(rolesTable, eq(rolesTable.key, approvalsTable.roleKey))
      .leftJoin(usersTable, eq(usersTable.id, approvalsTable.approverId))
      .where(eq(approvalsTable.changeId, c.id));

    // Outcome: explicit postpone wins; otherwise derived from approvals so
    // the PDF can never contradict the recorded votes.
    let derived: CabOutcome = "pending";
    if (outcome === "postponed") derived = "postponed";
    else if (votes.some((v) => v.decision === "rejected") || c.status === "rejected") derived = "rejected";
    else if (
      (votes.length > 0 && votes.every((v) => v.decision === "approved")) ||
      ["approved", "scheduled", "in_progress", "implemented", "awaiting_pir", "completed"].includes(c.status)
    )
      derived = "approved";

    let postponedTo = "";
    if (derived === "postponed" && postponedToMeetingId) {
      const [target] = await db.select().from(cabMeetingsTable).where(eq(cabMeetingsTable.id, postponedToMeetingId));
      if (target) postponedTo = `${target.title} (${fmt(target.scheduledStart)})`;
    }

    // Estimate the block height; start a new page when it will not fit.
    if (i > 0 && doc.y > bottom - 140) doc.addPage();
    else if (i > 0) doc.moveDown(1);

    const y0 = doc.y;
    doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.ink).text(`${i + 1}. [${c.ref}] ${c.title}`, MARGIN, y0, {
      width: CONTENT_W - 110,
    });
    // Remember where the (possibly multi-line) title ended BEFORE drawing the
    // outcome badge back up at y0 — the badge is a single line, so leaving
    // doc.y where the badge finishes would make the following lines overprint
    // the title's wrapped lines.
    const yTitleEnd = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(outcomeColor(derived))
      .text(derived.toUpperCase(), MARGIN + CONTENT_W - 100, y0, { width: 100, align: "right" });
    doc.y = Math.max(yTitleEnd, doc.y);
    doc.moveDown(0.3);

    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text(
      `Track: ${titleCase(c.track)}   ·   Risk: ${titleCase(c.risk)}   ·   Status: ${statusLabel(c.status)}${
        derived === "postponed" && postponedTo ? `   ·   Postponed to: ${postponedTo}` : ""
      }`,
      MARGIN,
      doc.y,
      { width: CONTENT_W },
    );

    if (derived === "postponed" && (outcomeNote || "").trim()) {
      doc.moveDown(0.3);
      doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(COLORS.ink).text(`Note: ${(outcomeNote || "").trim()}`, MARGIN, doc.y, {
        width: CONTENT_W,
        lineGap: 1.5,
      });
    }

    if (votes.length > 0) {
      doc.moveDown(0.4);
      for (const v of votes) {
        if (doc.y > bottom - 30) doc.addPage();
        const y = doc.y;
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(
            v.decision === "approved" ? COLORS.badgeLow : v.decision === "rejected" ? COLORS.badgeHigh : COLORS.muted,
          )
          .text(titleCase(v.decision), MARGIN, y, { width: 60 });
        doc
          .font("Helvetica")
          .fillColor(COLORS.ink)
          .text(
            `${v.roleName ?? v.roleKey}${v.approverName ? ` — ${v.approverName}` : ""}${v.decidedAt ? ` (${fmt(v.decidedAt)})` : ""}`,
            MARGIN + 66,
            y,
            { width: CONTENT_W - 66 },
          );
        if ((v.comment || "").trim()) {
          doc
            .font("Helvetica-Oblique")
            .fontSize(9)
            .fillColor(COLORS.muted)
            .text(`“${(v.comment || "").trim()}”`, MARGIN + 66, doc.y, { width: CONTENT_W - 66, lineGap: 1.2 });
        }
        doc.moveDown(0.25);
      }
    }

    const yLine = doc.y + 6;
    if (yLine < bottom) {
      doc.moveTo(MARGIN, yLine).lineTo(A4_WIDTH - MARGIN, yLine).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      doc.y = yLine + 8;
    }
  }

  doc.end();
  const content = await done;
  const safeTitle = m.title.replace(/[^\w\-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "cab";
  return { filename: `cab-results-${safeTitle}-${meetingId}.pdf`, content };
}
