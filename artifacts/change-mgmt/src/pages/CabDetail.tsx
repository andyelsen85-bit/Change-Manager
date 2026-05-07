import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, CheckCircle2, Loader2, Mail, Play, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Approval, CabMeetingDetail, ChangeRequest, User } from "@/lib/types";
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
  const usersQ = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });
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
    chairUserId: string;
    memberIds: number[];
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
        chairUserId: m.chairUserId == null ? "none" : String(m.chairUserId),
        memberIds: m.members.map((mb) => mb.userId),
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
        chairUserId: form!.chairUserId === "none" ? null : Number(form!.chairUserId),
        memberIds: form!.memberIds,
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

  const toggle = (key: "memberIds" | "changeIds", value: number) =>
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
            <Label>Chair</Label>
            <Select value={form.chairUserId} onValueChange={(v) => setForm({ ...form, chairUserId: v })}>
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
            <Label>Agenda</Label>
            <Textarea rows={4} value={form.agenda} onChange={(e) => setForm({ ...form, agenda: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Minutes</Label>
            <Textarea rows={6} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Members ({form.memberIds.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border p-2 text-sm">
              {(usersQ.data ?? []).map((u) => (
                <label key={u.id} className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={form.memberIds.includes(u.id)}
                    onChange={() => toggle("memberIds", u.id)}
                    data-testid={`checkbox-member-${u.id}`}
                  />
                  <span>{u.fullName}</span>
                  <span className="text-xs text-muted-foreground">{u.email}</span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
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

      {m.status === "in_progress" && form.changeIds.length > 0 && (
        <MeetingApprovalsPanel meetingId={id} changeIds={form.changeIds} />
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
function MeetingApprovalsPanel({ meetingId, changeIds }: { meetingId: number; changeIds: number[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Process docketed changes</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {changeIds.map((cid) => (
          <MeetingChangeRow key={cid} meetingId={meetingId} changeId={cid} />
        ))}
      </CardContent>
    </Card>
  );
}

function MeetingChangeRow({ meetingId, changeId }: { meetingId: number; changeId: number }) {
  const qc = useQueryClient();
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
  return (
    <div className="rounded-md border border-border p-3">
      <Link href={`/changes/${changeId}`} className="text-sm font-medium hover:underline">
        {cq.data?.ref ?? `Change #${changeId}`} — {cq.data?.title ?? ""}
      </Link>
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
              {a.decision === "pending" && (
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

