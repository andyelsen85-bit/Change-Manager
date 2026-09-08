import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ChangeRequest } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, TrackBadge } from "@/components/StatusBadge";
import { fmtDateShort } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

type MyRequestQueues = Record<"creator" | "owner" | "implementer" | "tester" | "requester", ChangeRequest[]>;

const QUEUES: { key: keyof MyRequestQueues; title: string; description: string }[] = [
  { key: "creator", title: "Created by me", description: "Requests you opened" },
  { key: "owner", title: "Owned by me", description: "Requests currently assigned to you" },
  { key: "implementer", title: "Implementer", description: "Requests where you implement the change" },
  { key: "tester", title: "Tester", description: "Requests where you test the change" },
  { key: "requester", title: "Requested by me", description: "Requests submitted on your behalf" },
];

export function MyRequestsPage() {
  const queueQ = useQuery({
    queryKey: ["changes", "my-requests"],
    queryFn: () => api.get<MyRequestQueues>("/changes/my-requests"),
  });

  return (
    <div className="space-y-4" data-testid="page-my-requests">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">My requests</h2>
        <p className="text-sm text-muted-foreground">Your changes grouped by your relationship to each request.</p>
      </div>
      {queueQ.isLoading ? <Skeleton className="h-96 w-full" /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {QUEUES.map(({ key, title, description }) => {
            const rows = queueQ.data?.[key] ?? [];
            return (
              <Card key={key}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{title}</CardTitle>
                  <p className="text-xs text-muted-foreground">{description} · {rows.length}</p>
                </CardHeader>
                <CardContent>
                  {rows.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No requests in this list.</p> : (
                    <ul className="divide-y divide-border">
                      {rows.map((change) => (
                        <li key={change.id}>
                          <Link href={`/changes/${change.id}`} className="block py-3 hover:bg-muted/40">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <span className="font-mono text-xs text-muted-foreground">{change.ref}</span>
                                <p className="truncate text-sm font-medium">{change.title}</p>
                              </div>
                              <StatusBadge status={change.status} />
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              <TrackBadge track={change.track} />
                              <span>{fmtDateShort(change.plannedStart)}</span>
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}