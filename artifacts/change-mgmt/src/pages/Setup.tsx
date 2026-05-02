import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function SetupPage() {
  const { setup } = useAuth();
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await setup(password);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-background via-background to-muted p-4">
      <Card className="w-full max-w-md border-border/60 shadow-xl" data-testid="page-setup">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <CardTitle className="text-2xl">First-time setup</CardTitle>
            <CardDescription>
              Choose a password for the built-in <span className="font-mono">admin</span> account.
              You will be signed in automatically.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit} data-testid="form-setup">
            <div className="space-y-2">
              <Label htmlFor="setup-password">New admin password</Label>
              <Input
                id="setup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                autoFocus
                minLength={8}
                data-testid="input-setup-password"
              />
              <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-confirm">Confirm password</Label>
              <Input
                id="setup-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                data-testid="input-setup-confirm"
              />
            </div>
            {error && (
              <Alert variant="destructive" data-testid="alert-setup-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={busy} data-testid="button-setup-submit">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create admin account
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              This page only appears once. After setup the standard login screen takes over.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
