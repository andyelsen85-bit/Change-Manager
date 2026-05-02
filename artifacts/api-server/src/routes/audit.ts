import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, ilike } from "drizzle-orm";
import { db, auditLogTable } from "@workspace/db";
import { requireAdmin } from "../lib/auth";

const router: IRouter = Router();

function buildConds(q: Record<string, unknown>) {
  const conds = [];
  if (q["actorId"]) {
    const id = Number(q["actorId"]);
    if (Number.isFinite(id)) conds.push(eq(auditLogTable.actorId, id));
  }
  if (typeof q["action"] === "string" && q["action"]) {
    conds.push(ilike(auditLogTable.action, `%${q["action"]}%`));
  }
  if (typeof q["entityType"] === "string" && q["entityType"]) {
    conds.push(eq(auditLogTable.entityType, q["entityType"]));
  }
  if (q["entityId"]) {
    const id = Number(q["entityId"]);
    if (Number.isFinite(id)) conds.push(eq(auditLogTable.entityId, id));
  }
  if (typeof q["from"] === "string" && q["from"]) conds.push(gte(auditLogTable.timestamp, new Date(q["from"])));
  if (typeof q["to"] === "string" && q["to"]) conds.push(lte(auditLogTable.timestamp, new Date(q["to"])));
  return conds;
}

router.get("/admin/audit-log", requireAdmin, async (req, res): Promise<void> => {
  const conds = buildConds(req.query as Record<string, unknown>);
  const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 100)));
  const offset = Math.max(0, Number(req.query["offset"] ?? 0));
  const base = db.select().from(auditLogTable);
  const rows = await (conds.length ? base.where(and(...conds)) : base)
    .orderBy(desc(auditLogTable.timestamp))
    .limit(limit)
    .offset(offset);
  res.json(rows);
});

function csvEscape(s: unknown): string {
  if (s == null) return "";
  const str = typeof s === "string" ? s : typeof s === "object" ? JSON.stringify(s) : String(s);
  if (/[,"\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

router.get("/admin/audit-log/export", requireAdmin, async (req, res): Promise<void> => {
  const conds = buildConds(req.query as Record<string, unknown>);
  const base = db.select().from(auditLogTable);
  const rows = await (conds.length ? base.where(and(...conds)) : base).orderBy(desc(auditLogTable.timestamp));
  const headers = ["id", "timestamp", "actorId", "actorName", "action", "entityType", "entityId", "summary", "ipAddress", "userAgent", "before", "after"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString()}.csv"`);
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
        r.actorId,
        r.actorName,
        r.action,
        r.entityType,
        r.entityId,
        r.summary,
        r.ipAddress,
        r.userAgent,
        r.before,
        r.after,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  res.send(lines.join("\n"));
});

export default router;
