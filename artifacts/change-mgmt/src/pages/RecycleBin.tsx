import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ChangeRequest } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge, TrackBadge } from "@/components/StatusBadge";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type DeletedChange = ChangeRequest & {
  deletedAt: string | null;
  deletedByName?: string | null;
};

export function RecycleBinPage() {
  const qc = useQueryClient();
  const [emptyOpen, setEmptyOpen] = useState(false);

  const binQ = useQuery({
    queryKey: ["recycle-bin"],
    queryFn: () => api.get<DeletedChange[]>("/recycle-bin/changes"),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["recycle-bin"] });
    // Restored changes reappear in the normal lists/dashboard.
    qc.invalidateQueries();
  };

  const restore = useMutation({
    mutationFn: (id: number) => api.post(`/changes/${id}/restore`, {}),
    onSuccess: () => {
      toast.success("Change restored");
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Restore failed"),
  });

  const empty = useMutation({
    mutationFn: () => api.delete("/recycle-bin/changes"),
    onSuccess: () => {
      toast.success("Recycle bin emptied");
      setEmptyOpen(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Empty failed"),
  });

  const rows = binQ.data ?? [];

  return (
    <div className="space-y-4" data-testid="page-recycle-bin">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Recycle Bin</h1>
          <p className="text-sm text-muted-foreground">
            Deleted changes stay here until the bin is emptied. Restoring a change puts it back
            exactly where it was.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setEmptyOpen(true)}
          disabled={rows.length === 0}
          data-testid="button-empty-bin"
        >
          <Trash2 className="mr-1.5 h-4 w-4" /> Empty recycle bin
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {binQ.isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground" data-testid="text-bin-empty">
              The recycle bin is empty.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Track</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Creator</TableHead>
                  <TableHead>Deleted</TableHead>
                  <TableHead>Deleted by</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id} data-testid={`row-bin-${c.id}`}>
                    <TableCell className="font-mono text-xs">{c.ref}</TableCell>
                    <TableCell className="max-w-[280px] truncate font-medium">{c.title}</TableCell>
                    <TableCell><TrackBadge track={c.track} /></TableCell>
                    <TableCell><StatusBadge status={c.status} /></TableCell>
                    <TableCell className="text-sm">{c.ownerName ?? "—"}</TableCell>
                    <TableCell className="text-sm" title={c.deletedAt ? fmtDateTime(c.deletedAt) : undefined}>
                      {c.deletedAt ? fmtAgo(c.deletedAt) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{c.deletedByName ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restore.mutate(c.id)}
                        disabled={restore.isPending}
                        data-testid={`button-restore-${c.id}`}
                      >
                        <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" /> Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={emptyOpen} onOpenChange={setEmptyOpen}>
        <AlertDialogContent data-testid="dialog-empty-bin">
          <AlertDialogHeader>
            <AlertDialogTitle>Empty the recycle bin?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {rows.length} change{rows.length === 1 ? "" : "s"} together
              with their plannings, approvals, comments, test records, and attachments. This cannot
              be undone. The audit log is preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-empty-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => empty.mutate()}
              disabled={empty.isPending}
              data-testid="button-empty-confirm"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
