import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, Loader2, KeyRound } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { SsoStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function LoginPage() {
  const { login, loginSso } = useAuth();
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  // Hide the SSO button by default — only render it once we've confirmed
  // with /auth/sso/status that the admin has enabled and configured the
  // Kerberos integration. Otherwise we'd be inviting users to click a
  // button that always 404s.
  const [ssoEnabled, setSsoEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.get<SsoStatus>("/auth/sso/status")
      .then((s) => { if (!cancelled) setSsoEnabled(!!s.enabled); })
      .catch(() => { /* leave hidden on any error */ });
    return () => { cancelled = true; };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const onSso = async () => {
    setError(null);
    setSsoBusy(true);
    try {
      await loginSso();
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in with Windows failed");
    } finally {
      setSsoBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-background via-background to-muted p-4">
      <Card className="w-full max-w-md border-border/60 shadow-xl">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <CardTitle className="text-2xl">Change Management</CardTitle>
            <CardDescription>Sign in to your account</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit} data-testid="form-login">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                autoFocus
                data-testid="input-username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                data-testid="input-password"
              />
            </div>
            {error && (
              <Alert variant="destructive" data-testid="alert-login-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={busy || ssoBusy} data-testid="button-login-submit">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
            {ssoEnabled && (
              <>
                <div className="relative my-2">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={onSso}
                  disabled={busy || ssoBusy}
                  data-testid="button-login-sso"
                >
                  {ssoBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  Sign in with Windows
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Uses your current Windows session — no password needed when this site is in your Trusted/Intranet zone.
                </p>
              </>
            )}
            {!ssoEnabled && (
              <p className="text-center text-xs text-muted-foreground">
                Local or LDAP credentials accepted.
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
