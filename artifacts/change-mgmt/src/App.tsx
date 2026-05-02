import { Route, Switch, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/Login";
import { SetupPage } from "@/pages/Setup";
import { DashboardPage } from "@/pages/Dashboard";
import { ChangesListPage } from "@/pages/ChangesList";
import { NewChangePage } from "@/pages/NewChange";
import { ChangeDetailPage } from "@/pages/ChangeDetail";
import { CabCalendarPage } from "@/pages/CabCalendar";
import { CabDetailPage } from "@/pages/CabDetail";
import { TemplatesPage } from "@/pages/Templates";
import { UsersPage } from "@/pages/Users";
import { RolesPage } from "@/pages/Roles";
import { SettingsPage } from "@/pages/Settings";
import { AuditLogPage } from "@/pages/AuditLog";
import { NotificationsPage } from "@/pages/Notifications";
import { ProfilePage } from "@/pages/Profile";
import { ForbiddenPage } from "@/pages/Forbidden";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, err) => {
        if (err instanceof Error && /HTTP 401|HTTP 403|HTTP 404/.test(err.message)) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

function ProtectedRoutes() {
  const { user, loading, needsSetup } = useAuth();
  const [location] = useLocation();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  // First-time setup. The backend reports needsSetup=true when the seeded
  // admin row has no password. The wizard is the only thing the user can
  // see until they pick a password — at which point the API returns an
  // authenticated session and the rest of the app unlocks.
  if (needsSetup && !user) {
    if (location !== "/setup") return <Redirect to="/setup" />;
    return <SetupPage />;
  }
  if (!user) {
    if (location === "/setup") return <Redirect to="/login" />;
    if (location !== "/login") return <Redirect to="/login" />;
    return <LoginPage />;
  }
  // /setup is meaningless once the user is authenticated.
  if (location === "/setup") return <Redirect to="/" />;
  if (location === "/login") return <Redirect to="/" />;
  // Force users who must change their password (e.g. operators promoted by
  // an admin and given a temporary password) onto the Profile page until
  // they rotate. The Profile page surfaces a banner when the flag is true.
  if (user.mustChangePassword && location !== "/profile") {
    return <Redirect to="/profile" />;
  }
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/changes" component={ChangesListPage} />
        <Route path="/changes/new" component={NewChangePage} />
        <Route path="/changes/:id" component={ChangeDetailPage} />
        <Route path="/cab" component={CabCalendarPage} />
        <Route path="/cab/:id" component={CabDetailPage} />
        <Route path="/templates" component={TemplatesPage} />
        <Route path="/users" component={user.isAdmin ? UsersPage : ForbiddenPage} />
        <Route path="/roles" component={user.isAdmin ? RolesPage : ForbiddenPage} />
        <Route path="/settings" component={user.isAdmin ? SettingsPage : ForbiddenPage} />
        <Route path="/admin/audit-log" component={user.isAdmin ? AuditLogPage : ForbiddenPage} />
        <Route path="/audit">{() => <Redirect to="/admin/audit-log" />}</Route>
        <Route path="/notifications" component={NotificationsPage} />
        <Route path="/profile" component={ProfilePage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ProtectedRoutes />
          <Toaster richColors closeButton position="top-right" />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
