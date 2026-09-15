import type { Request } from "express";
import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
};

function clientIp(req: Request | undefined): string {
  if (!req) return "";
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return req.ip ?? req.socket?.remoteAddress ?? "";
}

function userAgent(req: Request | undefined): string {
  if (!req) return "";
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : "";
}

export async function audit(
  req: Request | undefined,
  input: AuditInput,
  actor?: { id: number | null; name: string },
): Promise<void> {
  try {
    const sess = req?.session;
    const actorId = actor?.id ?? sess?.uid ?? null;
    const actorName = actor?.name ?? sess?.username ?? "system";
    await db.insert(auditLogTable).values({
      actorId,
      actorName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      ipAddress: clientIp(req),
      userAgent: userAgent(req),
      before: input.before ?? null,
      after: input.after ?? null,
    });
  } catch (err) {
    // The audit payload can legitimately contain user-entered change text.
    // Do not duplicate that payload in application logs when the audit insert
    // itself fails; retain only the event identity and redacted exception.
    logger.error(
      {
        err,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
      },
      "Failed to write audit entry",
    );
  }
}
