import PDFDocument from "pdfkit";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  cabMeetingsTable,
  cabChangesTable,
  changeRequestsTable,
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

  // Docket order: high risk first, then medium, then low; within the same
  // risk level keep the planned-start/ref ordering from the query above.
  const riskRank = (r: string): number => (r === "high" ? 0 : r === "medium" ? 1 : 2);
  changes.sort((a, b) => riskRank(a.change.risk) - riskRank(b.change.risk));

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
  const rowsWanted = Math.max(changes.length, 1);

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
    // Rows that fit on the remaining space, keeping one row for "+ N more".
    const fit = Math.max(1, Math.floor((overviewBottom - doc.y) / ROW_H));
    const shown = changes.length <= fit ? changes.length : fit - 1;
    for (let i = 0; i < shown; i++) {
      const c = changes[i]!.change;
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.ink).text(`${i + 1}.`, MARGIN, y, { width: 18 });
      doc.text(c.ref, MARGIN + 18, y, { width: 78 });
      doc.font("Helvetica").text(c.title, MARGIN + 100, y, { width: CONTENT_W - 250, height: ROW_H, ellipsis: true });
      doc.fillColor(riskColor(c.risk)).text(`Risk: ${titleCase(c.risk)}`, MARGIN + CONTENT_W - 145, y, { width: 75 });
      // Page number filled in later (see pageRefSlots) — a change can now
      // span multiple pages, so the target page is only known after render.
      pageRefSlots.push({ index: i, y });
      doc.y = y + ROW_H;
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
  for (let i = 0; i < changes.length; i++) {
    const { change: c, ownerName } = changes[i]!;
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
      ["Owner", ownerName || "—"],
      ["Planned start", fmt(c.plannedStart)],
      ["Planned end", fmt(c.plannedEnd)],
      ["Ticket", c.ticketLink || (c.sdpRequestId ? `SD+ #${c.sdpRequestId}` : "—")],
      ["Pre-prod env", c.hasPreprodEnv ? "Yes" : "No"],
    ]);

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
