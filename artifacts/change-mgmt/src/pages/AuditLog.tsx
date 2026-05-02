import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { AuditEntry } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtDateTime } from "@/lib/format";

export function AuditLogPage() {
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const params = new URLSearchParams();
  if (actionFilter) params.set("action", actionFilter);
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  params.set("limit", "200");
  const path = `/audit-log?${params.toString()}`;
  const q = useQuery({ queryKey: [path], queryFn: () => api.get<AuditEntry[]>(path) });

  const filtered = useMemo(() => {
    const list = q.data ?? [];
    if (!search) return list;
    const t = search.toLowerCase();
    return list.filter(
      (r) =>
        r.actorName.toLowerCase().includes(t) ||
        r.action.toLowerCase().includes(t) ||
        r.summary.toLowerCase().includes(t) ||
        r.entityType.toLowerCase().includes(t),
    );
  }, [q.data, search]);

  const downloadCsv = () => {
    const exportPath = `/audit-log/export?${params.toString()}`;
    api.download(exportPath, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`).catch((err) =>
      console.error(err),
    );
  };

  return (
    <div className="space-y-4" data-testid="page-audit">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Audit log</h2>
          <p className="text-sm text-muted-foreground">Immutable record of every administrative and operational action.</p>
        </div>
        <Button onClick={downloadCsv} data-testid="button-export-csv">
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search summary, actor, action, type" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-audit-search" />
            </div>
            <Input placeholder="Filter by action key" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} data-testid="input-audit-action" />
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          {q.isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelected(r)}
                      data-testid={`row-audit-${r.id}`}
                    >
                      <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(r.timestamp)}</TableCell>
                      <TableCell className="text-sm">{r.actorName}</TableCell>
                      <TableCell className="font-mono text-xs">{r.action}</TableCell>
                      <TableCell className="text-xs">{r.entityType}{r.entityId != null && ` #${r.entityId}`}</TableCell>
                      <TableCell className="max-w-md truncate text-sm">{r.summary}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.ipAddress ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-12">
                        No audit entries match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={selected != null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>Audit entry #{selected.id}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <Field label="Timestamp" value={fmtDateTime(selected.timestamp)} />
                <Field label="Actor" value={selected.actorName} />
                <Field label="Action" value={selected.action} mono />
                <Field label="Entity" value={`${selected.entityType}${selected.entityId != null ? ` #${selected.entityId}` : ""}`} />
                <Field label="Summary" value={selected.summary} />
                <Field label="IP" value={selected.ipAddress ?? "—"} />
                <Field label="User agent" value={selected.userAgent ?? "—"} small />
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Before</div>
                  <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
                    {selected.before == null ? "—" : JSON.stringify(selected.before, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">After</div>
                  <pre className="max-h-60 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
                    {selected.after == null ? "—" : JSON.stringify(selected.after, null, 2)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="text-xs font-semibold uppercase text-muted-foreground">{label}</div>
      <div className={`col-span-2 ${mono ? "font-mono text-xs" : small ? "text-xs" : ""}`}>{value}</div>
    </div>
  );
}
