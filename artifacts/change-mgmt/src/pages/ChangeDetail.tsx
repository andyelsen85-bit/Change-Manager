import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Loader2, MessageSquare, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  STATUS_LABELS,
  type Approval,
  type ChangeDetail as ChangeDetailT,
  type ChangeStatus,
  type ChangeTrack,
  type Comment,
  type PirRecord,
  type PlanningRecord,
  type TestRecord,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { RiskBadge, StatusBadge, TrackBadge } from "@/components/StatusBadge";
import { fmtAgo, fmtDateTime, toLocalDateTimeInput, fromLocalDateTimeInput } from "@/lib/format";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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

const TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["in_review", "cancelled"],
  in_review: ["awaiting_approval", "rejected", "cancelled"],
  awaiting_approval: ["approved", "rejected", "cancelled"],
  approved: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["implemented", "rolled_back"],
  implemented: ["in_testing", "awaiting_pir"],
  in_testing: ["awaiting_pir", "rolled_back"],
  awaiting_implementation: ["in_progress", "cancelled"],
  awaiting_pir: ["completed"],
  completed: [],
  rejected: [],
  rolled_back: [],
  cancelled: [],
};

function StatusTimeline({ track, status }: { track: ChangeTrack; status: ChangeStatus }) {
  const steps = TIMELINE_BY_TRACK[track] ?? TIMELINE_BY_TRACK.normal;
  const isFailure = TERMINAL_FAILURE.includes(status);
  const currentIndex = isFailure ? -1 : steps.findIndex((s) => stepIncludes(s, status));
  return (
    <ol className="flex flex-wrap items-center gap-y-2" data-testid="status-timeline">
      {steps.map((s, i) => {
        const done = !isFailure && i < currentIndex;
        const current = !isFailure && i === currentIndex;
        const pending = !done && !current;
        const labelStatus = stepLabelStatus(s, status);
        return (
          <li key={Array.isArray(s) ? s.join("|") : s} className="flex items-center" data-testid={`timeline-step-${labelStatus}`}>
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors",
                done && "border-success/40 bg-success/10 text-success",
                current && "border-info/50 bg-info/15 text-info font-semibold ring-1 ring-info/30",
                pending && !isFailure && "border-border bg-muted/40 text-muted-foreground",
                isFailure && "border-border bg-muted/30 text-muted-foreground opacity-70",
              )}
              data-state={done ? "done" : current ? "current" : "pending"}
            >
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold",
                  done
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

  const transition = useMutation({
    mutationFn: (status: ChangeStatus) => api.post(`/changes/${id}/transition`, { toStatus: status }),
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["change", id] });
      qc.invalidateQueries({ queryKey: ["change.approvals", id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Transition failed"),
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
              <StatusTimeline track={c.track} status={c.status} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {TRANSITIONS[c.status].map((next) => (
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
              {TRANSITIONS[c.status].length === 0 && (
                <span className="text-xs text-muted-foreground">No further transitions available from this state.</span>
              )}
            </div>
          </CardHeader>
        </Card>
      )}

      {c && (
        <Tabs defaultValue="planning" className="w-full">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="planning" data-testid="tab-planning">Planning</TabsTrigger>
            <TabsTrigger value="approvals" data-testid="tab-approvals">Approvals</TabsTrigger>
            <TabsTrigger value="schedule" data-testid="tab-schedule">Schedule</TabsTrigger>
            <TabsTrigger value="testing" data-testid="tab-testing">Testing</TabsTrigger>
            <TabsTrigger value="pir" data-testid="tab-pir">PIR</TabsTrigger>
            <TabsTrigger value="comments" data-testid="tab-comments">Discussion</TabsTrigger>
          </TabsList>

          <TabsContent value="planning"><PlanningTab id={id} /></TabsContent>
          <TabsContent value="approvals"><ApprovalsTab id={id} currentUserId={user?.id ?? 0} /></TabsContent>
          <TabsContent value="schedule"><ScheduleTab change={c} /></TabsContent>
          <TabsContent value="testing"><TestingTab id={id} /></TabsContent>
          <TabsContent value="pir"><PirTab id={id} /></TabsContent>
          <TabsContent value="comments"><CommentsTab id={id} /></TabsContent>
        </Tabs>
      )}
    </div>
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
            <Input type="datetime-local" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} data-testid="input-schedule-start" />
          </div>
          <div className="space-y-2">
            <Label>Planned end</Label>
            <Input type="datetime-local" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} data-testid="input-schedule-end" />
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

function TestingTab({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["change.testing", id], queryFn: () => api.get<TestRecord>(`/changes/${id}/testing`) });
  const [form, setForm] = useState<TestRecord | null>(null);
  if (q.data && !form) setForm(q.data);
  const save = useMutation({
    mutationFn: (overall: TestRecord["overallResult"]) =>
      api.put<TestRecord>(`/changes/${id}/testing`, { ...form, overallResult: overall }),
    onSuccess: (row) => {
      toast.success("Testing saved");
      setForm(row);
      qc.invalidateQueries({ queryKey: ["change.testing", id] });
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
            <Label>Environment</Label>
            <Input value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} data-testid="input-environment" />
          </div>
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
