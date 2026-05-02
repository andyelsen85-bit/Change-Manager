import { ShieldAlert } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export function ForbiddenPage() {
  return (
    <div
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center"
      data-testid="page-forbidden"
    >
      <ShieldAlert className="h-12 w-12 text-destructive" aria-hidden="true" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">403 — Forbidden</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          You do not have permission to view this page. This area is restricted to administrators. If
          you believe this is a mistake, please contact your system administrator.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Return to dashboard</Link>
      </Button>
    </div>
  );
}
