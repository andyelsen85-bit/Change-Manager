import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, CalendarDays, CheckCircle2, FileDown, Loader2, Mail, Play, Trash2, UserPlus, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Approval, CabAttendee, CabMeeting, CabMeetingDetail, ChangeRequest, LdapSearchUser, User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDateTime, fromLocalDateTimeInput, toLocalDateTimeInput } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function CabDetailPage() {
  const [, params] = useRoute("/cab/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);
  const qc = useQueryClient();

  const meetingQ = useQuery({
    queryKey: ["cab", id],
    queryFn: () => api.get<CabMeetingDetail>(`/cab-meetings/${id}`),
    enabled: Number.isFinite(id),
  });
  // Only changes that are in `awaiting_approval` are eligible for docketing —
  // they're the ones waiting on a CAB review. Already-docketed changes on
  // this meeting are merged in below so they remain visible even if their
  // status has since moved on.
  const changesQ = useQuery({
    queryKey: ["changes", "awaiting_approval"],
    queryFn: () => api.get<ChangeRequest[]>("/changes?status=awaiting_approval"),
  });

  const [form, setForm] = useState<{
    title: string;
    location: string;
    agenda: string;
    minutes: string;
    status: string;
    scheduledStart: string;
    scheduledEnd: string;
    changeIds: number[];
  } | null>(null);

  useEffect(() => {
    if (meetingQ.data && !form) {
      const m = meetingQ.data;
      setForm({
        title: m.title,
        location: m.location,
        agenda: m.agenda,
        minutes: m.minutes,
        status: m.status,
        scheduledStart: toLocalDateTimeInput(m.scheduledStart),
        scheduledEnd: toLocalDateTimeInput(m.scheduledEnd),
        changeIds: m.changes.map((c) => c.id),
      });
    }
  }, [meetingQ.data, form]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<CabMeetingDetail>(`/cab-meetings/${id}`, {
        title: form!.title,
        location: form!.location,
        agenda: form!.agenda,
        minutes: form!.minutes,
        status: form!.status,
        scheduledStart: fromLocalDateTimeInput(form!.scheduledStart),
        scheduledEnd: fromLocalDateTimeInput(form!.scheduledEnd),
        changeIds: form!.changeIds,
      }),
    onSuccess: () => {
      toast.success("Meeting updated");
      qc.invalidateQueries({ queryKey: ["cab", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const sendAgenda = useMutation({
    mutationFn: () => api.post<{ sent: number; skipped: number; errors: number }>(`/cab-meetings/${id}/send-agenda`),
    onSuccess: (r) => toast.success(`Agenda: ${r.sent} sent, ${r.skipped} skipped, ${r.errors} errors`),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to send agenda"),
  });

  const startMeeting = useMutation({
    mutationFn: () => api.post<CabMeetingDetail>(`/cab-meetings/${id}/start`),
    onSuccess: () => {
      toast.success("Meeting started — approvals are now open");
      qc.invalidateQueries({ queryKey: ["cab", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not start meeting"),
  });

  const completeMeeting = useMutation({
    mutationFn: () => api.post<CabMeetingDetail>(`/cab-meetings/${id}/complete`),
    onSuccess: () => {
      toast.success("Meeting completed");
      qc.invalidateQueries({ queryKey: ["cab", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not complete meeting"),
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/cab-meetings/${id}`),
    onSuccess: () => {
      toast.success("Meeting deleted");
      setLocation("/cab");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  if (!Number.isFinite(id)) return <div className="p-8">Invalid meeting id.</div>;
  if (meetingQ.isLoading || !form || !meetingQ.data) return <Skeleton className="h-72 w-full" />;
  const m = meetingQ.data;

  const toggle = (key: "changeIds", value: number) =>
    setForm({ ...form, [key]: form[key].includes(value) ? form[key].filter((x) => x !== value) : [...form[key], value] });

  return (
    <div className="space-y-4" data-testid="page-cab-detail">
      <Button variant="ghost" size="sm" onClick={() => setLocation("/cab")}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to calendar
      </Button>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-xl">{m.title}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {m.kind === "ecab" ? "Emergency CAB" : "Change Advisory Board"} · {fmtDateTime(m.scheduledStart)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => api.download(`/cab-meetings/${id}/ics`, `cab-${id}.ics`)} data-testid="button-download-ics">
              <CalendarDays className="mr-2 h-4 w-4" /> Download .ics
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => api.download(`/cab-meetings/${id}/agenda-pdf`, `cab-agenda-${id}.pdf`)}
              data-testid="button-download-agenda-pdf"
            >
              <FileDown className="mr-2 h-4 w-4" /> Agenda PDF
            </Button>
            {(m.status === "in_progress" || m.status === "completed") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => api.download(`/cab-meetings/${id}/results-pdf`, `cab-results-${id}.pdf`)}
                data-testid="button-download-results-pdf"
              >
                <FileDown className="mr-2 h-4 w-4" /> Results PDF
              </Button>
            )}
            <Button onClick={() => sendAgenda.mutate()} disabled={sendAgenda.isPending} data-testid="button-send-agenda">
              {sendAgenda.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
              Send agenda
            </Button>
            {m.status === "scheduled" && (
              <Button
                variant="default"
                onClick={() => startMeeting.mutate()}
                disabled={startMeeting.isPending}
                data-testid="button-start-meeting"
              >
                {startMeeting.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Process meeting
              </Button>
            )}
            {m.status === "in_progress" && (
              <Button
                variant="default"
                onClick={() => completeMeeting.mutate()}
                disabled={completeMeeting.isPending}
                data-testid="button-complete-meeting"
              >
                {completeMeeting.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Complete meeting
              </Button>
            )}
            <Button
              variant="destructive"
              size="icon"
              onClick={() => {
                if (confirm("Delete this meeting?")) del.mutate();
              }}
              data-testid="button-delete-cab"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Meeting details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="in_progress">In progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Start</Label>
              <DateTimePicker value={form.scheduledStart} onChange={(v) => setForm({ ...form, scheduledStart: v })} />
            </div>
            <div className="space-y-2">
              <Label>End</Label>
              <DateTimePicker value={form.scheduledEnd} onChange={(v) => setForm({ ...form, scheduledEnd: v })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Location</Label>
            <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Agenda</Label>
            <Textarea rows={4} value={form.agenda} onChange={(e) => setForm({ ...form, agenda: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea rows={6} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Changes on agenda ({form.changeIds.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border p-2 text-sm">
              {(() => {
                // Merge eligible (awaiting_approval) changes with any
                // already-docketed changes on this meeting so existing
                // selections remain visible even after they leave the
                // awaiting_approval state.
                const eligible = changesQ.data ?? [];
                const docketed = m.changes ?? [];
                const seen = new Set<number>();
                const merged: ChangeRequest[] = [];
                for (const c of [...eligible, ...docketed]) {
                  if (seen.has(c.id)) continue;
                  seen.add(c.id);
                  merged.push(c as ChangeRequest);
                }
                return merged;
              })().map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={form.changeIds.includes(c.id)}
                    onChange={() => toggle("changeIds", c.id)}
                    data-testid={`checkbox-change-${c.id}`}
                  />
                  <Link href={`/changes/${c.id}`} className="font-mono text-xs hover:underline">{c.ref}</Link>
                  <span className="truncate">{c.title}</span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <AttendancePanel meetingId={id} />

      {m.status === "in_progress" && form.changeIds.length > 0 && (
        <MeetingApprovalsPanel meetingId={id} changeIds={form.changeIds} meeting={m} />
      )}

      {form.changeIds.length === 0 && (
        <Alert>
          <AlertDescription>
            No changes are linked to this meeting yet. Add changes from above to populate the agenda.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-cab-changes">
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}

// Per-change approval panel rendered while the meeting is in progress.
// Lets CAB members vote on each docketed change without leaving the meeting
// page. Reuses the existing /approvals/:id/vote endpoint so audit + email
// flows stay identical to the change-detail page.
function MeetingApprovalsPanel({ meetingId, changeIds, meeting }: { meetingId: number; changeIds: number[]; meeting: CabMeetingDetail }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Process docketed changes</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {changeIds.map((cid) => (
          <MeetingChangeRow
            key={cid}
            meetingId={meetingId}
            changeId={cid}
            docket={meeting.changes.find((c) => c.id === cid)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function MeetingChangeRow({
  meetingId,
  changeId,
  docket,
}: {
  meetingId: number;
  changeId: number;
  docket?: CabMeetingDetail["changes"][number];
}) {
  const qc = useQueryClient();
  const [postponeOpen, setPostponeOpen] = useState(false);
  const q = useQuery({
    queryKey: ["change.approvals", changeId],
    queryFn: () => api.get<Approval[]>(`/changes/${changeId}/approvals`),
  });
  const cq = useQuery({
    queryKey: ["change", changeId],
    queryFn: () => api.get<ChangeRequest>(`/changes/${changeId}`),
  });
  const vote = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: number; decision: "approved" | "rejected" }) =>
      api.post(`/approvals/${approvalId}/vote`, { decision, comment: `Voted in CAB meeting #${meetingId}` }),
    onSuccess: (_d, v) => {
      toast.success(v.decision === "approved" ? "Approved" : "Declined");
      qc.invalidateQueries({ queryKey: ["change.approvals", changeId] });
      qc.invalidateQueries({ queryKey: ["change", changeId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Vote failed"),
  });
  const postponed = docket?.outcome === "postponed";
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/changes/${changeId}`} className="text-sm font-medium hover:underline">
          {cq.data?.ref ?? `Change #${changeId}`} — {cq.data?.title ?? ""}
        </Link>
        {postponed ? (
          <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs text-warning" data-testid={`badge-postponed-${changeId}`}>
            Postponed
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setPostponeOpen(true)} data-testid={`button-postpone-${changeId}`}>
            <CalendarClock className="mr-1 h-3 w-3" /> Postpone
          </Button>
        )}
      </div>
      {postponed && docket?.outcomeNote && (
        <p className="mt-1 text-xs text-muted-foreground">Note: {docket.outcomeNote}</p>
      )}
      <PostponeDialog
        open={postponeOpen}
        onOpenChange={setPostponeOpen}
        meetingId={meetingId}
        changeId={changeId}
        changeRef={cq.data?.ref ?? `#${changeId}`}
      />
      <div className="mt-2 space-y-2">
        {(q.data ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">No approvals required.</p>
        )}
        {(q.data ?? []).map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 p-2 text-xs">
            <div className="font-mono">{a.roleKey}</div>
            <div className="flex items-center gap-2">
              <span className={a.decision === "approved" ? "text-success" : a.decision === "rejected" ? "text-destructive" : "text-muted-foreground"}>
                {a.decision}
              </span>
              {a.decision === "pending" && !postponed && (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => vote.mutate({ approvalId: a.id, decision: "approved" })}
                    disabled={vote.isPending}
                    data-testid={`button-meeting-approve-${a.id}`}
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => vote.mutate({ approvalId: a.id, decision: "rejected" })}
                    disabled={vote.isPending}
                    data-testid={`button-meeting-decline-${a.id}`}
                  >
                    <XCircle className="mr-1 h-3 w-3" /> Decline
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// Dialog to move a docketed change to another CAB meeting. The current entry
// is kept and marked "postponed" (it stays in this meeting's results PDF);
// the change is docketed on the selected target meeting.
function PostponeDialog({
  open,
  onOpenChange,
  meetingId,
  changeId,
  changeRef,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  meetingId: number;
  changeId: number;
  changeRef: string;
}) {
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");
  const meetingsQ = useQuery({
    queryKey: ["cab-meetings", "upcoming"],
    queryFn: () => api.get<CabMeeting[]>("/cab-meetings"),
    enabled: open,
  });
  const options: ComboboxOption[] = useMemo(
    () =>
      (meetingsQ.data ?? [])
        .filter((mm) => mm.id !== meetingId && (mm.status === "scheduled" || mm.status === "in_progress"))
        .map((mm) => ({
          value: String(mm.id),
          label: `${mm.title} — ${fmtDateTime(mm.scheduledStart)}`,
          hint: mm.kind === "ecab" ? "eCAB" : "CAB",
        })),
    [meetingsQ.data, meetingId],
  );
  const postpone = useMutation({
    mutationFn: () =>
      api.post(`/cab-meetings/${meetingId}/changes/${changeId}/postpone`, {
        targetMeetingId: Number(targetId),
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(`${changeRef} postponed`);
      onOpenChange(false);
      setTargetId("");
      setNote("");
      qc.invalidateQueries({ queryKey: ["cab", meetingId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Postpone failed"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Postpone {changeRef}</DialogTitle>
          <DialogDescription>
            Move this change to another CAB meeting. It stays on this meeting's results as “postponed”.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Target meeting</Label>
            <Combobox
              options={options}
              value={targetId}
              onChange={setTargetId}
              placeholder="Select a meeting…"
              searchPlaceholder="Search meetings…"
              emptyText="No upcoming meetings."
              data-testid="select-postpone-target"
            />
          </div>
          <div className="space-y-2">
            <Label>Note (optional)</Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="textarea-postpone-note" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => postpone.mutate()}
            disabled={!targetId || postpone.isPending}
            data-testid="button-confirm-postpone"
          >
            {postpone.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Postpone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Attendance list: users holding CAB roles plus ad-hoc people added via the
// Active Directory search (same directory lookup as the internal requester).
// Every toggle/add/remove saves immediately.
function AttendancePanel({ meetingId }: { meetingId: number }) {
  const qc = useQueryClient();
  const attQ = useQuery({
    queryKey: ["cab.attendance", meetingId],
    queryFn: () => api.get<{ attendees: CabAttendee[] }>(`/cab-meetings/${meetingId}/attendance`),
  });
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(h);
  }, [query]);
  const searchQ = useQuery({
    queryKey: ["ldap-search", debounced],
    queryFn: () => api.get<{ users: LdapSearchUser[]; note?: string }>(`/users/ldap-search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });
  const ldapOptions: ComboboxOption[] = useMemo(
    () =>
      (searchQ.data?.users ?? []).map((u) => ({
        value: JSON.stringify({ name: u.fullName || u.username, email: u.email || "" }),
        label: u.fullName || u.username,
        hint: [u.username, u.email].filter(Boolean).join(" · "),
      })),
    [searchQ.data],
  );

  const save = useMutation({
    mutationFn: (attendees: CabAttendee[]) =>
      api.put(`/cab-meetings/${meetingId}/attendance`, {
        attendees: attendees.map((a) => ({ userId: a.userId, name: a.name, email: a.email, present: a.present })),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cab.attendance", meetingId] }),
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not save attendance");
      qc.invalidateQueries({ queryKey: ["cab.attendance", meetingId] });
    },
  });

  const attendees = attQ.data?.attendees ?? [];
  const keyOf = (a: CabAttendee) => (a.userId != null ? `u${a.userId}` : `e${a.email.toLowerCase()}|${a.name.toLowerCase()}`);

  const togglePresent = (a: CabAttendee) =>
    save.mutate(attendees.map((x) => (keyOf(x) === keyOf(a) ? { ...x, present: !x.present } : x)));
  const remove = (a: CabAttendee) => save.mutate(attendees.filter((x) => keyOf(x) !== keyOf(a)));
  const addFromLdap = (value: string) => {
    if (!value) return;
    try {
      const { name, email } = JSON.parse(value) as { name: string; email: string };
      const candidate: CabAttendee = { userId: null, name, email, present: true, adHoc: true };
      if (attendees.some((x) => x.name === name || (email && x.email.toLowerCase() === email.toLowerCase()))) {
        toast.info(`${name} is already on the list`);
        return;
      }
      save.mutate([...attendees, candidate]);
      setQuery("");
    } catch {
      /* ignore malformed option */
    }
  };

  return (
    <Card data-testid="card-attendance">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          Attendance{attendees.length > 0 ? ` (${attendees.filter((a) => a.present).length}/${attendees.length} present)` : ""}
        </CardTitle>
        <div className="w-72">
          <Combobox
            options={ldapOptions}
            value=""
            onChange={addFromLdap}
            placeholder="Add person…"
            searchPlaceholder="Search the directory (min 2 chars)…"
            emptyText={debounced.trim().length < 2 ? "Type at least 2 characters." : searchQ.data?.note || "No directory matches."}
            onSearchChange={setQuery}
            loading={searchQ.isFetching}
            data-testid="select-add-attendee"
          />
        </div>
      </CardHeader>
      <CardContent>
        {attQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : attendees.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No CAB members found — assign the CAB member role in Settings or add people via the directory search.
          </p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-2">
            {attendees.map((a) => (
              <div key={keyOf(a)} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm" data-testid={`attendee-${keyOf(a)}`}>
                <Checkbox
                  checked={a.present}
                  onCheckedChange={() => togglePresent(a)}
                  disabled={save.isPending}
                  data-testid={`checkbox-present-${keyOf(a)}`}
                />
                <span className="min-w-0 flex-1 truncate">
                  {a.name}
                  {a.email && <span className="ml-1 text-xs text-muted-foreground">· {a.email}</span>}
                </span>
                {a.adHoc && (
                  <>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">guest</span>
                    <button onClick={() => remove(a)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${a.name}`} data-testid={`button-remove-attendee-${keyOf(a)}`}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Tick who is present. The list is included in the results PDF and guests also receive the results email.
        </p>
      </CardContent>
    </Card>
  );
}
