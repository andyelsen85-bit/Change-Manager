import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import type { ChangeRequest } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

// A planning bar is a single change clipped to one calendar week. A change that
// spans several weeks produces one segment per week, each laid out on its own
// row of the grid. `lane` is the vertical slot within the week so overlapping
// changes stack instead of colliding.
type WeekSegment = {
  change: ChangeRequest;
  startCol: number; // 0-6 (Mon..Sun)
  span: number; // number of day columns
  isStart: boolean; // true if the change actually starts in this segment
  isEnd: boolean; // true if the change actually ends in this segment
  lane: number;
};

// Deterministic colour per change so the same change keeps its colour as the
// user pages between months. Tailwind-safe static classes (no dynamic strings).
const BAR_PALETTE = [
  "bg-sky-500/85 hover:bg-sky-500 text-white",
  "bg-violet-500/85 hover:bg-violet-500 text-white",
  "bg-emerald-500/85 hover:bg-emerald-500 text-white",
  "bg-amber-500/90 hover:bg-amber-500 text-white",
  "bg-rose-500/85 hover:bg-rose-500 text-white",
  "bg-teal-500/85 hover:bg-teal-500 text-white",
  "bg-fuchsia-500/85 hover:bg-fuchsia-500 text-white",
  "bg-indigo-500/85 hover:bg-indigo-500 text-white",
  "bg-cyan-500/85 hover:bg-cyan-500 text-white",
  "bg-orange-500/90 hover:bg-orange-500 text-white",
];

function barColor(id: number): string {
  return BAR_PALETTE[id % BAR_PALETTE.length];
}

// Parse a planned timestamp to a local-day boundary. Returns null when the
// value is missing or unparseable so the caller can skip the change.
function toDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  try {
    const d = parseISO(value);
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  } catch {
    return null;
  }
}

export function ChangePlanningsPage() {
  const [, setLocation] = useLocation();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  // Open changes only — the API's `status=active` view already excludes
  // completed / cancelled / rejected / rolled_back.
  const changesQ = useQuery({
    queryKey: ["changes", "/changes?status=active"],
    queryFn: () => api.get<ChangeRequest[]>("/changes?status=active"),
  });

  const gridStart = useMemo(() => startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), [cursor]);
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);
  const weeks = useMemo(() => {
    const out: Date[][] = [];
    for (let i = 0; i < 6; i++) out.push(days.slice(i * 7, i * 7 + 7));
    return out;
  }, [days]);

  // Changes that have a planned window and overlap the visible 6-week grid.
  const planned = useMemo(() => {
    const gridEnd = addDays(gridStart, 41);
    return (changesQ.data ?? [])
      .map((c) => {
        const start = toDay(c.plannedStart);
        if (!start) return null;
        // Open-ended (no plannedEnd) renders as a single day.
        const end = toDay(c.plannedEnd) ?? start;
        const lo = start <= end ? start : end;
        const hi = start <= end ? end : start;
        return { change: c, start: lo, end: hi };
      })
      .filter((x): x is { change: ChangeRequest; start: Date; end: Date } => x !== null)
      .filter((x) => x.end >= gridStart && x.start <= gridEnd);
  }, [changesQ.data, gridStart]);

  // Build per-week segments with lane assignment so overlapping bars stack.
  const segmentsByWeek = useMemo(() => {
    return weeks.map((week) => {
      const weekStart = week[0];
      const weekEnd = week[6];
      const segs: WeekSegment[] = [];
      for (const { change, start, end } of planned) {
        if (end < weekStart || start > weekEnd) continue;
        const segStart = start < weekStart ? weekStart : start;
        const segEnd = end > weekEnd ? weekEnd : end;
        const startCol = differenceInCalendarDays(segStart, weekStart);
        const span = differenceInCalendarDays(segEnd, segStart) + 1;
        segs.push({
          change,
          startCol,
          span,
          isStart: isSameDay(segStart, start),
          isEnd: isSameDay(segEnd, end),
          lane: 0,
        });
      }
      // Greedy lane packing: sort by start, place each segment in the first
      // lane whose last bar ends before this one starts.
      segs.sort((a, b) => a.startCol - b.startCol || b.span - a.span);
      const laneEnds: number[] = [];
      for (const seg of segs) {
        let placed = false;
        for (let lane = 0; lane < laneEnds.length; lane++) {
          if (laneEnds[lane] < seg.startCol) {
            seg.lane = lane;
            laneEnds[lane] = seg.startCol + seg.span - 1;
            placed = true;
            break;
          }
        }
        if (!placed) {
          seg.lane = laneEnds.length;
          laneEnds.push(seg.startCol + seg.span - 1);
        }
      }
      return segs;
    });
  }, [weeks, planned]);

  const totalPlanned = planned.length;

  return (
    <div className="space-y-4" data-testid="page-change-plannings">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Change Plannings</h2>
          <p className="text-sm text-muted-foreground">
            Planned windows for all open changes. Each bar spans a change's scheduled start to end — click it to open the change.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{format(cursor, "MMMM yyyy")}</CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setCursor((c) => addMonths(c, -1))} data-testid="button-prev-month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCursor(startOfMonth(new Date()))} data-testid="button-today">
              Today
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setCursor((c) => addMonths(c, 1))} data-testid="button-next-month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {changesQ.isLoading ? (
            <Skeleton className="h-[520px] w-full" />
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="grid grid-cols-7 bg-border text-xs">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                  <div key={d} className="bg-card px-2 py-1.5 text-center font-medium text-muted-foreground">
                    {d}
                  </div>
                ))}
              </div>
              <div>
                {weeks.map((week, wi) => {
                  const segs = segmentsByWeek[wi];
                  const laneCount = segs.reduce((m, s) => Math.max(m, s.lane + 1), 0);
                  // Reserve vertical room for the stacked bars beneath the date row.
                  const barsAreaHeight = laneCount * 26 + (laneCount ? 6 : 0);
                  return (
                    <div key={wi} className="relative border-t border-border first:border-t-0">
                      {/* Day cells (background) */}
                      <div className="grid grid-cols-7">
                        {week.map((day) => {
                          const inMonth = isSameMonth(day, cursor);
                          const today = isSameDay(day, new Date());
                          return (
                            <div
                              key={day.toISOString()}
                              className={cn(
                                "min-h-[112px] border-l border-border p-1.5 first:border-l-0",
                                !inMonth && "bg-muted/40 text-muted-foreground",
                              )}
                              data-testid={`day-${format(day, "yyyy-MM-dd")}`}
                            >
                              <div className={cn("flex justify-end text-xs font-medium", today && "text-primary")}>
                                {today ? (
                                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground">
                                    {format(day, "d")}
                                  </span>
                                ) : (
                                  format(day, "d")
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Bars overlay */}
                      <div className="pointer-events-none absolute inset-x-0 top-7 px-1" style={{ height: barsAreaHeight }}>
                        {segs.map((seg) => (
                          <button
                            key={`${seg.change.id}-${seg.startCol}`}
                            onClick={() => setLocation(`/changes/${seg.change.id}`)}
                            title={`${seg.change.ref} · ${seg.change.title} · ${STATUS_LABELS[seg.change.status] ?? seg.change.status}\n${fmtDateShort(seg.change.plannedStart)} → ${fmtDateShort(seg.change.plannedEnd ?? seg.change.plannedStart)}`}
                            data-testid={`planning-bar-${seg.change.id}`}
                            className={cn(
                              "pointer-events-auto absolute flex h-[22px] items-center truncate px-2 text-[11px] font-medium shadow-sm transition-colors",
                              barColor(seg.change.id),
                              seg.isStart ? "rounded-l-md" : "rounded-l-none",
                              seg.isEnd ? "rounded-r-md" : "rounded-r-none",
                            )}
                            style={{
                              left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                              width: `calc(${(seg.span / 7) * 100}% - 4px)`,
                              top: seg.lane * 26,
                            }}
                          >
                            <span className="truncate">
                              {!seg.isStart && "… "}
                              <span className="font-mono">{seg.change.ref}</span> {seg.change.title}
                            </span>
                          </button>
                        ))}
                      </div>
                      {/* Spacer to push cell height to fit bars when many lanes stack */}
                      {barsAreaHeight > 84 && <div style={{ height: barsAreaHeight - 84 }} aria-hidden="true" />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!changesQ.isLoading && totalPlanned === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <CalendarRange className="h-8 w-8" />
              <p className="text-sm">No open changes have a planned window in view.</p>
              <p className="text-xs">Set a planned start &amp; end on a change to see it scheduled here.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
