import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db, changeRequestsTable, standardTemplatesTable, templateSettingsTable } from "@workspace/db";

// "Potential Standard Change" promotion logic. A NORMAL change can be linked
// to a DISABLED standard template (potentialTemplateId). Once the number of
// linked changes that reached status 'completed' hits the global promotion
// threshold, the template becomes a promotion candidate: flagged in the CAB
// agenda (PDF + meeting page) and highlighted on the change detail header so
// the CAB can decide to enable it as a real standard template.

export const DEFAULT_PROMOTION_THRESHOLD = 5;

export async function getPromotionThreshold(): Promise<number> {
  const [row] = await db.select().from(templateSettingsTable).where(eq(templateSettingsTable.key, "global"));
  return row?.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD;
}

// Completed-change counts per template id ("proves it works repeatedly"):
// only NORMAL-track changes with status='completed', soft-deleted excluded.
// The track filter matters: a change switched to standard/emergency after
// being linked must not count toward promotion.
export async function getCompletedCountsByTemplate(templateIds?: number[]): Promise<Map<number, number>> {
  const conds = [
    sql`${changeRequestsTable.potentialTemplateId} IS NOT NULL`,
    eq(changeRequestsTable.track, "normal"),
    eq(changeRequestsTable.status, "completed"),
    isNull(changeRequestsTable.deletedAt),
  ];
  if (templateIds && templateIds.length > 0) {
    conds.push(inArray(changeRequestsTable.potentialTemplateId, templateIds));
  }
  const rows = await db
    .select({
      templateId: changeRequestsTable.potentialTemplateId,
      count: sql<number>`count(*)::int`,
    })
    .from(changeRequestsTable)
    .where(and(...conds))
    .groupBy(changeRequestsTable.potentialTemplateId);
  const map = new Map<number, number>();
  for (const r of rows) if (r.templateId != null) map.set(r.templateId, r.count);
  return map;
}

// Convenience for a single template: { count, threshold, ready }, or null
// when the template no longer needs promotion flags — i.e. it was deleted or
// has already been enabled as a real standard template. Links from trial
// changes (potentialTemplateId) are intentionally kept for history; hiding
// the flags here is what makes badges disappear after promotion.
export async function getPromotionStatus(templateId: number): Promise<{ completedCount: number; threshold: number; ready: boolean } | null> {
  const [tpl] = await db.select().from(standardTemplatesTable).where(eq(standardTemplatesTable.id, templateId));
  if (!tpl || tpl.isActive) return null;
  const [counts, threshold] = await Promise.all([
    getCompletedCountsByTemplate([templateId]),
    getPromotionThreshold(),
  ]);
  const completedCount = counts.get(templateId) ?? 0;
  return { completedCount, threshold, ready: completedCount >= threshold };
}
