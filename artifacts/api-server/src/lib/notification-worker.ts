import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
// (advisory lock removed — see flushNotificationQueue() comment.)
import {
  db,
  notificationQueueTable,
  notificationSettingsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { buildTransporter, getSmtp } from "./email";
import { NOTIFICATION_EVENTS } from "./events";

const KEY = "global";

// CHdN palette (kept in sync with apps/change-mgmt tailwind theme).
const BRAND_GREEN = "#00543f";
const BRAND_GREEN_DARK = "#003d2e";
const BRAND_BROWN = "#7a5a3a";
const BRAND_TEXT = "#1f2933";
const BRAND_MUTED = "#5a6677";
const BRAND_BG = "#f6f4ee";

const EVENT_LABEL: Record<string, string> = Object.fromEntries(
  NOTIFICATION_EVENTS.map((e) => [e.key, e.label]),
);
const EVENT_DESCRIPTION: Record<string, string> = Object.fromEntries(
  NOTIFICATION_EVENTS.map((e) => [e.key, e.description]),
);

export async function getNotificationSettings(): Promise<{
  batchIntervalMinutes: number;
  lastRunAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(notificationSettingsTable)
    .where(eq(notificationSettingsTable.key, KEY));
  if (!row) {
    await db
      .insert(notificationSettingsTable)
      .values({ key: KEY })
      .onConflictDoNothing();
    return { batchIntervalMinutes: 15, lastRunAt: null };
  }
  return {
    batchIntervalMinutes: row.batchIntervalMinutes,
    lastRunAt: row.lastRunAt ?? null,
  };
}

export async function setNotificationSettings(batchIntervalMinutes: number): Promise<void> {
  // Clamp: at least 1 minute, at most 24 hours, to keep the worker honest.
  const clamped = Math.max(1, Math.min(60 * 24, Math.floor(batchIntervalMinutes)));
  await db
    .insert(notificationSettingsTable)
    .values({ key: KEY, batchIntervalMinutes: clamped })
    .onConflictDoUpdate({
      target: notificationSettingsTable.key,
      set: { batchIntervalMinutes: clamped },
    });
}

export async function getQueueDepth(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationQueueTable)
    .where(isNull(notificationQueueTable.sentAt));
  return Number(row?.n ?? 0);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Notification subjects produced by the API consistently start with
// "[CHG <ref>] ..." — see all notify() call-sites in routes/. We parse the
// ref out and use it to visually group items in the digest so a recipient
// sees one section per change request instead of an undifferentiated list.
// Items whose subject doesn't carry a CHG ref (e.g. CAB agendas, future
// system messages) fall into a single "Other notifications" group at the end.
function parseChangeRef(subject: string): { ref: string | null; rest: string } {
  const m = subject.match(/^\[CHG\s+([^\]]+)\]\s*(.*)$/);
  if (m) return { ref: m[1].trim(), rest: m[2] };
  return { ref: null, rest: subject };
}

type DigestItem = { subject: string; bodyHtml: string; bodyText: string; eventKey: string; createdAt: Date };

function groupByChange(items: DigestItem[]): Array<{ ref: string | null; items: Array<DigestItem & { rest: string }> }> {
  const order: Array<string | null> = [];
  const map = new Map<string | null, Array<DigestItem & { rest: string }>>();
  for (const it of items) {
    const { ref, rest } = parseChangeRef(it.subject);
    if (!map.has(ref)) {
      order.push(ref);
      map.set(ref, []);
    }
    map.get(ref)!.push({ ...it, rest });
  }
  // Push the "Other" (null-ref) bucket to the end so per-change groups appear first.
  return order
    .sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0))
    .map((ref) => ({ ref, items: map.get(ref)! }));
}

// Build the consolidated digest email body for one user. Each row in the
// queue is an item; the wrapper supplies the brand chrome. Items are
// visually grouped by change-request reference so a recipient who has
// multiple events on the same change sees them under one heading.
function buildDigestHtml(opts: {
  fullName: string;
  fromName: string;
  items: DigestItem[];
}): string {
  const heading = opts.items.length === 1
    ? "You have 1 new notification"
    : `You have ${opts.items.length} new notifications`;

  const groups = groupByChange(opts.items);

  const renderItem = (item: DigestItem & { rest: string }): string => {
    const eventLabel = EVENT_LABEL[item.eventKey] ?? item.eventKey;
    const eventDesc = EVENT_DESCRIPTION[item.eventKey];
    // Manual dd/MM/yyyy HH:mm formatting — some Node ICU builds wrongly
    // return 12-hour AM/PM for en-GB even when hour12:false is requested.
    const pad = (n: number): string => String(n).padStart(2, "0");
    const d = item.createdAt;
    const when = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const inner = item.bodyHtml && item.bodyHtml.trim()
      ? item.bodyHtml
      : `<div style="white-space:pre-wrap;color:${BRAND_TEXT};font-size:14px;line-height:1.5;">${escapeHtml(item.bodyText)}</div>`;
    const descLine = eventDesc
      ? `<div style="font-size:12px;color:${BRAND_MUTED};font-style:italic;margin-bottom:8px;">${escapeHtml(eventDesc)}</div>`
      : "";
    // Within a change group the change ref is already in the group header,
    // so we show only the "rest" of the subject (the human-readable part)
    // to avoid repetition.
    const itemTitle = item.rest && item.rest.trim() ? item.rest : item.subject;
    return `
      <div style="padding:14px 18px;border-top:1px solid #ece7d8;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:${BRAND_BROWN};font-weight:600;margin-bottom:4px;">${escapeHtml(eventLabel)} &middot; ${escapeHtml(when)}</div>
        <div style="font-size:15px;font-weight:600;color:${BRAND_GREEN_DARK};margin-bottom:4px;">${escapeHtml(itemTitle)}</div>
        ${descLine}
        ${inner}
      </div>`;
  };

  const itemsHtml = groups
    .map((g) => {
      const groupTitle = g.ref
        ? `Change ${escapeHtml(g.ref)}`
        : "Other notifications";
      const countLabel = g.items.length === 1 ? "1 update" : `${g.items.length} updates`;
      return `
        <tr>
          <td style="padding:8px 24px 0 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e2d6;border-radius:10px;overflow:hidden;background:#fbfaf6;margin:14px 0 4px 0;">
              <tr>
                <td style="background:${BRAND_GREEN};padding:10px 18px;color:#ffffff;">
                  <div style="font-size:14px;font-weight:600;letter-spacing:0.02em;">${groupTitle}</div>
                  <div style="font-size:11px;opacity:0.85;margin-top:2px;">${countLabel}</div>
                </td>
              </tr>
              <tr>
                <td>
                  ${g.items.map(renderItem).join("")}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(opts.fromName)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND_TEXT};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_BG};padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:${BRAND_GREEN};padding:24px 28px;color:#ffffff;">
                <div style="font-size:13px;letter-spacing:0.1em;text-transform:uppercase;opacity:0.85;">${escapeHtml(opts.fromName)}</div>
                <div style="font-size:22px;font-weight:600;margin-top:4px;">${escapeHtml(heading)}</div>
              </td>
            </tr>
            <tr>
              <td style="height:6px;background:linear-gradient(90deg, ${BRAND_BROWN} 0%, ${BRAND_GREEN} 100%);"></td>
            </tr>
            <tr>
              <td style="padding:24px 24px 8px 24px;">
                <p style="margin:0;font-size:14px;color:${BRAND_TEXT};">Hello ${escapeHtml(opts.fullName)},</p>
                <p style="margin:8px 0 0 0;font-size:14px;color:${BRAND_MUTED};">Here is a summary of activity that concerns you since the last digest.</p>
              </td>
            </tr>
            ${itemsHtml}
            <tr>
              <td style="padding:18px 24px 24px 24px;border-top:1px solid #e7e2d6;font-size:12px;color:${BRAND_MUTED};">
                You can adjust which notifications you receive, or pause them entirely, from your profile in the application.
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND_GREEN_DARK};padding:14px 24px;text-align:center;font-size:11px;color:#cfdcd6;letter-spacing:0.04em;">
                ${escapeHtml(opts.fromName)} &middot; Change Management
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildDigestText(items: DigestItem[]): string {
  const groups = groupByChange(items);
  return groups
    .map((g) => {
      const header = g.ref ? `=== Change ${g.ref} ===` : "=== Other notifications ===";
      const body = g.items
        .map((it, i) => {
          const label = EVENT_LABEL[it.eventKey] ?? it.eventKey;
          const title = it.rest && it.rest.trim() ? it.rest : it.subject;
          return `  ${i + 1}. [${label}] ${title}\n${it.bodyText
            .split("\n")
            .map((l) => "     " + l)
            .join("\n")}`;
        })
        .join("\n\n");
      return `${header}\n${body}`;
    })
    .join("\n\n----------\n\n");
}

// In-process mutex. The API runs as a single Node process so a module-level
// promise is sufficient to serialize the background tick and the manual
// "Send digest now" admin action. We previously used pg_try_advisory_lock
// here, but drizzle's connection pool can run the lock/unlock on different
// physical sessions — session-scoped advisory locks are tied to a session,
// so the unlock would silently no-op and a second caller would be told the
// queue was busy when it actually wasn't. Worse, a manual flush kicked off
// while the worker tick was running would return zero counts even though
// digests were being sent, producing the misleading "Queue is empty" toast
// while users still received mail.
//
// Awaiting the in-flight promise (rather than bailing) means the manual
// flush returns the real counts of whichever drain ended up doing the work.
let inFlight: Promise<{ usersNotified: number; itemsSent: number; errors: number }> | null = null;

// Drain the queue: load all unsent rows, group by user, build one email per
// user and send it. Marks rows sent on success. Returns counts for logging.
export async function flushNotificationQueue(): Promise<{
  usersNotified: number;
  itemsSent: number;
  errors: number;
}> {
  if (inFlight) return inFlight;
  inFlight = runFlush().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(): Promise<{ usersNotified: number; itemsSent: number; errors: number }> {
  const transporter = await buildTransporter();
  const cfg = await getSmtp();
  if (!transporter || !cfg) {
    // No SMTP configured — leave rows in the queue. They'll be attempted on
    // the next tick once the admin configures SMTP.
    return { usersNotified: 0, itemsSent: 0, errors: 0 };
  }

  const pending = await db
    .select({
      id: notificationQueueTable.id,
      userId: notificationQueueTable.userId,
      eventKey: notificationQueueTable.eventKey,
      subject: notificationQueueTable.subject,
      bodyText: notificationQueueTable.bodyText,
      bodyHtml: notificationQueueTable.bodyHtml,
      createdAt: notificationQueueTable.createdAt,
    })
    .from(notificationQueueTable)
    .where(isNull(notificationQueueTable.sentAt))
    .orderBy(asc(notificationQueueTable.createdAt));

  if (pending.length === 0) {
    await db
      .update(notificationSettingsTable)
      .set({ lastRunAt: new Date() })
      .where(eq(notificationSettingsTable.key, KEY));
    return { usersNotified: 0, itemsSent: 0, errors: 0 };
  }

  // Per-user grouping = privacy guarantee: each generated email contains
  // ONLY the rows whose user_id matches the recipient.
  const byUser = new Map<number, typeof pending>();
  for (const r of pending) {
    const arr = byUser.get(r.userId) ?? [];
    arr.push(r);
    byUser.set(r.userId, arr);
  }

  let usersNotified = 0;
  let itemsSent = 0;
  let errors = 0;

  for (const [userId, items] of byUser.entries()) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user || !user.isActive || user.notificationsEnabled === false) {
      // User was deactivated or opted out after enqueue — silently mark
      // rows sent so we don't keep retrying. The audit trail still has them.
      const ids = items.map((i) => i.id);
      await db
        .update(notificationQueueTable)
        .set({ sentAt: new Date() })
        .where(and(isNull(notificationQueueTable.sentAt), inArray(notificationQueueTable.id, ids)));
      continue;
    }
    const html = buildDigestHtml({
      fullName: user.fullName,
      fromName: cfg.fromName,
      items: items.map((i) => ({
        subject: i.subject,
        bodyHtml: i.bodyHtml,
        bodyText: i.bodyText,
        eventKey: i.eventKey,
        createdAt: i.createdAt,
      })),
    });
    const text = buildDigestText(items);
    const subject = items.length === 1
      ? items[0].subject
      : `${cfg.fromName}: ${items.length} new notifications`;
    try {
      await transporter.sendMail({
        from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
        to: `"${user.fullName}" <${user.email}>`,
        subject,
        text,
        html,
      });
      const ids = items.map((i) => i.id);
      // CRITICAL: mark sent immediately after a successful send. If this
      // UPDATE fails or matches 0 rows the next worker tick will re-send
      // the same items — that's the "I keep getting the same mail every
      // X minutes" symptom. Using drizzle's inArray() guarantees correct
      // parameter binding (a previous version used raw `id = ANY(${ids})`
      // which is fragile across drivers); we also log rowCount so any
      // future regression is loud rather than silent.
      const upd = await db
        .update(notificationQueueTable)
        .set({ sentAt: new Date() })
        .where(and(isNull(notificationQueueTable.sentAt), inArray(notificationQueueTable.id, ids)))
        .returning({ id: notificationQueueTable.id });
      if (upd.length !== ids.length) {
        logger.error(
          { userId, expected: ids.length, marked: upd.length, ids },
          "Notification queue mark-sent UPDATE matched fewer rows than expected; duplicates may be sent on next tick",
        );
      }
      usersNotified++;
      itemsSent += items.length;
    } catch (err) {
      logger.error({ err, userId, count: items.length }, "Notification digest send failed; will retry next tick");
      errors++;
    }
  }

  await db
    .update(notificationSettingsTable)
    .set({ lastRunAt: new Date() })
    .where(eq(notificationSettingsTable.key, KEY));

  return { usersNotified, itemsSent, errors };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

// Started once from index.ts after app.listen. Wakes every 30s and decides
// whether enough time has elapsed since the last run to flush the queue.
// A short tick interval (vs. interval-equals-window) keeps the "next send in N
// minutes" countdown accurate even when the admin shortens the window.
export function startNotificationWorker(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { batchIntervalMinutes, lastRunAt } = await getNotificationSettings();
      const intervalMs = batchIntervalMinutes * 60_000;
      const elapsed = lastRunAt ? Date.now() - lastRunAt.getTime() : Infinity;
      if (elapsed >= intervalMs) {
        const r = await flushNotificationQueue();
        if (r.usersNotified > 0 || r.errors > 0) {
          logger.info(r, "Notification digest run complete");
        }
      }
    } catch (err) {
      logger.error({ err }, "Notification worker tick failed");
    } finally {
      running = false;
    }
  };
  // Kick off on boot so a freshly-started server doesn't sit idle for 30s.
  void tick();
  timer = setInterval(() => void tick(), 30_000);
  // Allow the process to exit without waiting for the timer.
  if (typeof timer.unref === "function") timer.unref();
}
