import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, changeRequestsTable } from "@workspace/db";
import { logger } from "./logger";
import { notify } from "./email";
import { resolveRecipients } from "./notification-routing";

// PIR deadline policy (per CHdN change policy):
//   Normal    → PIR within 30 days of implementation completion
//   Emergency → PIR within 5 days of implementation completion
//   Standard  → no PIR at all (pre-approved changes skip the review)
export const PIR_WINDOW_DAYS: Record<string, number> = {
  normal: 30,
  emergency: 5,
};

// Escalate to the Change Manager pool when fewer than this many days remain.
export const PIR_ESCALATION_THRESHOLD_DAYS = 10;

// Statuses in which implementation is finished but the PIR has not closed the
// change yet — the countdown is only meaningful in this window.
const PIR_PENDING_STATUSES = ["implemented", "in_testing", "awaiting_pir"];

export function computePirDueDate(track: string, actualEnd: Date | null): Date | null {
  const days = PIR_WINDOW_DAYS[track];
  if (!days || !actualEnd) return null;
  return new Date(actualEnd.getTime() + days * 24 * 60 * 60 * 1000);
}

export function daysUntil(date: Date, now: Date = new Date()): number {
  return Math.ceil((date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

// One pass: find changes whose PIR deadline is inside the escalation window
// and that have not been escalated yet, email the Change Manager pool
// (deputies included — they share the role_assignments pool), then stamp
// pirReminderSentAt so the reminder is sent exactly once per change.
export async function runPirReminderCheck(): Promise<{ sent: number }> {
  const candidates = await db
    .select()
    .from(changeRequestsTable)
    .where(
      and(
        inArray(changeRequestsTable.track, Object.keys(PIR_WINDOW_DAYS)),
        inArray(changeRequestsTable.status, PIR_PENDING_STATUSES),
        isNotNull(changeRequestsTable.actualEnd),
        isNull(changeRequestsTable.pirReminderSentAt),
      ),
    );

  let sent = 0;
  for (const c of candidates) {
    const due = computePirDueDate(c.track, c.actualEnd);
    if (!due) continue;
    const left = daysUntil(due);
    if (left >= PIR_ESCALATION_THRESHOLD_DAYS) continue;

    const targets = await resolveRecipients("pir.reminder", {
      changeId: c.id,
      ownerId: c.ownerId,
      assigneeId: c.assigneeId,
      track: c.track,
    });
    if (targets.length > 0) {
      const deadlineStr = due.toISOString().slice(0, 10);
      const urgency = left < 0
        ? `The PIR deadline passed ${Math.abs(left)} day(s) ago.`
        : `Only ${left} day(s) remain to complete the PIR.`;
      await notify({
        eventKey: "pir.reminder",
        to: targets,
        subject: `[CHG ${c.ref}] PIR deadline approaching: ${c.title}`,
        text: `${c.ref} ${c.title}\n\n${urgency}\n\nTrack: ${c.track} (PIR due within ${PIR_WINDOW_DAYS[c.track]} days of implementation completion)\nImplementation completed: ${c.actualEnd?.toISOString().slice(0, 10)}\nPIR deadline: ${deadlineStr}\n\nPlease ensure the post-implementation review is completed and the change is closed.`,
      });
    }
    // Stamp even when no recipients are configured — otherwise a change with
    // an empty change_manager pool would be re-evaluated forever and would
    // burst-send the moment someone is assigned to the role months later.
    await db
      .update(changeRequestsTable)
      .set({ pirReminderSentAt: new Date() })
      .where(eq(changeRequestsTable.id, c.id));
    sent++;
  }
  return { sent };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

// Daily-cadence check, evaluated hourly so a server restarted mid-day still
// escalates promptly. runPirReminderCheck() is idempotent (stamped rows are
// skipped) so the shorter tick interval costs nothing.
export function startPirReminderWorker(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await runPirReminderCheck();
      if (r.sent > 0) logger.info(r, "PIR reminder escalations sent");
    } catch (err) {
      logger.error({ err }, "PIR reminder check failed");
    } finally {
      running = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}
