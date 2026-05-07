import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, Loader2, MessageSquare, Paperclip, Send, Trash2, Undo2, Upload, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  STATUS_LABELS,
  type Approval,
  type Attachment,
  type ChangeAssignee,
  type ChangeDetail as ChangeDetailT,
  type ChangeStatus,
  type ChangeTrack,
  type Comment,
  type PirRecord,
  type PlanningRecord,
  type TestRecord,
  type User,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { RiskBadge, StatusBadge, TrackBadge } from "@/components/StatusBadge";
import { fmtAgo, fmtDateTime, toLocalDateTimeInput, fromLocalDateTimeInput } from "@/lib/format";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

// Lifecycle steps shown on the visual progress timeline. Mirrors the
// allowed-status graph in api-server/src/lib/state-machine.ts but flattened
// into a linear "happy path" for the user. A step may be a single
// `ChangeStatus` or an array of equivalent alternative statuses occupying
// the same slot — used for the Standard track where `awaiting_implementation`
// and `scheduled` are interchangeable optional waiting states (a Standard
// change can transition `draft -> scheduled` directly OR
// `draft -> awaiting_implementation -> in_progress`, skipping the other).
// Terminal failure states (cancelled / rejected / rolled_back) are rendered
// separately as a red stop-tile after the in-progress steps.
type TimelineStep = ChangeStatus | ChangeStatus[];
const TIMELINE_BY_TRACK: Record<ChangeTrack, TimelineStep[]> = {
  normal: [
    "draft",
    "submitted",
    "in_review",
    "awaiting_approval",
    "approved",
    "in_preprod_testing",
    "scheduled",
    "in_progress",
    "implemented",
    "in_testing",
    "awaiting_pir",
    "completed",
  ],
  standard: [
    "draft",
    ["scheduled", "awaiting_implementation"],
    "in_progress",
    "implemented",
    "completed",
  ],
  emergency: [
    "draft",
    "awaiting_approval",
    "approved",
    "in_progress",
    "implemented",
    "awaiting_pir",
    "completed",
  ],
};

const TERMINAL_FAILURE: ChangeStatus[] = ["cancelled", "rejected", "rolled_back"];

function stepIncludes(step: TimelineStep, status: ChangeStatus): boolean {
  return Array.isArray(step) ? step.includes(status) : step === status;
}

// Resolve which status to display in a step's label. For a single-status
// step it's the status itself. For an alternative-group step we show the
// current status if the change is in one of them, otherwise the first
// (canonical) alternative — that way completed/pending tiles display a
// stable, generic label and the current tile reflects what actually happened.
function stepLabelStatus(step: TimelineStep, currentStatus: ChangeStatus): ChangeStatus {
  if (!Array.isArray(step)) return step;
  if (step.includes(currentStatus)) return currentStatus;
  return step[0];
}

// Reverse-transition map mirrored from api-server/src/lib/state-machine.ts.
// The backend is authoritative — this client copy is purely for populating
// the "Revert to" dropdown without an extra API call. If the server rejects
// the choice, the mutation surfaces the error toast.
const REVERSIONS_BY_TRACK: Record<ChangeTrack, Record<ChangeStatus, ChangeStatus[]>> = {
  normal: {
    draft: [],
    submitted: ["draft"],
    in_review: ["submitted", "draft"],
    awaiting_approval: ["in_review", "submitted", "draft"],
    approved: ["awaiting_approval", "in_review", "draft"],
    in_preprod_testing: ["approved"],
    scheduled: ["in_preprod_testing", "approved", "awaiting_approval"],
    in_progress: ["scheduled", "in_preprod_testing", "approved"],
    implemented: ["in_progress"],
    in_testing: ["implemented", "in_progress"],
    awaiting_pir: ["in_testing", "implemented"],
    completed: ["awaiting_pir"],
    cancelled: ["draft"],
    rejected: ["draft", "in_review"],
    rolled_back: [],
    awaiting_implementation: [],
  },
  standard: {
    draft: [],
    awaiting_implementation: ["draft"],
    scheduled: ["awaiting_implementation", "draft"],
    in_progress: ["scheduled", "awaiting_implementation"],
    implemented: ["in_progress"],
    completed: ["implemented"],
    cancelled: ["draft"],
    rolled_back: [],
    submitted: [], in_review: [], awaiting_approval: [], approved: [], rejected: [], in_testing: [], awaiting_pir: [], in_preprod_testing: [],
  },
  emergency: {
    draft: [],
    awaiting_approval: ["draft"],
    approved: ["awaiting_approval", "draft"],
    in_progress: ["approved"],
    implemented: ["in_progress"],
    awaiting_pir: ["implemented"],
    completed: ["awaiting_pir"],
    cancelled: ["draft"],
    rejected: ["draft", "awaiting_approval"],
    rolled_back: [],
    submitted: [], in_review: [], scheduled: [], awaiting_implementation: [], in_testing: [], in_preprod_testing: [],
  },
};

// Forward-transition map mirrored from api-server/src/lib/state-machine.ts.
// Track-aware because the lifecycles diverge after `implemented` — Standard
// goes straight to completed; Normal/Emergency route through awaiting_pir.
// A universal map silently hides the only forward button on the track that
// doesn't share the Normal path, so we keep one entry per track.
const TRANSITIONS_BY_TRACK: Record<ChangeTrack, Record<ChangeStatus, ChangeStatus[]>> = {
  normal: {
    draft: ["submitted", "cancelled"],
    submitted: ["in_review", "cancelled"],
    in_review: ["awaiting_approval", "rejected", "cancelled"],
    awaiting_approval: ["approved", "rejected", "cancelled"],
    approved: ["in_preprod_testing", "scheduled", "cancelled"],
    in_preprod_testing: ["scheduled", "cancelled"],
    scheduled: ["in_progress", "cancelled"],
    in_progress: ["implemented", "rolled_back"],
    implemented: ["in_testing", "awaiting_pir"],
    in_testing: ["awaiting_pir", "rolled_back"],
    awaiting_pir: ["completed"],
    completed: [], rejected: [], rolled_back: [], cancelled: [], awaiting_implementation: [],
  },
  standard: {
    draft: ["scheduled", "awaiting_implementation", "cancelled"],
    awaiting_implementation: ["scheduled", "in_progress", "cancelled"],
    scheduled: ["in_progress", "cancelled"],
    in_progress: ["implemented", "rolled_back"],
    implemented: ["completed", "rolled_back"],
    completed: [], cancelled: [], rolled_back: [],
    submitted: [], in_review: [], awaiting_approval: [], approved: [], rejected: [], in_testing: [], awaiting_pir: [], in_preprod_testing: [],
  },
  emergency: {
    draft: ["awaiting_approval", "cancelled"],
    awaiting_approval: ["approved", "rejected", "cancelled"],
    approved: ["in_progress", "cancelled"],
    in_progress: ["implemented", "rolled_back"],
    implemented: ["awaiting_pir", "rolled_back"],
    awaiting_pir: ["completed"],
    completed: [], rejected: [], cancelled: [], rolled_back: [],
    submitted: [], in_review: [], scheduled: [], awaiting_implementation: [], in_testing: [], in_preprod_testing: [],
  },
};

// Maps each lifecycle status to the role/person responsible for that step
// so the timeline can display the assigned user beneath each tile.
type StepRole = "owner" | "technical_reviewer" | "implementer" | "tester" | "approvers" | null;
const STATUS_ROLE: Record<ChangeStatus, StepRole> = {
  draft: "owner",
  submitted: "owner",
  in_review: "technical_reviewer",
  awaiting_approval: "approvers",
  approved: "approvers",
  in_preprod_testing: "tester",
  scheduled: "implementer",
  awaiting_implementation: "implementer",
  in_progress: "implementer",
  implemented: "implementer",
  in_testing: "tester",
  awaiting_pir: "owner",
  completed: "owner",
  cancelled: null,
  rejected: null,
  rolled_back: null,
};

function resolveStepAssignee(
  step: TimelineStep,
  current: ChangeStatus,
  ownerName: string | undefined,
  assigneeName: string | null | undefined,
  assignees: ChangeAssignee[],
): string | null {
  const labelStatus = stepLabelStatus(step, current);
  const role = STATUS_ROLE[labelStatus];
  if (!role) return null;
  if (role === "owner") return ownerName ?? null;
  if (role === "approvers") return "Approvers";
  const a = assignees.find((x) => x.roleKey === role);
  if (a) return a.userName;
  // Implementer step falls back to the change owner / assignee field
  if (role === "implementer") return assigneeName ?? "Unassigned";
  return "Unassigned";
}

function StatusTimeline({
  track,
  status,
  hasPreprodEnv,
  ownerName,
  assigneeName,
  assignees,
}: {
  track: ChangeTrack;
  status: ChangeStatus;
  hasPreprodEnv?: boolean;
  ownerName?: string;
  assigneeName?: string | null;
  assignees: ChangeAssignee[];
}) {
  let steps = TIMELINE_BY_TRACK[track] ?? TIMELINE_BY_TRACK.normal;
  // The pre-prod testing tile is conditional — only Normal-track changes
  // that opted into a pre-prod environment ever pass through it. Hide the
  // tile entirely otherwise so the timeline reads as a clean linear path.
  if (track === "normal" && !hasPreprodEnv && status !== "in_preprod_testing") {
    steps = steps.filter((s) => s !== "in_preprod_testing");
  }
  const isFailure = TERMINAL_FAILURE.includes(status);
  const isCompleted = status === "completed";
  const currentIndex = isFailure ? -1 : steps.findIndex((s) => stepIncludes(s, status));
  return (
    <ol className="flex flex-wrap items-center gap-y-2" data-testid="status-timeline">
      {steps.map((s, i) => {
        const done = !isFailure && i < currentIndex;
        const current = !isFailure && i === currentIndex;
        const pending = !done && !current;
        const labelStatus = stepLabelStatus(s, status);
        const assignedName = resolveStepAssignee(s, status, ownerName, assigneeName, assignees);
        return (
          <li key={Array.isArray(s) ? s.join("|") : s} className="flex flex-col items-center" data-testid={`timeline-step-${labelStatus}`}>
            <div className="flex items-center">
              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors",
                  done && "border-success/40 bg-success/10 text-success",
                  current && isCompleted && "border-success/50 bg-success/15 text-success font-semibold ring-1 ring-success/30",
                  current && !isCompleted && "border-info/50 bg-info/15 text-info font-semibold ring-1 ring-info/30",
                  pending && !isFailure && "border-border bg-muted/40 text-muted-foreground",
                  isFailure && "border-border bg-muted/30 text-muted-foreground opacity-70",
                )}
                data-state={done ? "done" : current ? "current" : "pending"}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold",
                    done || (current && isCompleted)
                      ? "bg-success text-success-foreground"
                      : current
                        ? "bg-info text-info-foreground"
                        : "bg-muted-foreground/25 text-foreground/70",
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span>{STATUS_LABELS[labelStatus]}</span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    "mx-1 h-0.5 w-3 sm:w-5",
                    done ? "bg-success" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              )}
            </div>
            {assignedName && (
              <span
                className="mt-1 max-w-[110px] truncate text-[10px] text-muted-foreground"
                title={assignedName}
                data-testid={`timeline-assignee-${labelStatus}`}
              >
                {assignedName}
              </span>
            )}
          </li>
        );
      })}
      {isFailure && (
        <li className="ml-2 flex items-center" data-testid={`timeline-terminal-${status}`}>
          <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive">
            <X className="h-3 w-3" /> {STATUS_LABELS[status]}
          </div>
        </li>
      )}
    </ol>
  );
}

export function ChangeDetailPage() {
  const [, params] = useRoute("/changes/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);
  const qc = useQueryClient();
  const { user } = useAuth();

  const changeQ = useQuery({
    queryKey: ["change", id],
    queryFn: () => api.get<ChangeDetailT>(`/changes/${id}`),
    enabled: Number.isFinite(id),
  });
  const assigneesQ = useQuery({
    queryKey: ["change.assignees", id],
    queryFn: () => api.get<ChangeAssignee[]>(`/changes/${id}/assignees`),
    enabled: Number.isFinite(id),
  });

  const transition = useMutation({
    mutationFn: (status: ChangeStatus) => api.post(`/changes/${id}/transition`, { toStatus: status }),
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["change", id] });
      qc.invalidateQueries({ queryKey: ["change.approvals", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Transition failed"),
  });

  // Revert (Change Manager / Admin only). Walks the change BACK to an
  // earlier status; the backend is the source of truth on what's allowed
  // and resets approvals + execution timestamps when crossing those gates.
  const canRevert = !!user && (user.isAdmin || (user.roles ?? []).includes("change_manager"));
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertTo, setRevertTo] = useState<ChangeStatus | "">("");
  const [revertReason, setRevertReason] = useState("");
  const revert = useMutation({
    mutationFn: (payload: { toStatus: ChangeStatus; reason: string }) =>
      api.post(`/changes/${id}/revert`, payload),
    onSuccess: () => {
      toast.success("Change reverted");
      setRevertOpen(false);
      setRevertTo("");
      setRevertReason("");
      qc.invalidateQueries({ queryKey: ["change", id] });
      qc.invalidateQueries({ queryKey: ["change.approvals", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Revert failed"),
  });

  const c = changeQ.data;
  if (!Number.isFinite(id)) return <div className="p-8">Invalid change id.</div>;

  return (
    <div className="space-y-4" data-testid="page-change-detail">
      <Button variant="ghost" size="sm" onClick={() => setLocation("/changes")} data-testid="button-back">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to changes
      </Button>

      {changeQ.isLoading || !c ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-muted-foreground">{c.ref}</span>
                  <TrackBadge track={c.track} />
                  <StatusBadge status={c.status} />
                  <RiskBadge risk={c.risk} />
                </div>
                <CardTitle className="text-xl">{c.title}</CardTitle>
                <p className="max-w-3xl text-sm text-muted-foreground">{c.description || "No description provided."}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="text-xs text-muted-foreground">Owner: {c.ownerName ?? "—"}</div>
                <div className="text-xs text-muted-foreground">Assignee: {c.assigneeName ?? "Unassigned"}</div>
                <div className="text-xs text-muted-foreground">Updated {fmtAgo(c.updatedAt)}</div>
              </div>
            </div>
            <div className="mt-5">
              <StatusTimeline
                track={c.track}
                status={c.status}
                hasPreprodEnv={c.hasPreprodEnv}
                ownerName={c.ownerName}
                assigneeName={c.assigneeName}
                assignees={assigneesQ.data ?? []}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(TRANSITIONS_BY_TRACK[c.track]?.[c.status] ?? []).map((next) => (
                <Button
                  key={next}
                  variant={next === "cancelled" || next === "rejected" || next === "rolled_back" ? "destructive" : next === "completed" || next === "approved" ? "default" : "secondary"}
                  size="sm"
                  onClick={() => transition.mutate(next)}
                  disabled={transition.isPending}
                  data-testid={`button-transition-${next}`}
                >
                  → {next.replace(/_/g, " ")}
                </Button>
              ))}
              {(TRANSITIONS_BY_TRACK[c.track]?.[c.status] ?? []).length === 0 && (
                <span className="text-xs text-muted-foreground">No further transitions available from this state.</span>
              )}
              {canRevert && REVERSIONS_BY_TRACK[c.track][c.status].length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const opts = REVERSIONS_BY_TRACK[c.track][c.status];
                    setRevertTo(opts[0] ?? "");
                    setRevertReason("");
                    setRevertOpen(true);
                  }}
                  data-testid="button-revert"
                  title="Walk this change back to an earlier status (Change Manager / Admin only)"
                >
                  <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Revert…
                </Button>
              )}
            </div>
          </CardHeader>
        </Card>
      )}

      {c && (
        <Dialog open={revertOpen} onOpenChange={setRevertOpen}>
          <DialogContent data-testid="dialog-revert">
            <DialogHeader>
              <DialogTitle>Revert change {c.ref}</DialogTitle>
              <DialogDescription>
                Walk the change back from <strong>{STATUS_LABELS[c.status]}</strong> to an earlier status.
                Reverting past <em>Awaiting approval</em> resets all approval votes to pending; reverting
                past <em>In progress</em> clears recorded start/end timestamps. The action is recorded in
                the audit log with your reason.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="revert-to">Revert to</Label>
                <Select value={revertTo} onValueChange={(v) => setRevertTo(v as ChangeStatus)}>
                  <SelectTrigger id="revert-to" data-testid="select-revert-to">
                    <SelectValue placeholder="Choose target status" />
                  </SelectTrigger>
                  <SelectContent>
                    {REVERSIONS_BY_TRACK[c.track][c.status].map((s) => (
                      <SelectItem key={s} value={s}>{STATUS_LABELS[s] ?? s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="revert-reason">Reason (required, min 5 chars)</Label>
                <Textarea
                  id="revert-reason"
                  rows={3}
                  value={revertReason}
                  onChange={(e) => setRevertReason(e.target.value)}
                  placeholder="e.g. Sent for approval prematurely — Change Manager hasn't reviewed yet."
                  data-testid="textarea-revert-reason"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRevertOpen(false)} data-testid="button-revert-cancel">
                Cancel
              </Button>
              <Button
                disabled={!revertTo || revertReason.trim().length < 5 || revert.isPending}
                onClick={() => revertTo && revert.mutate({ toStatus: revertTo, reason: revertReason.trim() })}
                data-testid="button-revert-confirm"
              >
                {revert.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Revert
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {c && (
        <Tabs defaultValue="planning" className="w-full">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="planning" data-testid="tab-planning">Planning</TabsTrigger>
            <TabsTrigger value="approvals" data-testid="tab-approvals">Approvals</TabsTrigger>
            <TabsTrigger value="assignees" data-testid="tab-assignees">Assignees</TabsTrigger>
            <TabsTrigger value="schedule" data-testid="tab-schedule">Schedule</TabsTrigger>
            {c.hasPreprodEnv && (
              <TabsTrigger value="preprod-testing" data-testid="tab-preprod-testing">PreProdTesting</TabsTrigger>
            )}
            <TabsTrigger value="testing" data-testid="tab-testing">Post Prod Testing</TabsTrigger>
            <TabsTrigger value="pir" data-testid="tab-pir">PIR</TabsTrigger>
            <TabsTrigger value="attachments" data-testid="tab-attachments">Attachments</TabsTrigger>
            <TabsTrigger value="comments" data-testid="tab-comments">Discussion</TabsTrigger>
          </TabsList>

          <TabsContent value="planning"><PlanningTab id={id} /></TabsContent>
          <TabsContent value="approvals"><ApprovalsTab id={id} currentUserId={user?.id ?? 0} /></TabsContent>
          <TabsContent value="assignees"><AssigneesTab id={id} /></TabsContent>
          <TabsContent value="schedule"><ScheduleTab change={c} /></TabsContent>
          {c.hasPreprodEnv && (
            <TabsContent value="preprod-testing"><TestingTab id={id} kind="preprod" /></TabsContent>
          )}
          <TabsContent value="testing"><TestingTab id={id} kind="production" /></TabsContent>
          <TabsContent value="pir"><PirTab id={id} /></TabsContent>
          <TabsContent value="attachments"><AttachmentsTab id={id} /></TabsContent>
          <TabsContent value="comments"><CommentsTab id={id} /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// Per-change assignment of the three single-owner roles. The dropdowns are
// fed from the global users list filtered to active accounts; choosing a
// user overrides the global role-pool fallback used elsewhere (approvals +
// notifications). Setting back to "Unassigned" deletes the override and
// re-enables the role-pool fallback for that role on this change.
const ASSIGNABLE_ROLE_LABELS: Record<"technical_reviewer" | "implementer" | "tester", string> = {
  technical_reviewer: "Technical reviewer",
  implementer: "Implementer",
  tester: "Tester",
};

function AssigneesTab({ id }: { id: number }) {
  const qc = useQueryClient();
  const aq = useQuery({ queryKey: ["change.assignees", id], queryFn: () => api.get<ChangeAssignee[]>(`/changes/${id}/assignees`) });
  const uq = useQuery({ queryKey: ["users.active"], queryFn: () => api.get<User[]>("/users") });
  const save = useMutation({
    mutationFn: (assignments: Record<string, number | null>) =>
      api.put<ChangeAssignee[]>(`/changes/${id}/assignees`, { assignments }),
    onSuccess: () => {
      toast.success("Assignees updated");
      qc.invalidateQueries({ queryKey: ["change.assignees", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  const current = (role: string): number | null => {
    const r = (aq.data ?? []).find((x) => x.roleKey === role);
    return r ? r.userId : null;
  };
  const activeUsers = (uq.data ?? []).filter((u) => u.isActive);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Per-change assignees</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Override the global role pool for this change. If left unassigned, members of the role are notified instead.
        </p>
        {(["technical_reviewer", "implementer", "tester"] as const).map((role) => (
          <div key={role} className="grid items-center gap-2 md:grid-cols-[200px_1fr]">
            <Label>{ASSIGNABLE_ROLE_LABELS[role]}</Label>
            <Select
              value={current(role) ? String(current(role)) : "__none__"}
              onValueChange={(v) => save.mutate({ [role]: v === "__none__" ? null : Number(v) })}
            >
              <SelectTrigger data-testid={`select-assignee-${role}`}>
                <SelectValue placeholder="Unassigned (use role pool)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Unassigned (use role pool)</SelectItem>
                {activeUsers.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.fullName} ({u.username})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PlanningTab({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change.planning", id], queryFn: () => api.get<PlanningRecord>(`/changes/${id}/planning`) });
  const [form, setForm] = useState<PlanningRecord | null>(null);
  if (q.data && !form) setForm(q.data);
  const save = useMutation({
    mutationFn: (signOff: boolean) => api.put<PlanningRecord>(`/changes/${id}/planning`, { ...form, signedOff: signOff }),
    onSuccess: (row) => {
      toast.success("Planning saved");
      setForm(row);
      qc.invalidateQueries({ queryKey: ["change.planning", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  if (!form) return <Skeleton className="mt-4 h-72 w-full" />;
  const F = ({ k, label, rows = 3 }: { k: keyof PlanningRecord; label: string; rows?: number }) => (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Textarea
        rows={rows}
        value={(form[k] as string) ?? ""}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        data-testid={`textarea-${String(k)}`}
      />
    </div>
  );
  return (
    <Card className="mt-4">
      <CardContent className="space-y-4 p-6">
        <F k="scope" label="Scope" />
        <F k="implementationPlan" label="Implementation plan" rows={5} />
        <F k="rollbackPlan" label="Rollback plan" rows={4} />
        <F k="riskAssessment" label="Risk assessment" rows={3} />
        <F k="impactedServices" label="Impacted services" rows={2} />
        <F k="communicationsPlan" label="Communications plan" rows={2} />
        <F k="successCriteria" label="Success criteria" rows={2} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-xs text-muted-foreground">
            {form.signedOff && form.signedOffBy ? (
              <>Signed off by {form.signedOffBy} {fmtAgo(form.signedOffAt)}</>
            ) : (
              "Not yet signed off"
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => save.mutate(form.signedOff)} disabled={save.isPending} data-testid="button-save-planning">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save draft
            </Button>
            <Button onClick={() => save.mutate(true)} disabled={save.isPending} data-testid="button-signoff-planning">
              Sign off planning
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ApprovalsTab({ id, currentUserId }: { id: number; currentUserId: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change.approvals", id], queryFn: () => api.get<Approval[]>(`/changes/${id}/approvals`) });
  const vote = useMutation({
    mutationFn: ({ approvalId, decision, comment }: { approvalId: number; decision: string; comment: string }) =>
      api.post(`/approvals/${approvalId}/vote`, { decision, comment }),
    onSuccess: () => {
      toast.success("Vote recorded");
      qc.invalidateQueries({ queryKey: ["change.approvals", id] });
      qc.invalidateQueries({ queryKey: ["change", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Vote failed"),
  });
  return (
    <Card className="mt-4">
      <CardHeader><CardTitle className="text-base">Required approvals</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (q.data ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No approvals required for this change.</p>
        ) : (
          q.data!.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              canVote={currentUserId > 0}
              onVote={(decision, comment) => vote.mutate({ approvalId: a.id, decision, comment })}
              busy={vote.isPending}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalCard({ approval, canVote, onVote, busy }: { approval: Approval; canVote: boolean; onVote: (d: string, c: string) => void; busy: boolean }) {
  const [comment, setComment] = useState("");
  return (
    <div className="rounded-lg border border-border p-4" data-testid={`approval-${approval.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{approval.roleName}</div>
          {approval.approverName && (
            <div className="text-xs text-muted-foreground">
              {approval.decision === "pending" ? "Pending" : "Decided by"} {approval.approverName}
              {approval.viaDeputy && " (deputy)"} · {approval.decidedAt ? fmtAgo(approval.decidedAt) : ""}
            </div>
          )}
        </div>
        <span
          className={`rounded-md border px-2 py-0.5 text-xs ${
            approval.decision === "approved"
              ? "border-success/30 bg-success/10 text-success"
              : approval.decision === "rejected"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : approval.decision === "abstain"
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-warning/30 bg-warning/10 text-warning"
          }`}
        >
          {approval.decision}
        </span>
      </div>
      {approval.comment && <p className="mt-2 text-sm text-muted-foreground">"{approval.comment}"</p>}
      {approval.decision === "pending" && canVote && (
        <div className="mt-3 space-y-2">
          <Textarea
            placeholder="Optional comment"
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid={`textarea-vote-${approval.id}`}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onVote("approved", comment)} disabled={busy} data-testid={`button-approve-${approval.id}`}>Approve</Button>
            <Button size="sm" variant="destructive" onClick={() => onVote("rejected", comment)} disabled={busy} data-testid={`button-reject-${approval.id}`}>Reject</Button>
            <Button size="sm" variant="outline" onClick={() => onVote("abstain", comment)} disabled={busy} data-testid={`button-abstain-${approval.id}`}>Abstain</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduleTab({ change }: { change: ChangeDetailT }) {
  const qc = useQueryClient();
  const [plannedStart, setPlannedStart] = useState(toLocalDateTimeInput(change.plannedStart));
  const [plannedEnd, setPlannedEnd] = useState(toLocalDateTimeInput(change.plannedEnd));
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/changes/${change.id}`, {
        plannedStart: fromLocalDateTimeInput(plannedStart),
        plannedEnd: fromLocalDateTimeInput(plannedEnd),
      }),
    onSuccess: () => {
      toast.success("Schedule updated");
      qc.invalidateQueries({ queryKey: ["change", change.id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Update failed"),
  });
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Schedule & timing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Planned start</Label>
            <DateTimePicker value={plannedStart} onChange={setPlannedStart} data-testid="input-schedule-start" />
          </div>
          <div className="space-y-2">
            <Label>Planned end</Label>
            <DateTimePicker value={plannedEnd} onChange={setPlannedEnd} data-testid="input-schedule-end" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 text-sm">
          <div>
            <div className="text-muted-foreground">Actual start</div>
            <div>{fmtDateTime(change.actualStart)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Actual end</div>
            <div>{fmtDateTime(change.actualEnd)}</div>
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
          {change.cabMeetingId ? (
            <Link href={`/cab/${change.cabMeetingId}`} className="text-primary hover:underline">
              Linked to CAB meeting #{change.cabMeetingId} →
            </Link>
          ) : change.track === "standard" ? (
            "Standard change — bypasses CAB."
          ) : (
            <Link href="/cab" className="text-primary hover:underline">
              Not yet on a CAB agenda. Schedule from the CAB calendar →
            </Link>
          )}
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-schedule">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TestingTab({ id, kind = "production" }: { id: number; kind?: "production" | "preprod" }) {
  const qc = useQueryClient();
  // Same backing component drives both the production Testing tab and the
  // optional pre-prod Testing tab. The `kind` prop selects the API path and
  // the cache key so the two records stay isolated.
  const path = kind === "preprod" ? `/changes/${id}/preprod-testing` : `/changes/${id}/testing`;
  const cacheKey = kind === "preprod" ? "change.preprod-testing" : "change.testing";
  const label = kind === "preprod" ? "Pre-prod testing" : "Testing";
  const q = useQuery({ queryKey: [cacheKey, id], queryFn: () => api.get<TestRecord>(path) });
  const [form, setForm] = useState<TestRecord | null>(null);
  if (q.data && !form) setForm(q.data);
  const save = useMutation({
    mutationFn: (overall: TestRecord["overallResult"]) =>
      api.put<TestRecord>(path, { ...form, overallResult: overall }),
    onSuccess: (row) => {
      toast.success(`${label} saved`);
      setForm(row);
      qc.invalidateQueries({ queryKey: [cacheKey, id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  if (!form) return <Skeleton className="mt-4 h-72 w-full" />;
  return (
    <Card className="mt-4">
      <CardContent className="space-y-4 p-6">
        <div className="space-y-2">
          <Label>Test plan</Label>
          <Textarea rows={4} value={form.testPlan} onChange={(e) => setForm({ ...form, testPlan: e.target.value })} data-testid="textarea-test-plan" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Overall result</Label>
            <Select value={form.overallResult} onValueChange={(v) => setForm({ ...form, overallResult: v as TestRecord["overallResult"] })}>
              <SelectTrigger data-testid="select-overall"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="passed">Passed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Test cases</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  cases: [...form.cases, { name: "", steps: "", expectedResult: "", actualResult: "", status: "pending" }],
                })
              }
              data-testid="button-add-case"
            >
              + Add case
            </Button>
          </div>
          <div className="space-y-3">
            {form.cases.map((tc, i) => (
              <div key={i} className="rounded-md border border-border p-3 space-y-2" data-testid={`testcase-${i}`}>
                <div className="grid gap-2 md:grid-cols-2">
                  <Input placeholder="Case name" value={tc.name} onChange={(e) => updateCase(form, setForm, i, { name: e.target.value })} />
                  <Select value={tc.status} onValueChange={(v) => updateCase(form, setForm, i, { status: v as typeof tc.status })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="passed">Passed</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                      <SelectItem value="blocked">Blocked</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea placeholder="Steps" rows={2} value={tc.steps} onChange={(e) => updateCase(form, setForm, i, { steps: e.target.value })} />
                <div className="grid gap-2 md:grid-cols-2">
                  <Textarea placeholder="Expected result" rows={2} value={tc.expectedResult} onChange={(e) => updateCase(form, setForm, i, { expectedResult: e.target.value })} />
                  <Textarea placeholder="Actual result" rows={2} value={tc.actualResult} onChange={(e) => updateCase(form, setForm, i, { actualResult: e.target.value })} />
                </div>
                <div className="text-right">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, cases: form.cases.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            {form.cases.length === 0 && <p className="text-sm text-muted-foreground">No test cases yet. Add one above.</p>}
          </div>
        </div>
        <div className="space-y-2">
          <Label>Notes</Label>
          <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} data-testid="textarea-test-notes" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-xs text-muted-foreground">
            {form.testedBy ? `Signed off by ${form.testedBy} ${fmtAgo(form.testedAt)}` : "Not yet signed off"}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => save.mutate(form.overallResult)} disabled={save.isPending} data-testid="button-save-testing">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save draft
            </Button>
            <Button onClick={() => save.mutate("passed")} disabled={save.isPending} data-testid="button-signoff-pass">Sign off PASS</Button>
            <Button variant="destructive" onClick={() => save.mutate("failed")} disabled={save.isPending} data-testid="button-signoff-fail">Sign off FAIL</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function updateCase(form: TestRecord, setForm: (f: TestRecord) => void, i: number, patch: Partial<TestRecord["cases"][number]>) {
  const next = form.cases.slice();
  next[i] = { ...next[i], ...patch };
  setForm({ ...form, cases: next });
}

function PirTab({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change.pir", id], queryFn: () => api.get<PirRecord>(`/changes/${id}/pir`) });
  const [form, setForm] = useState<PirRecord | null>(null);
  if (q.data && !form) setForm(q.data);
  const save = useMutation({
    mutationFn: (completed: boolean) => api.put<PirRecord>(`/changes/${id}/pir`, { ...form, completed }),
    onSuccess: (row) => {
      toast.success("PIR saved");
      setForm(row);
      qc.invalidateQueries({ queryKey: ["change.pir", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  if (!form) return <Skeleton className="mt-4 h-72 w-full" />;
  return (
    <Card className="mt-4">
      <CardContent className="space-y-4 p-6">
        <div className="space-y-2">
          <Label>Outcome</Label>
          <Select value={form.outcome} onValueChange={(v) => setForm({ ...form, outcome: v as PirRecord["outcome"] })}>
            <SelectTrigger data-testid="select-outcome"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="successful">Successful</SelectItem>
              <SelectItem value="successful_with_issues">Successful with issues</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="rolled_back">Rolled back</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Objectives met</Label>
          <Textarea rows={3} value={form.objectivesMet} onChange={(e) => setForm({ ...form, objectivesMet: e.target.value })} data-testid="textarea-objectives" />
        </div>
        <div className="space-y-2">
          <Label>Issues encountered</Label>
          <Textarea rows={3} value={form.issuesEncountered} onChange={(e) => setForm({ ...form, issuesEncountered: e.target.value })} data-testid="textarea-issues" />
        </div>
        <div className="space-y-2">
          <Label>Lessons learned</Label>
          <Textarea rows={3} value={form.lessonsLearned} onChange={(e) => setForm({ ...form, lessonsLearned: e.target.value })} data-testid="textarea-lessons" />
        </div>
        <div className="space-y-2">
          <Label>Follow-up actions</Label>
          <Textarea rows={3} value={form.followupActions} onChange={(e) => setForm({ ...form, followupActions: e.target.value })} data-testid="textarea-followup" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-xs text-muted-foreground">
            {form.completedBy ? `Completed by ${form.completedBy} ${fmtAgo(form.completedAt)}` : "Not yet completed"}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending} data-testid="button-save-pir">Save draft</Button>
            <Button onClick={() => save.mutate(true)} disabled={save.isPending} data-testid="button-complete-pir">Complete PIR</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CommentsTab({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change.comments", id], queryFn: () => api.get<Comment[]>(`/changes/${id}/comments`) });
  const [body, setBody] = useState("");
  const post = useMutation({
    mutationFn: () => api.post<Comment>(`/changes/${id}/comments`, { body }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["change.comments", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to post comment"),
  });
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> Discussion
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            placeholder="Add a comment…"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            data-testid="textarea-new-comment"
          />
          <div className="flex justify-end">
            <Button onClick={() => post.mutate()} disabled={post.isPending || !body.trim()} data-testid="button-post-comment">
              {post.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Post comment
            </Button>
          </div>
        </div>
        <div className="space-y-3">
          {(q.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            q.data!.map((c) => (
              <div key={c.id} className="rounded-md border border-border p-3" data-testid={`comment-${c.id}`}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{c.authorName}</div>
                  <div className="text-xs text-muted-foreground">{fmtAgo(c.createdAt)}</div>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm">{c.body}</div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function AttachmentsTab({ id }: { id: number }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const aq = useQuery({
    queryKey: ["change.attachments", id],
    queryFn: () => api.get<Attachment[]>(`/changes/${id}/attachments`),
  });
  const del = useMutation({
    mutationFn: (attId: number) => api.delete(`/attachments/${attId}`),
    onSuccess: () => {
      toast.success("Attachment deleted");
      qc.invalidateQueries({ queryKey: ["change.attachments", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast.error("File too large (max 20 MB)");
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.post(`/changes/${id}/attachments`, {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64,
      });
      toast.success(`Uploaded ${file.name}`);
      qc.invalidateQueries({ queryKey: ["change.attachments", id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onDownload = (att: Attachment) => {
    api.download(`/attachments/${att.id}/download`, att.filename).catch((err) => {
      toast.error(err instanceof Error ? err.message : "Download failed");
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Paperclip className="h-4 w-4" /> Attachments
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Upload technical documentation, diagrams, runbooks, screenshots, or any supporting files
          for this change. Max 20 MB per file.
        </p>
        <div>
          <label className="inline-flex">
            <input
              type="file"
              className="hidden"
              onChange={onPick}
              disabled={busy}
              data-testid="input-attachment-file"
            />
            <Button asChild disabled={busy} data-testid="button-upload-attachment">
              <span className="cursor-pointer">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                Upload file
              </span>
            </Button>
          </label>
        </div>

        {aq.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (aq.data ?? []).length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No attachments yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {(aq.data ?? []).map((att) => {
              const canDelete =
                !!user && (user.isAdmin || user.id === att.uploadedById);
              return (
                <li
                  key={att.id}
                  className="flex items-center justify-between gap-3 p-3"
                  data-testid={`row-attachment-${att.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{att.filename}</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtBytes(att.size)} · {att.mimeType} · uploaded by {att.uploadedByName ?? "Unknown"} {fmtAgo(att.uploadedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDownload(att)}
                      data-testid={`button-download-${att.id}`}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => del.mutate(att.id)}
                        disabled={del.isPending}
                        data-testid={`button-delete-attachment-${att.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
