import { useEffect, useMemo, useRef, useState } from "react";
import { format, isValid, parse } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
};

const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parseIsoLocal(value: string): { date: Date | null; time: string } {
  const m = value?.match(ISO_LOCAL_RE);
  if (!m) return { date: null, time: "" };
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return { date: isValid(date) ? date : null, time: `${hh}:${mm}` };
}

function buildIsoLocal(date: Date, time: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const t = /^\d{2}:\d{2}$/.test(time) ? time : "00:00";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${t}`;
}

export function DateTimePicker({
  value,
  onChange,
  id,
  required,
  disabled,
  className,
  ...rest
}: Props) {
  const parsed = useMemo(() => parseIsoLocal(value), [value]);
  const [open, setOpen] = useState(false);
  const [dateText, setDateText] = useState(parsed.date ? format(parsed.date, "dd/MM/yyyy") : "");
  const [timeText, setTimeText] = useState(parsed.time);
  const lastEmitted = useRef(value);

  // Re-sync local text fields when the parent value changes from the outside
  // (e.g. form reset, prefill from server). Skip the echo from our own emits.
  useEffect(() => {
    if (value === lastEmitted.current) return;
    setDateText(parsed.date ? format(parsed.date, "dd/MM/yyyy") : "");
    setTimeText(parsed.time);
  }, [value, parsed.date, parsed.time]);

  const emit = (date: Date | null, time: string): void => {
    if (!date) return;
    const next = buildIsoLocal(date, time || "00:00");
    lastEmitted.current = next;
    onChange(next);
  };

  const onDateBlur = (): void => {
    const d = parse(dateText, "dd/MM/yyyy", new Date());
    if (isValid(d)) {
      setDateText(format(d, "dd/MM/yyyy"));
      emit(d, timeText || "00:00");
    } else if (dateText.trim() === "") {
      // Allow clearing
    } else {
      // Revert to last good value
      setDateText(parsed.date ? format(parsed.date, "dd/MM/yyyy") : "");
    }
  };

  const onTimeBlur = (): void => {
    const m = timeText.match(/^(\d{1,2}):?(\d{2})?$/);
    if (m) {
      const h = Math.min(23, Math.max(0, Number(m[1])));
      const mm = Math.min(59, Math.max(0, Number(m[2] ?? "0")));
      const t = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      setTimeText(t);
      const d = parse(dateText, "dd/MM/yyyy", new Date());
      if (isValid(d)) emit(d, t);
    } else {
      setTimeText(parsed.time);
    }
  };

  return (
    <div className={cn("flex gap-2", className)} data-testid={rest["data-testid"]}>
      <div className="relative flex-1">
        <Input
          id={id}
          required={required}
          disabled={disabled}
          placeholder="dd/mm/yyyy"
          inputMode="numeric"
          value={dateText}
          onChange={(e) => setDateText(e.target.value)}
          onBlur={onDateBlur}
          className="pr-10"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              className="absolute right-0 top-0 h-full w-9 text-muted-foreground hover:text-foreground"
              aria-label="Pick date"
            >
              <CalendarIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={parsed.date ?? undefined}
              onSelect={(d) => {
                if (d) {
                  setDateText(format(d, "dd/MM/yyyy"));
                  emit(d, timeText || "00:00");
                  setOpen(false);
                }
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>
      <Input
        type="text"
        inputMode="numeric"
        placeholder="HH:mm"
        value={timeText}
        disabled={disabled}
        onChange={(e) => setTimeText(e.target.value)}
        onBlur={onTimeBlur}
        className="w-24"
      />
    </div>
  );
}
