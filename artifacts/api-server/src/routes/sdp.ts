// Inbound webhook from ManageEngine ServiceDesk Plus (on-premises).
//
// A technician clicks a "Create Change" custom action on an RFC ticket in
// SD+; the custom trigger fires a webhook to this endpoint. Authentication
// is a shared secret configured in the Change-it Settings page and sent as
// the `X-Webhook-Secret` header (header-only by design — query parameters
// would leak the secret into proxy and access logs).
//
// The endpoint is idempotent per SD+ request: if an active (non-deleted)
// change already exists for the request ID, it is returned instead of
// creating a duplicate draft.
import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import {
  db,
  changeRequestsTable,
  planningRecordsTable,
  usersTable,
  sdpSettingsTable,
  changeCategoriesTable,
  standardTemplatesTable,
} from "@workspace/db";
import { createApprovalsForChange } from "./changes";
import { audit } from "../lib/audit";
import { nextRef } from "../lib/ref";
import { getSdpConfig, sdpAddBackLinkNote, sdpRequestUrl, appBaseUrl } from "../lib/sdp";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const KEY = "global";

// SD+ sends rich-text fields (notably the request description) as full HTML
// documents — inline styles, <table> layouts, email signatures and entity-
// encoded characters (&nbsp;, &quot;, &#8217;…). Change-it stores plain text,
// so convert: drop style/script blocks, turn block-level closers and <br>
// into newlines, strip the remaining tags, decode entities and collapse
// excess whitespace. Plain-text input passes through untouched.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ocirc: "ô",
  ucirc: "û",
  ugrave: "ù",
  iuml: "ï",
  euml: "ë",
  Eacute: "É",
  Egrave: "È",
  Agrave: "À",
  Ccedil: "Ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  Uuml: "Ü",
  Ouml: "Ö",
  Auml: "Ä",
  szlig: "ß",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

export function htmlToPlainText(input: string): string {
  // Fast path: nothing HTML-ish in the string.
  if (!/[<&]/.test(input)) return input;
  let s = input;
  s = s.replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|li|tr|h[1-6]|table|ul|ol|blockquote)\s*>/gi, "\n");
  s = s.replace(/<\s*(td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = decodeHtmlEntities(s);
  // Collapse whitespace but preserve intentional line breaks.
  s = s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function recordWebhook(requestId: string | null, status: string): Promise<void> {
  await db
    .update(sdpSettingsTable)
    .set({ lastWebhookAt: new Date(), lastWebhookRequestId: requestId, lastWebhookStatus: status })
    .where(eq(sdpSettingsTable.key, KEY));
}

router.post("/integrations/sdp/create-change", async (req, res): Promise<void> => {
  const cfg = await getSdpConfig();
  if (!cfg?.enabled || !cfg.webhookSecret) {
    res.status(503).json({ error: "ServiceDesk Plus integration is not enabled." });
    return;
  }
  // Header-only on purpose: a query-parameter secret would leak into proxy
  // and access logs. SD+ webhooks support custom headers.
  const provided =
    typeof req.headers["x-webhook-secret"] === "string" ? req.headers["x-webhook-secret"] : "";
  if (!provided || !timingSafeEqual(provided, cfg.webhookSecret)) {
    logger.warn({ ip: req.ip }, "SD+ webhook rejected: bad secret");
    res.status(401).json({ error: "Invalid webhook secret." });
    return;
  }

  // Accept both snake_case (SD+ webhook payload placeholders) and camelCase.
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const requestId = str(b.request_id ?? b.requestId ?? b.id ?? b.woid ?? b.WOID);
  const subject = htmlToPlainText(str(b.subject ?? b.title));
  const description = htmlToPlainText(str(b.description));
  const requesterName = htmlToPlainText(str(b.requester_name ?? b.requesterName ?? b.requester));
  const technicianEmail = str(b.technician_email ?? b.technicianEmail).toLowerCase();
  const requesterEmail = str(b.requester_email ?? b.requesterEmail).toLowerCase();
  const rawType = str(b.change_type ?? b.changeType ?? b.track).toLowerCase();
  const templateName = str(b.template ?? b.template_name ?? b.templateName);

  // Map the SD+-provided change type onto Change-it tracks. Urgent/urgency
  // are accepted as aliases for the emergency track.
  let track: "normal" | "standard" | "emergency" = "normal";
  if (["emergency", "urgent", "urgency"].includes(rawType)) track = "emergency";
  else if (rawType === "standard") track = "standard";
  else if (rawType && rawType !== "normal") {
    await recordWebhook(str(b.request_id ?? b.requestId ?? b.id) || null, `error: unknown change_type "${rawType}"`);
    res.status(400).json({ error: `Unknown change_type "${rawType}". Use normal, standard or emergency.` });
    return;
  }

  if (!requestId) {
    await recordWebhook(null, "error: missing request id");
    res.status(400).json({ error: "Missing request id. Send request_id (or id) in the JSON body." });
    return;
  }

  // Idempotency: one active change per SD+ request.
  const [existing] = await db
    .select()
    .from(changeRequestsTable)
    .where(and(eq(changeRequestsTable.sdpRequestId, requestId), isNull(changeRequestsTable.deletedAt)));
  if (existing) {
    await recordWebhook(requestId, `ok: already linked to ${existing.ref}`);
    res.json({
      ok: true,
      created: false,
      changeId: existing.id,
      ref: existing.ref,
      url: appBaseUrl() ? `${appBaseUrl()}/changes/${existing.id}` : null,
      message: `A change (${existing.ref}) already exists for SD+ request ${requestId}.`,
    });
    return;
  }

  // Owner: prefer the SD+ technician (matched by email), then the requester,
  // then fall back to the first active admin so the draft is never orphaned.
  let owner: typeof usersTable.$inferSelect | undefined;
  for (const email of [technicianEmail, requesterEmail]) {
    if (!email) continue;
    const [u] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.email, email), eq(usersTable.isActive, true)));
    if (u) {
      owner = u;
      break;
    }
  }
  if (!owner) {
    const admins = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.isAdmin, true), eq(usersTable.isActive, true)));
    owner = admins[0];
  }
  if (!owner) {
    await recordWebhook(requestId, "error: no owner available");
    res.status(500).json({ error: "No matching user or active admin found to own the change." });
    return;
  }

  // Category: keep 'general' when it is active, otherwise first active category.
  let category = "general";
  const cats = await db.select().from(changeCategoriesTable).where(eq(changeCategoriesTable.isActive, true));
  if (!cats.some((c) => c.key === "general") && cats.length > 0) category = cats[0]!.key;

  // Standard changes: the webhook may name a template. If it matches an
  // active template it is linked immediately; otherwise the draft is created
  // WITHOUT a template and the owner must pick one in Change-it before the
  // change can leave draft (enforced by the transition endpoint), so nothing
  // bypasses the approval pipeline.
  let templateId: number | null = null;
  let trackNote = "";
  if (track === "standard") {
    const templates = await db
      .select()
      .from(standardTemplatesTable)
      .where(eq(standardTemplatesTable.isActive, true));
    const match = templateName
      ? templates.find((t) => t.name.toLowerCase() === templateName.toLowerCase())
      : undefined;
    if (match) {
      templateId = match.id;
    } else {
      trackNote = templateName
        ? `\n\nNote: no active standard template named “${templateName}” exists — select a template in Change-it before submitting this change.`
        : `\n\nNote: select a standard template in Change-it before submitting this change.`;
    }
  }

  const ref = await nextRef(track);
  let created: typeof changeRequestsTable.$inferSelect;
  try {
    [created] = (await db
      .insert(changeRequestsTable)
      .values({
      ref,
      title: subject || `SD+ request ${requestId}`,
      description:
        (description || "(no description provided by ServiceDesk Plus)") +
        `\n\n— Created from ServiceDesk Plus request #${requestId}.` +
        trackNote,
      track,
      templateId,
      status: "draft",
      risk: "low",
      impact: "low",
      priority: "medium",
      category,
      ownerId: owner.id,
      sdpRequestId: requestId,
      ticketLink: sdpRequestUrl(cfg, requestId),
      requesterType: requesterName ? "external" : null,
      requesterName: requesterName || null,
      })
      .returning()) as [typeof changeRequestsTable.$inferSelect];
  } catch (err) {
    // Unique-index race: a concurrent webhook for the same SD+ request won
    // the insert. Return the winner instead of failing. Any other DB error
    // is rethrown untouched.
    const pgCode =
      (err as { code?: string }).code ??
      ((err as { cause?: { code?: string } }).cause?.code);
    if (pgCode !== "23505") throw err;
    const [winner] = await db
      .select()
      .from(changeRequestsTable)
      .where(and(eq(changeRequestsTable.sdpRequestId, requestId), isNull(changeRequestsTable.deletedAt)));
    if (winner) {
      await recordWebhook(requestId, `ok: already linked to ${winner.ref}`);
      res.json({
        ok: true,
        created: false,
        changeId: winner.id,
        ref: winner.ref,
        url: appBaseUrl() ? `${appBaseUrl()}/changes/${winner.id}` : null,
        message: `A change (${winner.ref}) already exists for SD+ request ${requestId}.`,
      });
      return;
    }
    throw err;
  }
  await db.insert(planningRecordsTable).values({ changeId: created.id }).onConflictDoNothing();
  if (templateId) {
    const [t] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, templateId));
    if (t?.prefilledPlanning) {
      await db
        .update(planningRecordsTable)
        .set({ implementationPlan: t.prefilledPlanning })
        .where(eq(planningRecordsTable.changeId, created.id));
    }
  }
  // Same approval scaffolding as changes created in the UI (standard: none).
  await createApprovalsForChange(created.id, track);

  await audit(req, {
    action: "integration.sdp_change_created",
    entityType: "change",
    entityId: created.id,
    summary: `${ref}: draft ${track} change created from ServiceDesk Plus request #${requestId}`,
    after: { sdpRequestId: requestId, subject, owner: owner.username, track },
  }, { id: null, name: "sdp-webhook" });
  await recordWebhook(requestId, `ok: created ${ref}`);

  // Best-effort back-link note into the SD+ ticket (never blocks the response).
  void sdpAddBackLinkNote(requestId, created).catch(() => {});

  res.status(201).json({
    ok: true,
    created: true,
    changeId: created.id,
    ref,
    url: appBaseUrl() ? `${appBaseUrl()}/changes/${created.id}` : null,
    message: `Draft ${track} change ${ref} created for SD+ request ${requestId}.${trackNote ? " Select a standard template in Change-it before submitting." : ""}`,
  });
});

export default router;
