import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import {
  getReturnToFromSearch,
  hasAdfsAutoLoginAttempt,
  hasAdfsLoginPreference,
  isAdfsReady,
  markAdfsAutoLoginAttempt,
  shouldStartAdfsAutoLogin,
  startAdfsLogin,
} from "@/lib/adfs";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
// The login splash uses the same white-stroke logo as the sidebar, but on
// a deep-brown panel so the wave gradient inside the mark stays vibrant.
import chdnLogo from "@assets/CHdN_Logo_Transp_WhiteStroke_1778142112460.png";

type AdfsLoginConfig = {
  enabled: boolean;
  configured: boolean;
  displayName: string;
};

const ADFS_ERROR_MESSAGES: Record<string, string> = {
  unavailable: "AD FS sign-in is currently unavailable.",
  configuration: "AD FS is not configured correctly. Contact an administrator.",
  discovery: "The AD FS provider could not be reached.",
  authorization: "AD FS did not authorize this sign-in.",
  provider_error: "AD FS did not authorize this sign-in.",
  state: "The AD FS sign-in expired or was not valid. Please try again.",
  nonce: "The AD FS response could not be verified. Please try again.",
  token: "AD FS did not return a valid sign-in response.",
  token_exchange: "AD FS did not return a valid sign-in response.",
  token_validation: "The AD FS response could not be verified. Please try again.",
  claims: "Your AD FS account is missing a required identity claim.",
  account: "Your AD FS account is not available in this application.",
  account_not_found: "Your AD FS account is not available in this application.",
  disabled: "Your application account is disabled.",
  account_disabled: "Your application account is disabled.",
  identity_conflict: "Your AD FS identity matches conflicting application accounts.",
  cancelled: "AD FS sign-in was cancelled.",
  authentication_failed: "AD FS sign-in could not be completed.",
};

function safeAdfsErrorMessage(search: string): string | null {
  let code: string | null = null;
  try {
    code = new URLSearchParams(search).get("adfsError");
  } catch {
    return "AD FS sign-in could not be completed.";
  }
  if (!code) return null;
  return ADFS_ERROR_MESSAGES[code] ?? "AD FS sign-in could not be completed.";
}

export function LoginPage() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const search = typeof window === "undefined" ? "" : window.location.search;
  const returnTo = getReturnToFromSearch(search);
  const adfsConfig = useQuery({
    queryKey: ["auth.adfs.config"],
    queryFn: () => api.get<AdfsLoginConfig>("/auth/adfs/config"),
  });
  const adfsReady = isAdfsReady(adfsConfig.data);
  const adfsError = safeAdfsErrorMessage(search);

  useEffect(() => {
    // ProtectedRoutes adds returnTo when it sends an expired session to this
    // page. A tab-scoped marker prevents callback failures from becoming an
    // infinite redirect loop. Successful /auth/me clears the marker.
    if (
      !!adfsError ||
      !shouldStartAdfsAutoLogin(
        adfsConfig.data,
        search,
        hasAdfsLoginPreference(),
        hasAdfsAutoLoginAttempt(),
      )
    ) {
      return;
    }
    markAdfsAutoLoginAttempt();
    startAdfsLogin(returnTo);
  }, [adfsError, adfsReady, returnTo, search]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      setLocation(returnTo);
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
        {/* Brand banner: white panel so the CHdN logo (dark letters +
            green/brown wave) reads at full saturation. Capped by the
            brand-wave divider to introduce the brand colors before the
            form. */}
        <div
          className="flex flex-col items-center gap-2 px-6 pt-8 pb-6 text-center"
          style={{ background: "#ffffff" }}
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
          <CardTitle className="text-xl">Change-it</CardTitle>
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
            {adfsError && !error && (
              <Alert variant="destructive" data-testid="alert-adfs-error">
                <AlertDescription>{adfsError}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={busy} data-testid="button-login-submit">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
            {adfsReady && (
              <>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  <span>or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    startAdfsLogin(returnTo);
                  }}
                  data-testid="button-login-adfs"
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {adfsConfig.data?.displayName?.trim() || "Sign in with AD FS"}
                </Button>
              </>
            )}
            <p className="text-center text-xs text-muted-foreground">
              Local or LDAP credentials accepted.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
