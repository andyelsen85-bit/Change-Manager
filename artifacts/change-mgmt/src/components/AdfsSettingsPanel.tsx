import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2, Save, ShieldCheck, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AdfsSettings } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type AdfsDraft = AdfsSettings & {
  clientSecret: string;
  caCertPem: string;
};

type ProtectedValueAction = "unchanged" | "replace" | "clear";

type AdfsSettingsUpdate = Pick<
  AdfsSettings,
  | "enabled"
  | "displayName"
  | "issuer"
  | "discoveryUrl"
  | "clientId"
  | "redirectUri"
  | "scopes"
  | "usernameClaim"
  | "emailClaim"
  | "displayNameClaim"
> & {
  /**
   * Omission means leave the stored value untouched. Null is an explicit
   * administrative removal, while a string replaces the value.
   */
  clientSecret?: string | null;
  caCertPem?: string | null;
};

function emptyDraft(settings: AdfsSettings): AdfsDraft {
  return {
    ...settings,
    clientSecret: "",
    caCertPem: "",
  };
}

function isCertificatePem(value: string): boolean {
  return /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(value.trim());
}

export function AdfsSettingsPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings.adfs"],
    queryFn: () => api.get<AdfsSettings>("/settings/adfs"),
  });
  const [form, setForm] = useState<AdfsDraft | null>(null);
  const [secretAction, setSecretAction] = useState<ProtectedValueAction>("unchanged");
  const [caAction, setCaAction] = useState<ProtectedValueAction>("unchanged");
  const caFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.data && !form) {
      setForm(emptyDraft(q.data));
      setSecretAction("unchanged");
      setCaAction("unchanged");
    }
  }, [q.data, form]);

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error("AD FS settings are not loaded");
      if (secretAction === "replace" && !form.clientSecret) {
        throw new Error("Enter a client secret or choose Remove saved secret.");
      }
      if (caAction === "replace" && !isCertificatePem(form.caCertPem)) {
        throw new Error("The custom CA must contain a PEM certificate.");
      }

      const payload: AdfsSettingsUpdate = {
        enabled: form.enabled,
        displayName: form.displayName.trim(),
        issuer: form.issuer.trim(),
        discoveryUrl: form.discoveryUrl.trim(),
        clientId: form.clientId.trim(),
        redirectUri: form.redirectUri.trim(),
        scopes: form.scopes.trim(),
        usernameClaim: form.usernameClaim.trim(),
        emailClaim: form.emailClaim.trim(),
        displayNameClaim: form.displayNameClaim.trim(),
        ...(secretAction === "replace"
          ? { clientSecret: form.clientSecret }
          : secretAction === "clear"
            ? { clientSecret: null }
            : {}),
        ...(caAction === "replace"
          ? { caCertPem: form.caCertPem }
          : caAction === "clear"
            ? { caCertPem: null }
            : {}),
      };
      return api.put<AdfsSettings>("/settings/adfs", payload);
    },
    onSuccess: (row) => {
      toast.success("AD FS settings saved");
      setForm(emptyDraft(row));
      setSecretAction("unchanged");
      setCaAction("unchanged");
      qc.setQueryData(["settings.adfs"], row);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  if (q.isError) {
    return (
      <Alert variant="destructive" className="mt-4" data-testid="alert-adfs-load-error">
        <AlertDescription>{q.error instanceof Error ? q.error.message : "Unable to load AD FS settings."}</AlertDescription>
      </Alert>
    );
  }
  if (q.isLoading || !form) return <Skeleton className="mt-4 h-[42rem] w-full" />;

  const update = <K extends keyof AdfsDraft>(key: K, value: AdfsDraft[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const chooseCaFile = async (file: File) => {
    try {
      const text = await file.text();
      update("caCertPem", text);
      setCaAction("replace");
      toast.success("CA certificate loaded — save to apply it");
    } catch {
      toast.error("Unable to read that certificate file");
    }
  };

  const clearSecret = () => {
    if (!form.secretConfigured) {
      update("clientSecret", "");
      setSecretAction("unchanged");
      return;
    }
    if (!window.confirm("Remove the stored AD FS client secret?")) return;
    update("clientSecret", "");
    setSecretAction("clear");
  };

  const clearCa = () => {
    if (!form.caConfigured) {
      update("caCertPem", "");
      setCaAction("unchanged");
      return;
    }
    if (!window.confirm("Remove the stored AD FS CA certificate?")) return;
    update("caCertPem", "");
    setCaAction("clear");
  };

  return (
    <Card className="mt-4" data-testid="panel-adfs-settings">
      <CardHeader>
        <CardTitle className="text-base">Microsoft AD FS (OpenID Connect)</CardTitle>
        <CardDescription>
          Optional AD FS sign-in using Authorization Code Flow with PKCE. Existing local and LDAP sign-in remain
          available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <Label htmlFor="adfs-enabled">Enable AD FS sign-in</Label>
            <p className="text-xs text-muted-foreground">The button appears on the login page only when AD FS is ready.</p>
          </div>
          <Switch
            id="adfs-enabled"
            checked={form.enabled}
            onCheckedChange={(value) => update("enabled", value)}
            data-testid="switch-adfs-enabled"
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="adfs-display-name">Button label</Label>
            <Input
              id="adfs-display-name"
              value={form.displayName}
              onChange={(e) => update("displayName", e.target.value)}
              placeholder="Sign in with AD FS"
              data-testid="input-adfs-display-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adfs-client-id">Client ID</Label>
            <Input
              id="adfs-client-id"
              value={form.clientId}
              onChange={(e) => update("clientId", e.target.value)}
              data-testid="input-adfs-client-id"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="adfs-issuer">AD FS issuer / authority URL</Label>
            <Input
              id="adfs-issuer"
              value={form.issuer}
              onChange={(e) => update("issuer", e.target.value)}
              placeholder="https://adfs.example.com/adfs"
              data-testid="input-adfs-issuer"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="adfs-discovery-url">OIDC discovery URL</Label>
            <Input
              id="adfs-discovery-url"
              value={form.discoveryUrl}
              onChange={(e) => update("discoveryUrl", e.target.value)}
              placeholder="https://adfs.example.com/adfs/.well-known/openid-configuration"
              data-testid="input-adfs-discovery-url"
            />
            <p className="text-xs text-muted-foreground">Leave blank only if the server derives discovery from the issuer.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="adfs-redirect-uri">Redirect URI</Label>
            <Input
              id="adfs-redirect-uri"
              value={form.redirectUri}
              onChange={(e) => update("redirectUri", e.target.value)}
              placeholder="https://change-it.example.com/api/auth/adfs/callback"
              data-testid="input-adfs-redirect-uri"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adfs-scopes">Scopes</Label>
            <Input
              id="adfs-scopes"
              value={form.scopes}
              onChange={(e) => update("scopes", e.target.value)}
              placeholder="openid profile email"
              data-testid="input-adfs-scopes"
            />
            <p className="text-xs text-muted-foreground">openid is mandatory. Do not add user_impersonation.</p>
          </div>
        </div>

        <div className="rounded-md border border-border p-3">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4" /> Claims mapping
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="adfs-username-claim">Username / identity claim</Label>
              <Input
                id="adfs-username-claim"
                value={form.usernameClaim}
                onChange={(e) => update("usernameClaim", e.target.value)}
                placeholder="upn"
                data-testid="input-adfs-username-claim"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adfs-email-claim">Email claim</Label>
              <Input
                id="adfs-email-claim"
                value={form.emailClaim}
                onChange={(e) => update("emailClaim", e.target.value)}
                placeholder="email"
                data-testid="input-adfs-email-claim"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adfs-display-name-claim">Display-name claim</Label>
              <Input
                id="adfs-display-name-claim"
                value={form.displayNameClaim}
                onChange={(e) => update("displayNameClaim", e.target.value)}
                placeholder="name"
                data-testid="input-adfs-display-name-claim"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4 rounded-md border border-border p-3">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              <Label htmlFor="adfs-client-secret">Client secret</Label>
              {form.secretConfigured && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" data-testid="status-adfs-secret">
                  <CheckCircle2 className="h-3 w-3" /> Configured
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Optional for a public PKCE client. It is never returned to this browser; leave blank to keep the current
              value.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              id="adfs-client-secret"
              type="password"
              value={form.clientSecret}
              onChange={(e) => {
                update("clientSecret", e.target.value);
                setSecretAction("replace");
              }}
              placeholder={form.secretConfigured ? "•••••••• (leave blank to keep)" : "Optional client secret"}
              autoComplete="new-password"
              data-testid="input-adfs-client-secret"
            />
            <Button
              type="button"
              variant="outline"
              onClick={clearSecret}
              disabled={save.isPending}
              data-testid="button-adfs-clear-secret"
            >
              <Trash2 className="mr-2 h-4 w-4" /> {form.secretConfigured ? "Remove" : "Clear"}
            </Button>
          </div>
          {secretAction === "clear" && (
            <p className="text-xs text-destructive" data-testid="status-adfs-secret-removal">
              Secret will be removed when you save.
            </p>
          )}
        </div>

        <div className="space-y-4 rounded-md border border-border p-3">
          <div>
            <div className="flex items-center gap-2">
              <Label htmlFor="adfs-ca">Internal CA certificate (PEM)</Label>
              {form.caConfigured && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" data-testid="status-adfs-ca">
                  <CheckCircle2 className="h-3 w-3" /> Configured
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Optional public certificate material used to trust an internal AD FS authority. Upload a PEM file or
              paste its contents; the server validates it before saving.
            </p>
          </div>
          <Textarea
            id="adfs-ca"
            rows={6}
            value={form.caCertPem}
            onChange={(e) => {
              update("caCertPem", e.target.value);
              setCaAction("replace");
            }}
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            className="font-mono text-xs"
            data-testid="textarea-adfs-ca"
          />
          <input
            ref={caFileRef}
            type="file"
            accept=".pem,.crt,.cer,text/plain,application/x-pem-file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void chooseCaFile(file);
            }}
            data-testid="input-adfs-ca-file"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => caFileRef.current?.click()}
              disabled={save.isPending}
              data-testid="button-adfs-upload-ca"
            >
              <Upload className="mr-2 h-4 w-4" /> Upload PEM
            </Button>
            <Button type="button" variant="outline" onClick={clearCa} disabled={save.isPending} data-testid="button-adfs-clear-ca">
              <Trash2 className="mr-2 h-4 w-4" /> {form.caConfigured ? "Remove saved CA" : "Clear"}
            </Button>
          </div>
          {caAction === "clear" && (
            <p className="text-xs text-destructive" data-testid="status-adfs-ca-removal">
              CA certificate will be removed when you save.
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-border pt-4">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-adfs">
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save AD FS settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}