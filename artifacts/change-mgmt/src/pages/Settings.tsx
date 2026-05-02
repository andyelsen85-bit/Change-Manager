import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { LdapSettings, SmtpSettings, SslSettings, WorkflowTimeouts } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function SettingsPage() {
  return (
    <div className="space-y-4" data-testid="page-settings">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">System settings</h2>
        <p className="text-sm text-muted-foreground">Administrator-only configuration for SMTP, LDAP, SSL, and timeouts.</p>
      </div>
      <Tabs defaultValue="smtp">
        <TabsList>
          <TabsTrigger value="smtp" data-testid="tab-smtp">SMTP</TabsTrigger>
          <TabsTrigger value="ldap" data-testid="tab-ldap">LDAP</TabsTrigger>
          <TabsTrigger value="ssl" data-testid="tab-ssl">SSL/TLS</TabsTrigger>
          <TabsTrigger value="timeouts" data-testid="tab-timeouts">Workflow timeouts</TabsTrigger>
        </TabsList>
        <TabsContent value="smtp"><SmtpPanel /></TabsContent>
        <TabsContent value="ldap"><LdapPanel /></TabsContent>
        <TabsContent value="ssl"><SslPanel /></TabsContent>
        <TabsContent value="timeouts"><TimeoutsPanel /></TabsContent>
      </Tabs>
    </div>
  );
}

function SmtpPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings.smtp"], queryFn: () => api.get<SmtpSettings>("/settings/smtp") });
  const [form, setForm] = useState<(SmtpSettings & { password: string }) | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm({ ...q.data, password: "" });
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: () => api.put<SmtpSettings>("/settings/smtp", form),
    onSuccess: (row) => {
      toast.success("SMTP settings saved");
      setForm({ ...row, password: "" });
      qc.invalidateQueries({ queryKey: ["settings.smtp"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  const [testTo, setTestTo] = useState("");
  const test = useMutation({
    mutationFn: () => api.post<{ success: boolean; message: string }>("/settings/smtp/test", { to: testTo }),
    onSuccess: (r) => (r.success ? toast.success(r.message) : toast.error(r.message)),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Test failed"),
  });
  if (!form) return <Skeleton className="mt-4 h-72 w-full" />;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">SMTP server</CardTitle>
        <CardDescription>Outgoing mail for notifications and CAB invitations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-2 md:col-span-2">
            <Label>Host</Label>
            <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" data-testid="input-smtp-host" />
          </div>
          <div className="space-y-2">
            <Label>Port</Label>
            <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} data-testid="input-smtp-port" />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Username</Label>
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>{form.passwordSet ? "Password (leave blank to keep)" : "Password"}</Label>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="input-smtp-password" />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>From address</Label>
            <Input type="email" value={form.fromAddress} onChange={(e) => setForm({ ...form, fromAddress: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>From name</Label>
            <Input value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label>Use SSL/TLS (port 465)</Label>
            <Switch checked={form.secure} onCheckedChange={(v) => setForm({ ...form, secure: v })} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label>Enabled</Label>
            <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} data-testid="switch-smtp-enabled" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-smtp">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
          <Label>Send a test email</Label>
          <div className="flex gap-2">
            <Input placeholder="recipient@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} data-testid="input-smtp-test-to" />
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !testTo} data-testid="button-smtp-test">
              {test.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send test
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LdapPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings.ldap"], queryFn: () => api.get<LdapSettings>("/settings/ldap") });
  const [form, setForm] = useState<(LdapSettings & { bindPassword: string }) | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm({ ...q.data, bindPassword: "" });
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: () => api.put<LdapSettings>("/settings/ldap", form),
    onSuccess: (row) => {
      toast.success("LDAP settings saved");
      setForm({ ...row, bindPassword: "" });
      qc.invalidateQueries({ queryKey: ["settings.ldap"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  const [testUser, setTestUser] = useState("");
  const [testPass, setTestPass] = useState("");
  const test = useMutation({
    mutationFn: () => api.post<{ success: boolean; message: string }>("/settings/ldap/test", { username: testUser, password: testPass }),
    onSuccess: (r) => (r.success ? toast.success(r.message) : toast.error(r.message)),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Test failed"),
  });
  if (!form) return <Skeleton className="mt-4 h-72 w-full" />;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">LDAP / Active Directory</CardTitle>
        <CardDescription>Optional centralized authentication.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <Label>Enabled</Label>
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} data-testid="switch-ldap-enabled" />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label>URL</Label>
            <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="ldaps://ldap.example.com:636" data-testid="input-ldap-url" />
          </div>
          <div className="space-y-2">
            <Label>Bind DN</Label>
            <Input value={form.bindDn} onChange={(e) => setForm({ ...form, bindDn: e.target.value })} placeholder="cn=admin,dc=example,dc=com" />
          </div>
          <div className="space-y-2">
            <Label>{form.bindPasswordSet ? "Bind password (leave blank to keep)" : "Bind password"}</Label>
            <Input type="password" value={form.bindPassword} onChange={(e) => setForm({ ...form, bindPassword: e.target.value })} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Base DN</Label>
            <Input value={form.baseDn} onChange={(e) => setForm({ ...form, baseDn: e.target.value })} placeholder="ou=people,dc=example,dc=com" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>User filter</Label>
            <Input value={form.userFilter} onChange={(e) => setForm({ ...form, userFilter: e.target.value })} placeholder="(uid={{username}})" />
            <p className="text-xs text-muted-foreground"><code>{`{{username}}`}</code> is replaced at login.</p>
          </div>
          <div className="space-y-2">
            <Label>Username attribute</Label>
            <Input value={form.usernameAttr} onChange={(e) => setForm({ ...form, usernameAttr: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Email attribute</Label>
            <Input value={form.emailAttr} onChange={(e) => setForm({ ...form, emailAttr: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Display name attribute</Label>
            <Input value={form.nameAttr} onChange={(e) => setForm({ ...form, nameAttr: e.target.value })} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label>StartTLS</Label>
            <Switch checked={form.tls} onCheckedChange={(v) => setForm({ ...form, tls: v })} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-ldap">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
          <Label>Test bind</Label>
          <div className="grid gap-2 md:grid-cols-3">
            <Input placeholder="username" value={testUser} onChange={(e) => setTestUser(e.target.value)} />
            <Input type="password" placeholder="password" value={testPass} onChange={(e) => setTestPass(e.target.value)} />
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !testUser || !testPass}>
              {test.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Test
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SslPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings.ssl"], queryFn: () => api.get<SslSettings>("/settings/ssl") });
  const [certificatePem, setCertificatePem] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [chainPem, setChainPem] = useState("");
  const [forceHttps, setForceHttps] = useState(false);
  const [hstsEnabled, setHstsEnabled] = useState(false);
  useEffect(() => {
    if (q.data) {
      setForceHttps(q.data.forceHttps);
      setHstsEnabled(q.data.hstsEnabled);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put<SslSettings>("/settings/ssl", {
        certificatePem: certificatePem || undefined,
        privateKeyPem: privateKeyPem || undefined,
        chainPem: chainPem || undefined,
        forceHttps,
        hstsEnabled,
      }),
    onSuccess: () => {
      toast.success("SSL settings saved. Restart the server for cert changes to take effect.");
      setCertificatePem("");
      setPrivateKeyPem("");
      setChainPem("");
      qc.invalidateQueries({ queryKey: ["settings.ssl"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  const ssl = q.data;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">SSL/TLS certificate</CardTitle>
        <CardDescription>Bring-your-own PEM certificates for HTTPS.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertDescription>
            Current state — Certificate: <strong>{ssl?.certificateInstalled ? "installed" : "not set"}</strong>;
            Private key: <strong>{ssl?.privateKeyInstalled ? "installed" : "not set"}</strong>;
            Chain: <strong>{ssl?.chainInstalled ? "installed" : "not set"}</strong>.
          </AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label>Certificate (PEM)</Label>
          <Textarea rows={5} placeholder="-----BEGIN CERTIFICATE-----…" value={certificatePem} onChange={(e) => setCertificatePem(e.target.value)} data-testid="textarea-cert" />
        </div>
        <div className="space-y-2">
          <Label>Private key (PEM)</Label>
          <Textarea rows={5} placeholder="-----BEGIN PRIVATE KEY-----…" value={privateKeyPem} onChange={(e) => setPrivateKeyPem(e.target.value)} data-testid="textarea-key" />
        </div>
        <div className="space-y-2">
          <Label>Chain / intermediate (PEM, optional)</Label>
          <Textarea rows={4} placeholder="-----BEGIN CERTIFICATE-----…" value={chainPem} onChange={(e) => setChainPem(e.target.value)} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label>Force HTTPS</Label>
              <p className="text-xs text-muted-foreground">Redirect all HTTP requests to HTTPS.</p>
            </div>
            <Switch checked={forceHttps} onCheckedChange={setForceHttps} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label>Enable HSTS</Label>
              <p className="text-xs text-muted-foreground">HTTP Strict Transport Security header.</p>
            </div>
            <Switch checked={hstsEnabled} onCheckedChange={setHstsEnabled} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-ssl">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TimeoutsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings.timeouts"], queryFn: () => api.get<WorkflowTimeouts>("/settings/workflow-timeouts") });
  const [form, setForm] = useState<WorkflowTimeouts | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: () => api.put<WorkflowTimeouts>("/settings/workflow-timeouts", form),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["settings.timeouts"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });
  if (!form) return <Skeleton className="mt-4 h-64 w-full" />;
  const NField = ({ k, label, suffix }: { k: keyof WorkflowTimeouts; label: string; suffix: string }) => (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input type="number" value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} className="max-w-xs" />
        <span className="text-xs text-muted-foreground">{suffix}</span>
      </div>
    </div>
  );
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Workflow timeouts</CardTitle>
        <CardDescription>Reminders, escalations, and review windows.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <NField k="approvalReminderHours" label="Approval reminder" suffix="hours" />
        <NField k="approvalEscalationHours" label="Approval escalation" suffix="hours" />
        <NField k="cabReminderHours" label="CAB reminder" suffix="hours" />
        <NField k="pirDueDays" label="PIR due window" suffix="days" />
        <NField k="emergencyApprovalMinutes" label="Emergency approval window" suffix="minutes" />
        <div className="md:col-span-2 flex justify-end border-t border-border pt-4">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
