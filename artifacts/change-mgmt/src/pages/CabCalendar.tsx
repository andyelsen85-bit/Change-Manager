import { useEffect, useMemo, useRef, useState } from "react";
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
  // Primary (non-deputy) members per role — used to pre-select attendees
  // based on the meeting kind. Standard CAB meetings default to all primary
  // CAB Members; eCAB meetings default to all primary eCAB Members.
  const cabPrimaryQ = useQuery({
    queryKey: ["users.role.cab_member.primary"],
    queryFn: () => api.get<User[]>("/users?role=cab_member&primary=1"),
  });
  const ecabPrimaryQ = useQuery({
    queryKey: ["users.role.ecab_member.primary"],
    queryFn: () => api.get<User[]>("/users?role=ecab_member&primary=1"),
  });
  const changesQ = useQuery({
    queryKey: ["changes.cab-eligible"],
    queryFn: () => api.get<ChangeRequest[]>("/changes?status=awaiting_approval"),
  });

  const now = new Date();
  const startDefault = new Date(now.getTime() + 60 * 60 * 1000);
  const endDefault = new Date(startDefault.getTime() + 60 * 60 * 1000);

  const [title, setTitle] = useState("Weekly CAB");
  const [kind, setKind] = useState<"cab" | "ecab">("cab");
  const [scheduledStart, setScheduledStart] = useState(toLocalDateTimeInput(startDefault));
  const [scheduledEnd, setScheduledEnd] = useState(toLocalDateTimeInput(endDefault));
  const [location, setMeetingLocation] = useState("");
  const [agenda, setAgenda] = useState("");
  const [chairUserId, setChairUserId] = useState<string>("none");
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [changeIds, setChangeIds] = useState<number[]>([]);

  // Auto-select the appropriate primary role members when the meeting kind
  // changes (or when their data first arrives for the active kind). Manual
  // additions/removals made by the operator are NOT overwritten by background
  // refetches of either query — the ref tracks which kind we last applied
  // defaults for, so the effect only fires on a real kind switch or on the
  // initial arrival of the active kind's data.
  const cabDefaults = cabPrimaryQ.data;
  const ecabDefaults = ecabPrimaryQ.data;
  const lastAppliedKindRef = useRef<"cab" | "ecab" | null>(null);
  useEffect(() => {
    const defaults = kind === "ecab" ? ecabDefaults : cabDefaults;
    if (!defaults) return;
    if (lastAppliedKindRef.current === kind) return;
    lastAppliedKindRef.current = kind;
    setMemberIds(defaults.map((u) => u.id));
  }, [kind, cabDefaults, ecabDefaults]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>("/cab-meetings", {
        title,
        kind,
        scheduledStart: fromLocalDateTimeInput(scheduledStart),
        scheduledEnd: fromLocalDateTimeInput(scheduledEnd),
        location,
        agenda,
        chairUserId: chairUserId === "none" ? null : Number(chairUserId),
        memberIds,
        changeIds,
      }),
    onSuccess: (m) => {
      toast.success("Meeting created");
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
            <Input type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>End</Label>
            <Input type="datetime-local" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.target.value)} />
          </div>
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
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Members ({memberIds.length})</Label>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2 text-sm">
              {(usersQ.data ?? []).map((u) => (
                <label key={u.id} className="flex items-center gap-2 py-1">
                  <input type="checkbox" checked={memberIds.includes(u.id)} onChange={() => toggle(memberIds, setMemberIds, u.id)} />
                  {u.fullName}
                </label>
              ))}
            </div>
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
