import { sql } from "drizzle-orm";
import { db, refCountersTable } from "@workspace/db";

const PREFIX_BY_TRACK: Record<string, string> = {
  normal: "NOR",
  standard: "STD",
  emergency: "EMR",
};

export async function nextRef(track: string): Promise<string> {
  const prefix = PREFIX_BY_TRACK[track] ?? "CHG";
  const [row] = await db
    .insert(refCountersTable)
    .values({ prefix, counter: 1 })
    .onConflictDoUpdate({
      target: refCountersTable.prefix,
      set: { counter: sql`${refCountersTable.counter} + 1` },
    })
    .returning();
  return `${prefix}-${String(row.counter).padStart(5, "0")}`;
}
