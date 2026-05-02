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

export function NotificationsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["notifications", user?.id],
    queryFn: () =>
      api.get<Array<{ eventKey: string; emailEnabled: boolean; inAppEnabled: boolean }>>(
        `/users/${user!.id}/notification-preferences`,
      ),
    enabled: !!user,
  });

  const [prefs, setPrefs] = useState<Map<string, NotificationPreference> | null>(null);

  useEffect(() => {
    if (q.data && !prefs) {
      const m = new Map<string, NotificationPreference>();
      for (const ev of NOTIFICATION_EVENTS) m.set(ev.key, { eventKey: ev.key, email: true, inApp: true });
      for (const p of q.data) m.set(p.eventKey, { eventKey: p.eventKey, email: p.emailEnabled, inApp: p.inAppEnabled });
      setPrefs(m);
    }
  }, [q.data, prefs]);

  const save = useMutation({
    mutationFn: () =>
      api.put(
        `/users/${user!.id}/notification-preferences`,
        Array.from(prefs!.values()).map((p) => ({
          eventKey: p.eventKey,
          emailEnabled: p.email,
          inAppEnabled: p.inApp,
        })),
      ),
    onSuccess: () => {
      toast.success("Notification preferences saved");
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
    const cur = next.get(key) ?? { eventKey: key, email: true, inApp: true };
    next.set(key, { ...cur, ...patch });
    setPrefs(next);
  };

  return (
    <div className="space-y-4" data-testid="page-notifications">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Notification preferences</h2>
        <p className="text-sm text-muted-foreground">Choose how you want to be notified for each kind of event.</p>
      </div>

      {Array.from(grouped.entries()).map(([group, items]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle className="text-base">{group}</CardTitle>
            <CardDescription>Per-event delivery channels.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.map((ev) => {
              const p = prefs.get(ev.key) ?? { eventKey: ev.key, email: true, inApp: true };
              return (
                <div key={ev.key} className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <div className="text-sm font-medium">{ev.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{ev.key}</div>
                  </div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        checked={p.email}
                        onCheckedChange={(v) => update(ev.key, { email: v })}
                        data-testid={`switch-email-${ev.key}`}
                      />
                      Email
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        checked={p.inApp}
                        onCheckedChange={(v) => update(ev.key, { inApp: v })}
                        data-testid={`switch-inapp-${ev.key}`}
                      />
                      In-app
                    </label>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-notifications">
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" /> Save preferences
        </Button>
      </div>
    </div>
  );
}
