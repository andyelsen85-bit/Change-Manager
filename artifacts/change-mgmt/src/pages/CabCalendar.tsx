import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { addMonths, endOfMonth, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, addDays } from "date-fns";
import { CalendarPlus, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CabMeeting, ChangeRequest, User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDateTime, fromLocalDateTimeInput, toLocalDateTimeInput } from "@/lib/format";
import { cn } from "@/lib/utils";

export function CabCalendarPage() {
  const [, setLocation] = useLocation();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [createOpen, setCreateOpen] = useState(false);

  const from = startOfMonth(cursor).toISOString();
  const to = endOfMonth(cursor).toISOString();
  const meetingsQ = useQuery({
    queryKey: ["cab.month", from, to],
    queryFn: () => api.get<CabMeeting[]>(`/cab-meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [cursor]);

  const byDay = useMemo(() => {
    const m = new Map<string, CabMeeting[]>();
    for (const meeting of meetingsQ.data ?? []) {
      const k = format(new Date(meeting.scheduledStart), "yyyy-MM-dd");
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(meeting);
    }
    return m;
  }, [meetingsQ.data]);

  return (
    <div className="space-y-4" data-testid="page-cab-calendar">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">CAB Calendar</h2>
          <p className="text-sm text-muted-foreground">Schedule and review all CAB &amp; emergency CAB meetings.</p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-cab">
                <CalendarPlus className="mr-2 h-4 w-4" /> New meeting
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <NewCabDialog onClose={() => setCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{format(cursor, "MMMM yyyy")}</CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => setCursor((c) => addMonths(c, -1))} data-testid="button-prev-month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCursor(startOfMonth(new Date()))}>Today</Button>
            <Button variant="ghost" size="icon" onClick={() => setCursor((c) => addMonths(c, 1))} data-testid="button-next-month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border text-xs">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="bg-card px-2 py-1.5 text-center font-medium text-muted-foreground">{d}</div>
            ))}
            {days.map((day) => {
              const k = format(day, "yyyy-MM-dd");
              const items = byDay.get(k) ?? [];
              const inMonth = isSameMonth(day, cursor);
              const today = isSameDay(day, new Date());
              return (
                <div
                  key={k}
                  className={cn("min-h-[100px] bg-card p-1.5", !inMonth && "bg-muted/40 text-muted-foreground")}
                  data-testid={`day-${k}`}
                >
                  <div className={cn("mb-1 flex justify-end text-xs font-medium", today && "text-primary")}>
                    {today ? <span className="rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground">{format(day, "d")}</span> : format(day, "d")}
                  </div>
                  <div className="space-y-1">
                    {items.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setLocation(`/cab/${m.id}`)}
                        data-testid={`meeting-${m.id}`}
                        className={cn(
                          "block w-full truncate rounded px-1.5 py-1 text-left text-[11px] font-medium",
                          m.kind === "ecab" ? "bg-destructive/15 text-destructive hover:bg-destructive/25" : "bg-info/15 text-info hover:bg-info/25",
                        )}
                        title={m.title}
                      >
                        {format(new Date(m.scheduledStart), "HH:mm")} {m.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upcoming this month</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {(meetingsQ.data ?? []).map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <Link href={`/cab/${m.id}`} className="text-sm font-medium hover:underline">{m.title}</Link>
                  <div className="text-xs text-muted-foreground">{fmtDateTime(m.scheduledStart)} · {m.kind === "ecab" ? "Emergency CAB" : "CAB"}</div>
                </div>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{m.status}</span>
              </li>
            ))}
            {(meetingsQ.data ?? []).length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No meetings this month.</p>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function NewCabDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const usersQ = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });
  const changesQ = useQuery({
    queryKey: ["changes.cab-eligible"],
    queryFn: () => api.get<ChangeRequest[]>("/changes?status=awaiting_approval"),
  });

  // Default start: 10:30 on the next calendar day. Operators told us the
  // common CAB cadence is "tomorrow morning"; today's morning slot is often
  // already past when they sit down to schedule.
  const startDefault = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 30, 0, 0);
    return d;
  })();

  const [title, setTitle] = useState("Weekly CAB");
  const [kind, setKind] = useState<"cab" | "ecab">("cab");
  const [scheduledStart, setScheduledStart] = useState(toLocalDateTimeInput(startDefault));
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [location, setMeetingLocation] = useState("");
  const [agenda, setAgenda] = useState("");
  const [chairUserId, setChairUserId] = useState<string>("none");
  const [changeIds, setChangeIds] = useState<number[]>([]);
  const [recurring, setRecurring] = useState(false);
  const [recurrenceIntervalWeeks, setRecurrenceIntervalWeeks] = useState<number>(1);
  const [recurrenceUntil, setRecurrenceUntil] = useState<string>("");

  const create = useMutation({
    mutationFn: () => {
      if (recurring && !recurrenceUntil) {
        throw new Error("Please choose a 'Repeat until' date for recurring meetings.");
      }
      return api.post<{ id: number }>("/cab-meetings", {
        title,
        kind,
        scheduledStart: fromLocalDateTimeInput(scheduledStart),
        durationMinutes,
        location,
        agenda,
        chairUserId: chairUserId === "none" ? null : Number(chairUserId),
        changeIds,
        recurring,
        recurrenceIntervalWeeks: recurring ? recurrenceIntervalWeeks : undefined,
        recurrenceUntil: recurring ? recurrenceUntil : undefined,
      });
    },
    onSuccess: (m) => {
      toast.success(recurring ? "Recurring meeting series created" : "Meeting created");
      qc.invalidateQueries({ queryKey: ["cab.month"] });
      onClose();
      setLocation(`/cab/${m.id}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Create failed"),
  });

  const toggle = (arr: number[], setArr: (v: number[]) => void, id: number) => {
    if (arr.includes(id)) setArr(arr.filter((x) => x !== id));
    else setArr([...arr, id]);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New CAB meeting</DialogTitle>
        <DialogDescription>Schedule a Change Advisory Board or eCAB meeting.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 py-2">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="input-cab-title" />
          </div>
          <div className="space-y-2">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "cab" | "ecab")}>
              <SelectTrigger data-testid="select-cab-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cab">Standard CAB</SelectItem>
                <SelectItem value="ecab">Emergency CAB (eCAB)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Start</Label>
            <DateTimePicker value={scheduledStart} onChange={setScheduledStart} />
          </div>
          <div className="space-y-2">
            <Label>Duration (minutes)</Label>
            <Input
              type="number"
              min={5}
              step={5}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Math.max(5, Number(e.target.value) || 60))}
              data-testid="input-cab-duration"
            />
          </div>
        </div>
        <div className="rounded-md border border-border p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              data-testid="checkbox-recurring"
            />
            <span className="font-medium">Recurring meeting</span>
          </label>
          {recurring && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Every</Label>
                <Select value={String(recurrenceIntervalWeeks)} onValueChange={(v) => setRecurrenceIntervalWeeks(Number(v))}>
                  <SelectTrigger data-testid="select-recurrence-interval"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Week</SelectItem>
                    <SelectItem value="2">2 weeks</SelectItem>
                    <SelectItem value="3">3 weeks</SelectItem>
                    <SelectItem value="4">4 weeks</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Repeat until</Label>
                <Input
                  type="date"
                  value={recurrenceUntil}
                  onChange={(e) => setRecurrenceUntil(e.target.value)}
                  data-testid="input-recurrence-until"
                />
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label>Location</Label>
          <Input
            value={location}
            onChange={(e) => setMeetingLocation(e.target.value)}
            placeholder="Conference room / video link"
          />
        </div>
        <div className="space-y-2">
          <Label>Agenda</Label>
          <Textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Chair</Label>
          <Select value={chairUserId} onValueChange={setChairUserId}>
            <SelectTrigger><SelectValue placeholder="No chair" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No chair</SelectItem>
              {(usersQ.data ?? []).map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>{u.fullName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Changes on agenda ({changeIds.length})</Label>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2 text-sm">
            {(changesQ.data ?? []).map((c) => (
              <label key={c.id} className="flex items-center gap-2 py-1">
                <input type="checkbox" checked={changeIds.includes(c.id)} onChange={() => toggle(changeIds, setChangeIds, c.id)} />
                <span className="font-mono text-xs">{c.ref}</span> {c.title}
              </label>
            ))}
            {(changesQ.data ?? []).length === 0 && <span className="text-xs text-muted-foreground">No changes awaiting CAB.</span>}
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="button-create-cab">
          {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create meeting
        </Button>
      </DialogFooter>
    </>
  );
}
