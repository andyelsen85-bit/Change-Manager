import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { ChangeRequest, ChangeStatus, ChangeTrack } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RiskBadge, StatusBadge, TrackBadge } from "@/components/StatusBadge";
import { fmtDateShort, fmtDateTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

const TRACKS: ChangeTrack[] = ["normal", "standard", "emergency"];
const STATUSES: ChangeStatus[] = [
  "draft",
  "submitted",
  "in_review",
  "awaiting_approval",
  "approved",
  "scheduled",
  "in_progress",
  "implemented",
  "in_testing",
  "awaiting_implementation",
  "awaiting_pir",
  "completed",
  "rejected",
  "rolled_back",
  "cancelled",
];

export function ChangesListPage() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [trackFilter, setTrackFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const params = new URLSearchParams();
  if (trackFilter !== "all") params.set("track", trackFilter);
  if (statusFilter !== "all") params.set("status", statusFilter);
  const qs = params.toString();
  const path = qs ? `/changes?${qs}` : "/changes";

  const { data, isLoading } = useQuery({ queryKey: [path], queryFn: () => api.get<ChangeRequest[]>(path) });

  const filtered = useMemo(() => {
    const list = data ?? [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (c) =>
        c.ref.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        (c.ownerName ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  return (
    <div className="space-y-4" data-testid="page-changes-list">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Change requests</h2>
          <p className="text-sm text-muted-foreground">All requests across normal, standard, and emergency tracks.</p>
        </div>
        <Link href="/changes/new">
          <Button data-testid="button-create-change">
            <Plus className="mr-2 h-4 w-4" /> New Change
          </Button>
        </Link>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by ref, title, or owner"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-search-changes"
              />
            </div>
            <Select value={trackFilter} onValueChange={setTrackFilter}>
              <SelectTrigger data-testid="select-track-filter"><SelectValue placeholder="Track" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tracks</SelectItem>
                {TRACKS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="select-status-filter"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No changes match these filters.{" "}
              <Link href="/changes/new" className="text-primary hover:underline">
                Create the first one →
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ref</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Track</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Risk</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Planned start</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setLocation(`/changes/${c.id}`)}
                      data-testid={`row-change-${c.id}`}
                    >
                      <TableCell className="font-mono text-xs">{c.ref}</TableCell>
                      <TableCell className="max-w-md">
                        <div className="truncate font-medium">{c.title}</div>
                      </TableCell>
                      <TableCell><TrackBadge track={c.track} /></TableCell>
                      <TableCell><StatusBadge status={c.status} /></TableCell>
                      <TableCell><RiskBadge risk={c.risk} /></TableCell>
                      <TableCell className="text-sm">{c.ownerName ?? "—"}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{fmtDateShort(c.plannedStart)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {fmtDateTime(c.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
