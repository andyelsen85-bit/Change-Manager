import { cn } from "@/lib/utils";
import { STATUS_LABELS, type ChangeStatus } from "@/lib/types";
import { statusVariant } from "@/lib/format";

const VARIANT_CLASSES: Record<string, string> = {
  default: "bg-muted text-foreground border-border",
  secondary: "bg-secondary text-secondary-foreground border-border",
  destructive: "bg-destructive/10 text-destructive border-destructive/30",
  outline: "bg-transparent text-foreground border-border",
  success: "bg-success/10 text-success border-success/30",
  warning: "bg-warning/10 text-warning border-warning/30",
  info: "bg-info/10 text-info border-info/30",
};

export function StatusBadge({ status, className }: { status: ChangeStatus; className?: string }) {
  const v = statusVariant(status);
  return (
    <span
      data-testid={`badge-status-${status}`}
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        VARIANT_CLASSES[v],
        className,
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function TrackBadge({ track }: { track: "normal" | "standard" | "emergency" }) {
  const v = track === "emergency" ? "destructive" : track === "standard" ? "secondary" : "info";
  const label = track.charAt(0).toUpperCase() + track.slice(1);
  return (
    <span
      data-testid={`badge-track-${track}`}
      className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium uppercase tracking-wide", VARIANT_CLASSES[v])}
    >
      {label}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: "low" | "medium" | "high" }) {
  const v = risk === "high" ? "destructive" : risk === "medium" ? "warning" : "success";
  return (
    <span
      data-testid={`badge-risk-${risk}`}
      className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize", VARIANT_CLASSES[v])}
    >
      {risk} risk
    </span>
  );
}
