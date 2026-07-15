import { AlertTriangle, CalendarClock } from "lucide-react";
import type { ChangeRequest } from "@/lib/types";
import { getPirCountdown } from "@/lib/pir";
import { cn } from "@/lib/utils";
import { fmtDateShort } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Compact PIR-deadline countdown. Renders nothing when no PIR applies
// (standard track, not yet implemented, or already closed).
export function PirCountdownBadge({
  change,
  "data-testid": testId,
}: {
  change: Pick<ChangeRequest, "track" | "status" | "actualEnd">;
  "data-testid"?: string;
}) {
  const pir = getPirCountdown(change);
  if (!pir) return <span className="text-muted-foreground">—</span>;
  const label = pir.overdue
    ? `${Math.abs(pir.daysLeft)}d overdue`
    : `${pir.daysLeft}d left`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={testId}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
              pir.urgent
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-border bg-muted/50 text-muted-foreground",
            )}
          >
            {pir.urgent ? <AlertTriangle className="h-3 w-3" /> : <CalendarClock className="h-3 w-3" />}
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent>PIR due by {fmtDateShort(pir.dueDate.toISOString())}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
