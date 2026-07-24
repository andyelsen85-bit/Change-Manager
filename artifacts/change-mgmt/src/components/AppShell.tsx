import { type ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  ClipboardList,
  CalendarDays,
  CalendarRange,
  FileText,
  Users,
  ShieldCheck,
  ShieldAlert,
  Settings,
  ScrollText,
  Trash2,
  LogOut,
  Bell,
  Moon,
  Sun,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useDiscussionStates, useMarkAllDiscussionsRead } from "@/lib/discussions";
import { fmtAgo } from "@/lib/format";
import { useTheme } from "@/lib/theme-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
// The CHdN brand mark is rendered against the dark sidebar, so we use the
// white-stroke variant. Importing through the @assets alias keeps the file
// out of /public and lets Vite hash + cache-bust it like any other asset.
import chdnLogo from "@assets/CHdN_Logo_Transp_WhiteStroke_1778142112460.png";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type NavItem = {
  label: string;
  path: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
};

const NAV: NavItem[] = [
  { label: "Dashboard", path: "/", icon: LayoutDashboard },
  { label: "Changes", path: "/changes", icon: ClipboardList },
  { label: "Change Plannings", path: "/plannings", icon: CalendarRange },
  { label: "CAB Calendar", path: "/cab", icon: CalendarDays },
  { label: "Templates", path: "/templates", icon: FileText },
  // Always visible: a plain user added to a pentest must be able to reach it.
  // The page/API scope what they actually see to their assigned requests.
  { label: "PenTesting", path: "/pentests", icon: ShieldAlert },
  { label: "Users", path: "/users", icon: Users, adminOnly: true },
  { label: "Roles", path: "/roles", icon: ShieldCheck, adminOnly: true },
  { label: "Audit Log", path: "/admin/audit-log", icon: ScrollText, adminOnly: true },
  { label: "Recycle Bin", path: "/admin/recycle-bin", icon: Trash2, adminOnly: true },
  { label: "Settings", path: "/settings", icon: Settings, adminOnly: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const visibleNav = NAV.filter((n) => {
    if (n.adminOnly && !user?.isAdmin) return false;
    return true;
  });

  const handleLogout = async () => {
    await logout();
    setLocation("/login");
  };

  const initials = (user?.fullName || user?.username || "?")
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex h-full bg-background text-foreground">
      {/* Sidebar */}
      <aside
        data-testid="app-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 transform bg-sidebar text-sidebar-foreground transition-transform md:relative md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-20 items-center justify-between gap-3 border-b border-sidebar-border px-3">
          <Link href="/" className="flex items-center gap-3">
            {/*
             * Logo sits inside a white pill so the dark letters and the
             * green/brown wave inside the mark stay legible against the
             * brown sidebar — the brand brief calls for the logo on a
             * white field.
             */}
            <div className="flex h-14 items-center justify-center rounded-md bg-white px-3 shadow-sm">
              <img
                src={chdnLogo}
                alt="CHdN — Centre Hospitalier du Nord"
                className="h-10 w-auto select-none"
                draggable={false}
              />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/60">
                CHdN
              </span>
              <span className="text-base font-semibold">Change-it</span>
            </div>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden text-sidebar-foreground"
            onClick={() => setMobileOpen(false)}
            data-testid="button-close-sidebar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = location === item.path || (item.path !== "/" && location.startsWith(item.path));
            return (
              <Link
                key={item.path}
                href={item.path}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-sidebar-border p-3 text-xs text-sidebar-foreground/60">
          <div>v2.0.5</div>
          <div>{user?.source === "ldap" ? "LDAP-authenticated session" : "Local session"}</div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="flex h-16 items-center justify-between border-b border-border bg-card px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              data-testid="button-open-sidebar"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="text-base font-semibold md:text-lg">{titleFor(location)}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              data-testid="button-theme-toggle"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <DiscussionBell />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  data-testid="button-user-menu"
                  className="ml-1 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                    {initials}
                  </span>
                  <span className="hidden sm:flex flex-col items-start leading-tight">
                    <span className="font-medium">{user?.fullName || user?.username}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {user?.isAdmin ? "Administrator" : user?.roles.length ? user.roles.join(", ") : "User"}
                    </span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <Link href="/profile">
                  <DropdownMenuItem data-testid="menuitem-profile">My Profile</DropdownMenuItem>
                </Link>
                <Link href="/notifications">
                  <DropdownMenuItem data-testid="menuitem-notification-prefs">Notification Preferences</DropdownMenuItem>
                </Link>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid="menuitem-logout" onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>

      {mobileOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-foreground/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </div>
  );
}

// Header bell: unread-discussion counter with a popup listing each change
// that has unread messages, linking straight to its Discussion tab.
function DiscussionBell() {
  const statesQ = useDiscussionStates();
  const markAll = useMarkAllDiscussionsRead();
  const [, setLocation] = useLocation();
  const unread = (statesQ.data ?? []).filter((s) => s.unread);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Unread discussions" className="relative" data-testid="button-discussion-bell">
          <Bell className="h-4 w-4" />
          {unread.length > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
              data-testid="badge-discussion-count"
            >
              {unread.length > 9 ? "9+" : unread.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Unread discussions</span>
          {unread.length > 0 && (
            <button
              className="text-xs font-normal text-primary hover:underline"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              data-testid="button-mark-all-read"
            >
              Mark all as read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {unread.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground" data-testid="text-no-unread">
            No unread discussions
          </div>
        ) : (
          unread.map((s) => (
            <DropdownMenuItem
              key={s.changeId}
              className="flex flex-col items-start gap-0.5"
              onClick={() => setLocation(`/changes/${s.changeId}?tab=comments`)}
              data-testid={`menuitem-discussion-${s.changeId}`}
            >
              <span className="text-sm font-medium">
                <span className="font-mono text-xs text-muted-foreground">{s.ref}</span> {s.title}
              </span>
              <span className="text-xs text-muted-foreground">New message {fmtAgo(s.lastMessageAt)}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function titleFor(path: string): string {
  if (path === "/" || path === "") return "Dashboard";
  if (path.startsWith("/changes/new")) return "New Change Request";
  if (path.startsWith("/changes")) return "Change Requests";
  if (path.startsWith("/plannings")) return "Change Plannings";
  if (path.startsWith("/cab")) return "CAB Calendar";
  if (path.startsWith("/templates")) return "Standard Templates";
  if (path.startsWith("/pentests/new")) return "New PenTest Request";
  if (path.startsWith("/pentests")) return "PenTesting";
  if (path.startsWith("/users")) return "Users";
  if (path.startsWith("/roles")) return "Roles & Assignments";
  if (path.startsWith("/admin/audit-log") || path.startsWith("/audit")) return "Audit Log";
  if (path.startsWith("/settings")) return "System Settings";
  if (path.startsWith("/notifications")) return "Notification Preferences";
  if (path.startsWith("/profile")) return "My Profile";
  return "Change-it";
}
