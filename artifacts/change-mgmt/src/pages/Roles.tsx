import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Role, RoleAssignment, User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";

export function RolesPage() {
  const qc = useQueryClient();
  const rolesQ = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
  const usersQ = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });
  const assignmentsQ = useQuery({ queryKey: ["role-assignments"], queryFn: () => api.get<RoleAssignment[]>("/role-assignments") });

  const create = useMutation({
    mutationFn: (a: { roleKey: string; userId: number; isDeputy: boolean }) => api.post("/role-assignments", a),
    onSuccess: () => {
      toast.success("Assignment created");
      qc.invalidateQueries({ queryKey: ["role-assignments"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Create failed"),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/role-assignments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["role-assignments"] });
    },
  });

  const byRole = new Map<string, RoleAssignment[]>();
  for (const a of assignmentsQ.data ?? []) {
    if (!byRole.has(a.roleKey)) byRole.set(a.roleKey, []);
    byRole.get(a.roleKey)!.push(a);
  }

  return (
    <div className="space-y-4" data-testid="page-roles">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Roles &amp; assignments</h2>
        <p className="text-sm text-muted-foreground">
          Govern who can approve and review changes. Every role supports a deputy/replacement for continuity.
        </p>
      </div>

      {rolesQ.isLoading || usersQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(rolesQ.data ?? []).map((r) => (
            <RoleCard
              key={r.key}
              role={r}
              users={usersQ.data ?? []}
              assignments={byRole.get(r.key) ?? []}
              onAdd={(userId, isDeputy) => create.mutate({ roleKey: r.key, userId, isDeputy })}
              onRemove={(id) => del.mutate(id)}
              busy={create.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoleCard({
  role,
  users,
  assignments,
  onAdd,
  onRemove,
  busy,
}: {
  role: Role;
  users: User[];
  assignments: RoleAssignment[];
  onAdd: (userId: number, isDeputy: boolean) => void;
  onRemove: (id: number) => void;
  busy: boolean;
}) {
  const [userId, setUserId] = useState<string>("none");
  const [isDeputy, setIsDeputy] = useState(false);
  return (
    <Card data-testid={`role-card-${role.key}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" />
          {role.name}
        </CardTitle>
        <CardDescription>{role.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="mb-2 block">Assigned users</Label>
          {assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody assigned yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {assignments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm"
                  data-testid={`assignment-${a.id}`}
                >
                  <div className="flex items-center gap-2">
                    <span data-testid={`assignment-name-${a.id}`}>{a.userName}</span>
                    {a.isDeputy ? (
                      <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">Deputy</span>
                    ) : (
                      <span className="rounded-md border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success">Primary</span>
                    )}
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => onRemove(a.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-md border border-dashed border-border p-3 space-y-2">
          <div className="grid gap-2 md:grid-cols-2">
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger data-testid={`select-add-user-${role.key}`}><SelectValue placeholder="Choose user" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Choose user —</SelectItem>
                {users.filter((u) => u.isActive).map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
              <span>Assign as deputy</span>
              <Switch checked={isDeputy} onCheckedChange={setIsDeputy} />
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => {
              if (userId === "none") return;
              onAdd(Number(userId), isDeputy);
              setUserId("none");
              setIsDeputy(false);
            }}
            disabled={busy || userId === "none"}
            data-testid={`button-add-assignment-${role.key}`}
          >
            <UserPlus className="mr-2 h-4 w-4" /> Add assignment
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
