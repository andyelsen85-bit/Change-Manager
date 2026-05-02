import { format, formatDistanceToNow, parseISO } from "date-fns";
import type { ChangeStatus } from "./types";

export function fmtDate(value: string | Date | null | undefined, pattern = "PPpp"): string {
  if (!value) return "—";
  try {
    const d = typeof value === "string" ? parseISO(value) : value;
    if (isNaN(d.getTime())) return "—";
    return format(d, pattern);
  } catch {
    return "—";
  }
}

export function fmtDateShort(value: string | Date | null | undefined): string {
  return fmtDate(value, "MMM d, yyyy");
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  return fmtDate(value, "MMM d, yyyy h:mm a");
}

export function fmtTime(value: string | Date | null | undefined): string {
  return fmtDate(value, "h:mm a");
}

export function fmtAgo(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    const d = typeof value === "string" ? parseISO(value) : value;
    if (isNaN(d.getTime())) return "—";
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return "—";
  }
}

export function statusVariant(
  status: ChangeStatus,
): "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" {
  switch (status) {
    case "completed":
    case "approved":
      return "success";
    case "rejected":
    case "rolled_back":
    case "cancelled":
      return "destructive";
    case "in_progress":
    case "implemented":
    case "scheduled":
      return "info";
    case "awaiting_approval":
    case "in_review":
    case "awaiting_pir":
    case "awaiting_implementation":
    case "in_testing":
      return "warning";
    case "draft":
    case "submitted":
      return "secondary";
    default:
      return "default";
  }
}

export function trackVariant(track: string): "default" | "secondary" | "destructive" | "outline" {
  if (track === "emergency") return "destructive";
  if (track === "standard") return "secondary";
  return "default";
}

export function riskColor(risk: string): string {
  if (risk === "high") return "text-destructive";
  if (risk === "medium") return "text-warning";
  return "text-success";
}

export function toLocalDateTimeInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalDateTimeInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
