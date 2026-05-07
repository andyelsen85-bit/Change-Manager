import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
// The login splash uses the same white-stroke logo as the sidebar, but on
// a deep-brown panel so the wave gradient inside the mark stays vibrant.
import chdnLogo from "@assets/CHdN_Logo_Transp_WhiteStroke_1778142112460.png";

export function LoginPage() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div
      className="relative flex min-h-full items-center justify-center p-4"
      style={{
        // Soft brand-tinted backdrop: tan → off-white → pale lime, with a
        // subtle radial highlight roughly where the card sits. Done inline
        // so we don't have to wire a new gradient utility into Tailwind.
        backgroundImage: [
          "radial-gradient(circle at 30% 20%, hsl(74 67% 42% / 0.10), transparent 55%)",
          "radial-gradient(circle at 75% 80%, hsl(30 43% 41% / 0.10), transparent 55%)",
          "linear-gradient(135deg, hsl(60 30% 98%) 0%, hsl(35 35% 95%) 100%)",
        ].join(", "),
      }}
    >
      <Card className="w-full max-w-md overflow-hidden border-border/60 shadow-2xl">
        {/* Brand banner: dark espresso panel with the white-stroke logo,
            capped by the wave divider so the brand colors lead into the
            form below. Mirrors the visual language of the logo itself. */}
        <div
          className="flex flex-col items-center gap-2 px-6 pt-8 pb-6 text-center"
          style={{ background: "hsl(30 30% 12%)" }}
        >
          <img
            src={chdnLogo}
            alt="CHdN — Centre Hospitalier du Nord"
            className="h-24 w-auto select-none"
            draggable={false}
          />
        </div>
        <div className="brand-wave" />
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-xl">Change Management</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
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
            <Button type="submit" className="w-full" disabled={busy} data-testid="button-login-submit">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Local or LDAP credentials accepted.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
