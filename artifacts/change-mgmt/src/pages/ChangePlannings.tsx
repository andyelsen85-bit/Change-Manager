import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, Globe, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ChangeRequest, ExternalChange } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { fmtDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// A calendar bar is either one of our change requests or an external change
// (third-party maintenance window, visibility only).
type CalItem =
  | { kind: "change"; id: string; change: ChangeRequest }
  | { kind: "external"; id: string; external: ExternalChange };

// A planning bar is a single item clipped to one calendar week. An item that
// spans several weeks produces one segment per week, each laid out on its own
// row of the grid. `lane` is the vertical slot within the week so overlapping
// items stack instead of colliding.
type WeekSegment = {
  item: CalItem;
  startCol: number; // 0-6 (Mon..Sun)
  span: number; // number of day columns
  isStart: boolean; // true if the item actually starts in this segment
  isEnd: boolean; // true if the item actually ends in this segment
  lane: number;
};

// Every internal change uses the colour assigned to its track. Static classes
// keep the legend and all calendar views consistent.
const TRACK_BAR_COLORS = {
  standard: "bg-sky-600/85 hover:bg-sky-600 text-white",
  normal: "bg-violet-600/85 hover:bg-violet-600 text-white",
  emergency: "bg-rose-600/85 hover:bg-rose-600 text-white",
} as const;

function barColor(track: keyof typeof TRACK_BAR_COLORS): string {
  return TRACK_BAR_COLORS[track];
}

// External changes render as red hazard stripes — a deliberate "barrier tape"
// look that reads as "not ours, caution" and cannot be confused with any
// palette colour used for our own changes.
const EXTERNAL_BAR_STYLE: React.CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, #dc2626 0px, #dc2626 10px, #991b1b 10px, #991b1b 20px)",
};

// Parse a planned timestamp to a local-day boundary. Returns null when the
// value is missing or unparseable so the caller can skip the item.
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

// ISO string -> local date (dd/mm/yyyy) and 24h time ("HH:mm") parts.
// Split date + explicit 24h time fields are used instead of a native
// datetime-local input, whose time picker renders AM/PM in many browser
// locales and cannot be forced to 24h.
function toLocalParts(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

const TIME_24H = /^([01]\d|2[0-3]):[0-5]\d$/;

// Displayed dd/mm/yyyy + 24h time -> ISO payload ("" time defaults to 00:00).
function partsToIso(date: string, time: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!match) return null;
  const d = new Date(`${match[3]}-${match[2]}-${match[1]}T${time || "00:00"}`);
  if (
    isNaN(d.getTime()) ||
    d.getFullYear() !== Number(match[3]) ||
    d.getMonth() + 1 !== Number(match[2]) ||
    d.getDate() !== Number(match[1])
  ) return null;
  return d.toISOString();
}

type ExternalForm = {
  title: string;
  provider: string;
  description: string;
  startDate: string; // dd/mm/yyyy
  startTime: string; // HH:mm (24h)
  endDate: string;
  endTime: string;
};

const EMPTY_FORM: ExternalForm = {
  title: "",
  provider: "",
  description: "",
  startDate: "",
  startTime: "",
  endDate: "",
  endTime: "",
};

export function ChangePlanningsPage() {
  const [, setLocation] = useLocation();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const { toast } = useToast();
  const qc = useQueryClient();

  // Dialog state: null = closed, "new" = create, otherwise the external
  // change being edited.
  const [editing, setEditing] = useState<ExternalChange | "new" | null>(null);
  const [form, setForm] = useState<ExternalForm>(EMPTY_FORM);

  // All changes, then filtered client-side: open changes plus completed ones
  // (shown with a green check mark). Cancelled / rejected / rolled-back
  // changes stay hidden — their planned window never happened.
  const changesQ = useQuery({
    queryKey: ["changes", "/changes"],
    queryFn: () => api.get<ChangeRequest[]>("/changes"),
    select: (rows) => rows.filter((c) => !["cancelled", "rejected", "rolled_back"].includes(c.status)),
  });

  const externalsQ = useQuery({
    queryKey: ["external-changes"],
    queryFn: () => api.get<ExternalChange[]>("/external-changes"),
  });

  const saveExternal = useMutation({
    mutationFn: async () => {
      const payload = {
        title: form.title.trim(),
        provider: form.provider.trim(),
        description: form.description.trim(),
        startAt: partsToIso(form.startDate, form.startTime) ?? "",
        endAt: partsToIso(form.endDate, form.endTime),
      };
      if (editing === "new") return api.post<ExternalChange>("/external-changes", payload);
      return api.patch<ExternalChange>(`/external-changes/${(editing as ExternalChange).id}`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["external-changes"] });
      setEditing(null);
      toast({ title: editing === "new" ? "External change added" : "External change updated" });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deleteExternal = useMutation({
    mutationFn: async () => api.delete(`/external-changes/${(editing as ExternalChange).id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["external-changes"] });
      setEditing(null);
      toast({ title: "External change deleted" });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }

  function openEdit(ext: ExternalChange) {
    setForm({
      title: ext.title,
      provider: ext.provider,
      description: ext.description ?? "",
      startDate: toLocalParts(ext.startAt).date,
      startTime: toLocalParts(ext.startAt).time,
      endDate: toLocalParts(ext.endAt).date,
      endTime: toLocalParts(ext.endAt).time,
    });
    setEditing(ext);
  }

  const gridStart = useMemo(
    () => view === "month" ? startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }) : startOfWeek(cursor, { weekStartsOn: 1 }),
    [cursor, view],
  );
  const days = useMemo(
    () => Array.from({ length: view === "month" ? 42 : 7 }, (_, i) => addDays(gridStart, i)),
    [gridStart, view],
  );
  const weeks = useMemo(() => {
    const out: Date[][] = [];
    for (let i = 0; i < days.length / 7; i++) out.push(days.slice(i * 7, i * 7 + 7));
    return out;
  }, [days]);

  // Items that have a planned window and overlap the visible 6-week grid.
  const planned = useMemo(() => {
    const gridEnd = addDays(gridStart, days.length - 1);
    const items: { item: CalItem; start: Date; end: Date }[] = [];
    for (const c of changesQ.data ?? []) {
      const start = toDay(c.plannedStart);
      if (!start) continue;
      // Open-ended (no plannedEnd) renders as a single day.
      const end = toDay(c.plannedEnd) ?? start;
      const lo = start <= end ? start : end;
      const hi = start <= end ? end : start;
      items.push({ item: { kind: "change", id: `c-${c.id}`, change: c }, start: lo, end: hi });
    }
    for (const x of externalsQ.data ?? []) {
      const start = toDay(x.startAt);
      if (!start) continue;
      const end = toDay(x.endAt) ?? start;
      const lo = start <= end ? start : end;
      const hi = start <= end ? end : start;
      items.push({ item: { kind: "external", id: `x-${x.id}`, external: x }, start: lo, end: hi });
    }
    return items.filter((x) => x.end >= gridStart && x.start <= gridEnd);
  }, [changesQ.data, externalsQ.data, gridStart, days.length]);

  // Build per-week segments with lane assignment so overlapping bars stack.
  const segmentsByWeek = useMemo(() => {
    return weeks.map((week) => {
      const weekStart = week[0];
      const weekEnd = week[6];
      const segs: WeekSegment[] = [];
      for (const { item, start, end } of planned) {
        if (end < weekStart || start > weekEnd) continue;
        const segStart = start < weekStart ? weekStart : start;
        const segEnd = end > weekEnd ? weekEnd : end;
        const startCol = differenceInCalendarDays(segStart, weekStart);
        const span = differenceInCalendarDays(segEnd, segStart) + 1;
        segs.push({
          item,
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
  const dayItems = planned.filter(({ start, end }) => {
    const day = new Date(cursor);
    day.setHours(0, 0, 0, 0);
    return start <= day && end >= day;
  });
  const isLoading = changesQ.isLoading || externalsQ.isLoading;
  const startTimeOk = form.startTime === "" || TIME_24H.test(form.startTime);
  const endTimeOk = form.endTime === "" || TIME_24H.test(form.endTime);
  const dateOk = (value: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(value) && partsToIso(value, "00:00") !== null;
  const canSave = form.title.trim().length > 0 && dateOk(form.startDate) && startTimeOk && endTimeOk && (!form.endDate || dateOk(form.endDate));

  return (
    <div className="space-y-4" data-testid="page-change-plannings">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Change Plannings</h2>
          <p className="text-sm text-muted-foreground">
            Planned windows for all open changes. Colors identify the change track; click a bar to open the change.
          </p>
        </div>
        <Button onClick={openNew} data-testid="button-add-external">
          <Plus className="mr-2 h-4 w-4" />
          Add external change
        </Button>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-2">
            <CardTitle className="text-base">
              {view === "month"
                ? format(cursor, "MMMM yyyy")
                : view === "week"
                  ? `${format(gridStart, "d MMM")} – ${format(addDays(gridStart, 6), "d MMM yyyy")}`
                  : format(cursor, "EEEE, d MMMM yyyy")}
            </CardTitle>
            <Tabs value={view} onValueChange={(v) => setView(v as "month" | "week" | "day")}>
              <TabsList data-testid="tabs-calendar-view">
                <TabsTrigger value="month">Month</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="day">Day</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-3 text-xs text-muted-foreground lg:flex">
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm bg-sky-600" />Standard</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm bg-violet-600" />Normal</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm bg-rose-600" />Emergency</span>
              <span className="flex items-center gap-1.5" data-testid="legend-external">
                <span className="inline-block h-3 w-5 rounded-sm" style={EXTERNAL_BAR_STYLE} />
                External
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={() => setCursor((c) => view === "month" ? addMonths(c, -1) : view === "week" ? addWeeks(c, -1) : addDays(c, -1))} data-testid="button-prev-month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCursor(new Date())} data-testid="button-today">
                Today
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setCursor((c) => view === "month" ? addMonths(c, 1) : view === "week" ? addWeeks(c, 1) : addDays(c, 1))} data-testid="button-next-month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[520px] w-full" />
          ) : view === "day" ? (
            <div className="min-h-[360px] rounded-md border border-border p-4" data-testid="calendar-day-view">
              <div className="mb-4 text-sm font-medium text-muted-foreground">{format(cursor, "EEEE, d MMMM yyyy")}</div>
              <div className="space-y-2">
                {dayItems.map(({ item }) => item.kind === "external" ? (
                  <button
                    key={item.id}
                    onClick={() => openEdit(item.external)}
                    className="flex w-full items-center gap-2 rounded-md p-3 text-left text-sm text-white"
                    style={EXTERNAL_BAR_STYLE}
                    data-testid={`external-day-${item.external.id}`}
                  >
                    <Globe className="h-4 w-4" />
                    <span><strong>EXT</strong> {item.external.title} — {toLocalParts(item.external.startAt).time}–{toLocalParts(item.external.endAt).time}</span>
                  </button>
                ) : (
                  <button
                    key={item.id}
                    onClick={() => setLocation(`/changes/${item.change.id}`)}
                    className={cn("flex w-full items-center gap-2 rounded-md p-3 text-left text-sm", barColor(item.change.track))}
                    data-testid={`planning-day-${item.change.id}`}
                  >
                    {item.change.status === "completed" && <CheckCircle2 className="h-4 w-4" />}
                    <span><span className="font-mono">{item.change.ref}</span> {item.change.title} — {toLocalParts(item.change.plannedStart).time}–{toLocalParts(item.change.plannedEnd).time}</span>
                  </button>
                ))}
                {dayItems.length === 0 && (
                  <p className="py-16 text-center text-sm text-muted-foreground">No planned changes on this day.</p>
                )}
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="grid grid-cols-7 bg-border text-xs">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <div key={d} className="bg-card px-2 py-1.5 text-center font-medium text-muted-foreground">
                      {d}{view === "week" ? ` ${format(days[["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(d)]!, "d MMM")}` : ""}
                  </div>
                ))}
              </div>
              <div>
                {weeks.map((week, wi) => {
                  const segs = segmentsByWeek[wi];
                  const laneCount = segs.reduce((m, s) => Math.max(m, s.lane + 1), 0);
                  // Reserve vertical room for the stacked bars beneath the date row.
                  const barsAreaHeight = laneCount * 26 + (laneCount ? 6 : 0);
                  // Day cells must grow with the bars so borders always enclose them:
                  // 28px date row + bars area + 8px bottom padding, min 112px.
                  const cellMinHeight = Math.max(112, 28 + barsAreaHeight + 8);
                  return (
                    <div key={wi} className="relative border-t border-border first:border-t-0">
                      {/* Day cells (background) */}
                      <div className="grid grid-cols-7">
                        {week.map((day) => {
                          const inMonth = view === "week" || isSameMonth(day, cursor);
                          const today = isSameDay(day, new Date());
                          return (
                            <div
                              key={day.toISOString()}
                              className={cn(
                                "border-l border-border p-1.5 first:border-l-0",
                                !inMonth && "bg-muted/40 text-muted-foreground",
                              )}
                              style={{ minHeight: cellMinHeight }}
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
                        {segs.map((seg) => {
                          const common = {
                            className: cn(
                              "pointer-events-auto absolute flex h-[22px] items-center truncate px-2 text-[11px] font-medium shadow-sm transition-colors",
                              seg.isStart ? "rounded-l-md" : "rounded-l-none",
                              seg.isEnd ? "rounded-r-md" : "rounded-r-none",
                            ),
                            style: {
                              left: `calc(${(seg.startCol / 7) * 100}% + 2px)`,
                              width: `calc(${(seg.span / 7) * 100}% - 4px)`,
                              top: seg.lane * 26,
                            } as React.CSSProperties,
                          };
                          if (seg.item.kind === "external") {
                            const x = seg.item.external;
                            return (
                              <button
                                key={`${seg.item.id}-${seg.startCol}`}
                                onClick={() => openEdit(x)}
                                title={`External change · ${x.title}${x.provider ? ` · ${x.provider}` : ""}\n${fmtDateShort(x.startAt)} → ${fmtDateShort(x.endAt ?? x.startAt)}\nClick to edit`}
                                data-testid={`external-bar-${x.id}`}
                                className={cn(common.className, "text-white hover:brightness-110")}
                                style={{ ...common.style, ...EXTERNAL_BAR_STYLE }}
                              >
                                <Globe className="mr-1 h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">
                                  {!seg.isStart && "… "}
                                  <span className="font-semibold">EXT</span> {x.title}
                                  {x.provider ? ` — ${x.provider}` : ""}
                                </span>
                              </button>
                            );
                          }
                          const c = seg.item.change;
                          return (
                            <button
                              key={`${seg.item.id}-${seg.startCol}`}
                              onClick={() => setLocation(`/changes/${c.id}`)}
                              title={`${c.ref} · ${c.title} · ${STATUS_LABELS[c.status] ?? c.status}\n${fmtDateShort(c.plannedStart)} → ${fmtDateShort(c.plannedEnd ?? c.plannedStart)}`}
                              data-testid={`planning-bar-${c.id}`}
                              className={cn(
                                common.className,
                                barColor(c.track),
                              )}
                              style={common.style}
                            >
                              {c.status === "completed" && (
                                <CheckCircle2 className="mr-1 h-3.5 w-3.5 shrink-0 text-green-200" data-testid={`icon-completed-${c.id}`} />
                              )}
                              <span className="truncate">
                                {!seg.isStart && "… "}
                                <span className="font-mono">{c.ref}</span> {c.title}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!isLoading && view !== "day" && totalPlanned === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <CalendarRange className="h-8 w-8" />
              <p className="text-sm">No open changes have a planned window in view.</p>
              <p className="text-xs">Set a planned start &amp; end on a change to see it scheduled here.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* External change create / edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-2xl" data-testid="dialog-external-change">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "Add external change" : "Edit external change"}</DialogTitle>
            <DialogDescription>
              A third-party maintenance window (provider, vendor, carrier…) shown on the calendar for visibility only.
              It is not planned or approved in Change-it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="SBC maintenance"
                data-testid="input-external-title"
              />
            </div>
            <div className="space-y-2">
              <Label>Provider / responsible party</Label>
              <Input
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                placeholder="Telecom provider"
                data-testid="input-external-provider"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Start *</Label>
                <div className="flex gap-2">
                  <Input
                    inputMode="numeric"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    placeholder="dd/mm/yyyy"
                    data-testid="input-external-start-date"
                  />
                  <Input
                    value={form.startTime}
                    onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                    placeholder="HH:MM"
                    maxLength={5}
                    className={cn("w-24 shrink-0", !startTimeOk && "border-destructive")}
                    data-testid="input-external-start-time"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>End</Label>
                <div className="flex gap-2">
                  <Input
                    inputMode="numeric"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    placeholder="dd/mm/yyyy"
                    data-testid="input-external-end-date"
                  />
                  <Input
                    value={form.endTime}
                    onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                    placeholder="HH:MM"
                    maxLength={5}
                    className={cn("w-24 shrink-0", !endTimeOk && "border-destructive")}
                    data-testid="input-external-end-time"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                rows={3}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Expected impact on our systems…"
                data-testid="input-external-description"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {editing !== "new" && editing !== null ? (
              <Button
                variant="destructive"
                onClick={() => deleteExternal.mutate()}
                disabled={deleteExternal.isPending}
                data-testid="button-external-delete"
              >
                {deleteExternal.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditing(null)} data-testid="button-external-cancel">
                Cancel
              </Button>
              <Button onClick={() => saveExternal.mutate()} disabled={!canSave || saveExternal.isPending} data-testid="button-external-save">
                {saveExternal.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editing === "new" ? "Add" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
