import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { StandardTemplate } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth-context";

const EMPTY: StandardTemplate = {
  id: 0,
  name: "",
  description: "",
  category: "",
  risk: "low",
  impact: "low",
  defaultPriority: "low",
  autoApprove: true,
  bypassCab: true,
  prefilledPlanning: "",
  prefilledTestPlan: "",
  isActive: true,
};

export function TemplatesPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin === true;
  const q = useQuery({ queryKey: ["templates"], queryFn: () => api.get<StandardTemplate[]>("/templates") });
  const [editing, setEditing] = useState<StandardTemplate | null>(null);

  const save = useMutation({
    mutationFn: (t: StandardTemplate) =>
      t.id === 0 ? api.post<StandardTemplate>("/templates", t) : api.patch<StandardTemplate>(`/templates/${t.id}`, t),
    onSuccess: () => {
      toast.success("Template saved");
      qc.invalidateQueries({ queryKey: ["templates"] });
      setEditing(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/templates/${id}`),
    onSuccess: () => {
      toast.success("Template deleted");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  return (
    <div className="space-y-4" data-testid="page-templates">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Standard templates</h2>
          <p className="text-sm text-muted-foreground">Pre-approved low-risk changes that auto-approve and bypass CAB.</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setEditing(EMPTY)} data-testid="button-new-template">
            <Plus className="mr-2 h-4 w-4" /> New template
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Risk / Impact</TableHead>
                  <TableHead>Behavior</TableHead>
                  <TableHead>Active</TableHead>
                  {isAdmin && <TableHead className="w-32 text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data ?? []).map((t) => (
                  <TableRow key={t.id} data-testid={`row-template-${t.id}`}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-muted-foreground">{t.description}</div>
                    </TableCell>
                    <TableCell className="text-sm">{t.category ?? "—"}</TableCell>
                    <TableCell className="text-sm capitalize">{t.risk} / {t.impact}</TableCell>
                    <TableCell className="text-xs">
                      {t.autoApprove ? <span className="mr-1 text-success">auto-approve</span> : <span className="mr-1 text-muted-foreground">manual</span>}
                      {t.bypassCab ? <span className="text-success">bypass CAB</span> : <span className="text-muted-foreground">CAB required</span>}
                    </TableCell>
                    <TableCell>{t.isActive ? "Yes" : "No"}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right space-x-1">
                        <Button size="icon" variant="ghost" onClick={() => setEditing({ ...t })} data-testid={`button-edit-template-${t.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (confirm("Delete this template?")) del.mutate(t.id);
                          }}
                          data-testid={`button-delete-template-${t.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle>{editing.id ? "Edit template" : "New template"}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="input-template-name" />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea rows={2} value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Input value={editing.category ?? ""} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Risk</Label>
                    <Select value={editing.risk} onValueChange={(v) => setEditing({ ...editing, risk: v as StandardTemplate["risk"] })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Impact</Label>
                    <Select value={editing.impact} onValueChange={(v) => setEditing({ ...editing, impact: v as StandardTemplate["impact"] })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Default priority</Label>
                    <Select value={editing.defaultPriority} onValueChange={(v) => setEditing({ ...editing, defaultPriority: v as StandardTemplate["defaultPriority"] })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border p-3">
                    <div>
                      <Label>Auto-approve</Label>
                      <p className="text-xs text-muted-foreground">Skip approvals for this template.</p>
                    </div>
                    <Switch checked={editing.autoApprove} onCheckedChange={(v) => setEditing({ ...editing, autoApprove: v })} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border p-3">
                    <div>
                      <Label>Bypass CAB</Label>
                      <p className="text-xs text-muted-foreground">No CAB review required.</p>
                    </div>
                    <Switch checked={editing.bypassCab} onCheckedChange={(v) => setEditing({ ...editing, bypassCab: v })} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Pre-filled implementation plan</Label>
                  <Textarea rows={3} value={editing.prefilledPlanning ?? ""} onChange={(e) => setEditing({ ...editing, prefilledPlanning: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Pre-filled test plan</Label>
                  <Textarea rows={3} value={editing.prefilledTestPlan ?? ""} onChange={(e) => setEditing({ ...editing, prefilledTestPlan: e.target.value })} />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <Label>Active</Label>
                    <p className="text-xs text-muted-foreground">Available when creating standard changes.</p>
                  </div>
                  <Switch checked={editing.isActive} onCheckedChange={(v) => setEditing({ ...editing, isActive: v })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button onClick={() => save.mutate(editing)} disabled={save.isPending}>
                  {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save template
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
