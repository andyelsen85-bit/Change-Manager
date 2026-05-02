import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtAgo } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

type EditUser = {
  id: number;
  username: string;
  email: string;
  fullName: string;
  source: "local" | "ldap";
  isAdmin: boolean;
  isActive: boolean;
  password: string;
};

const NEW: EditUser = {
  id: 0,
  username: "",
  email: "",
  fullName: "",
  source: "local",
  isAdmin: false,
  isActive: true,
  password: "",
};

export function UsersPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });
  const [editing, setEditing] = useState<EditUser | null>(null);

  const save = useMutation({
    mutationFn: (u: EditUser) => {
      // For NEW LDAP users we send only the short login + flags. The server
      // looks the account up in the directory and fills in displayName / mail
      // itself, so the form doesn't have to ask the admin for them.
      const isNewLdap = u.id === 0 && u.source === "ldap";
      const body: Record<string, unknown> = {
        username: u.username,
        source: u.source,
        isAdmin: u.isAdmin,
        isActive: u.isActive,
      };
      if (!isNewLdap) {
        body["email"] = u.email;
        body["fullName"] = u.fullName;
      }
      if (u.password) body["password"] = u.password;
      return u.id === 0 ? api.post<User>("/users", body) : api.patch<User>(`/users/${u.id}`, body);
    },
    onSuccess: () => {
      toast.success("User saved");
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditing(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/users/${id}`),
    onSuccess: () => {
      toast.success("User deactivated");
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  return (
    <div className="space-y-4" data-testid="page-users">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Users</h2>
          <p className="text-sm text-muted-foreground">Local and LDAP user accounts.</p>
        </div>
        <Button onClick={() => setEditing({ ...NEW })} data-testid="button-new-user">
          <Plus className="mr-2 h-4 w-4" /> New user
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Full name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead className="text-right w-32">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data ?? []).map((u) => (
                  <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                    <TableCell className="font-mono text-xs">{u.username}{u.isAdmin && <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-[10px] uppercase text-primary-foreground">admin</span>}</TableCell>
                    <TableCell>{u.fullName}</TableCell>
                    <TableCell className="text-sm">{u.email}</TableCell>
                    <TableCell><span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs uppercase">{u.source}</span></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.roles?.length ? u.roles.join(", ") : "—"}</TableCell>
                    <TableCell>
                      {u.isActive ? (
                        <span className="inline-flex items-center gap-1 text-success"><UserCheck className="h-3.5 w-3.5" /> Active</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground"><UserX className="h-3.5 w-3.5" /> Inactive</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.lastLoginAt ? fmtAgo(u.lastLoginAt) : "Never"}</TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button size="icon" variant="ghost" onClick={() => setEditing({ id: u.id, username: u.username, email: u.email, fullName: u.fullName, source: u.source, isAdmin: u.isAdmin, isActive: u.isActive, password: "" })} data-testid={`button-edit-user-${u.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {u.isActive && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Deactivate ${u.username}?`)) del.mutate(u.id);
                          }}
                          data-testid={`button-delete-user-${u.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          {editing && (
            <>
              <DialogHeader><DialogTitle>{editing.id ? "Edit user" : "New user"}</DialogTitle></DialogHeader>
              <div className="grid gap-3 py-2">
                <div className="space-y-2">
                  <Label>
                    Username <span className="text-destructive">*</span>
                    {editing.id === 0 && editing.source === "ldap" && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(short login from your directory)</span>
                    )}
                  </Label>
                  <Input required value={editing.username} onChange={(e) => setEditing({ ...editing, username: e.target.value })} disabled={editing.id !== 0} data-testid="input-user-username" />
                </div>
                {editing.id === 0 && editing.source === "ldap" ? (
                  <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    Full name and email will be imported automatically from the directory (<code>displayName</code> / <code>mail</code>) when you save.
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label>Full name <span className="text-destructive">*</span></Label>
                      <Input required value={editing.fullName} onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Email <span className="text-destructive">*</span></Label>
                      <Input required type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
                    </div>
                  </>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Source <span className="text-destructive">*</span></Label>
                    <Select value={editing.source} onValueChange={(v) => setEditing({ ...editing, source: v as "local" | "ldap" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">Local</SelectItem>
                        <SelectItem value="ldap">LDAP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {editing.source === "local" && (
                    <div className="space-y-2">
                      <Label>
                        {editing.id ? "Reset password (leave blank to keep)" : <>Password <span className="text-destructive">*</span></>}
                      </Label>
                      <Input required={!editing.id} type="password" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} data-testid="input-user-password" />
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Fields marked <span className="text-destructive">*</span> are required.</p>
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <Label>Administrator</Label>
                  <Switch checked={editing.isAdmin} onCheckedChange={(v) => setEditing({ ...editing, isAdmin: v })} />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <Label>Active</Label>
                  <Switch checked={editing.isActive} onCheckedChange={(v) => setEditing({ ...editing, isActive: v })} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  onClick={() => {
                    const missing: string[] = [];
                    const isNewLdap = editing.id === 0 && editing.source === "ldap";
                    if (!editing.username.trim()) missing.push("Username");
                    if (!isNewLdap && !editing.fullName.trim()) missing.push("Full name");
                    if (!isNewLdap && !editing.email.trim()) missing.push("Email");
                    if (editing.source === "local" && !editing.id && !editing.password) missing.push("Password");
                    if (missing.length) {
                      toast.error(`Please fill in: ${missing.join(", ")}`);
                      return;
                    }
                    save.mutate(editing);
                  }}
                  disabled={save.isPending}
                  data-testid="button-save-user"
                >
                  {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
