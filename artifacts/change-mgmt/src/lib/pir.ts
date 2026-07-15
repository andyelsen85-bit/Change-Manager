import type { ChangeRequest } from "@/lib/types";

// PIR deadline policy — mirrors the API's pir-reminder worker:
//   Normal → 30 days, Emergency → 5 days after implementation completion.
//   Standard changes have no PIR in this workflow.
const PIR_WINDOW_DAYS: Record<string, number> = {
  normal: 30,
  emergency: 5,
};

export const PIR_HIGHLIGHT_THRESHOLD_DAYS = 10;

// Countdown is only meaningful once implementation finished and until the
// change is closed.
const PIR_PENDING_STATUSES = new Set(["implemented", "in_testing", "awaiting_pir"]);

export type PirCountdown = {
  daysLeft: number;
  dueDate: Date;
  urgent: boolean;
  overdue: boolean;
};

export function getPirCountdown(c: Pick<ChangeRequest, "track" | "status" | "actualEnd">): PirCountdown | null {
  const days = PIR_WINDOW_DAYS[c.track];
  if (!days || !c.actualEnd || !PIR_PENDING_STATUSES.has(c.status)) return null;
  const dueDate = new Date(new Date(c.actualEnd).getTime() + days * 24 * 60 * 60 * 1000);
  const daysLeft = Math.ceil((dueDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return {
    daysLeft,
    dueDate,
    urgent: daysLeft < PIR_HIGHLIGHT_THRESHOLD_DAYS,
    overdue: daysLeft < 0,
  };
}
