import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Plus,
  ShieldAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ActivityItem, CabMeeting, DashboardSummary, DashboardTask } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PIE_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

export function DashboardPage() {
  const summaryQ = useQuery({ queryKey: ["dashboard.summary"], queryFn: () => api.get<DashboardSummary>("/dashboard/summary") });
  const activityQ = useQuery({ queryKey: ["dashboard.activity"], queryFn: () => api.get<ActivityItem[]>("/dashboard/activity") });
  const cabQ = useQuery({ queryKey: ["dashboard.upcoming-cab"], queryFn: () => api.get<CabMeeting[]>("/dashboard/upcoming-cab") });
  const tasksQ = useQuery({ queryKey: ["dashboard.my-tasks"], queryFn: () => api.get<DashboardTask[]>("/dashboard/my-tasks") });

  const s = summaryQ.data;

  return (
    <div className="space-y-6" data-testid="page-dashboard">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Operations overview</h2>
          <p className="text-sm text-muted-foreground">Real-time pulse of your change management practice.</p>
        </div>
        <Link href="/changes/new">
          <Button data-testid="button-new-change">
            <Plus className="mr-2 h-4 w-4" />
            New Change
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <KPI title="Total" value={s?.totalChanges} icon={ClipboardList} loading={summaryQ.isLoading} />
        <KPI title="Open" value={s?.openChanges} icon={Clock} loading={summaryQ.isLoading} accent="info" />
        <KPI title="Awaiting approval" value={s?.awaitingApproval} icon={ShieldAlert} loading={summaryQ.isLoading} accent="warning" />
        <KPI title="Scheduled this week" value={s?.scheduledThisWeek} icon={CalendarClock} loading={summaryQ.isLoading} />
        <KPI
          title="Emergency open"
          value={s?.emergencyOpen}
          icon={AlertTriangle}
          loading={summaryQ.isLoading}
          accent={s?.emergencyOpen ? "destructive" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Changes by status</CardTitle>
            <CardDescription>Distribution across the entire pipeline.</CardDescription>
          </CardHeader>
          <CardContent>
            {summaryQ.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={(s?.byStatus ?? []).slice().sort((a, b) => b.count - a.count)} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="key"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickFormatter={(v: string) => v.replace(/_/g, " ")}
                    interval={0}
                    angle={-25}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis allowDecimals={false} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted))" }}
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: "0.5rem",
                      color: "hsl(var(--popover-foreground))",
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Risk profile</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryQ.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie
                      data={s?.byRisk ?? []}
                      dataKey="count"
                      nameKey="key"
                      cx="50%"
                      cy="50%"
                      innerRadius={36}
                      outerRadius={62}
                      stroke="none"
                    >
                      {(s?.byRisk ?? []).map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        borderColor: "hsl(var(--border))",
                        borderRadius: "0.5rem",
                        color: "hsl(var(--popover-foreground))",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
              <div className="mt-2 flex justify-center gap-3 text-xs text-muted-foreground">
                {(s?.byRisk ?? []).map((r, i) => (
                  <span key={r.key} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    {r.key} ({r.count})
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">Success rate</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{s?.successRate ?? 0}%</div>
              <p className="text-xs text-muted-foreground">Of completed/closed changes that succeeded.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">My tasks</CardTitle>
            <CardDescription>Changes waiting on you for approval, testing, or post-implementation review.</CardDescription>
          </CardHeader>
          <CardContent>
            {tasksQ.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (tasksQ.data ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">You're all caught up. Nice work.</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="list-my-tasks">
                {tasksQ.data!.map((t, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/changes/${t.changeId}`}
                        className="block truncate text-sm font-medium text-foreground hover:underline"
                        data-testid={`link-task-${t.changeId}`}
                      >
                        {t.ref} — {t.title}
                      </Link>
                      <div className="text-xs text-muted-foreground">{t.note}</div>
                    </div>
                    <span className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs uppercase tracking-wide text-secondary-foreground">
                      {t.kind}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming CAB</CardTitle>
            <CardDescription>Next ten meetings.</CardDescription>
          </CardHeader>
          <CardContent>
            {cabQ.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (cabQ.data ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No upcoming meetings scheduled.</p>
            ) : (
              <ul className="space-y-3">
                {cabQ.data!.map((m) => (
                  <li key={m.id} className="rounded-md border border-border bg-card p-3">
                    <Link
                      href={`/cab/${m.id}`}
                      className="block text-sm font-medium hover:underline"
                      data-testid={`link-cab-${m.id}`}
                    >
                      {m.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {fmtDateTime(m.scheduledStart)} · {m.kind === "ecab" ? "Emergency CAB" : "CAB"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>Operational events from the audit trail.</CardDescription>
        </CardHeader>
        <CardContent>
          {activityQ.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (activityQ.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No recent activity yet.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="list-activity">
              {activityQ.data!.map((a) => (
                <li key={a.id} className="flex items-start gap-3 py-3 text-sm">
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.actorName}</span>
                      <span className="text-xs text-muted-foreground">{a.action}</span>
                    </div>
                    <div className="truncate text-muted-foreground">{a.summary}</div>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">{fmtAgo(a.timestamp)}</div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KPI({
  title,
  value,
  icon: Icon,
  loading,
  accent = "default",
}: {
  title: string;
  value: number | undefined;
  icon: typeof ClipboardList;
  loading?: boolean;
  accent?: "default" | "info" | "warning" | "destructive";
}) {
  const accentClass: Record<string, string> = {
    default: "text-foreground",
    info: "text-info",
    warning: "text-warning",
    destructive: "text-destructive",
  };
  return (
    <Card data-testid={`kpi-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className={`h-4 w-4 ${accentClass[accent]}`} />
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-8 w-16" /> : <div className={`text-2xl font-bold ${accentClass[accent]}`}>{value ?? 0}</div>}
      </CardContent>
    </Card>
  );
}
