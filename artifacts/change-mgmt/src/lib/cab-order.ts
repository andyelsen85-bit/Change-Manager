import type { CategoryItem } from "@/lib/types";

/**
 * The fields shared by change rows shown in the CAB docket and approval
 * panels. Keep this ordering in one place so both panels present the same
 * agenda order even though they receive different API projections.
 */
export type CabSortableChange = {
  category?: string | null;
  risk: string | null;
  plannedStart?: string | null;
  ref: string;
};

export type CabChangeGroup<T extends CabSortableChange> = {
  key: string;
  label: string;
  changes: T[];
};

const UNCATEGORIZED_KEY = "__uncategorized__";

const riskRank = (risk: string | null): number => {
  if (risk === "high") return 0;
  if (risk === "medium") return 1;
  if (risk === "low") return 2;
  return 3;
};

const configuredCategoryOrder = (a: CategoryItem, b: CategoryItem): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);

const plannedStartValue = (plannedStart: string | null | undefined): number => {
  if (!plannedStart) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(plannedStart);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
};

/**
 * Sort a CAB group's changes by the established docket order: high, medium,
 * low risk, then planned start and finally change reference.
 */
export function compareCabChanges(a: CabSortableChange, b: CabSortableChange): number {
  // Use `||` rather than a `!== 0` check here: subtracting two missing
  // dates yields NaN, and NaN must fall through to the reference tie-breaker.
  return (
    riskRank(a.risk) - riskRank(b.risk) ||
    plannedStartValue(a.plannedStart) - plannedStartValue(b.plannedStart) ||
    a.ref.localeCompare(b.ref)
  );
}

/**
 * Group CAB rows by category. Configured categories retain their canonical
 * sortOrder (including inactive categories needed by historical changes).
 * Category keys not present in the settings table are shown alphabetically
 * after configured categories, with uncategorized rows explicitly last.
 */
export function groupCabChanges<T extends CabSortableChange>(
  changes: readonly T[],
  categories: readonly CategoryItem[],
): CabChangeGroup<T>[] {
  const configured = [...categories].sort(configuredCategoryOrder);
  const categoryByKey = new Map(configured.map((category) => [category.key, category]));
  const groups = new Map<string, { label: string; configuredIndex: number; changes: T[] }>();

  for (const change of changes) {
    const key = typeof change.category === "string" ? change.category.trim() : "";
    const configuredCategory = key ? categoryByKey.get(key) : undefined;
    const groupKey = key || UNCATEGORIZED_KEY;
    const group = groups.get(groupKey);

    if (group) {
      group.changes.push(change);
      continue;
    }

    groups.set(groupKey, {
      label: (configuredCategory?.name ?? key) || "Uncategorized",
      configuredIndex: configuredCategory
        ? configured.indexOf(configuredCategory)
        : key
          ? configured.length
          : configured.length + 1,
      changes: [change],
    });
  }

  return [...groups.entries()]
    .sort(([keyA, groupA], [keyB, groupB]) => {
      if (groupA.configuredIndex !== groupB.configuredIndex) {
        return groupA.configuredIndex - groupB.configuredIndex;
      }
      if (groupA.configuredIndex < configured.length) return 0;
      return groupA.label.localeCompare(groupB.label) || keyA.localeCompare(keyB);
    })
    .map(([key, group]) => ({
      key,
      label: group.label,
      changes: [...group.changes].sort(compareCabChanges),
    }));
}