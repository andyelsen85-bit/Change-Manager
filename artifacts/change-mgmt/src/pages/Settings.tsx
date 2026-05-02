import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Download, FileSignature, Loader2, Save, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { LdapSettings, LdapTestResult, SmtpSettings, SslSettings, WorkflowTimeouts } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type CsrResponse = {
  csrPem: string;
  publicKeyFingerprintSha256: string;
  subject: {
    commonName: string;
    organization?: string;
    organizationalUnit?: string;
    locality?: string;
    state?: string;
    country?: string;
    emailAddress?: string;
  };
  subjectAltNames: string[];
  keyBits: number;
};

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

// Quick presets for the most common directory layouts. Clicking one fills
// the user-filter and username-attribute together so admins don't have to
// remember which AD attribute matches which schema.
const LDAP_PRESETS: Array<{
  id: string;
  label: string;
  hint: string;
  userFilter: string;
  usernameAttr: string;
  emailAttr: string;
  nameAttr: string;
}> = [
  {
    id: "openldap",
    label: "OpenLDAP / posixAccount",
    hint: "Login is the short uid (e.g. jdoe).",
    userFilter: "(uid={{username}})",
    usernameAttr: "uid",
    emailAttr: "mail",
    nameAttr: "cn",
  },
  {
    id: "ad-sam",
    label: "Active Directory (sAMAccountName)",
    hint: "Login is the pre-Windows-2000 name (e.g. jdoe).",
    userFilter: "(&(objectClass=user)(sAMAccountName={{username}}))",
    usernameAttr: "sAMAccountName",
    emailAttr: "mail",
    nameAttr: "displayName",
  },
  {
    id: "ad-upn",
    label: "Active Directory (userPrincipalName)",
    hint: "Login is the full UPN (e.g. jdoe@corp.local).",
    userFilter: "(&(objectClass=user)(userPrincipalName={{username}}))",
    usernameAttr: "userPrincipalName",
    emailAttr: "mail",
    nameAttr: "displayName",
  },
];

// Friendly label for each phase the bind can fail at — mirrors the LdapStage
// union on the backend.
const STAGE_LABEL: Record<LdapTestResult["stage"], string> = {
  config: "Configuration",
  connect: "Connection / TLS",
  "service-bind": "Service account bind",
  search: "User lookup",
  "user-bind": "User password bind",
  ok: "Success",
};

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
  // Persist the most recent diagnostic so admins can keep the failure
  // details on screen while editing the form to fix them.
  const [lastResult, setLastResult] = useState<LdapTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<LdapTestResult>("/settings/ldap/test", { username: testUser, password: testPass }),
    onSuccess: (r) => {
      setLastResult(r);
      if (r.success) toast.success(r.message);
      else toast.error(`${STAGE_LABEL[r.stage]}: ${r.message}`);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Test failed";
      setLastResult({ success: false, stage: "config", message: msg });
      toast.error(msg);
    },
  });
  if (!form) return <Skeleton className="mt-4 h-72 w-full" />;

  const applyPreset = (id: string) => {
    const preset = LDAP_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setForm({
      ...form,
      userFilter: preset.userFilter,
      usernameAttr: preset.usernameAttr,
      emailAttr: preset.emailAttr,
      nameAttr: preset.nameAttr,
    });
    toast.success(`Applied preset: ${preset.label}`);
  };

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
            <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="ldaps://dc01.corp.local:636" data-testid="input-ldap-url" />
            <p className="text-xs text-muted-foreground">
              Use <code>ldaps://</code> on port 636 for AD over TLS, or <code>ldap://</code> on 389 + StartTLS.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Bind DN</Label>
            <Input
              value={form.bindDn}
              onChange={(e) => setForm({ ...form, bindDn: e.target.value })}
              placeholder="cn=svc-changemgmt,ou=Service Accounts,dc=corp,dc=local"
              data-testid="input-ldap-bind-dn"
            />
            <p className="text-xs text-muted-foreground">
              Service account used to look up users. AD also accepts the UPN form (e.g. <code>svc-changemgmt@corp.local</code>).
            </p>
          </div>
          <div className="space-y-2">
            <Label>{form.bindPasswordSet ? "Bind password (leave blank to keep)" : "Bind password"}</Label>
            <Input
              type="password"
              value={form.bindPassword}
              onChange={(e) => setForm({ ...form, bindPassword: e.target.value })}
              data-testid="input-ldap-bind-password"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Base DN</Label>
            <Input
              value={form.baseDn}
              onChange={(e) => setForm({ ...form, baseDn: e.target.value })}
              placeholder="dc=corp,dc=local"
              data-testid="input-ldap-base-dn"
            />
            <p className="text-xs text-muted-foreground">
              Where the user lookup begins. For AD this is usually the domain root, e.g. <code>dc=corp,dc=local</code>.
            </p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>User filter</Label>
            <Input
              value={form.userFilter}
              onChange={(e) => setForm({ ...form, userFilter: e.target.value })}
              placeholder="(&(objectClass=user)(sAMAccountName={{username}}))"
              data-testid="input-ldap-user-filter"
            />
            <p className="text-xs text-muted-foreground">
              An LDAP search filter the server runs under <em>Base DN</em> to find the account that's logging in.
              The literal token <code>{`{{username}}`}</code> is replaced with whatever the user typed in the
              login form before the search runs. The first matching entry's DN is then used for the password bind.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="self-center text-xs text-muted-foreground">Quick presets:</span>
              {LDAP_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => applyPreset(p.id)}
                  title={p.hint}
                  data-testid={`button-ldap-preset-${p.id}`}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Username attribute</Label>
            <Input
              value={form.usernameAttr}
              onChange={(e) => setForm({ ...form, usernameAttr: e.target.value })}
              data-testid="input-ldap-username-attr"
            />
            <p className="text-xs text-muted-foreground">
              Attribute to read for the local username. AD: <code>sAMAccountName</code> or <code>userPrincipalName</code>; OpenLDAP: <code>uid</code>.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Email attribute</Label>
            <Input value={form.emailAttr} onChange={(e) => setForm({ ...form, emailAttr: e.target.value })} />
            <p className="text-xs text-muted-foreground">AD: <code>mail</code>. OpenLDAP: <code>mail</code>.</p>
          </div>
          <div className="space-y-2">
            <Label>Display name attribute</Label>
            <Input value={form.nameAttr} onChange={(e) => setForm({ ...form, nameAttr: e.target.value })} />
            <p className="text-xs text-muted-foreground">AD: <code>displayName</code> (or <code>cn</code>). OpenLDAP: <code>cn</code>.</p>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label>StartTLS</Label>
            <Switch checked={form.tls} onCheckedChange={(v) => setForm({ ...form, tls: v })} />
          </div>
          <div className="md:col-span-2 space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <Label>Verify TLS certificate</Label>
              <Switch
                checked={form.tlsRejectUnauthorized}
                onCheckedChange={(v) => setForm({ ...form, tlsRejectUnauthorized: v })}
                data-testid="switch-ldap-tls-verify"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              On (recommended) the server certificate must be valid and its name must match the URL hostname.
              Turn OFF only if your directory uses a self-signed cert, an internal CA Node doesn't trust, or
              you connect by IP address. With verification disabled the connection is still encrypted but
              <strong> no longer authenticated</strong> — an attacker who can intercept traffic to the
              directory can impersonate it.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-ldap">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
          <div className="space-y-1">
            <Label>Test bind</Label>
            <p className="text-xs text-muted-foreground">
              Run a real bind against the directory using the saved settings. Save the form first
              if you've just made changes — the test uses the stored values, not the form draft.
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <Input
              placeholder="username"
              value={testUser}
              onChange={(e) => setTestUser(e.target.value)}
              data-testid="input-ldap-test-username"
            />
            <Input
              type="password"
              placeholder="password"
              value={testPass}
              onChange={(e) => setTestPass(e.target.value)}
              data-testid="input-ldap-test-password"
            />
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending || !testUser || !testPass}
              data-testid="button-ldap-test"
            >
              {test.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Test
            </Button>
          </div>
          {lastResult && (
            <div
              className={
                "rounded-md border p-3 text-sm " +
                (lastResult.success
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                  : "border-destructive/40 bg-destructive/5 text-destructive")
              }
              data-testid="ldap-test-result"
            >
              <div className="flex items-center gap-2 font-medium">
                {lastResult.success ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {lastResult.success
                  ? "Bind succeeded"
                  : `Failed at: ${STAGE_LABEL[lastResult.stage]}`}
              </div>
              <p className="mt-1 text-foreground/90">{lastResult.message}</p>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-[max-content_1fr]">
                {lastResult.code && (
                  <>
                    <dt className="font-medium">LDAP code:</dt>
                    <dd><code>{lastResult.code}</code></dd>
                  </>
                )}
                {lastResult.userDn && (
                  <>
                    <dt className="font-medium">User DN:</dt>
                    <dd className="break-all"><code>{lastResult.userDn}</code></dd>
                  </>
                )}
                {lastResult.details && (
                  <>
                    <dt className="font-medium">Server message:</dt>
                    <dd className="break-words whitespace-pre-wrap"><code>{lastResult.details}</code></dd>
                  </>
                )}
              </dl>
              {!lastResult.success && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Full structured logs (with the masked username, base DN and stage) are written to the API
                  server's log stream — check <code>docker compose logs api</code> on the host.
                </p>
              )}
            </div>
          )}
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
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <CsrDialog
            onGenerated={() => qc.invalidateQueries({ queryKey: ["settings.ssl"] })}
          />
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-ssl">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <Save className="mr-2 h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CsrDialog({ onGenerated }: { onGenerated: () => void }) {
  const [open, setOpen] = useState(false);
  const [commonName, setCommonName] = useState("");
  const [organization, setOrganization] = useState("");
  const [organizationalUnit, setOrganizationalUnit] = useState("");
  const [locality, setLocality] = useState("");
  const [stateField, setStateField] = useState("");
  const [country, setCountry] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [sansText, setSansText] = useState("");
  const [keyBits, setKeyBits] = useState<2048 | 3072 | 4096>(2048);
  const [result, setResult] = useState<CsrResponse | null>(null);

  const reset = () => {
    setCommonName("");
    setOrganization("");
    setOrganizationalUnit("");
    setLocality("");
    setStateField("");
    setCountry("");
    setEmailAddress("");
    setSansText("");
    setKeyBits(2048);
    setResult(null);
  };

  const generate = useMutation({
    mutationFn: () => {
      const sans = sansText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return api.post<CsrResponse>("/settings/ssl/csr", {
        commonName: commonName.trim(),
        organization: organization.trim() || undefined,
        organizationalUnit: organizationalUnit.trim() || undefined,
        locality: locality.trim() || undefined,
        state: stateField.trim() || undefined,
        country: country.trim() || undefined,
        emailAddress: emailAddress.trim() || undefined,
        subjectAltNames: sans,
        keyBits,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      onGenerated();
      toast.success("CSR generated. The private key is held on the server until your CA returns the signed certificate.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "CSR generation failed"),
  });

  const copyCsr = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.csrPem);
      toast.success("CSR copied to clipboard");
    } catch {
      toast.error("Clipboard not available");
    }
  };

  const downloadCsr = () => {
    if (!result) return;
    const blob = new Blob([result.csrPem], { type: "application/pkcs10" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeCn = result.subject.commonName.replace(/[^a-zA-Z0-9._-]/g, "_");
    a.href = url;
    a.download = `${safeCn || "request"}.csr`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-open-csr">
          <FileSignature className="mr-2 h-4 w-4" /> Generate CSR
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate certificate signing request</DialogTitle>
          <DialogDescription>
            Create a fresh RSA key pair and a CSR for your internal PKI to sign. The private key is
            stored on this server; once the CA returns the signed certificate, paste it into the
            Certificate field above and save.
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>Common name (CN) <span className="text-destructive">*</span></Label>
              <Input
                value={commonName}
                onChange={(e) => setCommonName(e.target.value)}
                placeholder="change-mgmt.example.com"
                data-testid="input-csr-cn"
              />
            </div>
            <div className="space-y-2">
              <Label>Organization (O)</Label>
              <Input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="Acme Corp" />
            </div>
            <div className="space-y-2">
              <Label>Organizational unit (OU)</Label>
              <Input value={organizationalUnit} onChange={(e) => setOrganizationalUnit(e.target.value)} placeholder="IT Operations" />
            </div>
            <div className="space-y-2">
              <Label>Locality (L)</Label>
              <Input value={locality} onChange={(e) => setLocality(e.target.value)} placeholder="Berlin" />
            </div>
            <div className="space-y-2">
              <Label>State / province (ST)</Label>
              <Input value={stateField} onChange={(e) => setStateField(e.target.value)} placeholder="Berlin" />
            </div>
            <div className="space-y-2">
              <Label>Country (C, 2-letter)</Label>
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                maxLength={2}
                placeholder="DE"
              />
            </div>
            <div className="space-y-2">
              <Label>Email address</Label>
              <Input value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} placeholder="pki@example.com" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Subject alternative names (one per line)</Label>
              <Textarea
                rows={3}
                value={sansText}
                onChange={(e) => setSansText(e.target.value)}
                placeholder={"change-mgmt.example.com\nchange-mgmt-internal.example.com\n10.0.1.42"}
                data-testid="textarea-csr-sans"
              />
              <p className="text-xs text-muted-foreground">
                Hostnames or IP addresses. The common name is added automatically.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Key size</Label>
              <Select value={String(keyBits)} onValueChange={(v) => setKeyBits(Number(v) as 2048 | 3072 | 4096)}>
                <SelectTrigger data-testid="select-csr-keybits">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2048">RSA 2048</SelectItem>
                  <SelectItem value="3072">RSA 3072</SelectItem>
                  <SelectItem value="4096">RSA 4096</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <Alert>
              <AlertDescription className="space-y-1 text-xs">
                <div>
                  <strong>CN:</strong> {result.subject.commonName}
                  {result.subject.organization ? ` · O=${result.subject.organization}` : ""}
                </div>
                <div>
                  <strong>SANs:</strong> {result.subjectAltNames.join(", ") || "(none)"}
                </div>
                <div>
                  <strong>Key:</strong> RSA {result.keyBits} ·{" "}
                  <span className="font-mono">SHA-256 {result.publicKeyFingerprintSha256}</span>
                </div>
                <div className="pt-1 text-muted-foreground">
                  Submit the CSR below to your internal PKI. When the signed certificate is
                  returned, paste it into the Certificate field and click Save — the matching
                  private key is already stored.
                </div>
              </AlertDescription>
            </Alert>
            <Textarea
              rows={12}
              readOnly
              value={result.csrPem}
              className="font-mono text-xs"
              data-testid="textarea-csr-result"
            />
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={copyCsr} data-testid="button-copy-csr">
                <Copy className="mr-2 h-4 w-4" /> Copy
              </Button>
              <Button variant="outline" onClick={downloadCsr} data-testid="button-download-csr">
                <Download className="mr-2 h-4 w-4" /> Download .csr
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                onClick={() => generate.mutate()}
                disabled={generate.isPending || !commonName.trim()}
                data-testid="button-generate-csr"
              >
                {generate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
