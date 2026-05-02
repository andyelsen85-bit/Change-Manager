import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ChangeRequest, ChangeTrack, StandardTemplate, User } from "@/lib/types";
import { TRACK_OPTIONS } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fromLocalDateTimeInput } from "@/lib/format";
import { cn } from "@/lib/utils";

export function NewChangePage() {
  const [, setLocation] = useLocation();
  const [track, setTrack] = useState<ChangeTrack>("normal");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [risk, setRisk] = useState<"low" | "medium" | "high">("medium");
  const [impact, setImpact] = useState<"low" | "medium" | "high">("medium");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [plannedStart, setPlannedStart] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("none");
  const [templateId, setTemplateId] = useState<string>("none");

  const templatesQ = useQuery({ queryKey: ["templates"], queryFn: () => api.get<StandardTemplate[]>("/templates") });
  const usersQ = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });

  const selectedTemplate = templatesQ.data?.find((t) => String(t.id) === templateId);
  useEffect(() => {
    if (selectedTemplate) {
      setRisk(selectedTemplate.risk);
      setImpact(selectedTemplate.impact);
      setPriority(selectedTemplate.defaultPriority);
    }
  }, [selectedTemplate]);

  const create = useMutation({
    mutationFn: async () => {
      return api.post<ChangeRequest>("/changes", {
        track,
        title: title.trim(),
        description: description.trim(),
        risk,
        impact,
        priority,
        category: selectedTemplate?.category ?? "general",
        plannedStart: fromLocalDateTimeInput(plannedStart),
        plannedEnd: fromLocalDateTimeInput(plannedEnd),
        assigneeId: assigneeId === "none" ? null : Number(assigneeId),
        templateId: templateId === "none" ? null : Number(templateId),
      });
    },
    onSuccess: (c) => {
      toast.success(`Created ${c.ref}`);
      setLocation(`/changes/${c.id}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create change"),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (track === "standard" && templateId === "none") {
      toast.error("Standard track requires a template");
      return;
    }
    create.mutate();
  };

  return (
    <form className="mx-auto max-w-4xl space-y-6" onSubmit={onSubmit} data-testid="form-new-change">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">New change request</h2>
        <p className="text-sm text-muted-foreground">Choose the right track for the level of risk and urgency.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Track</CardTitle>
          <CardDescription>Determines workflow, approvers, and CAB review.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            {TRACK_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTrack(opt.value)}
                data-testid={`button-track-${opt.value}`}
                className={cn(
                  "rounded-lg border-2 p-4 text-left transition-colors",
                  track === opt.value ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/40",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{opt.label}</div>
                  {track === opt.value && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                      Selected
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{opt.description}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {track === "standard" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pre-approved template</CardTitle>
            <CardDescription>Standard changes must use a pre-approved template.</CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger data-testid="select-template"><SelectValue placeholder="Select a template" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Select a template —</SelectItem>
                {(templatesQ.data ?? []).filter((t) => t.isActive).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplate && (
              <div className="mt-4 space-y-2 rounded-md border border-dashed border-border bg-muted/40 p-4 text-sm">
                <p className="text-muted-foreground">{selectedTemplate.description}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span>Risk: {selectedTemplate.risk}</span>
                  <span>Impact: {selectedTemplate.impact}</span>
                  <span>Priority: {selectedTemplate.defaultPriority}</span>
                  {selectedTemplate.autoApprove && <span className="text-success">Auto-approves</span>}
                  {selectedTemplate.bypassCab && <span className="text-success">Bypasses CAB</span>}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title <span className="text-destructive">*</span></Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="input-title" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-description" />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Risk</Label>
              <Select value={risk} onValueChange={(v) => setRisk(v as typeof risk)}>
                <SelectTrigger data-testid="select-risk"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Impact</Label>
              <Select value={impact} onValueChange={(v) => setImpact(v as typeof impact)}>
                <SelectTrigger data-testid="select-impact"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                <SelectTrigger data-testid="select-priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="planned-start">Planned start</Label>
              <Input id="planned-start" type="datetime-local" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} data-testid="input-planned-start" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="planned-end">Planned end</Label>
              <Input id="planned-end" type="datetime-local" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} data-testid="input-planned-end" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Assignee (implementer)</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger data-testid="select-assignee"><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {(usersQ.data ?? []).filter((u) => u.isActive).map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.fullName} ({u.username})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => setLocation("/changes")} data-testid="button-cancel">
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending} data-testid="button-submit-change">
          {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create change
        </Button>
      </div>
    </form>
  );
}
