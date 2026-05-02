import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import {
  db,
  smtpSettingsTable,
  notificationPreferencesTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { decryptSecret } from "./secret-crypto";

export async function getSmtp() {
  const [row] = await db.select().from(smtpSettingsTable).where(eq(smtpSettingsTable.key, "global"));
  return row ?? null;
}

export async function buildTransporter() {
  const cfg = await getSmtp();
  if (!cfg || !cfg.enabled || !cfg.host) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username
      ? { user: cfg.username, pass: decryptSecret(cfg.passwordEnc) }
      : undefined,
  });
}

export async function userWantsEmail(userId: number, eventKey: string): Promise<boolean> {
  const [pref] = await db
    .select()
    .from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.userId, userId));
  if (!pref) return true;
  const matches = await db
    .select()
    .from(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.userId, userId));
  const found = matches.find((m) => m.eventKey === eventKey);
  return found ? found.emailEnabled : true;
}

export type NotifyTarget = { userId: number; email: string; name: string };

export async function notify(opts: {
  eventKey: string;
  to: NotifyTarget[];
  subject: string;
  text: string;
  html?: string;
  ics?: { content: string; filename: string };
}): Promise<{ sent: number; skipped: number; errors: number }> {
  const transporter = await buildTransporter();
  const cfg = await getSmtp();
  if (!transporter || !cfg) {
    logger.info({ eventKey: opts.eventKey }, "SMTP not configured; skipping notification");
    return { sent: 0, skipped: opts.to.length, errors: 0 };
  }
  let sent = 0,
    skipped = 0,
    errors = 0;
  for (const t of opts.to) {
    if (!(await userWantsEmail(t.userId, opts.eventKey))) {
      skipped++;
      continue;
    }
    try {
      await transporter.sendMail({
        from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
        to: `"${t.name}" <${t.email}>`,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        attachments: opts.ics
          ? [
              {
                filename: opts.ics.filename,
                content: opts.ics.content,
                contentType: "text/calendar; charset=utf-8; method=REQUEST",
              },
            ]
          : undefined,
      });
      sent++;
    } catch (err) {
      logger.error({ err, to: t.email }, "Email send failed");
      errors++;
    }
  }
  return { sent, skipped, errors };
}

export async function sendTestEmail(to: string): Promise<{ success: boolean; message: string }> {
  const transporter = await buildTransporter();
  const cfg = await getSmtp();
  if (!transporter || !cfg) return { success: false, message: "SMTP is not configured or not enabled" };
  try {
    await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
      to,
      subject: "Change Management — SMTP test",
      text: "If you received this, SMTP is configured correctly.",
    });
    return { success: true, message: `Test email sent to ${to}` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getUserEmail(userId: number): Promise<NotifyTarget | null> {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!u) return null;
  return { userId: u.id, email: u.email, name: u.fullName };
}
