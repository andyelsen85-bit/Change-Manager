import { describe, expect, it } from "vitest";
import { groupCabChanges } from "./cab-order";

const categories = [
  { id: 1, key: "platform", name: "Platform", sortOrder: 20, isActive: true },
  { id: 2, key: "legacy", name: "Legacy", sortOrder: 30, isActive: false },
  { id: 3, key: "apps", name: "Applications", sortOrder: 10, isActive: true },
];

type TestChange = {
  ref: string;
  category: string | null;
  risk: string;
  plannedStart: string | null;
};

const change = (overrides: Partial<TestChange> = {}): TestChange => ({
  ref: "CHG-1",
  category: "platform",
  risk: "low",
  plannedStart: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

const changes = [
  change({ ref: "CHG-3", category: "unknown-z", risk: "low" }),
  change({ ref: "CHG-1", category: "platform", risk: "medium" }),
  change({ ref: "CHG-2", category: "legacy", risk: "high" }),
  change({ ref: "CHG-4", category: "unknown-a", risk: "high" }),
  change({ ref: "CHG-5", category: null, risk: "low" }),
];

describe("CAB category ordering", () => {
  it("keeps configured inactive categories before unknown keys", () => {
    const groups = groupCabChanges(changes, categories);

    expect(groups.map((group) => group.label)).toEqual(["Platform", "Legacy", "unknown-a", "unknown-z", "Uncategorized"]);
  });

  it("sorts rows by risk, planned start, and reference inside a group", () => {
    const rows = [
      change({ ref: "CHG-3", risk: "low", plannedStart: "2025-01-01T00:00:00.000Z" }),
      change({ ref: "CHG-2", risk: "high", plannedStart: "2025-01-03T00:00:00.000Z" }),
      change({ ref: "CHG-1", risk: "high", plannedStart: "2025-01-01T00:00:00.000Z" }),
    ];

    expect(groupCabChanges(rows, categories)[0]?.changes.map((row) => row.ref)).toEqual(["CHG-1", "CHG-2", "CHG-3"]);
  });

  it("uses the reference as a tie-breaker when both planned starts are missing", () => {
    const rows = [
      change({ ref: "CHG-2", risk: "low", plannedStart: null }),
      change({ ref: "CHG-1", risk: "low", plannedStart: null }),
    ];

    expect(groupCabChanges(rows, categories)[0]?.changes.map((row) => row.ref)).toEqual(["CHG-1", "CHG-2"]);
  });
});