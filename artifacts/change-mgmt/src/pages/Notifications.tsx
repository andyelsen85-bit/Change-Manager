import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { NOTIFICATION_EVENTS, type NotificationPreference } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth-context";

type ServerPref = { eventKey: string; emailEnabled: boolean };

function buildPrefMap(server: ServerPref[]): Map<string, NotificationPreference> {
  const m = new Map<string, NotificationPreference>();
  for (const ev of NOTIFICATION_EVENTS) m.set(ev.key, { eventKey: ev.key, email: true });
  for (const p of server) m.set(p.eventKey, { eventKey: p.eventKey, email: p.emailEnabled });
  return m;
}

function prefsEqual(a: Map<string, NotificationPreference>, b: Map<string, NotificationPreference>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.email !== v.email) return false;
  }
  return true;
}

export function NotificationsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["notifications", user?.id],
    queryFn: () => api.get<ServerPref[]>(`/users/${user!.id}/notification-preferences`),
    enabled: !!user,
  });

  const [prefs, setPrefs] = useState<Map<string, NotificationPreference> | null>(null);
  const [initialPrefs, setInitialPrefs] = useState<Map<string, NotificationPreference> | null>(null);

  // Re-sync local state every time the server query refreshes — fixes the
  // bug where a stale baseline left the Save button disabled after a
  // background refetch returned identical data the second time the page
  // was opened. We only overwrite local edits when the server snapshot
  // genuinely differs from our last-saved baseline.
  useEffect(() => {
    if (!q.data) return;
    const next = buildPrefMap(q.data);
    if (!initialPrefs || !prefsEqual(initialPrefs, next)) {
      setPrefs(next);
      setInitialPrefs(new Map(next));
    }
  }, [q.dataUpdatedAt, q.data, initialPrefs]);

  const save = useMutation({
    mutationFn: () =>
      api.put(
        `/users/${user!.id}/notification-preferences`,
        Array.from(prefs!.values()).map((p) => ({
          eventKey: p.eventKey,
          emailEnabled: p.email,
        })),
      ),
    onSuccess: () => {
      toast.success("Notification preferences saved");
      if (prefs) setInitialPrefs(new Map(prefs));
      qc.invalidateQueries({ queryKey: ["notifications", user?.id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const grouped = useMemo(() => {
    const g = new Map<string, typeof NOTIFICATION_EVENTS>();
    for (const ev of NOTIFICATION_EVENTS) {
      if (!g.has(ev.group)) g.set(ev.group, []);
      g.get(ev.group)!.push(ev);
    }
    return g;
  }, []);

  if (!prefs) return <Skeleton className="h-72 w-full" />;

  const update = (key: string, patch: Partial<NotificationPreference>) => {
    const next = new Map(prefs);
    const cur = next.get(key) ?? { eventKey: key, email: true };
    next.set(key, { ...cur, ...patch });
    setPrefs(next);
  };

  const dirty = !!initialPrefs && !prefsEqual(prefs, initialPrefs);

  return (
    <div className="space-y-4" data-testid="page-notifications">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Notification preferences</h2>
        <p className="text-sm text-muted-foreground">Choose which events trigger an email to you.</p>
      </div>

      {Array.from(grouped.entries()).map(([group, items]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle className="text-base">{group}</CardTitle>
            <CardDescription>Per-event email delivery.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.map((ev) => {
              const p = prefs.get(ev.key) ?? { eventKey: ev.key, email: true };
              return (
                <div key={ev.key} className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <div className="text-sm font-medium">{ev.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{ev.key}</div>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={p.email}
                      onCheckedChange={(v) => update(ev.key, { email: v })}
                      data-testid={`switch-email-${ev.key}`}
                    />
                    Email
                  </label>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-end">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty}
          data-testid="button-save-notifications"
        >
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" /> Save preferences
        </Button>
      </div>
    </div>
  );
}
