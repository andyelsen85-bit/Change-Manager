import { describe, expect, it, vi } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DbMock } from "../routes/test-helpers";

const dbMock = new DbMock();
const execFile = promisify(execFileCallback);

vi.mock("@workspace/db", () => ({
  db: dbMock,
  cabMeetingsTable: { id: "id" },
  cabChangesTable: { meetingId: "meeting_id", changeId: "change_id" },
  cabAttendeesTable: { meetingId: "meeting_id" },
  approvalsTable: {},
  rolesTable: {},
  changeRequestsTable: {
    id: "id",
    ownerId: "owner_id",
    plannedStart: "planned_start",
    ref: "ref",
    category: "category",
  },
  changeCategoriesTable: {
    key: "key",
    name: "name",
    sortOrder: "sort_order",
  },
  planningRecordsTable: { changeId: "change_id" },
  usersTable: { id: "id", fullName: "full_name" },
}));

vi.mock("drizzle-orm", () => ({
  asc: () => ({}),
  eq: () => ({}),
  and: () => ({}),
}));

const { buildCabAgendaPdf, groupAgendaChanges } = await import("./agenda-pdf");

const categories = [
  { key: "platform", name: "Platform", sortOrder: 20 },
  { key: "legacy", name: "Legacy", sortOrder: 30 },
  { key: "applications", name: "Applications", sortOrder: 10 },
];

const change = (
  overrides: Partial<{
    ref: string;
    title: string;
    category: string | null;
    risk: string;
    plannedStart: Date | null;
  }> = {},
) => ({
  change: {
    ref: "CHG-1",
    title: "Change",
    category: "platform",
    risk: "low",
    plannedStart: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  },
});

describe("CAB agenda category ordering", () => {
  it("keeps inactive configured categories before unknown categories and uses an alphabetical fallback", () => {
    const groups = groupAgendaChanges(
      [
        change({ ref: "CHG-Z", title: "Unknown Z", category: "unknown-z" }),
        change({ ref: "CHG-L", title: "Historical", category: "legacy" }),
        change({ ref: "CHG-A", title: "Unknown A", category: "unknown-a" }),
        change({ ref: "CHG-N", title: "No category", category: null }),
      ],
      categories,
    );

    expect(groups.map((group) => group.label)).toEqual([
      "Legacy",
      "unknown-a",
      "unknown-z",
      "Uncategorized",
    ]);
  });

  it("keeps high/medium/low risk ordering, then planned start and reference inside a category", () => {
    const groups = groupAgendaChanges(
      [
        change({
          ref: "CHG-3",
          risk: "low",
          plannedStart: new Date("2026-01-01T00:00:00Z"),
        }),
        change({
          ref: "CHG-2",
          risk: "high",
          plannedStart: new Date("2026-01-03T00:00:00Z"),
        }),
        change({
          ref: "CHG-1",
          risk: "high",
          plannedStart: new Date("2026-01-01T00:00:00Z"),
        }),
        change({
          ref: "CHG-4",
          risk: "medium",
          plannedStart: new Date("2026-01-01T00:00:00Z"),
        }),
      ],
      categories,
    );

    expect(groups[0]?.changes.map((row) => row.change.ref)).toEqual([
      "CHG-1",
      "CHG-2",
      "CHG-4",
      "CHG-3",
    ]);
  });
});

describe("CAB agenda PDF ordering", () => {
  it("renders the configured category order and the same order on detail pages", async () => {
    dbMock.reset();
    dbMock.enqueue("select", [
      {
        id: 77,
        title: "Ordering CAB",
        kind: "cab",
        scheduledStart: new Date("2026-02-01T10:00:00Z"),
        scheduledEnd: new Date("2026-02-01T11:00:00Z"),
        location: "Boardroom",
        agenda: "",
      },
    ]);
    const rows = [
      {
        change: {
          id: 1,
          ref: "CHG-UNKNOWN",
          title: "Unknown change",
          category: "unknown",
          risk: "low",
          plannedStart: new Date("2026-01-01T00:00:00Z"),
          potentialTemplateId: null,
          track: "normal",
          status: "awaiting_approval",
          impact: "low",
          priority: "low",
          requesterName: null,
          description: "Unknown description",
          plannedEnd: null,
          ticketLink: null,
          sdpRequestId: null,
          hasPreprodEnv: false,
          ownerId: 10,
        },
        ownerName: "Owner",
      },
      {
        change: {
          id: 2,
          ref: "CHG-LEGACY",
          title: "Legacy change",
          category: "legacy",
          risk: "medium",
          plannedStart: new Date("2026-01-01T00:00:00Z"),
          potentialTemplateId: null,
          track: "normal",
          status: "awaiting_approval",
          impact: "low",
          priority: "low",
          requesterName: null,
          description: "Legacy description",
          plannedEnd: null,
          ticketLink: null,
          sdpRequestId: null,
          hasPreprodEnv: false,
          ownerId: 10,
        },
        ownerName: "Owner",
      },
      {
        change: {
          id: 3,
          ref: "CHG-PLATFORM-LOW",
          title: "Platform low change",
          category: "platform",
          risk: "low",
          plannedStart: new Date("2026-01-01T00:00:00Z"),
          potentialTemplateId: null,
          track: "normal",
          status: "awaiting_approval",
          impact: "low",
          priority: "low",
          requesterName: null,
          description: "Platform low description",
          plannedEnd: null,
          ticketLink: null,
          sdpRequestId: null,
          hasPreprodEnv: false,
          ownerId: 10,
        },
        ownerName: "Owner",
      },
      {
        change: {
          id: 4,
          ref: "CHG-PLATFORM-HIGH",
          title: "Platform high change",
          category: "platform",
          risk: "high",
          plannedStart: new Date("2026-01-02T00:00:00Z"),
          potentialTemplateId: null,
          track: "normal",
          status: "awaiting_approval",
          impact: "low",
          priority: "low",
          requesterName: null,
          description: "Platform high description",
          plannedEnd: null,
          ticketLink: null,
          sdpRequestId: null,
          hasPreprodEnv: false,
          ownerId: 10,
        },
        ownerName: "Owner",
      },
    ];
    dbMock.enqueue("select", rows);
    dbMock.enqueue("select", categories);
    for (const _row of rows) dbMock.enqueue("select", []);

    const pdf = await buildCabAgendaPdf(77);
    expect(pdf).not.toBeNull();
    expect(pdf!.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf!.filename).toBe("cab-agenda-ordering-cab-77.pdf");

    const directory = await mkdtemp(join(tmpdir(), "cab-agenda-pdf-"));
    const path = join(directory, "agenda.pdf");
    try {
      await writeFile(path, pdf!.content);
      const { stdout } = await execFile("pdftotext", [path, "-"]);
      const overviewOrder = [
        "Platform high change",
        "Platform low change",
        "Legacy change",
        "Unknown change",
      ];
      const overviewPositions = overviewOrder.map((title) =>
        stdout.indexOf(title),
      );
      expect(overviewPositions.every((position) => position >= 0)).toBe(true);
      for (let i = 1; i < overviewOrder.length; i++) {
        expect(overviewPositions[i - 1]!).toBeLessThan(overviewPositions[i]!);
      }

      // The bracketed heading is only used on detail pages, so this checks
      // that the page sequence follows the same category/risk order.
      const detailOrder = [
        "[CHG-PLATFORM-HIGH] Platform high change",
        "[CHG-PLATFORM-LOW] Platform low change",
        "[CHG-LEGACY] Legacy change",
        "[CHG-UNKNOWN] Unknown change",
      ];
      const detailPositions = detailOrder.map((heading) =>
        stdout.indexOf(heading),
      );
      expect(detailPositions.every((position) => position >= 0)).toBe(true);
      for (let i = 1; i < detailOrder.length; i++) {
        expect(detailPositions[i - 1]!).toBeLessThan(detailPositions[i]!);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
